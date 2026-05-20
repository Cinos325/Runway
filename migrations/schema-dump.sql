--
-- Name: generate_recurring_transactions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_recurring_transactions() RETURNS TABLE(transactions_created integer, details text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  rec RECORD;
  current_month_date DATE;
  new_transaction_date DATE;
  transaction_count INTEGER := 0;
  detail_text TEXT := '';
BEGIN
  -- Target month is always the current month
  current_month_date := date_trunc('month', CURRENT_DATE)::date;

  -- Loop through active recurring transactions
  FOR rec IN
    SELECT *
    FROM recurring_transactions
    WHERE is_active = true
      AND start_date <= current_month_date
      AND (end_date IS NULL OR end_date >= current_month_date)
  LOOP
    -- Calculate transaction date based on frequency
    IF rec.frequency = 'monthly' THEN
      new_transaction_date :=
        current_month_date + (rec.day_of_month - 1);

    ELSIF rec.frequency = 'biweekly' THEN
      -- First occurrence in the month
      new_transaction_date :=
        current_month_date + (rec.day_of_month - 1);

      -- (Optional: second biweekly occurrence would go here later)

    ELSIF rec.frequency = 'yearly' THEN
      new_transaction_date :=
        rec.start_date
        + (EXTRACT(YEAR FROM current_month_date)
           - EXTRACT(YEAR FROM rec.start_date))::INTEGER * INTERVAL '1 year';

    ELSE
      CONTINUE;
    END IF;

    -- Only generate once per month
    IF rec.last_generated IS NULL
       OR rec.last_generated < current_month_date THEN

      INSERT INTO transactions (
        transaction_date,
        month,
        type,
        payee,
        category,
        amount,
        account,
        description
      ) VALUES (
        new_transaction_date,
        current_month_date,
        rec.type,
        rec.payee,
        rec.category,
        rec.amount,
        rec.account,
        COALESCE(rec.description, '')
          || ' (auto-generated from: '
          || rec.name
          || ')'
      );

      -- Mark as generated for this month
      UPDATE recurring_transactions
      SET last_generated = current_month_date,
          updated_at = now()
      WHERE id = rec.id;

      transaction_count := transaction_count + 1;
      detail_text := detail_text || rec.name || ', ';
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT
    transaction_count,
    TRIM(TRAILING ', ' FROM detail_text);
END;
$$;


--
-- Name: initialize_current_month_checklist(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.initialize_current_month_checklist() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_month_date DATE;
    previous_month_date DATE;
BEGIN
    -- Current month (target)
    current_month_date := date_trunc('month', CURRENT_DATE)::date;

    -- Previous month (source)
    previous_month_date := (current_month_date - interval '1 month')::date;

    -- If current month already exists, do nothing
    IF EXISTS (
        SELECT 1
        FROM payment_checklist
        WHERE month = current_month_date
    ) THEN
        RAISE NOTICE 'Checklist for % already exists. Skipping.', current_month_date;
        RETURN;
    END IF;

    -- Copy from previous month
    INSERT INTO payment_checklist (
        month,
        item_name,
        category,
        planned_amount,
        due_date,
        priority,
        account_paid_from,
        notes
    )
    SELECT
        current_month_date,
        item_name,
        category,
        CASE
            WHEN category IN ('Savings', 'Bills', 'Investment') THEN planned_amount
            ELSE 0
        END,
        CASE
            WHEN due_date IS NOT NULL THEN
                current_month_date + (due_date - previous_month_date)
            ELSE NULL
        END,
        priority,
        account_paid_from,
        CASE
            WHEN category = 'Credit Card' THEN 'Amount needs to be updated'
            ELSE 'Auto-generated from previous month'
        END
    FROM payment_checklist
    WHERE month = previous_month_date;

    RAISE NOTICE 'Initialized % items for %',
        (SELECT COUNT(*) FROM payment_checklist WHERE month = current_month_date),
        current_month_date;
END;
$$;


--
-- Name: run_monthly_rollover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_monthly_rollover() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_month_date DATE;
  checklist_count INTEGER;
  transaction_count INTEGER;
  transaction_details TEXT;
BEGIN
  current_month_date := date_trunc('month', CURRENT_DATE)::date;

  RAISE NOTICE 'Starting monthly rollover for %', current_month_date;

  /*
   * 1. Initialize payment checklist for the current month
   */
  PERFORM public.initialize_current_month_checklist();

  /*
   * 2. Generate recurring transactions for the current month
   */
  SELECT
    transactions_created,
    details
  INTO
    transaction_count,
    transaction_details
  FROM public.generate_recurring_transactions();

  /*
   * 3. Summary
   */
  RAISE NOTICE 'Monthly rollover complete for %', current_month_date;
  RAISE NOTICE 'Recurring transactions created: %', transaction_count;

  IF transaction_details IS NOT NULL AND transaction_details <> '' THEN
    RAISE NOTICE 'Transactions generated from: %', transaction_details;
  END IF;
END;
$$;


--
-- Name: set_payment_defaults(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_payment_defaults() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- When marking as paid, auto-populate fields if not already set
    IF NEW.paid = true AND OLD.paid = false THEN
        -- Set actual_amount to planned_amount if not provided
        IF NEW.actual_amount IS NULL THEN
            NEW.actual_amount := NEW.planned_amount;
        END IF;
        
        -- Set paid_date to today if not provided
        IF NEW.paid_date IS NULL THEN
            NEW.paid_date := CURRENT_DATE;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    transaction_date date NOT NULL,
    month date DEFAULT date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone) NOT NULL,
    type text DEFAULT 'Spending'::text,
    payee text NOT NULL,
    category text,
    amount numeric(10,2) NOT NULL,
    account text DEFAULT 'Paypal'::text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    description text,
    CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['Income'::text, 'Spending'::text, 'Transfer'::text, 'Savings'::text, 'Bills'::text])))
);


