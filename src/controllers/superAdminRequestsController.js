import { pool, query } from '../db/index.js';
import { calculateRequest, getAllowanceBalances, requestCategories, validateSubmission } from '../services/superAdminRequestPolicy.js';
async function sqlContext(run, userId) {
  return {
    holidays: (await run('SELECT holiday_date FROM holidays')).rows,
    requests: (await run('SELECT * FROM requests WHERE employee_id = $1', [userId])).rows
  };
}
function respondError(res, error) {
  return res.status(error.status || 500).json({
    success: false,
    error: error.status ? error.message : 'Could not save your request. Please retry.'
  });
}
export async function requestOptions(req, res) {
  try {
    const year = Number(req.query.year) || Number(new Intl.DateTimeFormat('en', {
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    }).format(new Date()));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({
      success: false,
      error: 'Choose a year between 2000 and 2100.'
    });
    const context = await sqlContext(query, req.user.id);
    res.json({
      success: true,
      data: {
        year,
        categories: Object.entries(requestCategories).map(([id, c]) => ({
          id,
          label: c.label
        })),
        balances: getAllowanceBalances(context.requests, year),
        policy: 'Annual default policy: CL 12, SL 10, EL 15, WFH 24. Pending requests reserve balance.'
      }
    });
  } catch (error) {
    respondError(res, error);
  }
}
export async function previewRequest(req, res) {
  try {
    const holidays = (await query('SELECT holiday_date FROM holidays')).rows;
    res.json({
      success: true,
      data: calculateRequest(req.body, holidays)
    });
  } catch (error) {
    respondError(res, error);
  }
}
export async function createPersonalRequest(req, res) {
  let client;
  try {
    let request;
    const makeData = context => {
      const calculation = validateSubmission(req.body, context);
      return {
        employee_id: req.user.id,
        request_type: requestCategories[calculation.category].type,
        start_date: req.body.start_date,
        end_date: req.body.end_date,
        reason: req.body.reason.trim(),
        status: 'PENDING',
        submission_date: new Date().toISOString(),
        metadata: {
          ...calculation,
          label: requestCategories[calculation.category].label
        }
      };
    };
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize this account's balance checks and submission writes.
    await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [req.user.id]);
    const data = makeData(await sqlContext(client.query.bind(client), req.user.id));
    request = (await client.query(`INSERT INTO requests (employee_id, request_type, start_date, end_date, reason, status, submission_date, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [data.employee_id, data.request_type, data.start_date, data.end_date, data.reason, data.status, data.submission_date, JSON.stringify(data.metadata)])).rows[0];
    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: 'Request submitted and pending review.',
      data: request
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    respondError(res, error);
  } finally {
    client?.release();
  }
}
export async function cancelPersonalRequest(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({
      success: false,
      error: 'Invalid request ID.'
    });
    let request;
    client = await pool.connect();
    await client.query('BEGIN');
    request = (await client.query("UPDATE requests SET status = 'CANCELLED' WHERE id = $1 AND employee_id = $2 AND status = 'PENDING' RETURNING *", [id, req.user.id])).rows[0];
    if (request) await client.query("INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark) VALUES ($1,$2,'cancel','PENDING','CANCELLED','Cancelled by request owner')", [id, req.user.id]);
    await client.query('COMMIT');
    if (!request) return res.status(409).json({
      success: false,
      error: 'Only your own pending requests can be cancelled. Refresh and try again.'
    });
    res.json({
      success: true,
      message: 'Request cancelled. Reserved allowance released.',
      data: request
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    respondError(res, error);
  } finally {
    client?.release();
  }
}
