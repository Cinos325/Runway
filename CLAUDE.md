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
- `transactions` — id, transaction_date, month (auto-derived), type, payee, category, amount, account, description, created_at
- `recurring_transactions` — templates with frequency, day_of_month, start_date, end_date, is_active
- `budget_config` — single-row baseline value
- `savings_goals` — id, name, target_amount, match_category, is_active, completed_at, notes
- `spending_power` (view) — `baseline + income + goal_releases - planned - spending`
- `installment_progress` (view) — auto-detects from recurring Spending with end_date
- `savings_plan_progress` (view) — auto-detects from recurring Savings with end_date
- `savings_goal_progress` (view) — for open-ended goals in savings_goals table

## Transaction types
- `Spending`, `Income`, `Bills`, `Transfer`, `Savings` — user-creatable
- `GoalRelease` — system-only, created when an open goal or saving plan is completed; positive amount that adds to spending power, offsetting the matching purchase

## UI architecture
Bottom nav (3 tabs): Home / Add / More
- **Persistent header** above all tabs: "Runway" wordmark + month name on top row, large spending power number centered, runway bar with days-of-runway status text underneath. Tap spending power to expand a detailed breakdown.
- **Home**: Recent (5 most recent transactions), Top categories this month (top 5 Spending categories), Goals card (Installments / Saving plans / Open goals)
- **Add**: One transaction form with a "This repeats" toggle that reveals frequency/day-of-month/number-of-payments fields. Total-amount calculator field appears when number of payments is set.
- **More** (three sub-tabs: Recurring / History / Settings): manage recurring templates, full transaction history with type+category filters, baseline edit + theme + tool links

## Key files
- `index.html` — single-page app shell with all tabs and modals inline
- `public/app.js` — all client logic (~2200 lines, sections marked with `// =====` banner comments)
- `public/styles.css` — all styling, uses CSS custom properties for theming (light/dark/auto)
- `server.js` — Express API, ~700 lines
- `migrations/*.sql` — versioned SQL migrations, run manually in pgAdmin
- `Dockerfile` + `docker-compose.yml` + `docker-compose.unified.yml` — container setup
- `.github/workflows/ci.yml` — lint and validation pipeline

## ID naming conventions in JS/HTML
- `rec*` prefix — old recurring modal (still used for editing)
- `rep*` prefix — new Add form's repeats section
- `more*` prefix — More tab elements
- `goal*` prefix — savings goal modal
- `ph*` prefix — persistent header elements

## Important workflows
- Recurring generation: external cron job (lives outside the repo) reads `recurring_transactions` and creates `transactions` rows monthly. Planned future migration: dedicated worker container.
- Savings goal completion: `POST /api/goals/:id/complete` or `POST /api/savings-plans/:id/complete` — atomic: creates GoalRelease, deactivates matching recurring, marks goal complete (for open goals)
- Spending power refresh: runs every 30 seconds on a setInterval, also after any add/edit/delete

## Commands
- `docker compose up -d --build finance-mobile-api` — rebuild after server.js changes
- For `public/app.js` and `public/styles.css` changes, hard-refresh in browser (volume-mounted)
- `node -c public/app.js && node -c server.js` — syntax check
- ESLint: `npx eslint --config eslint.config.mjs public/app.js server.js`
- SQL migrations: open in pgAdmin Query Tool, paste, execute

## Design conventions
- Comments explain *why*, not *what*
- Cards have consistent style: `var(--bg-card)` background, 12px radius, `var(--shadow-card)`
- Type-aware coloring: incoming amounts (Income, GoalRelease) green-ish; outgoing (Spending, Bills, Savings) red-ish; Transfer neutral
- The runway bar uses a single accent color regardless of state — color-escalation (red/amber) was rejected as stress-inducing
- All forms use `autocomplete="off"` to suppress browser autofill in favor of in-app autocomplete

## Known limitations / future work
- No authentication — intended for trusted home network only
- No automated tests (CI only does syntax/lint/build validation)
- No automated database backups
- Cron-based recurring generation is invisible to the app — planned move to a worker container
- "Recent" endpoint on More → History caps at 50 results, no pagination
- A 4th "Plans" bottom-nav tab is planned to separate finite plans from one-time transaction entry; deferred from v1.0

## Things the app deliberately does NOT do
- Track per-account balances — spending power is one global pool
- Reconcile against real bank data — manual entry only
- Forecast beyond current month — runway bar extends only to month-end
- Auto-categorize transactions — categories are free-text, autocomplete from history