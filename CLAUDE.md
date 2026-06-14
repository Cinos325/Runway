# Runway

Self-hosted personal finance tracker. Junior DevOps / platform portfolio project.

## Stack
- Postgres 16 (data)
- Express / Node.js 18+ (API, serves the frontend statically too)
- Vanilla HTML / CSS / JS — no build step
- Metabase (dashboards) + pgAdmin (admin) alongside
- Everything in Docker Compose, deployed via Komodo on a home Linux server
- iOS PWA support (manifest, apple-touch-icon, status-bar meta)
- GitHub Actions CI runs ESLint + `docker compose config` validation on push

## Containers
- `finance-postgres` — Postgres 16, external volume so it survives compose-down
- `finance-mobile-api` — Express server (port 3002 host, 3000 container)
- `finance-metabase` — port 3001
- `finance-pgadmin` — port 8082

Inter-container DNS uses Docker service names.

## Database schema essentials
- `transactions` — id, transaction_date, month (auto-derived), type, payee, category, amount, account, description, **recurring_id** (FK to recurring_transactions, nullable, ON DELETE SET NULL), created_at
- `recurring_transactions` — templates with frequency, day_of_month, start_date, end_date, is_active
- `budget_config` — single-row baseline value
- `savings_goals` — id, name, target_amount, match_category, is_active, completed_at, notes
- `spending_power` (view) — `baseline + income + goal_releases − planned − spending − adhoc_obligations`
- `installment_progress` (view) — auto-detects from recurring **Bills** with end_date
- `savings_plan_progress` (view) — **deprecated, unused.** No endpoints reference it. Retained for easier feature restoration if "saving plans with deadlines" ever returns; safe to drop in a future cleanup if not.
- `savings_goal_progress` (view) — for open-ended goals in savings_goals table

