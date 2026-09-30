-- Migration: 2026-09-28-credit-cards.sql
-- Adds a dedicated credit_cards table plus a summary view that joins each
-- card to its current-month activity (via the existing free-text
-- transactions.account column, same join key spending_by_account already uses).
--
-- "current_balance" here means "this card's Spending + Bills activity so far
-- this month", matching the semantics of the existing spending_by_account
-- view. It is NOT a true statement balance (it won't reflect balances carried
-- from prior months or payments made). That's a reasonable v1 approximation
-- given the app doesn't currently model card payoffs as a distinct event.

-- ===== Table =====

CREATE TABLE public.credit_cards (
    id integer NOT NULL,
    account_name text NOT NULL,          -- must match the "account" value used on transactions
    issuer text,                         -- e.g. 'Chase', 'Amex'
    last_four text,
    credit_limit numeric(10,2),
    statement_day integer,               -- day-of-month the statement closes (1-31)
    due_day integer,                     -- day-of-month payment is due (1-31)
    apr numeric(5,2),                    -- annual percentage rate, e.g. 24.99
    annual_fee numeric(10,2) DEFAULT 0,
    opened_date date,                    -- drives "age of card"
    reward_type text DEFAULT 'cashback', -- 'cashback' | 'points' | 'miles'
    reward_rates jsonb DEFAULT '{}'::jsonb, -- e.g. {"dining": 3, "groceries": 2, "default": 1}
    is_active boolean DEFAULT true,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT credit_cards_reward_type_check
        CHECK (reward_type = ANY (ARRAY['cashback'::text, 'points'::text, 'miles'::text])),
    CONSTRAINT credit_cards_statement_day_check
        CHECK (statement_day IS NULL OR (statement_day BETWEEN 1 AND 31)),
    CONSTRAINT credit_cards_due_day_check
        CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
    CONSTRAINT credit_cards_credit_limit_check
        CHECK (credit_limit IS NULL OR credit_limit >= 0)
);

ALTER TABLE public.credit_cards OWNER TO finance;

COMMENT ON TABLE public.credit_cards IS 'One row per physical credit card, keyed by the free-text account name used in transactions.account';

CREATE SEQUENCE public.credit_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.credit_cards_id_seq OWNER TO finance;
ALTER SEQUENCE public.credit_cards_id_seq OWNED BY public.credit_cards.id;
ALTER TABLE ONLY public.credit_cards ALTER COLUMN id SET DEFAULT nextval('public.credit_cards_id_seq'::regclass);

ALTER TABLE ONLY public.credit_cards
    ADD CONSTRAINT credit_cards_pkey PRIMARY KEY (id);

-- One card row per account name (case-insensitive) — mirrors the free-text
-- account field being the join key everywhere else in the schema.
CREATE UNIQUE INDEX credit_cards_unique_account_name
    ON public.credit_cards USING btree (lower(account_name));

CREATE INDEX idx_credit_cards_active ON public.credit_cards USING btree (is_active);

-- ===== updated_at trigger (generic — reusable if other tables want it later) =====

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.set_updated_at() OWNER TO finance;

CREATE TRIGGER credit_cards_set_updated_at
    BEFORE UPDATE ON public.credit_cards
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== Summary view =====
-- Joins each card to its current-month Spending+Bills activity on the
-- matching account name (case-insensitive) and derives utilization/available
-- credit. Due-date/age math is left to the API layer (JS Date handling is
-- less error-prone than SQL for "next occurrence of day-of-month" logic).

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
    c.is_active,
    c.notes,
    c.created_at,
    c.updated_at,
    COALESCE(bal.current_balance, 0) AS current_balance,
    CASE
        WHEN c.credit_limit > 0 THEN COALESCE(bal.current_balance, 0) / c.credit_limit
        ELSE NULL
    END AS utilization_pct,
    CASE
        WHEN c.credit_limit > 0 THEN c.credit_limit - COALESCE(bal.current_balance, 0)
        ELSE NULL
    END AS available_credit,
    (CURRENT_DATE - c.opened_date) AS age_days
   FROM (public.credit_cards c
     LEFT JOIN (
        SELECT
            transactions.account,
            SUM(transactions.amount) AS current_balance
        FROM public.transactions
        WHERE transactions.type IN ('Spending', 'Bills')
          AND transactions.month = date_trunc('month', CURRENT_DATE)::date
        GROUP BY transactions.account
     ) bal ON (lower(bal.account) = lower(c.account_name)))
  ORDER BY c.is_active DESC, c.account_name;

ALTER VIEW public.credit_card_summary OWNER TO finance;
