-- Stage 4b: Installments now use type='Bills' instead of 'Spending'.
--
-- WHY: Installments are commitments (auto-insurance payment plans, phone-on-payments,
-- etc.) — money you can't easily skip. Modeling them as Bills means the spending_power
-- view deducts them via the planned subquery (forward-looking commitment) rather than
-- waiting for the actual transaction (after-the-fact spending). This matches how the
-- user thinks about installments: "already accounted for, plan around it."
--
-- No data migration needed — there are no historical installments to convert.

BEGIN;

CREATE OR REPLACE VIEW public.installment_progress AS
 WITH installments AS (
         SELECT recurring_transactions.id,
            recurring_transactions.name,
            recurring_transactions.type,
            recurring_transactions.payee,
            recurring_transactions.category,
            recurring_transactions.amount AS payment_amount,
            recurring_transactions.account,
            recurring_transactions.frequency,
            recurring_transactions.start_date,
            recurring_transactions.end_date,
                CASE recurring_transactions.frequency
                    WHEN 'monthly'::text THEN ((((((EXTRACT(year FROM recurring_transactions.end_date) - EXTRACT(year FROM recurring_transactions.start_date)) * (12)::numeric) + EXTRACT(month FROM recurring_transactions.end_date)) - EXTRACT(month FROM recurring_transactions.start_date)) + (1)::numeric))::integer
                    WHEN 'yearly'::text THEN (((EXTRACT(year FROM recurring_transactions.end_date) - EXTRACT(year FROM recurring_transactions.start_date)) + (1)::numeric))::integer
                    WHEN 'biweekly'::text THEN (((recurring_transactions.end_date - recurring_transactions.start_date) / 14) + 1)
                    WHEN 'weekly'::text THEN (((recurring_transactions.end_date - recurring_transactions.start_date) / 7) + 1)
                    ELSE NULL::integer
                END AS total_periods
           FROM public.recurring_transactions
          WHERE ((recurring_transactions.is_active = true) AND (recurring_transactions.type = 'Bills'::text) AND (recurring_transactions.end_date IS NOT NULL))
        ), matched AS (
         SELECT i_1.id AS installment_id,
            COALESCE(sum(t.amount), (0)::numeric) AS amount_paid,
            count(t.id) AS payments_made
           FROM (installments i_1
             LEFT JOIN public.transactions t ON (((t.payee = i_1.payee) AND (t.category = i_1.category) AND (t.amount = i_1.payment_amount) AND ((t.transaction_date >= i_1.start_date) AND (t.transaction_date <= i_1.end_date)) AND (t.type = 'Bills'::text))))
          GROUP BY i_1.id
        )
 SELECT i.id,
    i.name,
    i.payee,
    i.category,
    i.account,
    i.frequency,
    i.start_date,
    i.end_date,
    i.payment_amount,
    i.total_periods,
    (i.payment_amount * (i.total_periods)::numeric) AS target_amount,
    m.amount_paid,
    m.payments_made,
    ((i.payment_amount * (i.total_periods)::numeric) - m.amount_paid) AS amount_remaining,
        CASE
            WHEN ((i.payment_amount * (i.total_periods)::numeric) > (0)::numeric) THEN (m.amount_paid / (i.payment_amount * (i.total_periods)::numeric))
            ELSE (0)::numeric
        END AS pct_paid,
    GREATEST((0)::numeric, LEAST((1)::numeric, (((CURRENT_DATE - i.start_date))::numeric / (NULLIF((i.end_date - i.start_date), 0))::numeric))) AS pct_time_elapsed
   FROM (installments i
     JOIN matched m ON ((m.installment_id = i.id)))
  ORDER BY i.end_date;

COMMIT;