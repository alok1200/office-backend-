import crypto from 'node:crypto';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

function encryptionKey() {
  const secret = process.env.PAYROLL_ENCRYPTION_KEY || process.env.DATABASE_URL || 'knooviq-payroll-default-key';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptAccountNumber(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptAccountNumber(stored) {
  const [ivHex, tagHex, dataHex] = String(stored || '').split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted bank account record.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function maskAccountNumber(accountNumber) {
  const clean = String(accountNumber || '').replace(/\s+/g, '');
  if (clean.length <= 4) return 'XXXX';
  return `${'X'.repeat(Math.max(4, clean.length - 4))}${clean.slice(-4)}`;
}

export function validateBankDetails(body = {}) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
  const account_holder_name = String(body.account_holder_name || '').trim();
  const bank_name = String(body.bank_name || '').trim();
  const account_number = String(body.account_number || '').replace(/\s+/g, '');
  const ifsc_code = String(body.ifsc_code || '').trim().toUpperCase();
  const account_type = String(body.account_type || 'SAVINGS').trim().toUpperCase();

  if (!account_holder_name || account_holder_name.length > 150) fail('Account holder name is required (max 150 characters).');
  if (!bank_name || bank_name.length > 150) fail('Bank name is required (max 150 characters).');
  if (!ACCOUNT_RE.test(account_number)) fail('Bank account number must be 9 to 18 digits.');
  if (!IFSC_RE.test(ifsc_code)) fail('Enter a valid 11-character IFSC code (e.g. HDFC0001234).');
  if (!['SAVINGS', 'CURRENT', 'SALARY'].includes(account_type)) fail('Account type must be SAVINGS, CURRENT, or SALARY.');

  return {
    account_holder_name,
    bank_name,
    account_number,
    account_number_encrypted: encryptAccountNumber(account_number),
    account_number_masked: maskAccountNumber(account_number),
    ifsc_code,
    account_type,
  };
}

export function providerConfigStatus(provider) {
  if (provider === 'RAZORPAYX') {
    const configured = Boolean(process.env.RAZORPAYX_KEY_ID && process.env.RAZORPAYX_KEY_SECRET && process.env.RAZORPAYX_ACCOUNT_NUMBER);
    const webhookConfigured = Boolean(process.env.RAZORPAYX_WEBHOOK_SECRET);
    return { provider, configured, webhookConfigured };
  }
  if (provider === 'CASHFREE') {
    const configured = Boolean(process.env.CASHFREE_CLIENT_ID && process.env.CASHFREE_CLIENT_SECRET);
    const webhookConfigured = Boolean(process.env.CASHFREE_WEBHOOK_SECRET);
    return { provider, configured, webhookConfigured };
  }
  return { provider, configured: false, webhookConfigured: false };
}

function mapRazorpayStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'processed') return 'SUCCESS';
  if (['failed', 'reversed', 'rejected', 'cancelled'].includes(s)) return 'FAILED';
  return 'PROCESSING';
}

function mapCashfreeStatus(status) {
  const s = String(status || '').toUpperCase();
  if (['SUCCESS', 'COMPLETED'].includes(s)) return 'SUCCESS';
  if (['FAILED', 'REVERSED', 'REJECTED', 'CANCELLED'].includes(s)) return 'FAILED';
  return 'PROCESSING';
}

/**
 * Backend payment provider adapter supporting RazorpayX and Cashfree Payouts.
 * Never marks a payment as SUCCESS without confirmed provider status.
 */
