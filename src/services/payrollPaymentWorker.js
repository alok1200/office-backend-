import { pool, query } from '../db/index.js';
import { createPaymentAdapter, decryptAccountNumber } from './paymentProvider.js';

let running = false;

async function syncPeriodStatus(client, payrollPeriodId) {
  const stats = (await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success_count,
       COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
       COUNT(*) FILTER (WHERE status IN ('PENDING','PROCESSING'))::int AS inflight_count
     FROM salary_payments WHERE payroll_period_id = $1`,
    [payrollPeriodId]
  )).rows[0];
  if (!stats || stats.total === 0) return;

  let nextStatus = 'PROCESSING';
  if (stats.inflight_count === 0) {
    if (stats.success_count === stats.total) nextStatus = 'COMPLETED';
    else if (stats.success_count > 0) nextStatus = 'PARTIALLY_PAID';
    else nextStatus = 'AUTHORIZED';
  }
  await client.query('UPDATE payroll_periods SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [nextStatus, payrollPeriodId]);
}

/**
 * Process a single PENDING salary payment safely with row-level lock and idempotency key.
 * Never marks a payment SUCCESS without confirmed provider status.
 */
export async function processSinglePayment(paymentId, adapterFactory = createPaymentAdapter) {
  let client;
  let payment;
  let bank;
  let record;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT sp.*, pr.employee_name, pr.employee_code, pp.year, pp.month
       FROM salary_payments sp
       JOIN payroll_records pr ON pr.id = sp.payroll_record_id
       JOIN payroll_periods pp ON pp.id = sp.payroll_period_id
       WHERE sp.id = $1 AND sp.status = 'PENDING'
       FOR UPDATE OF sp SKIP LOCKED`,
      [paymentId]
    )).rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    payment = row;
    record = row;

    bank = (await client.query('SELECT * FROM employee_bank_accounts WHERE id = $1', [payment.bank_account_id])).rows[0];
    if (!bank) {
      await client.query(
        `UPDATE salary_payments SET status = 'FAILED', failure_reason = 'Employee bank account is not registered.', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [payment.id]
      );
      await syncPeriodStatus(client, payment.payroll_period_id);
      await client.query('COMMIT');
      return { id: payment.id, status: 'FAILED' };
    }

    await client.query(
      `UPDATE salary_payments SET status = 'PROCESSING', attempt_count = attempt_count + 1, initiated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [payment.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }

  // Call external payment provider outside DB lock
  const adapter = adapterFactory(payment.provider);
  const referenceId = `PAY-${record.year}${String(record.month).padStart(2, '0')}-${payment.id}`;
  const narration = `Salary ${record.year}-${String(record.month).padStart(2, '0')}`;

  try {
    const plainAccount = decryptAccountNumber(bank.account_number_encrypted);
    const result = await adapter.initiatePayout({
      idempotencyKey: payment.idempotency_key,
      amountPaise: Number(payment.amount_paise),
      accountHolderName: bank.account_holder_name,
      accountNumber: plainAccount,
      ifscCode: bank.ifsc_code,
      bankName: bank.bank_name,
      referenceId,
      narration,
    });

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO payment_transactions (salary_payment_id, provider, idempotency_key, request_type, provider_reference_id, status, http_status, response_payload)
         VALUES ($1,$2,$3,'INITIATE',$4,$5,$6,$7)`,
        [payment.id, payment.provider, payment.idempotency_key, result.providerPayoutId, result.status, result.httpStatus || 200, JSON.stringify(result.payload || {})]
      );
      await c.query(
        `UPDATE salary_payments
         SET status = $1, provider_payout_id = COALESCE($2, provider_payout_id), provider_utr = COALESCE($3, provider_utr),
             failure_reason = NULL, completed_at = CASE WHEN $1 = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE completed_at END, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [result.status, result.providerPayoutId, result.providerUtr, payment.id]
      );
      await syncPeriodStatus(c, payment.payroll_period_id);
      await c.query('COMMIT');
      return { id: payment.id, status: result.status };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  } catch (err) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO payment_transactions (salary_payment_id, provider, idempotency_key, request_type, status, http_status, response_payload, error_message)
         VALUES ($1,$2,$3,'INITIATE','FAILED',$4,$5,$6)`,
        [payment.id, payment.provider, payment.idempotency_key, err.httpStatus || 500, JSON.stringify(err.payload || {}), err.message]
      );
      await c.query(
        `UPDATE salary_payments SET status = 'FAILED', failure_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [err.message, payment.id]
      );
      await syncPeriodStatus(c, payment.payroll_period_id);
      await c.query('COMMIT');
      return { id: payment.id, status: 'FAILED', error: err.message };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}

/**
 * Drain all PENDING salary payments in background.
 */
export async function processPendingPayrollPayments(payrollPeriodId = null) {
  if (running) return;
  running = true;
  try {
    const pending = payrollPeriodId
      ? (await query("SELECT id FROM salary_payments WHERE payroll_period_id = $1 AND status = 'PENDING' ORDER BY id", [payrollPeriodId])).rows
      : (await query("SELECT id FROM salary_payments WHERE status = 'PENDING' ORDER BY id LIMIT 50")).rows;
    for (const row of pending) {
      await processSinglePayment(row.id).catch(err => console.error('[PayrollWorker] Payment failed:', row.id, err.message));
    }
  } finally {
    running = false;
  }
}

export function enqueuePayrollPayments(payrollPeriodId) {
  setImmediate(() => {
    processPendingPayrollPayments(payrollPeriodId).catch(err => console.error('[PayrollWorker] Queue error:', err.message));
  });
}

/**
 * Apply a verified provider webhook event to salary_payments and payroll_periods.
 */
export async function reconcileWebhookEvent(provider, event) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payment = event.providerPayoutId
      ? (await client.query('SELECT * FROM salary_payments WHERE provider = $1 AND provider_payout_id = $2 FOR UPDATE', [provider, event.providerPayoutId])).rows[0]
      : null;

    if (!payment) {
      await client.query('COMMIT');
      return { matched: false };
    }
    // Never regress an already confirmed SUCCESS payment.
    if (payment.status === 'SUCCESS') {
      await client.query('COMMIT');
      return { matched: true, unchanged: true };
    }

    await client.query(
      `UPDATE salary_payments
       SET status = $1, provider_utr = COALESCE($2, provider_utr), failure_reason = $3,
           completed_at = CASE WHEN $1 = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE completed_at END, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [event.status, event.providerUtr || null, event.status === 'FAILED' ? (event.failureReason || 'Transfer failed at provider') : null, payment.id]
    );
    await client.query(
      `INSERT INTO payment_transactions (salary_payment_id, provider, idempotency_key, request_type, provider_reference_id, status, response_payload, error_message)
       VALUES ($1,$2,$3,'WEBHOOK',$4,$5,$6,$7)`,
      [payment.id, provider, payment.idempotency_key, event.providerPayoutId, event.status, JSON.stringify(event), event.failureReason || null]
    );
    await syncPeriodStatus(client, payment.payroll_period_id);
    await client.query('COMMIT');
    return { matched: true, paymentId: payment.id, status: event.status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
