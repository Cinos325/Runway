-- Stage 3: Link transactions to their source recurring template.
--
-- WHY: The spending_power view assumes all Bills/Savings obligations are
-- projected via the recurring_transactions table (the "planned" subquery).
-- Manually-logged Bills or Savings transactions weren't being subtracted
-- from spending power, causing it to overstate available cash whenever a
-- user logged a one-off bill or an ad-hoc contribution toward an open goal.
--
-- Fix: distinguish recurring-generated transactions (already accounted for)
-- from manual ones (need to be subtracted) via a new recurring_id column.

BEGIN;

ALTER TABLE transactions
    ADD COLUMN recurring_id INTEGER
    REFERENCES recurring_transactions(id) ON DELETE SET NULL;

-- ON DELETE SET NULL is deliberate: deleting a recurring template should
-- not wipe out the historical transactions it generated. Orphaned but
-- preserved is the right behavior.

CREATE INDEX idx_transactions_recurring_id ON transactions(recurring_id);

-- Backfill historical auto-generated transactions. The generator function
-- appends "(auto-generated from: <name>)" to the description, so we can
-- match on that marker plus payee+amount+account+category+type.
--
-- Imperfect for ambiguous cases (two templates with identical fields), but
-- such collisions are rare and the unique-auto-generated index already
-- prevents duplicates from accumulating.
UPDATE transactions t
SET recurring_id = r.id
FROM recurring_transactions r
WHERE t.description LIKE '%auto-generated from: ' || r.name || '%'
  AND t.payee     IS NOT DISTINCT FROM r.payee
  AND t.amount    = r.amount
  AND t.account   IS NOT DISTINCT FROM r.account
  AND t.category  IS NOT DISTINCT FROM r.category
  AND t.type      = r.type;

-- ============================================================
-- Replace the spending_power view to subtract ad-hoc obligations
-- ============================================================
--
-- Adds an `adhoc_obligations` subquery summing this month's Bills and
-- Savings transactions where recurring_id IS NULL. These are manually
-- logged one-offs that weren't projected via the planned subquery, so
-- without this subtraction, spending_power overstated available cash.

CREATE OR REPLACE VIEW public.spending_power AS
SELECT
    (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date AS current_month,
    (
        COALESCE(bc.baseline, 0::numeric)
        + COALESCE(income.total, 0::numeric)
        + COALESCE(releases.total, 0::numeric)
        - COALESCE(planned.total, 0::numeric)
        - COALESCE(spending.total, 0::numeric)
        - COALESCE(adhoc.total, 0::numeric)
    ) AS spending_power,
    COALESCE(bc.baseline, 0::numeric) AS baseline,
    COALESCE(income.total, 0::numeric) AS current_month_income,
    COALESCE(planned.total, 0::numeric) AS planned_payments_total,
    COALESCE(spending.total, 0::numeric) AS current_month_spending,
    COALESCE(releases.total, 0::numeric) AS current_month_goal_releases,
    COALESCE(adhoc.total, 0::numeric) AS current_month_adhoc_obligations
FROM budget_config bc
CROSS JOIN (
    SELECT COALESCE(sum(amount), 0::numeric) AS total
    FROM transactions
    WHERE month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date
      AND type = 'Income'::text
) income
CROSS JOIN (
    SELECT COALESCE(sum(amount), 0::numeric) AS total
    FROM transactions
    WHERE month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date
      AND type = 'GoalRelease'::text
) releases
CROSS JOIN (
    SELECT COALESCE(sum(amount), 0::numeric) AS total
    FROM recurring_transactions
    WHERE is_active = true
      AND type <> 'Spending'::text
      AND start_date < ((date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)) + '1 mon'::interval))::date
      AND (end_date IS NULL OR end_date >= (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date)
) planned
CROSS JOIN (
    SELECT COALESCE(sum(amount), 0::numeric) AS total
    FROM transactions
    WHERE month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date
      AND type = 'Spending'::text
) spending
CROSS JOIN (
    -- NEW: manually-logged Bills/Savings (no recurring template behind them)
    SELECT COALESCE(sum(amount), 0::numeric) AS total
    FROM transactions
    WHERE month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date
      AND type IN ('Bills'::text, 'Savings'::text)
      AND recurring_id IS NULL
) adhoc;

COMMIT;