export function createPaymentAdapter(provider) {
  const normalized = String(provider || 'RAZORPAYX').toUpperCase();

  if (normalized === 'RAZORPAYX') {
    const keyId = process.env.RAZORPAYX_KEY_ID;
    const keySecret = process.env.RAZORPAYX_KEY_SECRET;
    const sourceAccount = process.env.RAZORPAYX_ACCOUNT_NUMBER;
    const webhookSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;
    const baseUrl = process.env.RAZORPAYX_API_URL || 'https://api.razorpay.com/v1';

    const authHeader = () => `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

    return {
      provider: 'RAZORPAYX',
      isConfigured: () => Boolean(keyId && keySecret && sourceAccount),

      async initiatePayout({ idempotencyKey, amountPaise, accountHolderName, accountNumber, ifscCode, referenceId, narration }) {
        if (!keyId || !keySecret || !sourceAccount) {
          throw Object.assign(new Error('RazorpayX credentials are not configured in backend environment variables.'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 });
        }
        const res = await fetch(`${baseUrl}/payouts`, {
          method: 'POST',
          headers: {
            Authorization: authHeader(),
            'Content-Type': 'application/json',
            'X-Payout-Idempotency': idempotencyKey,
          },
          body: JSON.stringify({
            account_number: sourceAccount,
            amount: Number(amountPaise),
            currency: 'INR',
            mode: 'IMPS',
            purpose: 'salary',
            queue_if_low_balance: false,
            reference_id: referenceId,
            narration: String(narration || 'Monthly Salary').slice(0, 30),
            fund_account: {
              account_type: 'bank_account',
              bank_account: {
                name: accountHolderName,
                ifsc: ifscCode,
                account_number: accountNumber,
              },
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw Object.assign(new Error(data?.error?.description || `RazorpayX payout failed (HTTP ${res.status}).`), {
            httpStatus: res.status,
            payload: data,
          });
        }
        return {
          providerPayoutId: data.id || null,
          providerUtr: data.utr || null,
          status: mapRazorpayStatus(data.status),
          httpStatus: res.status,
          payload: data,
        };
      },

      async fetchPayoutStatus({ providerPayoutId }) {
        if (!keyId || !keySecret || !providerPayoutId) return null;
        const res = await fetch(`${baseUrl}/payouts/${encodeURIComponent(providerPayoutId)}`, {
          headers: { Authorization: authHeader() },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        return {
          providerPayoutId: data.id || providerPayoutId,
          providerUtr: data.utr || null,
          status: mapRazorpayStatus(data.status),
          failureReason: data.failure_reason || data.status_details?.description || null,
          httpStatus: res.status,
          payload: data,
        };
      },

      verifyWebhookSignature(rawBody, headers = {}) {
        if (!webhookSecret) return false;
        const signature = headers['x-razorpay-signature'];
        if (!signature || typeof signature !== 'string') return false;
        const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        const sigBuf = Buffer.from(signature, 'utf8');
        const expBuf = Buffer.from(expected, 'utf8');
        return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      },

      parseWebhookEvent(payload = {}) {
        const entity = payload?.payload?.payout?.entity || payload?.payout || {};
        return {
          eventId: payload.event_id || payload.id || (entity.id && payload.event ? `${entity.id}:${payload.event}` : null),
          eventType: payload.event || 'payout.updated',
          providerPayoutId: entity.id || null,
          referenceId: entity.reference_id || null,
          providerUtr: entity.utr || null,
          status: mapRazorpayStatus(entity.status),
          failureReason: entity.failure_reason || entity.status_details?.description || null,
        };
      },
    };
  }

  if (normalized === 'CASHFREE') {
    const clientId = process.env.CASHFREE_CLIENT_ID;
    const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
    const webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET || clientSecret;
    const baseUrl = process.env.CASHFREE_API_URL || 'https://sandbox.cashfree.com/payout';

    const headers = () => ({
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
      'x-api-version': '2024-01-01',
      'Content-Type': 'application/json',
    });

    return {
      provider: 'CASHFREE',
      isConfigured: () => Boolean(clientId && clientSecret),

      async initiatePayout({ idempotencyKey, amountPaise, accountHolderName, accountNumber, ifscCode, referenceId, narration }) {
        if (!clientId || !clientSecret) {
          throw Object.assign(new Error('Cashfree Payouts credentials are not configured in backend environment variables.'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 });
        }
        const res = await fetch(`${baseUrl}/transfers`, {
          method: 'POST',
          headers: { ...headers(), 'x-idempotency-key': idempotencyKey },
          body: JSON.stringify({
            transfer_id: referenceId,
            transfer_amount: Number((Number(amountPaise) / 100).toFixed(2)),
            transfer_mode: 'imps',
            transfer_remarks: String(narration || 'Monthly Salary').slice(0, 70),
            beneficiary_details: {
              beneficiary_name: accountHolderName,
              beneficiary_instrument_details: {
                bank_account_number: accountNumber,
                bank_ifsc: ifscCode,
              },
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw Object.assign(new Error(data?.message || `Cashfree transfer failed (HTTP ${res.status}).`), {
            httpStatus: res.status,
            payload: data,
          });
        }
        return {
          providerPayoutId: data.cf_transfer_id || data.transfer_id || referenceId,
          providerUtr: data.transfer_utr || null,
          status: mapCashfreeStatus(data.status),
          httpStatus: res.status,
          payload: data,
        };
      },

      async fetchPayoutStatus({ providerPayoutId, referenceId }) {
        if (!clientId || !clientSecret || (!providerPayoutId && !referenceId)) return null;
        const queryParam = providerPayoutId
          ? `cf_transfer_id=${encodeURIComponent(providerPayoutId)}`
          : `transfer_id=${encodeURIComponent(referenceId)}`;
        const res = await fetch(`${baseUrl}/transfers?${queryParam}`, {
          headers: headers(),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        return {
          providerPayoutId: data.cf_transfer_id || providerPayoutId,
          providerUtr: data.transfer_utr || null,
          status: mapCashfreeStatus(data.status),
          failureReason: data.status_description || null,
          httpStatus: res.status,
          payload: data,
        };
      },

      verifyWebhookSignature(rawBody, reqHeaders = {}) {
        if (!webhookSecret) return false;
        const signature = reqHeaders['x-webhook-signature'];
        const timestamp = reqHeaders['x-webhook-timestamp'] || '';
        if (!signature || typeof signature !== 'string') return false;
        const expected = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}${rawBody}`).digest('base64');
        const sigBuf = Buffer.from(signature, 'utf8');
        const expBuf = Buffer.from(expected, 'utf8');
        return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      },

      parseWebhookEvent(payload = {}) {
        const data = payload?.data || payload;
        return {
          eventId: payload.event_id || (data.cf_transfer_id && payload.type ? `${data.cf_transfer_id}:${payload.type}` : null),
          eventType: payload.type || 'TRANSFER_UPDATED',
          providerPayoutId: data.cf_transfer_id || null,
          referenceId: data.transfer_id || null,
          providerUtr: data.transfer_utr || null,
          status: mapCashfreeStatus(data.status),
          failureReason: data.status_description || data.reason || null,
        };
      },
    };
  }

  throw Object.assign(new Error(`Unsupported payment provider: ${provider}`), { status: 400 });
}
