-- Migration: 2026-09-30-credit-cards-v2-fixup.sql
--
-- Your database currently has ONLY the v1 `credit_cards` table (no
-- opening_balance/balance_as_of columns, no credit_card_payments table, no
-- credit_card_summary view). This script is safe to run on top of that —
-- it uses IF NOT EXISTS / OR REPLACE everywhere so it won't error or
-- clobber any card rows you've already added.
--
-- After this runs, GET /api/credit-cards will work (it queries
-- credit_card_summary, which this script creates).

-- ===== 1. Add missing columns to credit_cards =====

ALTER TABLE public.credit_cards
    ADD COLUMN IF NOT EXISTS opening_balance numeric(10,2) DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS balance_as_of date DEFAULT CURRENT_DATE NOT NULL;

COMMENT ON COLUMN public.credit_cards.opening_balance IS 'Balance owed as of balance_as_of. Seed value for the running-balance ledger.';
COMMENT ON COLUMN public.credit_cards.balance_as_of IS 'The date opening_balance was accurate as of.';

-- ===== 2. credit_card_payments table =====

CREATE TABLE IF NOT EXISTS public.credit_card_payments (
    id integer NOT NULL,
    credit_card_id integer NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    amount numeric(10,2) NOT NULL,
    source_account text,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT credit_card_payments_amount_check CHECK (amount > 0)
);

ALTER TABLE public.credit_card_payments OWNER TO finance;

CREATE SEQUENCE IF NOT EXISTS public.credit_card_payments_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

ALTER SEQUENCE public.credit_card_payments_id_seq OWNED BY public.credit_card_payments.id;

ALTER TABLE ONLY public.credit_card_payments
    ALTER COLUMN id SET DEFAULT nextval('public.credit_card_payments_id_seq'::regclass);

-- Add PK/FK/index only if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'credit_card_payments_pkey'
    ) THEN
        ALTER TABLE ONLY public.credit_card_payments
            ADD CONSTRAINT credit_card_payments_pkey PRIMARY KEY (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'credit_card_payments_card_fkey'
    ) THEN
        ALTER TABLE ONLY public.credit_card_payments
            ADD CONSTRAINT credit_card_payments_card_fkey
                FOREIGN KEY (credit_card_id) REFERENCES public.credit_cards(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_card_payments_card_date
    ON public.credit_card_payments USING btree (credit_card_id, payment_date DESC);

-- ===== 3. credit_card_summary view (drop/recreate — views are cheap to replace) =====

DROP VIEW IF EXISTS public.credit_card_summary;

CREATE VIEW public.credit_card_summary AS
 SELECT
    c.id,
    c.account_name,
    c.issuer,
    c.last_four,
    c.credit_limit,
    c.statement_day,
    c.due_day,
    c.apr,
    c.annual_fee,
    c.opened_date,
    c.reward_type,
    c.reward_rates,
    c.opening_balance,
    c.balance_as_of,
    c.is_active,
    c.notes,
    c.created_at,
    c.updated_at,
    (c.opening_balance + COALESCE(chg.total, 0) - COALESCE(pay.total_paid, 0)) AS current_balance,
    COALESCE(cm.current_month_charges, 0) AS current_month_charges,
    lastpay.last_payment_date,
    lastpay.last_payment_amount,
    CASE
        WHEN c.credit_limit > 0
        THEN (c.opening_balance + COALESCE(chg.total, 0) - COALESCE(pay.total_paid, 0)) / c.credit_limit
        ELSE NULL
    END AS utilization_pct,
    CASE
        WHEN c.credit_limit > 0
        THEN c.credit_limit - (c.opening_balance + COALESCE(chg.total, 0) - COALESCE(pay.total_paid, 0))
        ELSE NULL
    END AS available_credit
 FROM public.credit_cards c
 LEFT JOIN LATERAL (
    SELECT SUM(t.amount) AS total
    FROM public.transactions t
    WHERE lower(t.account) = lower(c.account_name)
      AND t.type IN ('Spending', 'Bills')
      AND t.transaction_date >= c.balance_as_of
 ) chg ON true
 LEFT JOIN LATERAL (
    SELECT SUM(p.amount) AS total_paid
    FROM public.credit_card_payments p
    WHERE p.credit_card_id = c.id
      AND p.payment_date >= c.balance_as_of
 ) pay ON true
 LEFT JOIN LATERAL (
    SELECT SUM(t.amount) AS current_month_charges
    FROM public.transactions t
    WHERE lower(t.account) = lower(c.account_name)
      AND t.type IN ('Spending', 'Bills')
      AND t.month = date_trunc('month', CURRENT_DATE)::date
 ) cm ON true
 LEFT JOIN LATERAL (
    SELECT p.payment_date AS last_payment_date, p.amount AS last_payment_amount
    FROM public.credit_card_payments p
    WHERE p.credit_card_id = c.id
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT 1
 ) lastpay ON true;

ALTER VIEW public.credit_card_summary OWNER TO finance;