### `recurring_id` semantics
Auto-generated transactions (from the cron-driven `generate_monthly_recurring_transactions()` function) carry `recurring_id` pointing back to their source template. Manually-logged transactions have `recurring_id = NULL`. This drives the `adhoc_obligations` subquery in `spending_power`: manual Bills/Savings transactions are subtracted (since they weren't projected via `planned`), recurring-linked ones are not (already accounted for).

### `spending_power` formula
baseline (manually-set by user, "checking after last month cleared")
- current_month_income (sum of this month's Income transactions)
- current_month_goal_releases (sum of this month's GoalRelease transactions)
- planned_payments_total (active recurring Bills/Savings/Income projected for this month)
- current_month_spending (sum of this month's Spending transactions)
- current_month_adhoc_obligations (this month's Bills/Savings with recurring_id IS NULL)

The `adhoc_obligations` term was added in stage 3 of the v1.1 redesign. Before that, manual Bills/Savings transactions (e.g., ad-hoc savings toward an open goal, surprise bills) silently overstated spending power. Baseline-setting rule: set it when checking is settled, before any ad-hoc obligations happen that month. Don't lower the baseline to compensate for ad-hoc transactions — the view subtracts them automatically.

## Transaction types
- `Spending`, `Income`, `Bills`, `Transfer`, `Savings` — user-creatable
- `GoalRelease` — system-only, created when an open goal is completed; positive amount that adds to spending power, offsetting the matching purchase

## UI architecture
Bottom nav (4 tabs): Home / Add / Plan / More

- **Persistent header** above all tabs: "Runway" wordmark + month name on top row, large spending power number centered, runway bar with days-of-runway status text underneath. Tap spending power to expand a detailed breakdown.
- **Home**: Recent (5 most recent transactions), Top categories this month (top 5 Spending categories), Goals card (Installments and Open goals).
- **Add**: Single-instance transactions only. A simple form — type, date, amount, category, description, payee, account — that POSTs to `/api/transactions`. Edit mode is triggered by swipe/tap on a transaction elsewhere in the app.
- **Plan**: Recurring-transaction management. Top of tab has a four-button picker (Subscription / Recurring / Installment / Open goal), each opens a preconfigured modal. Below the picker, the existing recurring templates are listed with type filter chips (All / Bills / Savings / Spending) and inline edit/pause/delete actions.
- **More** (two sub-tabs: History / Settings): full transaction history with type+category filters, baseline edit + theme + tool links.

### Plan-tab picker behavior
Each picker button opens the recurring modal preconfigured via `applyPlanTypeToForm(planType)`:

- **Subscription** — type=Spending (field hidden), category prefilled "Sub" (editable), no end date, pay-today defaults ON. Name auto-derives from payee.
- **Recurring** — type=Bills default (user-selectable), no end date, pay-today OFF. Name auto-derives from payee. Catch-all for fresh recurring Bills/Savings/Spending.
- **Installment** — type=Bills (locked/disabled), end-date required via number-of-payments. Amount field repurposed: user enters TOTAL purchase price, per-payment is computed and shown read-only below; save handler divides before POST. Pay-today hidden (installments start next period).
- **Open goal** — branches to the separate `#goalModal`, since open goals live in the `savings_goals` table, not `recurring_transactions`.

Edit mode (clicking an existing recurring entry in the list) does NOT apply a plan type — all fields are shown, no field-locking or installment-total UX. Edits are expected to be rare and power-user.

## Key files
- `public/index.html` — single-page app shell with all tabs and modals inline (~530 lines)
- `public/app.js` — all client logic (~1900 lines, sections marked with `// =====` banner comments)
- `public/styles.css` — all styling, uses CSS custom properties for theming (light/dark/auto) (~2000 lines)
- `server.js` — Express API, ~700 lines
- `migrations/*.sql` — versioned SQL migrations, run manually in pgAdmin
- `Dockerfile` + `docker-compose.yml` + `docker-compose.unified.yml` — container setup
- `.github/workflows/ci.yml` — lint and validation pipeline

## ID naming conventions in JS/HTML
- `rec*` prefix — recurring modal fields (form view only since v1.1 stage 6; old list view was removed)
- `plan*` prefix — Plan tab elements (planRecurringList, planTypeChips, plan-type-picker, plan-type-btn)
- `more*` prefix — More tab elements
- `goal*` prefix — open-goal modal
- `ph*` prefix — persistent header elements

## Important workflows

### Recurring transaction generation
External cron job (lives outside the repo) calls `generate_monthly_recurring_transactions()` at end of month. The function inserts a `transactions` row for each active recurring template, including `recurring_id` so the new row is linked back. Templates are never modified by the job other than their `last_generated` field. Editing or deleting a template doesn't retroactively change past months (ON DELETE SET NULL preserves historical transactions as orphans).

### Spending-power refresh
Runs every 30 seconds on a setInterval, also after any add/edit/delete. The view recomputes from primary data on every read — no caching, no triggers.

### First-payment-today flow
When creating a recurring entry with "Also record today's payment" enabled, the POST handler does two inserts in sequence within the same request: the recurring template, then a transactions row with `recurring_id` set to the new template's id. This way, the today-payment counts as recurring-linked (not ad-hoc) for spending-power purposes.

### Open-goal completion
`POST /api/goals/:id/complete` atomically creates a GoalRelease transaction, marks the goal as completed, and (if there's a matching active recurring entry) deactivates it.

## Commands
- `docker compose up -d --build finance-mobile-api` — rebuild after server.js changes
- For `public/app.js`, `public/index.html`, and `public/styles.css` changes, hard-refresh in browser (volume-mounted, no rebuild needed)
- `node -c public/app.js && node -c server.js` — syntax check
- ESLint: `npx eslint --config eslint.config.mjs public/app.js server.js`
- SQL migrations: open in pgAdmin Query Tool, paste, execute

## Design conventions
- Comments explain *why*, not *what*
- Cards have consistent style: `var(--bg-card)` background, 12px radius, `var(--shadow-card)`
- Type-aware coloring: incoming amounts (Income, GoalRelease) green-ish; outgoing (Spending, Bills, Savings) red-ish; Transfer neutral
- The runway bar uses a single accent color regardless of state — color-escalation (red/amber) was rejected as stress-inducing
- All forms use `autocomplete="off"` to suppress browser autofill in favor of in-app autocomplete
- Filter-chip pattern: `.history-filter-chips` container + `.filter-chip` buttons, reused on More→History and Plan tab

## Known limitations / future work

### v1.1 cleanup deferred items
- `savings_plan_progress` DB view remains in place but unused — drop if confident the feature won't return
- Installment edit mode shows per-payment in the Amount field, not the total — minor inconsistency with create mode; intentional for now

### v1.2 candidates
- **Volatile-subs tracking** — a lightweight watchlist for subscriptions paid ad-hoc month-to-month (e.g., Patreon creators where you decide each month whether to continue). Distinct from the recurring template model; would need its own table and Plan-tab section.
- **Type-aware autofill on the Recurring button** — e.g., switching type to Income suggests category "Salary"

### Standing limitations
- No authentication — intended for trusted home network only
- No automated tests (CI only does syntax/lint/build validation)
- No automated database backups
- Cron-based recurring generation is invisible to the app — planned move to a worker container
- "Recent" endpoint on More → History caps at 50 results, no pagination

## Things the app deliberately does NOT do
- Track per-account balances — spending power is one global pool
- Reconcile against real bank data — manual entry only
- Forecast beyond current month — runway bar extends only to month-end
- Auto-categorize transactions — categories are free-text, autocomplete from history