--
-- Name: active_subscriptions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_subscriptions AS
 SELECT payee,
    max(transaction_date) AS last_payment,
    count(*) AS total_payments,
    sum(amount) AS total_spent,
    avg(amount) AS typical_amount,
    (CURRENT_DATE - max(transaction_date)) AS days_since_last_payment
   FROM public.transactions
  WHERE (category = 'Sub'::text)
  GROUP BY payee
 HAVING (max(transaction_date) >= (CURRENT_DATE - '60 days'::interval))
  ORDER BY (max(transaction_date)) DESC;


--
-- Name: bills_paid_by_category; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.bills_paid_by_category AS
 SELECT category,
    count(*) AS payment_count,
    sum(amount) AS total_paid,
    avg(amount) AS average_payment,
    min(transaction_date) AS first_payment,
    max(transaction_date) AS last_payment
   FROM public.transactions
  WHERE (type = 'Bills'::text)
  GROUP BY category
  ORDER BY (sum(amount)) DESC;


--
-- Name: budget_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_config (
    id integer NOT NULL,
    baseline numeric DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE budget_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.budget_config IS 'Stores monthly budget configuration - currently just baseline cash amount';


--
-- Name: budget_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.budget_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: budget_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.budget_config_id_seq OWNED BY public.budget_config.id;


--
-- Name: category_spending_with_top_items; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.category_spending_with_top_items AS
 SELECT category,
    count(*) AS total_transactions,
    sum(amount) AS total_spent,
    ( SELECT string_agg((((top_items.description || ' ($'::text) || top_items.amount) || ')'::text), ', '::text) AS string_agg
           FROM ( SELECT t2.description,
                    t2.amount
                   FROM public.transactions t2
                  WHERE ((t2.category = t1.category) AND (t2.description IS NOT NULL) AND (t2.type = 'Spending'::text))
                  ORDER BY t2.amount DESC
                 LIMIT 3) top_items) AS top_3_purchases
   FROM public.transactions t1
  WHERE (type = 'Spending'::text)
  GROUP BY category
  ORDER BY (sum(amount)) DESC;


--
-- Name: payment_checklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_checklist (
    id integer NOT NULL,
    month date NOT NULL,
    item_name text NOT NULL,
    category text NOT NULL,
    planned_amount numeric(10,2) NOT NULL,
    due_date date,
    priority integer DEFAULT 1,
    paid boolean DEFAULT false,
    paid_date date,
    actual_amount numeric(10,2),
    account_paid_from text DEFAULT 'Truist'::text,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: current_month_payment_checklist; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_month_payment_checklist AS
 SELECT id,
    month,
    item_name,
    category,
    planned_amount,
    due_date,
    priority,
    paid,
    paid_date,
    actual_amount,
    account_paid_from,
    notes,
        CASE
            WHEN paid THEN 0
            WHEN (due_date < CURRENT_DATE) THEN '-1'::integer
            ELSE 1
        END AS status_order
   FROM public.payment_checklist
  WHERE (month = ( SELECT COALESCE(( SELECT payment_checklist_1.month
                   FROM public.payment_checklist payment_checklist_1
                  WHERE (payment_checklist_1.paid = false)
                  ORDER BY payment_checklist_1.month
                 LIMIT 1), (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date) AS "coalesce"))
  ORDER BY
        CASE
            WHEN paid THEN 0
            WHEN (due_date < CURRENT_DATE) THEN '-1'::integer
            ELSE 1
        END, priority, due_date;


--
-- Name: income_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.income_summary AS
 SELECT 'Total Income (All Time)'::text AS metric,
    sum(transactions.amount) AS value
   FROM public.transactions
  WHERE (transactions.type = 'Income'::text)
UNION ALL
 SELECT 'Last 12 Months Income'::text AS metric,
    sum(transactions.amount) AS value
   FROM public.transactions
  WHERE ((transactions.type = 'Income'::text) AND (transactions.transaction_date >= (CURRENT_DATE - '1 year'::interval)))
UNION ALL
 SELECT 'YTD Income'::text AS metric,
    sum(transactions.amount) AS value
   FROM public.transactions
  WHERE ((transactions.type = 'Income'::text) AND (EXTRACT(year FROM transactions.transaction_date) = EXTRACT(year FROM CURRENT_DATE)))
UNION ALL
 SELECT 'This Month Income'::text AS metric,
    sum(transactions.amount) AS value
   FROM public.transactions
  WHERE ((transactions.type = 'Income'::text) AND (transactions.month = (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone))::date))
UNION ALL
 SELECT 'Average Monthly Income'::text AS metric,
    round(avg(monthly_totals.monthly_income), 2) AS value
   FROM ( SELECT transactions.month,
            sum(transactions.amount) AS monthly_income
           FROM public.transactions
          WHERE (transactions.type = 'Income'::text)
          GROUP BY transactions.month) monthly_totals;


--
-- Name: recurring_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_transactions (
    id integer NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'Spending'::text NOT NULL,
    payee text NOT NULL,
    category text,
    amount numeric(10,2) NOT NULL,
    account text DEFAULT 'Paypal'::text,
    description text,
    frequency text NOT NULL,
    day_of_month integer,
    start_date date NOT NULL,
    end_date date,
    is_active boolean DEFAULT true,
    last_generated date,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT recurring_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT recurring_type_check CHECK ((type = ANY (ARRAY['Bills'::text, 'Income'::text, 'Savings'::text, 'Spending'::text])))
);


--
-- Name: installment_progress; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.installment_progress AS
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
          WHERE ((recurring_transactions.is_active = true) AND (recurring_transactions.type = 'Spending'::text) AND (recurring_transactions.end_date IS NOT NULL))
        ), matched AS (
         SELECT i_1.id AS installment_id,
            COALESCE(sum(t.amount), (0)::numeric) AS amount_paid,
            count(t.id) AS payments_made
           FROM (installments i_1
             LEFT JOIN public.transactions t ON (((t.payee = i_1.payee) AND (t.category = i_1.category) AND (t.amount = i_1.payment_amount) AND ((t.transaction_date >= i_1.start_date) AND (t.transaction_date <= i_1.end_date)) AND (t.type = 'Spending'::text))))
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


--
-- Name: monthly_totals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_totals AS
 SELECT month,
    sum(
        CASE
            WHEN (type = 'Spending'::text) THEN amount
            ELSE (0)::numeric
        END) AS spending,
    sum(
        CASE
            WHEN (type = 'Bills'::text) THEN amount
            ELSE (0)::numeric
        END) AS bills,
    sum(
        CASE
            WHEN (type = 'Savings'::text) THEN amount
            ELSE (0)::numeric
        END) AS savings,
    sum(
        CASE
            WHEN (type = 'Income'::text) THEN amount
            ELSE (0)::numeric
        END) AS income
   FROM public.transactions
  GROUP BY month
  ORDER BY month DESC;


--
-- Name: payment_checklist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_checklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_checklist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_checklist_id_seq OWNED BY public.payment_checklist.id;


--
-- Name: recurring_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recurring_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recurring_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recurring_transactions_id_seq OWNED BY public.recurring_transactions.id;


--
-- Name: savings_goal_progress; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.savings_goal_progress AS
SELECT
    NULL::integer AS id,
    NULL::text AS name,
    NULL::numeric(10,2) AS target_amount,
    NULL::text AS match_category,
    NULL::text AS notes,
    NULL::timestamp without time zone AS created_at,
    NULL::date AS completed_at,
    NULL::numeric AS amount_saved,
    NULL::numeric AS amount_remaining,
    NULL::numeric AS pct_saved,
    NULL::bigint AS contribution_count;


--
-- Name: savings_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.savings_goals (
    id integer NOT NULL,
    name text NOT NULL,
    target_amount numeric(10,2) NOT NULL,
    match_category text NOT NULL,
    is_active boolean DEFAULT true,
    completed_at date,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT savings_goals_target_amount_check CHECK ((target_amount > (0)::numeric))
);


--
-- Name: savings_goals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.savings_goals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: savings_goals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.savings_goals_id_seq OWNED BY public.savings_goals.id;


--
-- Name: savings_plan_progress; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.savings_plan_progress AS
 WITH plans AS (
         SELECT recurring_transactions.id,
            recurring_transactions.name,
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
          WHERE ((recurring_transactions.is_active = true) AND (recurring_transactions.type = 'Savings'::text) AND (recurring_transactions.end_date IS NOT NULL))
        ), matched AS (
         SELECT p_1.id AS plan_id,
            (COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'Savings'::text)), (0)::numeric) - COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'GoalRelease'::text)), (0)::numeric)) AS amount_saved,
            count(t.id) FILTER (WHERE (t.type = 'Savings'::text)) AS payments_made
           FROM (plans p_1
             LEFT JOIN public.transactions t ON (((t.category = p_1.category) AND (t.amount = p_1.payment_amount) AND ((t.transaction_date >= p_1.start_date) AND (t.transaction_date <= p_1.end_date)) AND (t.type = ANY (ARRAY['Savings'::text, 'GoalRelease'::text])))))
          GROUP BY p_1.id
        )
 SELECT p.id,
    p.name,
    p.payee,
    p.category,
    p.account,
    p.frequency,
    p.start_date,
    p.end_date,
    p.payment_amount,
    p.total_periods,
    (p.payment_amount * (p.total_periods)::numeric) AS target_amount,
    m.amount_saved,
    m.payments_made,
    ((p.payment_amount * (p.total_periods)::numeric) - m.amount_saved) AS amount_remaining,
        CASE
            WHEN ((p.payment_amount * (p.total_periods)::numeric) > (0)::numeric) THEN GREATEST((0)::numeric, LEAST((1)::numeric, (m.amount_saved / (p.payment_amount * (p.total_periods)::numeric))))
            ELSE (0)::numeric
        END AS pct_saved
   FROM (plans p
     JOIN matched m ON ((m.plan_id = p.id)))
  ORDER BY p.end_date;


