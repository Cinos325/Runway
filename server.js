require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3002;

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Get spending power (and the breakdown that produces it)
app.get('/api/spending-power', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        spending_power,
        baseline,
        current_month_income,
        planned_payments_total,
        current_month_spending,
        current_month
      FROM spending_power
    `);
    if (result.rows.length === 0) {
      return res.json({
        spending_power: 0,
        baseline: 0,
        current_month_income: 0,
        planned_payments_total: 0,
        current_month_spending: 0,
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* Get recent transactions (by calendar date)
app.get('/api/transactions/recent', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT transaction_date, type, amount, category, description, payee
      FROM transactions
      WHERE month = date_trunc('month', CURRENT_DATE)::date
      ORDER BY transaction_date DESC, id DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
*/

// Get recent transactions (by created_at date) with optional filtering.
// Query params: type (Spending|Income|Bills|Transfer), category, limit (default 10, max 200)
app.get('/api/transactions/recent', async (req, res) => {
  try {
    const { type, category } = req.query;
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 10;
    if (limit > 200) limit = 200;
    
    // Build WHERE clause from optional filters. Parameterized to avoid SQL injection.
    const where = [];
    const params = [];
    if (type) {
      params.push(type);
      where.push(`type = $${params.length}`);
    }
    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    
    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    
    const result = await pool.query(`
      SELECT
        id,
        transaction_date,
        type,
        amount,
        category,
        description,
        payee
      FROM transactions
      ${whereSQL}
      ORDER BY created_at DESC NULLS LAST
      LIMIT ${limitPlaceholder}
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// List active installment plans with progress.
// An installment plan is a Spending-type recurring transaction with an end_date.
app.get('/api/installments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, payee, category, account, frequency,
        start_date, end_date,
        payment_amount, total_periods, target_amount,
        amount_paid, payments_made, amount_remaining,
        pct_paid, pct_time_elapsed
      FROM installment_progress
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ===== Savings goals =====

function validateGoalInput(body) {
  const errors = [];
  if (!body.name || !String(body.name).trim()) errors.push('name is required');
  const target = parseFloat(body.target_amount);
  if (isNaN(target) || target <= 0) errors.push('target_amount must be a positive number');
  if (!body.match_category || !String(body.match_category).trim()) {
    errors.push('match_category is required');
  }
  return errors;
}

// List all active savings goals with progress
app.get('/api/goals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, target_amount, match_category, notes,
             created_at, completed_at,
             amount_saved, amount_remaining, pct_saved, contribution_count
      FROM savings_goal_progress
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create a new savings goal
app.post('/api/goals', async (req, res) => {
  const errors = validateGoalInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  const { name, target_amount, match_category, notes } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO savings_goals (name, target_amount, match_category, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name.trim(), parseFloat(target_amount), match_category.trim(), notes || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

// Update a savings goal
app.put('/api/goals/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  const errors = validateGoalInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  
  const { name, target_amount, match_category, notes, is_active, completed_at } = req.body;
  try {
    const result = await pool.query(`
      UPDATE savings_goals SET
        name = $1, target_amount = $2, match_category = $3, notes = $4,
        is_active = $5, completed_at = $6, updated_at = now()
      WHERE id = $7
      RETURNING *
    `, [
      name.trim(),
      parseFloat(target_amount),
      match_category.trim(),
      notes || null,
      is_active !== false,
      completed_at || null,
      id,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

// Delete a savings goal
app.delete('/api/goals/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await pool.query(
      'DELETE FROM savings_goals WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// Mark a goal complete. Atomically:
//   1. Reads the goal's current amount_saved (from the savings_goal_progress view)
//   2. Inserts a GoalRelease transaction for that amount, dated today, matching the goal's category
//   3. Sets the goal's completed_at and is_active=false
//   4. Deactivates any matching recurring transaction (same category, type='Savings')
// If any step fails, the whole thing rolls back.
//
// The GoalRelease transaction is positive: it adds to spending power, offsetting
// the user's actual purchase. See migrations/2026-05-19-goal-release.sql for the
// view definitions that use this.
app.post('/api/goals/:id/complete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Look up the goal and its current saved amount
    const goalQ = await client.query(
      `SELECT g.id, g.name, g.match_category, sgp.amount_saved
       FROM savings_goals g
       LEFT JOIN savings_goal_progress sgp ON sgp.id = g.id
       WHERE g.id = $1`,
      [id]
    );
    if (goalQ.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Goal not found' });
    }
    const goal = goalQ.rows[0];
    const amountSaved = parseFloat(goal.amount_saved || 0);
    
    // Create the GoalRelease transaction if there's anything to release.
    // A goal with $0 saved (never funded) still gets marked complete, just no release.
    if (amountSaved > 0) {
      await client.query(
        `INSERT INTO transactions
          (transaction_date, type, amount, category, description, payee, account)
         VALUES (CURRENT_DATE, 'GoalRelease', $1, $2, $3, 'Goal completion', NULL)`,
        [amountSaved, goal.match_category, `Released $${amountSaved.toFixed(2)} from goal: ${goal.name}`]
      );
    }
    
    // Mark goal complete
    await client.query(
      `UPDATE savings_goals
       SET completed_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    
    // Deactivate any matching recurring template (type='Savings', same category)
    await client.query(
      `UPDATE recurring_transactions
       SET is_active = false
       WHERE type = 'Savings' AND category = $1 AND is_active = true`,
      [goal.match_category]
    );
    
    await client.query('COMMIT');
    res.json({
      goal_id: id,
      released_amount: amountSaved,
      released: amountSaved > 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete goal' });
  } finally {
    client.release();
  }
});

// Add new transaction
function validateTransactionInput(body) {
  // GoalRelease is internal-only — created server-side by goal completion,
  // not accepted from clients.
  const validTypes = ['Spending', 'Income', 'Transfer', 'Bills', 'Savings'];
  const errors = [];
  if (!body.transaction_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.transaction_date)) {
    errors.push('transaction_date must be in YYYY-MM-DD format');
  }
  if (!validTypes.includes(body.type)) {
    errors.push(`type must be one of: ${validTypes.join(', ')}`);
  }
  const amountNum = parseFloat(body.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    errors.push('amount must be a positive number');
  }
  if (!body.category || typeof body.category !== 'string' || !body.category.trim()) {
    errors.push('category is required');
  }
  return errors;
}

app.post('/api/transactions', async (req, res) => {
  const { transaction_date, type, amount, category, description, payee, account } = req.body;
  
  const errors = validateTransactionInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO transactions (transaction_date, month, type, amount, category, description, payee, account)
      VALUES (
        CAST($1 AS date),
        date_trunc('month', CAST($1 AS date))::date,
        $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [transaction_date, type, amount, category, description || null, 
      payee || null, account || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to insert transaction' });
  }
});

// Update the spending power baseline (writes to budget_config)
app.put('/api/spending-power', async (req, res) => {
  // Accept either {baseline} or {spending_power} for backward compatibility
  const raw = req.body.baseline ?? req.body.spending_power;
  const value = parseFloat(raw);
  if (isNaN(value)) {
    return res.status(400).json({ error: 'baseline must be a number' });
  }
  
  try {
    // budget_config is a single-row table; UPDATE the existing row,
    // or INSERT one if the table is somehow empty.
    const updateResult = await pool.query(`
      UPDATE budget_config SET baseline = $1
      RETURNING baseline
    `, [value]);
    
    if (updateResult.rowCount === 0) {
      const insertResult = await pool.query(`
        INSERT INTO budget_config (baseline) VALUES ($1)
        RETURNING baseline
      `, [value]);
      return res.json({ baseline: insertResult.rows[0].baseline });
    }
    
    res.json({ baseline: updateResult.rows[0].baseline });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update baseline' });
  }
});

// Update a transaction
app.put('/api/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  const errors = validateTransactionInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  
  const { transaction_date, type, amount, category, description, payee, account } = req.body;
  
  try {
    // Recompute `month` from the (possibly changed) transaction_date so it stays in sync.
    const result = await pool.query(`
      UPDATE transactions SET
        transaction_date = CAST($1 AS date),
        month = date_trunc('month', CAST($1 AS date))::date,
        type = $2,
        amount = $3,
        category = $4,
        description = $5,
        payee = $6,
        account = $7
      WHERE id = $8
      RETURNING *
    `, [
      transaction_date, type, amount, category,
      description || null, payee || null, account || null,
      id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// Delete a transaction
app.delete('/api/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  try {
    const result = await pool.query(
      'DELETE FROM transactions WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// Get distinct categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT category 
      FROM transactions 
      WHERE category IS NOT NULL 
        AND category != ''
      ORDER BY category
    `);
    const categories = result.rows.map(row => row.category);
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Top N spending categories for the current month.
// Returns: [{ category, total }, ...] sorted by total descending.
// Filters to type='Spending' (discretionary) by design — Bills are excluded
// because they're fixed obligations and would dominate the chart every month.
app.get('/api/spending-by-category', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 5;
    if (limit > 20) limit = 20;
    
    const result = await pool.query(`
      SELECT category, SUM(amount)::numeric AS total
      FROM transactions
      WHERE type = 'Spending'
        AND month = date_trunc('month', CURRENT_DATE)::date
        AND category IS NOT NULL
        AND category != ''
      GROUP BY category
      ORDER BY total DESC
      LIMIT $1
    `, [limit]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get distinct accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT account 
      FROM transactions 
      WHERE account IS NOT NULL 
        AND account != ''
      ORDER BY account
    `);
    const accounts = result.rows.map(row => row.account);
    res.json(accounts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ===== Recurring transactions =====

const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'yearly'];
const VALID_TYPES = ['Bills', 'Income', 'Savings', 'Spending'];

function validateRecurring(body) {
  const errors = [];
  if (!body.name || !String(body.name).trim()) errors.push('name is required');
  if (!VALID_TYPES.includes(body.type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!body.payee || !String(body.payee).trim()) errors.push('payee is required');
  if (!body.category || !String(body.category).trim()) errors.push('category is required');
  if (!body.account || !String(body.account).trim()) errors.push('account is required');
  const amountNum = parseFloat(body.amount);
  if (isNaN(amountNum) || amountNum <= 0) errors.push('amount must be a positive number');
  if (!VALID_FREQUENCIES.includes(body.frequency)) {
    errors.push(`frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`);
  }
  if (!body.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) {
    errors.push('start_date must be in YYYY-MM-DD format');
  }
  if (body.end_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.end_date)) {
    errors.push('end_date must be in YYYY-MM-DD format if provided');
  }
  return errors;
}

// List all recurring transactions
app.get('/api/recurring', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, type, payee, category, amount, account, description,
             frequency, day_of_month, start_date, end_date, is_active
      FROM recurring_transactions
      ORDER BY is_active DESC, type, name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create a recurring transaction
app.post('/api/recurring', async (req, res) => {
  const errors = validateRecurring(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  
  const {
    name, type, payee, category, amount, account, description,
    frequency, day_of_month, start_date, end_date,
    create_first_payment_today,  // optional: also insert a transactions row for today
  } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const result = await client.query(`
      INSERT INTO recurring_transactions (
        name, type, payee, category, amount, account, description,
        frequency, day_of_month, start_date, end_date, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING *
    `, [
      name.trim(),
      type,
      payee.trim(),
      category || null,
      parseFloat(amount),
      account || null,
      description || null,
      frequency,
      day_of_month ? parseInt(day_of_month, 10) : null,
      start_date,
      end_date || null,
    ]);
    
    let firstTransaction = null;
    if (create_first_payment_today) {
      // Insert a transactions row dated today, mirroring the recurring entry.
      // The transactions table's "month" column gets computed from today's date.
      const txResult = await client.query(`
        INSERT INTO transactions (transaction_date, month, type, amount, category, description, payee, account)
        VALUES (
          CURRENT_DATE,
          date_trunc('month', CURRENT_DATE)::date,
          $1, $2, $3, $4, $5, $6
        )
        RETURNING *
      `, [
        type,
        parseFloat(amount),
        category || null,
        description || null,
        payee.trim(),
        account || null,
      ]);
      firstTransaction = txResult.rows[0];
    }
    
    await client.query('COMMIT');
    res.status(201).json({
      recurring: result.rows[0],
      first_transaction: firstTransaction,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create recurring transaction' });
  } finally {
    client.release();
  }
});

// Update a recurring transaction
app.put('/api/recurring/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  const errors = validateRecurring(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  
  const {
    name, type, payee, category, amount, account, description,
    frequency, day_of_month, start_date, end_date, is_active,
  } = req.body;
  
  try {
    const result = await pool.query(`
      UPDATE recurring_transactions SET
        name = $1, type = $2, payee = $3, category = $4, amount = $5,
        account = $6, description = $7, frequency = $8, day_of_month = $9,
        start_date = $10, end_date = $11, is_active = $12,
        updated_at = now()
      WHERE id = $13
      RETURNING *
    `, [
      name.trim(),
      type,
      payee.trim(),
      category || null,
      parseFloat(amount),
      account || null,
      description || null,
      frequency,
      day_of_month ? parseInt(day_of_month, 10) : null,
      start_date,
      end_date || null,
      is_active !== false,  // default true
      id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update recurring transaction' });
  }
});

// Delete a recurring transaction
app.delete('/api/recurring/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  
  try {
    const result = await pool.query(
      'DELETE FROM recurring_transactions WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete recurring transaction' });
  }
});

// List configured external tool links (from env vars: TOOL_<NAME>_URL=...)
// e.g. TOOL_METABASE_URL=http://192.168.85.109:3001 → { name: 'Metabase', url: '...' }
function loadConfiguredTools() {
  const tools = [];
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^TOOL_(.+)_URL$/);
    if (!match) continue;
    const url = process.env[key];
    if (!url) continue;
    // Title-case the env var: METABASE → Metabase, PG_ADMIN → Pg Admin
    const name = match[1]
      .toLowerCase()
      .split('_')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
    tools.push({ name, url });
  }
  // Sort alphabetically for stable ordering
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

const CONFIGURED_TOOLS = loadConfiguredTools();
console.log(`Loaded ${CONFIGURED_TOOLS.length} tool link(s):`, CONFIGURED_TOOLS.map(t => t.name).join(', ') || '(none)');

app.get('/api/tools', (req, res) => {
  res.json(CONFIGURED_TOOLS);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Finance API running on http://0.0.0.0:${port}`);
});