--
-- Name: spending_by_category_total; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.spending_by_category_total AS
 SELECT category,
    count(*) AS transaction_count,
    sum(amount) AS total_spent,
    avg(amount) AS average_transaction,
    min(transaction_date) AS first_purchase,
    max(transaction_date) AS last_purchase
   FROM public.transactions
  WHERE (type = 'Spending'::text)
  GROUP BY category
  ORDER BY (sum(amount)) DESC;


--
-- Name: spending_power; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.spending_power AS
 SELECT (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date AS current_month,
    ((((COALESCE(bc.baseline, (0)::numeric) + COALESCE(income.total, (0)::numeric)) + COALESCE(releases.total, (0)::numeric)) - COALESCE(planned.total, (0)::numeric)) - COALESCE(spending.total, (0)::numeric)) AS spending_power,
    COALESCE(bc.baseline, (0)::numeric) AS baseline,
    COALESCE(income.total, (0)::numeric) AS current_month_income,
    COALESCE(planned.total, (0)::numeric) AS planned_payments_total,
    COALESCE(spending.total, (0)::numeric) AS current_month_spending,
    COALESCE(releases.total, (0)::numeric) AS current_month_goal_releases
   FROM ((((public.budget_config bc
     CROSS JOIN ( SELECT COALESCE(sum(transactions.amount), (0)::numeric) AS total
           FROM public.transactions
          WHERE ((transactions.month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date) AND (transactions.type = 'Income'::text))) income)
     CROSS JOIN ( SELECT COALESCE(sum(transactions.amount), (0)::numeric) AS total
           FROM public.transactions
          WHERE ((transactions.month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date) AND (transactions.type = 'GoalRelease'::text))) releases)
     CROSS JOIN ( SELECT COALESCE(sum(recurring_transactions.amount), (0)::numeric) AS total
           FROM public.recurring_transactions
          WHERE ((recurring_transactions.is_active = true) AND (recurring_transactions.type <> 'Spending'::text) AND (recurring_transactions.start_date < ((date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)) + '1 mon'::interval))::date) AND ((recurring_transactions.end_date IS NULL) OR (recurring_transactions.end_date >= (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date)))) planned)
     CROSS JOIN ( SELECT COALESCE(sum(transactions.amount), (0)::numeric) AS total
           FROM public.transactions
          WHERE ((transactions.month = (date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'::text)))::date) AND (transactions.type = 'Spending'::text))) spending);


--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- Name: budget_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_config ALTER COLUMN id SET DEFAULT nextval('public.budget_config_id_seq'::regclass);


--
-- Name: payment_checklist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checklist ALTER COLUMN id SET DEFAULT nextval('public.payment_checklist_id_seq'::regclass);


--
-- Name: recurring_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_transactions ALTER COLUMN id SET DEFAULT nextval('public.recurring_transactions_id_seq'::regclass);


--
-- Name: savings_goals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals ALTER COLUMN id SET DEFAULT nextval('public.savings_goals_id_seq'::regclass);


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- Name: budget_config budget_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_config
    ADD CONSTRAINT budget_config_pkey PRIMARY KEY (id);


--
-- Name: payment_checklist payment_checklist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checklist
    ADD CONSTRAINT payment_checklist_pkey PRIMARY KEY (id);


--
-- Name: recurring_transactions recurring_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_transactions
    ADD CONSTRAINT recurring_transactions_pkey PRIMARY KEY (id);


--
-- Name: savings_goals savings_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_goals
    ADD CONSTRAINT savings_goals_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: idx_payment_checklist_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_checklist_month ON public.payment_checklist USING btree (month);


--
-- Name: idx_recurring_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_active ON public.recurring_transactions USING btree (is_active, last_generated);


--
-- Name: idx_savings_goals_match_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_savings_goals_match_category ON public.savings_goals USING btree (match_category) WHERE (is_active = true);


--
-- Name: idx_transactions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_account ON public.transactions USING btree (account);


--
-- Name: idx_transactions_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_category ON public.transactions USING btree (category);


--
-- Name: idx_transactions_created_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_created_at_desc ON public.transactions USING btree (created_at DESC);


--
-- Name: idx_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_date ON public.transactions USING btree (transaction_date);


--
-- Name: idx_transactions_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_month ON public.transactions USING btree (month);


--
-- Name: idx_transactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_type ON public.transactions USING btree (type);


--
-- Name: payment_checklist_unique_month_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_checklist_unique_month_item ON public.payment_checklist USING btree (month, item_name);


--
-- Name: transactions_unique_auto_generated; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_unique_auto_generated ON public.transactions USING btree (month, payee, amount, account) WHERE (description ~~ '%auto-generated%'::text);


--
-- Name: savings_goal_progress _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.savings_goal_progress AS
 SELECT g.id,
    g.name,
    g.target_amount,
    g.match_category,
    g.notes,
    g.created_at,
    g.completed_at,
    (COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'Savings'::text)), (0)::numeric) - COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'GoalRelease'::text)), (0)::numeric)) AS amount_saved,
    GREATEST((0)::numeric, (g.target_amount - (COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'Savings'::text)), (0)::numeric) - COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'GoalRelease'::text)), (0)::numeric)))) AS amount_remaining,
        CASE
            WHEN (g.target_amount > (0)::numeric) THEN LEAST((1)::numeric, GREATEST((0)::numeric, ((COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'Savings'::text)), (0)::numeric) - COALESCE(sum(t.amount) FILTER (WHERE (t.type = 'GoalRelease'::text)), (0)::numeric)) / g.target_amount)))
            ELSE (0)::numeric
        END AS pct_saved,
    count(t.id) FILTER (WHERE (t.type = 'Savings'::text)) AS contribution_count
   FROM (public.savings_goals g
     LEFT JOIN public.transactions t ON (((t.category = g.match_category) AND (t.type = ANY (ARRAY['Savings'::text, 'GoalRelease'::text])) AND (t.transaction_date >= (g.created_at)::date) AND ((g.completed_at IS NULL) OR (t.transaction_date <= g.completed_at)))))
  WHERE (g.is_active = true)
  GROUP BY g.id
  ORDER BY g.created_at DESC;


--
-- Name: payment_checklist auto_set_payment_defaults; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_set_payment_defaults BEFORE UPDATE ON public.payment_checklist FOR EACH ROW EXECUTE FUNCTION public.set_payment_defaults();

