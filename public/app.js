const API_URL = '/api';

// Close-on-backdrop helper that doesn't fire on text-selection drags.
// The bug: a click handler treats "mousedown inside content, mouseup on backdrop"
// as a click on the backdrop (the click target is the common ancestor — the overlay).
// Fix: only close if BOTH the mousedown and mouseup landed on the overlay itself.
function closeOnBackdropClick(overlayEl, closeFn) {
    let downOnBackdrop = false;
    overlayEl.addEventListener('mousedown', (e) => {
        downOnBackdrop = (e.target === overlayEl);
    });
    overlayEl.addEventListener('mouseup', (e) => {
        if (downOnBackdrop && e.target === overlayEl) closeFn();
        downOnBackdrop = false;
    });
}

let currentType = 'Spending';
let currentBaseline = 0;  // tracked so the edit modal can pre-fill it

async function loadSpendingPower() {
    // Keep the month label in sync. Cheap, and means if the user has the app
    // open across midnight on the last day of the month, it'll update on the
    // next poll without needing a reload.
    const phMonth = document.getElementById('phMonth');
    if (phMonth) {
        phMonth.textContent = new Date().toLocaleString(undefined, { month: 'long' });
    }
    try {
        const response = await fetch(`${API_URL}/spending-power`);
        const data = await response.json();
        document.getElementById('spendingPower').textContent = parseFloat(data.spending_power).toFixed(2);
        currentBaseline = parseFloat(data.baseline) || 0;
        
        // Show a breakdown of how spending power is computed
        const breakdown = document.getElementById('breakdown');
        if (breakdown) {
            const baseline = parseFloat(data.baseline || 0).toFixed(2);
            const income = parseFloat(data.current_month_income || 0).toFixed(2);
            const planned = parseFloat(data.planned_payments_total || 0).toFixed(2);
            const spending = parseFloat(data.current_month_spending || 0).toFixed(2);
            breakdown.textContent =
                `$${baseline} baseline + $${income} income − $${planned} planned − $${spending} spent`;
        }
        
        updatePaceRing(data);
        updateRunwayBar(data);
    } catch (err) {
        console.error('Failed to load spending power:', err);
    }
}

// Update the runway bar — the visual replacement for the pace ring.
// Computes "days of runway" = spending_power / (avg daily spend so far).
// Bar fills to (days_of_runway / days_remaining_in_month), clamped 0..100%.
// Full bar means you have at least enough runway to reach month-end.
function updateRunwayBar(data) {
    const fill = document.getElementById('runwayBarFill');
    const marker = document.getElementById('runwayBarMarker');
    const statusText = document.getElementById('phStatusText');
    const statusSub = document.getElementById('phStatusSub');
    if (!fill || !statusText) return;
    
    const spendingPower = parseFloat(data.spending_power || 0);
    const spent = parseFloat(data.current_month_spending || 0);
    
    const now = new Date();
    const day = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysRemaining = Math.max(1, daysInMonth - day + 1);  // include today as "available"
    
    // Compute days of runway. If you haven't spent anything yet this month, we
    // can't project a daily rate — fall back to "X days remaining in the month."
    let daysOfRunway = null;
    let avgDaily = 0;
    if (spent > 0 && day >= 1) {
        avgDaily = spent / day;
        daysOfRunway = spendingPower / avgDaily;
    }
    
    // The marker is always at 100% (end-of-month). The fill represents how
    // much of "what you need" your runway covers.
    marker.style.left = '100%';
    
    if (daysOfRunway === null) {
        // No spending yet — bar shows full (nothing's been used), status is informational
        fill.style.width = '100%';
        statusText.textContent = 'Plenty of runway';
        statusSub.textContent = `${daysRemaining} days left in the month`;
    } else if (spendingPower <= 0) {
        fill.style.width = '0%';
        statusText.textContent = 'Out of runway';
        statusSub.textContent = `${daysRemaining} days remain at current pace`;
    } else {
        // Cap fill at 100% — overshooting end-of-month just means "all good"
        const coverage = Math.min(1, daysOfRunway / daysRemaining);
        fill.style.width = (coverage * 100).toFixed(1) + '%';
        
        const runwayDays = Math.round(daysOfRunway);
        // Grounding the runway days in the actual daily rate makes the number
        // less abstract — "17 days of runway ($28 average per day)" tells you
        // both the headline and the implicit math behind it.
        const avgFormatted = formatAvgDaily(avgDaily);
        statusText.textContent = `${runwayDays} days of runway (${avgFormatted} avg/day)`;
        if (daysOfRunway >= daysRemaining) {
            statusSub.textContent = `${daysRemaining} days left in the month`;
        } else {
            const shortBy = daysRemaining - runwayDays;
            statusSub.textContent = `${shortBy} day${shortBy === 1 ? '' : 's'} short of month-end at current pace`;
        }
    }
}

// Format a daily average. Whole-number dollars when >= $10/day, two decimals when small.
function formatAvgDaily(avg) {
    if (avg >= 10) {
        return '$' + Math.round(avg);
    }
    return '$' + avg.toFixed(2);
}

// Update the pace ring based on spending-power data.
// Available = baseline + income - planned (excludes planned payments since they're committed).
// Remaining fraction = spending_power / available.
// Expected fraction at this point in the month = 1 - day_of_month / days_in_month.
function updatePaceRing(data) {
    const baseline = parseFloat(data.baseline || 0);
    const income = parseFloat(data.current_month_income || 0);
    const planned = parseFloat(data.planned_payments_total || 0);
    const spendingPower = parseFloat(data.spending_power || 0);
    
    const available = baseline + income - planned;
    // Edge case: nothing to spend means there's nothing meaningful to show
    if (available <= 0) {
        setPaceRing(0, null, '—', 'no budget', 'var(--text-secondary)');
        return;
    }
    
    // Remaining fraction, clamped to [0, 1]. Above 1 happens if spending is somehow negative;
    // below 0 happens if you've overspent your fully-available amount.
    const remainingFrac = Math.max(0, Math.min(1, spendingPower / available));
    
    // Where you "should" be on a linear pace through the month.
    const now = new Date();
    const day = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthProgress = day / daysInMonth;          // e.g. day 14/31 → 0.45
    const expectedRemainingFrac = 1 - monthProgress;  // expected to still have ~55%
    
    // Color: how far ahead/behind pace are we?
    // Difference > 0 = ahead of pace (good), < 0 = behind (worse).
    // We use CSS variable names so the ring picks up the right shade for the active theme.
    const diff = remainingFrac - expectedRemainingFrac;
    let color, status;
    if (remainingFrac <= 0) {
        color = 'var(--pace-low)'; status = 'overspent';
    } else if (diff >= 0.10) {
        color = 'var(--pace-ahead)'; status = 'ahead';
    } else if (diff >= -0.05) {
        color = 'var(--pace-on)';    status = 'on pace';
    } else if (diff >= -0.15) {
        color = 'var(--pace-behind)'; status = 'behind';
    } else {
        color = 'var(--pace-low)';   status = 'low';
    }
    
    setPaceRing(remainingFrac, expectedRemainingFrac, Math.round(remainingFrac * 100) + '%', status, color);
}

function setPaceRing(remainingFrac, expectedFrac, pctText, labelText, color) {
    const CIRCUMFERENCE = 263.89;  // 2 * π * 42
    const progress = document.getElementById('paceRingProgress');
    const marker = document.getElementById('paceRingMarker');
    const pctEl = document.getElementById('paceRingPct');
    const labelEl = document.getElementById('paceRingLabel');
    const ring = document.getElementById('paceRing');
    
    progress.style.strokeDashoffset = CIRCUMFERENCE * (1 - remainingFrac);
    // Set color via the ring's `color` property — both the SVG stroke (via
    // currentColor in the CSS) and the percent text inherit from this.
    // Using the `color` property means the value can be a CSS variable reference
    // and the browser resolves it correctly.
    ring.style.color = color;
    pctEl.textContent = pctText;
    labelEl.textContent = labelText;
    
    // Note: the persistent-header status text (phStatusText / phStatusSub) is no
    // longer updated here. The runway bar's updateRunwayBar() owns that surface
    // now and writes a calm, days-of-runway message instead of the pace status word.
    
    if (expectedFrac === null) {
        marker.style.display = 'none';
        ring.title = '';
    } else {
        marker.style.display = '';
        // Marker rotation: the ring's progress runs clockwise from 12 o'clock,
        // so to place a tick at the "expected remaining" position we rotate by (1 - expectedFrac) * 360.
        const angle = (1 - expectedFrac) * 360;
        marker.setAttribute('transform', `rotate(${angle} 50 50)`);
        ring.title = `${pctText} of available remaining; expected ${Math.round(expectedFrac * 100)}% at this point in the month (${labelText})`;
    }
}

function setupAutocomplete(inputId, listId, items) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);

    input.addEventListener('input', () => {
        const value = input.value.toLowerCase();
        list.innerHTML = '';

        if (!value) {
            list.style.display = 'none';
            return;
        }

        items
            .filter(item => item.toLowerCase().includes(value))
            .forEach(item => {
                const el = document.createElement('div');
                el.className = 'autocomplete-item';
                el.textContent = item;
                el.onclick = () => {
                    input.value = item;
                    list.style.display = 'none';
                };
                list.appendChild(el);
            });

        list.style.display = list.children.length ? 'block' : 'none';
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.autocomplete')) {
            list.style.display = 'none';
        }
    });
}

async function loadCategories() {
    try {
        const response = await fetch(`${API_URL}/categories`);
        const categories = await response.json();
        setupAutocomplete('category', 'categoryList', categories);
        // Same suggestions in the recurring transaction modal
        setupAutocomplete('recCategory', 'recCategoryList', categories);
    } catch (err) {
        console.error('Failed to load categories:', err);
    }
}

async function loadAccounts() {
    try {
        const response = await fetch(`${API_URL}/accounts`);
        const accounts = await response.json();
        setupAutocomplete('account', 'accountList', accounts);
        // Same suggestions in the recurring transaction modal
        setupAutocomplete('recAccount', 'recAccountList', accounts);
    } catch (err) {
        console.error('Failed to load accounts:', err);
    }
}

// ============================================
// Goals card (installments + savings goals)
// ============================================

async function loadGoals() {
    // Fetch installments and open goals in parallel.
    // (Saving plans dropped in stage 4a — recurring Savings with end_date no
    // longer surfaces as a tracked plan. The endpoint and view still exist
    // server-side; remove in stage 6 cleanup once confirmed unmissed.)
    const [installments, savingsGoals] = await Promise.all([
        fetchJSON(`${API_URL}/installments`).catch(err => { console.error(err); return []; }),
        fetchJSON(`${API_URL}/goals`).catch(err => { console.error(err); return []; }),
    ]);
    
    renderInstallments(installments);
    renderSavingsGoals(savingsGoals);
    
    document.getElementById('goalsCard').classList.remove('empty');
}

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
    return await resp.json();
}

function renderInstallments(items) {
    const section = document.getElementById('installmentsSection');
    const list = document.getElementById('installmentsList');
    section.classList.remove('empty');
    if (!Array.isArray(items) || items.length === 0) {
        list.innerHTML = '<div class="goal-empty-state">No installment plans detected. Add a Spending-type recurring transaction with a number of payments to track one here.</div>';
        return;
    }
    list.innerHTML = items.map(renderInstallment).join('');
}

function renderInstallment(it) {
    const pctPaid = parseFloat(it.pct_paid) || 0;
    const pctTime = parseFloat(it.pct_time_elapsed) || 0;
    const paid = parseFloat(it.amount_paid).toFixed(2);
    const target = parseFloat(it.target_amount).toFixed(2);
    
    const diff = pctPaid - pctTime;
    let statusClass, statusText;
    if (pctPaid >= 1) {
        statusClass = 'ahead'; statusText = 'Complete';
    } else if (diff >= 0.05) {
        statusClass = 'ahead'; statusText = 'Ahead of schedule';
    } else if (diff >= -0.05) {
        statusClass = 'on-pace'; statusText = 'On pace';
    } else if (diff >= -0.15) {
        statusClass = 'behind'; statusText = 'Behind';
    } else {
        statusClass = 'late'; statusText = 'Far behind';
    }
    
    const fillWidth = Math.min(100, pctPaid * 100).toFixed(1);
    const markerLeft = Math.min(100, pctTime * 100).toFixed(1);
    
    return `
        <div class="installment-item">
            <div class="installment-header">
                <div class="installment-name">${escapeHtml(it.name)}</div>
                <div class="installment-amount">$${paid} / $${target}</div>
            </div>
            <div class="installment-progress-bar">
                <div class="installment-progress-fill ${statusClass}" style="width: ${fillWidth}%"></div>
                <div class="installment-pace-marker" style="left: ${markerLeft}%" title="Expected position at this point"></div>
            </div>
            <div class="installment-meta">
                <span>${it.payments_made} of ${it.total_periods} payments • ends ${it.end_date.slice(0, 10)}</span>
                <span class="installment-status ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function renderSavingsGoals(items) {
    const section = document.getElementById('savingsGoalsSection');
    const list = document.getElementById('savingsGoalsList');
    section.classList.remove('empty');
    if (!Array.isArray(items) || items.length === 0) {
        list.innerHTML = '<div class="goal-empty-state">No savings goals yet. Click + New goal above to create one.</div>';
        return;
    }
    list.innerHTML = items.map(renderSavingsGoal).join('');
}

function renderSavingsGoal(g) {
    const pct = parseFloat(g.pct_saved) || 0;
    const saved = parseFloat(g.amount_saved).toFixed(2);
    const target = parseFloat(g.target_amount).toFixed(2);
    const remaining = parseFloat(g.amount_remaining).toFixed(2);
    const isComplete = pct >= 1;
    
    const fillWidth = Math.min(100, pct * 100).toFixed(1);
    const pctText = Math.round(pct * 100) + '%';
    
    return `
        <div class="goal-item" data-goal-id="${g.id}">
            <div class="goal-item-header">
                <div class="goal-name">${escapeHtml(g.name)}</div>
                <div class="goal-amount">$${saved} / $${target}</div>
            </div>
            <div class="goal-progress-bar">
                <div class="goal-progress-fill ${isComplete ? 'complete' : ''}" style="width: ${fillWidth}%"></div>
            </div>
            <div class="goal-meta">
                <span>Category: ${escapeHtml(g.match_category)}</span>
                <span class="goal-pct ${isComplete ? 'complete' : ''}">
                    ${isComplete ? 'Complete' : `${pctText} • $${remaining} to go`}
                </span>
            </div>
        </div>
    `;
}

// ============================================
// Savings goal modal (create / edit)
// ============================================

const goalModal = document.getElementById('goalModal');
const goalNameInput = document.getElementById('goalName');
const goalTargetInput = document.getElementById('goalTarget');
const goalCategoryInput = document.getElementById('goalCategory');
const goalNotesInput = document.getElementById('goalNotes');
let editingGoalId = null;

function openGoalModalForAdd() {
    editingGoalId = null;
    document.getElementById('goalModalTitle').textContent = 'New savings goal';
    goalNameInput.value = '';
    goalTargetInput.value = '';
    goalCategoryInput.value = '';
    goalNotesInput.value = '';
    document.getElementById('goalEditButtons').style.display = 'none';
    goalModal.classList.add('active');
    goalNameInput.focus();
}

function openGoalModalForEdit(goal) {
    editingGoalId = goal.id;
    document.getElementById('goalModalTitle').textContent = 'Edit savings goal';
    goalNameInput.value = goal.name || '';
    goalTargetInput.value = parseFloat(goal.target_amount).toFixed(2);
    goalCategoryInput.value = goal.match_category || '';
    goalNotesInput.value = goal.notes || '';
    document.getElementById('goalEditButtons').style.display = 'grid';
    goalModal.classList.add('active');
}

document.getElementById('addGoalBtn').addEventListener('click', openGoalModalForAdd);
document.getElementById('goalCancelBtn').addEventListener('click', () => goalModal.classList.remove('active'));
closeOnBackdropClick(goalModal, () => goalModal.classList.remove('active'));

// Click a goal item to edit it
document.getElementById('savingsGoalsList').addEventListener('click', async (e) => {
    const item = e.target.closest('.goal-item');
    if (!item) return;
    const id = parseInt(item.dataset.goalId, 10);
    if (isNaN(id)) return;
    try {
        const goals = await fetchJSON(`${API_URL}/goals`);
        const goal = goals.find(g => g.id === id);
        if (goal) openGoalModalForEdit(goal);
    } catch (err) {
        console.error(err);
    }
});

document.getElementById('goalSaveBtn').addEventListener('click', async () => {
    const payload = {
        name: goalNameInput.value.trim(),
        target_amount: parseFloat(goalTargetInput.value),
        match_category: goalCategoryInput.value.trim(),
        notes: goalNotesInput.value.trim() || null,
    };
    // is_active is no longer user-controllable; the modal removed the toggle.
    // The server defaults to active on create. Completion/deletion are the only
    // ways for a goal to become inactive — both have their own dedicated actions.
    
    const btn = document.getElementById('goalSaveBtn');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    
    try {
        const url = editingGoalId === null
            ? `${API_URL}/goals`
            : `${API_URL}/goals/${editingGoalId}`;
        const method = editingGoalId === null ? 'POST' : 'PUT';
        const resp = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const detail = err.details ? '\n\n' + err.details.join('\n') : '';
            throw new Error((err.error || 'Save failed') + detail);
        }
        goalModal.classList.remove('active');
        await loadGoals();
    } catch (err) {
        alert('Failed to save goal.\n\n' + err.message);
        console.error(err);
    } finally {
        btn.textContent = 'Save';
        btn.disabled = false;
    }
});

document.getElementById('goalDeleteBtn').addEventListener('click', async () => {
    if (editingGoalId === null) return;
    if (!confirm('Delete this goal? Saved contributions in your transaction history are NOT deleted; only the goal itself is removed.')) return;
    try {
        const resp = await fetch(`${API_URL}/goals/${editingGoalId}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error('Delete failed');
        goalModal.classList.remove('active');
        await loadGoals();
    } catch (err) {
        alert('Failed to delete.');
        console.error(err);
    }
});

document.getElementById('goalMarkCompleteBtn').addEventListener('click', async () => {
    if (editingGoalId === null) return;
    // Calls the dedicated /complete endpoint which:
    //   - creates a GoalRelease transaction for the saved amount (adds to spending power)
    //   - marks the goal complete (sets completed_at, is_active=false)
    //   - deactivates any matching recurring template (so future contributions stop)
    // All atomic — if any step fails, none are applied.
    if (!confirm('Mark this goal complete? This will release the saved amount back into spending power and stop any recurring contributions.')) return;
    try {
        const resp = await fetch(`${API_URL}/goals/${editingGoalId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Update failed');
        }
        const result = await resp.json();
        goalModal.classList.remove('active');
        await loadGoals();
        await loadSpendingPower();
        await loadRecentTransactions();
        await loadTopCategories();
        // If a release was created, show a confirmatory message
        if (result.released) {
            const successMsg = document.getElementById('successMsg');
            successMsg.textContent = `Goal complete — $${parseFloat(result.released_amount).toFixed(2)} released`;
            successMsg.hidden = false;
            successMsg.classList.add('show');
            setTimeout(() => { successMsg.classList.remove('show'); successMsg.hidden = true; }, 3000);
        }
    } catch (err) {
        alert('Failed to mark complete: ' + err.message);
        console.error(err);
    }
});

async function loadRecentTransactions() {
    try {
        const response = await fetch(`${API_URL}/transactions/recent`);
        const transactions = await response.json();
        // Home shows only the first ~5 — quick context, not the full history.
        // Stage 5 adds a full list to the More tab using the same data.
        const HOME_LIMIT = 5;
        const limited = Array.isArray(transactions) ? transactions.slice(0, HOME_LIMIT) : [];
        displayRecentTransactions(limited);
    } catch (err) {
        console.error('Failed to load recent transactions:', err);
    }
}

// "View all" link on Home jumps to the More tab where the full history will live (stage 5).
const viewAllBtn = document.getElementById('viewAllTransactionsBtn');
if (viewAllBtn) {
    viewAllBtn.addEventListener('click', () => switchTab('more'));
}

document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentType = this.dataset.type;
        // Recompute whether the "this repeats" toggle should be available.
        // Transfer is conceptually a one-time event, so the toggle is hidden then.
        updateRepeatsVisibility();
        // If the payee already has a value, refresh the auto-name preview
        updateAutoName();
    });
});

// ===== Edit mode state and helpers =====
let editingTransactionId = null;
let editingOriginalDate = null;  // preserved so we can show "Editing transaction from YYYY-MM-DD" in the banner
const formCard = document.getElementById('formCard');
const editBannerText = document.getElementById('editBannerText');
const transactionDateInput = document.getElementById('transactionDate');

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

// Initialize the date input to today on every page load
transactionDateInput.value = todayString();

function setTypeButton(type) {
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    const target = document.querySelector(`.type-btn[data-type="${type}"]`);
    if (target) target.classList.add('active');
    currentType = type;
    updateRepeatsVisibility();
}

// ============================================
// "This repeats" toggle and conditional fields (stage 4)
// ============================================
//
// When isRepeating = true, the form submits to /api/recurring instead of /api/transactions.
// The toggle is hidden when type=Transfer (no recurring transfers).

let isRepeating = false;

const repeatsRow = document.getElementById('repeatsRow');
const repeatsToggle = document.getElementById('repeatsToggle');
const repeatsFields = document.getElementById('repeatsFields');
const repName = document.getElementById('repName');
const repFrequency = document.getElementById('repFrequency');
const repDayOfMonth = document.getElementById('repDayOfMonth');
const repNumPayments = document.getElementById('repNumPayments');
const repEndPreview = document.getElementById('repEndPreview');
const repTotalGroup = document.getElementById('repTotalGroup');
const repTotalAmount = document.getElementById('repTotalAmount');
const addPayTodayToggle = document.getElementById('addPayTodayToggle');
const payeeInput = document.getElementById('payee');
const amountInput = document.getElementById('amount');

// Two-way sync between Amount (per-payment) and Total amount (the calculator helper).
// The Amount field is the source of truth for saving; the Total field is purely a UI
// convenience. When the user types in either, the other updates. Number of payments
// must be set, otherwise the Total field is hidden (the math has no operand).
//
// A 'syncing' flag prevents infinite recursion (typing in one triggers an input event
// on the other if we just set its value).
let syncing = false;

function syncTotalFromAmount() {
    if (syncing) return;
    const n = parseInt(repNumPayments.value, 10);
    const per = parseFloat(amountInput.value);
    if (isNaN(n) || n < 1 || isNaN(per)) {
        // Can't compute; leave Total blank
        syncing = true;
        repTotalAmount.value = '';
        syncing = false;
        return;
    }
    syncing = true;
    repTotalAmount.value = (per * n).toFixed(2);
    syncing = false;
}

function syncAmountFromTotal() {
    if (syncing) return;
    const n = parseInt(repNumPayments.value, 10);
    const total = parseFloat(repTotalAmount.value);
    if (isNaN(n) || n < 1 || isNaN(total)) return;
    syncing = true;
    amountInput.value = (total / n).toFixed(2);
    syncing = false;
}

// Total field visibility: only relevant when "this repeats" is on AND number of
// payments is set. Otherwise hidden (it has no meaning).
function updateTotalFieldVisibility() {
    const n = parseInt(repNumPayments.value, 10);
    const shouldShow = isRepeating && !isNaN(n) && n >= 1;
    if (shouldShow) {
        repTotalGroup.removeAttribute('hidden');
        syncTotalFromAmount();  // populate it based on current Amount
    } else {
        repTotalGroup.setAttribute('hidden', '');
    }
}

repTotalAmount.addEventListener('input', syncAmountFromTotal);
amountInput.addEventListener('input', syncTotalFromAmount);

function updateRepeatsVisibility() {
    // Hide the toggle row entirely on Transfer (and force isRepeating off if active)
    if (currentType === 'Transfer') {
        repeatsRow.setAttribute('hidden', '');
        if (isRepeating) {
            isRepeating = false;
            repeatsToggle.classList.remove('active');
            repeatsToggle.setAttribute('aria-pressed', 'false');
            repeatsFields.setAttribute('hidden', '');
        }
    } else {
        repeatsRow.removeAttribute('hidden');
    }
    updateSubmitButtonLabel();
}

function updateSubmitButtonLabel() {
    const btn = document.querySelector('#transactionForm .submit-btn');
    if (!btn) return;
    if (editingTransactionId !== null) {
        btn.textContent = 'Update Transaction';
        return;
    }
    if (!isRepeating) {
        btn.textContent = 'Add Transaction';
        return;
    }
    // Repeating: label differs by type, and finite ("number of payments" set) is
    // called a "plan", while indefinite is "recurring".
    const hasEnd = repNumPayments.value.trim() && parseInt(repNumPayments.value, 10) >= 1;
    if (hasEnd) {
        // Finite — a structured plan
        if (currentType === 'Spending') btn.textContent = 'Save Installment Plan';
        else if (currentType === 'Savings') btn.textContent = 'Save Saving Plan';
        else if (currentType === 'Bills') btn.textContent = 'Save Bill Plan';
        else if (currentType === 'Income') btn.textContent = 'Save Income Plan';
        else btn.textContent = 'Save Plan';
    } else {
        // Indefinite — just a recurring template
        if (currentType === 'Bills') btn.textContent = 'Save Recurring Bill';
        else if (currentType === 'Income') btn.textContent = 'Save Recurring Income';
        else if (currentType === 'Savings') btn.textContent = 'Save Recurring Saving';
        else if (currentType === 'Spending') btn.textContent = 'Save Recurring Spending';
        else btn.textContent = 'Save Recurring';
    }
}

repeatsToggle.addEventListener('click', () => {
    isRepeating = !isRepeating;
    repeatsToggle.classList.toggle('active', isRepeating);
    repeatsToggle.setAttribute('aria-pressed', isRepeating ? 'true' : 'false');
    if (isRepeating) {
        repeatsFields.removeAttribute('hidden');
        updateAutoName();
        updateRepEndPreview();
    } else {
        repeatsFields.setAttribute('hidden', '');
    }
    updateTotalFieldVisibility();
    updateSubmitButtonLabel();
});

addPayTodayToggle.addEventListener('click', () => {
    const on = !addPayTodayToggle.classList.contains('active');
    addPayTodayToggle.classList.toggle('active', on);
    addPayTodayToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
});

// Auto-derive the recurring entry's "Name" from payee + frequency.
// Updates only when the field hasn't been manually edited (the dataset.userEdited flag tracks this).
function updateAutoName() {
    if (!isRepeating) return;
    if (repName.dataset.userEdited === 'true') return;
    const payee = payeeInput.value.trim();
    if (!payee) {
        repName.value = '';
        return;
    }
    const freqLabel = repFrequency.options[repFrequency.selectedIndex].text.toLowerCase();
    repName.value = `${payee} ${freqLabel}`;
}

// Track when the user has manually edited the name field; from then on, don't auto-overwrite
repName.addEventListener('input', () => {
    repName.dataset.userEdited = 'true';
});

// Trigger auto-name on payee or frequency changes
payeeInput.addEventListener('input', updateAutoName);
repFrequency.addEventListener('change', () => {
    updateAutoName();
    updateRepEndPreview();
});

// End-date preview from start_date (today) + frequency + number of payments
function updateRepEndPreview() {
    const n = parseInt(repNumPayments.value, 10);
    if (isNaN(n) || n < 1) {
        repEndPreview.textContent = '';
        updateSubmitButtonLabel();
        return;
    }
    const startStr = transactionDateInput.value || todayString();
    const freq = repFrequency.value;
    const end = computeEndDateFromNumPaymentsAdd(startStr, freq, n);
    repEndPreview.textContent = `= ends ${end} (${n} payment${n === 1 ? '' : 's'})`;
    updateSubmitButtonLabel();
}

// Compute end_date from start_date + frequency + N. Inclusive: N payments means
// the first on start_date and the Nth on the returned end_date.
function computeEndDateFromNumPaymentsAdd(startDateStr, frequency, n) {
    const d = new Date(startDateStr + 'T00:00:00');
    const periods = n - 1;
    if (frequency === 'monthly')  d.setMonth(d.getMonth() + periods);
    else if (frequency === 'weekly')   d.setDate(d.getDate() + periods * 7);
    else if (frequency === 'biweekly') d.setDate(d.getDate() + periods * 14);
    else if (frequency === 'yearly')   d.setFullYear(d.getFullYear() + periods);
    return d.toISOString().slice(0, 10);
}

repNumPayments.addEventListener('input', () => {
    updateRepEndPreview();
    updateTotalFieldVisibility();
});
transactionDateInput.addEventListener('input', updateRepEndPreview);

// Reset the repeats section to its default state (called after successful submit)
function resetRepeats() {
    isRepeating = false;
    repeatsToggle.classList.remove('active');
    repeatsToggle.setAttribute('aria-pressed', 'false');
    repeatsFields.setAttribute('hidden', '');
    repName.value = '';
    delete repName.dataset.userEdited;
    repFrequency.value = 'monthly';
    repDayOfMonth.value = '';
    repNumPayments.value = '';
    repEndPreview.textContent = '';
    repTotalAmount.value = '';
    repTotalGroup.setAttribute('hidden', '');
    addPayTodayToggle.classList.remove('active');
    addPayTodayToggle.setAttribute('aria-pressed', 'false');
}

function enterEditMode(t) {
    editingTransactionId = t.id;
    editingOriginalDate = t.transaction_date.slice(0, 10);
    
    // Pre-fill form fields
    setTypeButton(t.type);
    transactionDateInput.value = editingOriginalDate;
    document.getElementById('amount').value = parseFloat(t.amount).toFixed(2);
    document.getElementById('category').value = t.category || '';
    document.getElementById('description').value = t.description || '';
    document.getElementById('payee').value = t.payee || '';
    document.getElementById('account').value = t.account || '';
    
    // Visual edit-mode markers
    formCard.classList.add('editing');
    editBannerText.textContent = `Editing transaction from ${editingOriginalDate}`;
    
    // Editing applies only to one-time transactions; force isRepeating off and hide
    // the repeats row so the user can't try to convert during edit.
    if (isRepeating) {
        isRepeating = false;
        repeatsToggle.classList.remove('active');
        repeatsToggle.setAttribute('aria-pressed', 'false');
        repeatsFields.setAttribute('hidden', '');
    }
    repeatsRow.setAttribute('hidden', '');
    updateSubmitButtonLabel();
    
    // Switch to the Add tab so the form is actually visible
    switchTab('add');
    
    // Close any open swipe rows on Home so the UI is tidy
    closeAllSwipes();
}

function exitEditMode() {
    editingTransactionId = null;
    editingOriginalDate = null;
    formCard.classList.remove('editing');
    const form = document.getElementById('transactionForm');
    form.reset();
    setTypeButton('Spending');
    // form.reset() clears the date input too, so restore today
    transactionDateInput.value = todayString();
    // setTypeButton('Spending') already called updateRepeatsVisibility(),
    // which shows the repeats row for non-Transfer types.
    updateSubmitButtonLabel();
}

document.getElementById('cancelEditBtn').addEventListener('click', exitEditMode);

document.getElementById('transactionForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const submitBtn = this.querySelector('.submit-btn');
    const isEditing = editingTransactionId !== null;
    submitBtn.textContent = 'Saving...';
    submitBtn.disabled = true;
    
    // Branch: are we creating a recurring entry, or a regular transaction?
    // Recurring entries always create on a new entity in /api/recurring, even when
    // editing isn't supported in this flow (edit-mode is only for one-time transactions).
    const wantsRecurring = isRepeating && !isEditing;
    
    try {
        if (wantsRecurring) {
            // Compute end_date from number of payments if provided
            const startDate = transactionDateInput.value;
            const freq = repFrequency.value;
            const nRaw = repNumPayments.value.trim();
            const n = nRaw ? parseInt(nRaw, 10) : null;
            let endDate = null;
            if (n && n >= 1 && startDate) {
                endDate = computeEndDateFromNumPaymentsAdd(startDate, freq, n);
            }
            
            const payload = {
                name: repName.value.trim() || `${document.getElementById('payee').value.trim()} ${freq}`,
                type: currentType,
                payee: document.getElementById('payee').value.trim(),
                category: document.getElementById('category').value.trim() || null,
                amount: parseFloat(document.getElementById('amount').value),
                account: document.getElementById('account').value.trim() || null,
                description: document.getElementById('description').value.trim() || null,
                frequency: freq,
                day_of_month: repDayOfMonth.value || null,
                start_date: startDate,
                end_date: endDate,
                create_first_payment_today: addPayTodayToggle.classList.contains('active'),
            };
            
            const resp = await fetch(`${API_URL}/recurring`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                const detail = err.details ? '\n\n' + err.details.join('\n') : '';
                throw new Error((err.error || 'Save failed') + detail);
            }
            
            const successMsg = document.getElementById('successMsg');
            successMsg.textContent = endDate ? 'Installment plan saved!' : 'Recurring transaction saved!';
            successMsg.hidden = false;
            successMsg.classList.add('show');
            setTimeout(() => { successMsg.classList.remove('show'); successMsg.hidden = true; }, 3000);
            
            await loadSpendingPower();
            await loadRecentTransactions();
            await loadTopCategories();
            await loadGoals();
            
            // Reset form for next entry — stay on Add tab, ready to go
            this.reset();
            setTypeButton('Spending');
            transactionDateInput.value = todayString();
            resetRepeats();
        } else {
            // One-time transaction: POST or PUT
            const transaction = {
                transaction_date: transactionDateInput.value,
                type: currentType,
                amount: parseFloat(document.getElementById('amount').value),
                category: document.getElementById('category').value,
                description: document.getElementById('description').value,
                payee: document.getElementById('payee').value,
                account: document.getElementById('account').value,
            };
            
            const url = isEditing
                ? `${API_URL}/transactions/${editingTransactionId}`
                : `${API_URL}/transactions`;
            const method = isEditing ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transaction)
            });
            
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                const detail = err.details ? '\n\n' + err.details.join('\n') : '';
                throw new Error((err.error || 'Save failed') + detail);
            }
            
            const successMsg = document.getElementById('successMsg');
            successMsg.textContent = isEditing ? 'Transaction updated!' : 'Transaction added!';
            successMsg.hidden = false;
            successMsg.classList.add('show');
            setTimeout(() => { successMsg.classList.remove('show'); successMsg.hidden = true; }, 3000);
            
            await loadSpendingPower();
            await loadRecentTransactions();
            await loadTopCategories();
            await loadGoals();
            
            if (isEditing) {
                exitEditMode();
            } else {
                this.reset();
                setTypeButton('Spending');
                transactionDateInput.value = todayString();
            }
        }
    } catch (err) {
        alert('Failed to save.\n\n' + err.message);
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        updateSubmitButtonLabel();
    }
});

function displayRecentTransactions(transactions) {
    const list = document.getElementById('recentList');
    if (!transactions || transactions.length === 0) {
        list.innerHTML = '<div style="color: #86868b; text-align: center; padding: 20px;">No recent transactions</div>';
        return;
    }
    
    list.innerHTML = transactions.map(t => `
        <div class="recent-item" data-id="${t.id}">
            <div class="recent-item-edit-bg" data-action="edit" data-id="${t.id}">Edit</div>
            <div class="recent-item-delete-bg" data-action="confirm-delete" data-id="${t.id}">Delete</div>
            <div class="recent-item-content">
                <div>
                    <div class="recent-desc">${escapeHtml(t.description || t.payee || t.category)}${transactionBadge(t.type)}</div>
                    <div class="recent-cat">${escapeHtml(t.category)} • ${t.transaction_date.slice(0, 10)}</div>
                </div>
                <div style="display: flex; align-items: center;">
                    <div class="recent-amount ${recentAmountVariant(t.type)}">
                        ${amountSign(t.type)}${parseFloat(t.amount).toFixed(2)}
                    </div>
                    <button type="button" class="recent-item-edit-btn" data-action="edit" data-id="${t.id}" aria-label="Edit" title="Edit">✎</button>
                    <button type="button" class="recent-item-delete-btn" data-action="confirm-delete" data-id="${t.id}" aria-label="Delete" title="Delete">×</button>
                </div>
            </div>
        </div>
    `).join('');
    
    attachSwipeHandlers();
}

// ===== Swipe-to-edit/delete (mobile) and click-edit/delete (desktop) =====
// Swipe left → reveal red Delete pane on the right
// Swipe right → reveal blue Edit pane on the left
const SWIPE_THRESHOLD = 60;  // px swiped before the action is revealed/triggered
const SWIPE_REVEAL = 80;     // px the row stays open at after release

function attachSwipeHandlers() {
    const items = document.querySelectorAll('.recent-item');
    items.forEach(item => {
        const content = item.querySelector('.recent-item-content');
        let startX = 0;
        let currentX = 0;
        let isDragging = false;
        
        content.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            currentX = startX;
            isDragging = true;
            content.classList.add('swiping');
        }, { passive: true });
        
        content.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            currentX = e.touches[0].clientX;
            const dx = currentX - startX;
            // Clamp to a small overshoot in either direction so the gesture has a soft cap
            const clamped = Math.max(-SWIPE_REVEAL - 20, Math.min(SWIPE_REVEAL + 20, dx));
            content.style.transform = `translateX(${clamped}px)`;
        }, { passive: true });
        
        content.addEventListener('touchend', () => {
            if (!isDragging) return;
            isDragging = false;
            content.classList.remove('swiping');
            const dx = currentX - startX;
            
            if (dx < -SWIPE_THRESHOLD) {
                // Swiped left far enough → leave row open with Delete visible on the right
                content.style.transform = `translateX(-${SWIPE_REVEAL}px)`;
            } else if (dx > SWIPE_THRESHOLD) {
                // Swiped right far enough → leave row open with Edit visible on the left
                content.style.transform = `translateX(${SWIPE_REVEAL}px)`;
            } else {
                // Snap back closed
                content.style.transform = '';
            }
        });
        
        // If finger moves out before lifting, treat as cancel
        content.addEventListener('touchcancel', () => {
            if (!isDragging) return;
            isDragging = false;
            content.classList.remove('swiping');
            content.style.transform = '';
        });
    });
    
    // Tapping anywhere else closes any open swipe
    document.addEventListener('click', closeAllSwipes, { passive: true });
}

function closeAllSwipes(e) {
    // Don't close if the click is on an edit/delete trigger — let those handlers run first
    if (e && e.target.closest('[data-action="confirm-delete"], [data-action="edit"]')) return;
    document.querySelectorAll('.recent-item-content').forEach(c => {
        c.style.transform = '';
    });
}

// Delegated click handler for edit/delete entry points (desktop buttons or mobile reveal panes)
document.getElementById('recentList').addEventListener('click', async (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;
    const id = parseInt(trigger.dataset.id, 10);
    if (isNaN(id)) return;
    
    if (trigger.dataset.action === 'confirm-delete') {
        openDeleteConfirm(id);
    } else if (trigger.dataset.action === 'edit') {
        // Need the full row to pre-fill the form. Refetch the recent list and find this id.
        try {
            const resp = await fetch(`${API_URL}/transactions/recent`);
            const items = await resp.json();
            const t = items.find(x => x.id === id);
            if (t) enterEditMode(t);
        } catch (err) {
            console.error('Failed to load transaction for edit:', err);
        }
    }
});

// ===== Delete confirmation modal =====
let pendingDeleteId = null;
const deleteConfirmModal = document.getElementById('deleteConfirmModal');

function openDeleteConfirm(id) {
    pendingDeleteId = id;
    deleteConfirmModal.classList.add('active');
}

function closeDeleteConfirm() {
    pendingDeleteId = null;
    deleteConfirmModal.classList.remove('active');
    closeAllSwipes();
}

document.getElementById('cancelDeleteBtn').addEventListener('click', closeDeleteConfirm);
closeOnBackdropClick(deleteConfirmModal, closeDeleteConfirm);

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (pendingDeleteId === null) return;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.textContent = 'Deleting…';
    btn.disabled = true;
    try {
        const resp = await fetch(`${API_URL}/transactions/${pendingDeleteId}`, {
            method: 'DELETE'
        });
        if (!resp.ok) throw new Error('Delete failed');
        closeDeleteConfirm();
        await loadSpendingPower();
        await loadRecentTransactions();
        await loadTopCategories();
        await loadGoals();
    } catch (err) {
        alert('Failed to delete. Please try again.');
        console.error(err);
    } finally {
        btn.textContent = 'Delete';
        btn.disabled = false;
    }
});

// Baseline edit modal handlers
const baselineModal = document.getElementById('baselineModal');
const newBaselineInput = document.getElementById('newBaseline');
const saveBaselineBtn = document.getElementById('saveBaselineBtn');

document.getElementById('editBaselineBtn').addEventListener('click', () => {
    // Pre-fill with the baseline (not the displayed spending power, which is post-deductions)
    newBaselineInput.value = currentBaseline.toFixed(2);
    baselineModal.classList.add('active');
    newBaselineInput.focus();
    newBaselineInput.select();
});

document.getElementById('cancelBaselineBtn').addEventListener('click', () => {
    baselineModal.classList.remove('active');
});

// Click outside the modal to dismiss (won't fire on text-selection drags)
closeOnBackdropClick(baselineModal, () => baselineModal.classList.remove('active'));

saveBaselineBtn.addEventListener('click', async () => {
    const value = parseFloat(newBaselineInput.value);
    if (isNaN(value)) {
        alert('Please enter a valid number.');
        return;
    }
    
    saveBaselineBtn.textContent = 'Saving...';
    saveBaselineBtn.disabled = true;
    
    try {
        const response = await fetch(`${API_URL}/spending-power`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseline: value })
        });
        
        if (!response.ok) throw new Error('Failed to save');
        
        baselineModal.classList.remove('active');
        await loadSpendingPower();
    } catch (err) {
        alert('Failed to update baseline. Please try again.');
        console.error(err);
    } finally {
        saveBaselineBtn.textContent = 'Save';
        saveBaselineBtn.disabled = false;
    }
});

// ===== Recurring transactions modal =====
const recurringModal = document.getElementById('recurringModal');
const recurringListView = document.getElementById('recurringListView');
const recurringFormView = document.getElementById('recurringFormView');
const recurringList = document.getElementById('recurringList');
let editingRecurringId = null;  // null = adding new

function showRecurringList() {
    recurringListView.style.display = '';
    recurringFormView.style.display = 'none';
}

function showRecurringForm() {
    recurringListView.style.display = 'none';
    recurringFormView.style.display = '';
}

document.getElementById('manageRecurringBtn').addEventListener('click', async () => {
    showRecurringList();
    recurringModal.classList.add('active');
    await loadRecurringList();
});

document.getElementById('recurringCloseBtn').addEventListener('click', () => {
    recurringModal.classList.remove('active');
});

closeOnBackdropClick(recurringModal, () => recurringModal.classList.remove('active'));

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// Transaction type semantics for display:
//   Income, GoalRelease → "incoming" — money flowing into spending power (green-ish, + sign)
//   Spending, Savings, Bills → "outgoing" — money out of spending power (- sign)
//   Transfer → neutral (just a movement, doesn't affect spending power)
function isIncomingType(type) {
    return type === 'Income' || type === 'GoalRelease';
}

// Visual variant of the recent-amount cell for a given transaction type
function recentAmountVariant(type) {
    if (isIncomingType(type)) return 'income';
    if (type === 'Transfer') return 'neutral';
    return 'spending';
}

// The +/- sign prefix
function amountSign(type) {
    return isIncomingType(type) ? '+' : '-';
}

// A small badge HTML for unusual transaction types (e.g. GoalRelease)
function transactionBadge(type) {
    if (type === 'GoalRelease') {
        return ' <span class="txn-badge txn-badge-release">goal release</span>';
    }
    return '';
}

async function loadRecurringList() {
    try {
        const response = await fetch(`${API_URL}/recurring`);
        const items = await response.json();
        
        if (items.length === 0) {
            recurringList.innerHTML = '<div class="empty-state">No recurring transactions yet.</div>';
            return;
        }
        
        // Group by type for readability
        const groups = {};
        items.forEach(item => {
            if (!groups[item.type]) groups[item.type] = [];
            groups[item.type].push(item);
        });
        
        const typeOrder = ['Income', 'Bills', 'Savings', 'Spending'];
        let html = '';
        typeOrder.forEach(type => {
            if (!groups[type]) return;
            html += `<div class="section-header"><div class="section-title">${type}</div></div>`;
            groups[type].forEach(item => {
                const amount = parseFloat(item.amount).toFixed(2);
                const meta = [
                    item.frequency,
                    item.payee,
                    item.category,
                    item.end_date ? `until ${item.end_date.slice(0,10)}` : null,
                ].filter(Boolean).join(' · ');
                const inactiveClass = item.is_active ? '' : ' inactive';
                html += `
                    <div class="recurring-row${inactiveClass}">
                        <div class="recurring-info">
                            <div class="recurring-name">${escapeHtml(item.name)} — $${amount}</div>
                            <div class="recurring-meta">${escapeHtml(meta)}${item.is_active ? '' : ' · inactive'}</div>
                        </div>
                        <div class="recurring-actions">
                            <button data-action="edit" data-id="${item.id}">Edit</button>
                            <button data-action="delete" data-id="${item.id}" class="danger">Delete</button>
                        </div>
                    </div>
                `;
            });
        });
        recurringList.innerHTML = html;
    } catch (err) {
        console.error('Failed to load recurring:', err);
        recurringList.innerHTML = '<div class="empty-state">Failed to load.</div>';
    }
}

// Delegated click handler for edit/delete buttons in the list
recurringList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    const action = btn.dataset.action;
    
    if (action === 'edit') {
        try {
            const resp = await fetch(`${API_URL}/recurring`);
            const items = await resp.json();
            const item = items.find(i => i.id === id);
            if (!item) return;
            openRecurringFormForEdit(item);
        } catch (err) { console.error(err); }
    } else if (action === 'delete') {
        if (!confirm('Delete this recurring transaction? This cannot be undone.')) return;
        try {
            const resp = await fetch(`${API_URL}/recurring/${id}`, { method: 'DELETE' });
            if (!resp.ok) throw new Error('Delete failed');
            await loadRecurringList();
            await loadSpendingPower();
        } catch (err) {
            alert('Failed to delete.');
            console.error(err);
        }
    }
});

// ===== Add/edit form =====
const recNumPaymentsInput = document.getElementById('recNumPayments');
const recEndDatePreview = document.getElementById('recEndDatePreview');
const recActiveRow = document.getElementById('recActiveRow');
const recAmountInput = document.getElementById('recAmount');
const payTodayToggle = document.getElementById('payTodayToggle');
const payTodayRow = document.getElementById('payTodayRow');
const recIsActiveBtn = document.getElementById('recIsActive');
const recTypeSelect = document.getElementById('recType');
const recStartDateInput = document.getElementById('recStartDate');
const recFrequencySelect = document.getElementById('recFrequency');

// Toggle button helpers (these replace native checkbox behavior)
function isToggled(btn) {
    return btn.classList.contains('active');
}
function setToggled(btn, on) {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
// Click handlers — make the buttons flip on click
payTodayToggle.addEventListener('click', () => setToggled(payTodayToggle, !isToggled(payTodayToggle)));
recIsActiveBtn.addEventListener('click', () => setToggled(recIsActiveBtn, !isToggled(recIsActiveBtn)));

// Default the "pay today" toggle based on type: on for Spending, off for everything else
function syncPayTodayDefault() {
    if (editingRecurringId !== null) return;
    setToggled(payTodayToggle, recTypeSelect.value === 'Spending');
}
recTypeSelect.addEventListener('change', syncPayTodayDefault);

document.getElementById('recurringAddNewBtn').addEventListener('click', () => {
    openRecurringFormForAdd();
});

document.getElementById('recurringFormCancelBtn').addEventListener('click', () => {
    showRecurringList();
});

function clearRecurringForm() {
    document.getElementById('recName').value = '';
    document.getElementById('recType').value = 'Bills';
    document.getElementById('recPayee').value = '';
    document.getElementById('recCategory').value = '';
    recAmountInput.value = '';
    document.getElementById('recAccount').value = '';
    document.getElementById('recDescription').value = '';
    document.getElementById('recFrequency').value = 'monthly';
    document.getElementById('recDayOfMonth').value = '';
    recStartDateInput.value = todayString();
    recNumPaymentsInput.value = '';
    recEndDatePreview.textContent = '';
    setToggled(recIsActiveBtn, true);
    setToggled(payTodayToggle, false);
}

function openRecurringFormForAdd() {
    editingRecurringId = null;
    clearRecurringForm();
    document.getElementById('recurringFormTitle').textContent = 'Add recurring transaction';
    recActiveRow.style.display = 'none';
    payTodayRow.style.display = '';  // show the "pay today" option only when adding
    syncPayTodayDefault();
    showRecurringForm();
}

function openRecurringFormForEdit(item) {
    editingRecurringId = item.id;
    clearRecurringForm();
    document.getElementById('recurringFormTitle').textContent = 'Edit recurring transaction';
    document.getElementById('recName').value = item.name || '';
    document.getElementById('recType').value = item.type;
    document.getElementById('recPayee').value = item.payee || '';
    document.getElementById('recCategory').value = item.category || '';
    recAmountInput.value = item.amount;
    document.getElementById('recAccount').value = item.account || '';
    document.getElementById('recDescription').value = item.description || '';
    document.getElementById('recFrequency').value = item.frequency;
    document.getElementById('recDayOfMonth').value = item.day_of_month || '';
    recStartDateInput.value = item.start_date ? item.start_date.slice(0, 10) : '';
    // Derive "number of payments" from the existing end_date for display.
    if (item.end_date) {
        recNumPaymentsInput.value = computeNumPaymentsFromEndDate(
            item.start_date.slice(0, 10),
            item.end_date.slice(0, 10),
            item.frequency
        );
    } else {
        recNumPaymentsInput.value = '';
    }
    updateEndDatePreview();
    setToggled(recIsActiveBtn, !!item.is_active);
    recActiveRow.style.display = '';
    payTodayRow.style.display = 'none';  // can't retroactively pay today on edit
    showRecurringForm();
}

// ===== Plan-type-aware modal opening (stage 4b) =====
//
// Each plan type maps to a preconfigured opening of the existing recurring modal.
// We reuse openRecurringFormForAdd's logic, then layer on type-specific tweaks:
// hide irrelevant fields, set sensible defaults, lock fields that shouldn't vary.
// On edit, no plan-type is applied — all fields stay visible (we don't know
// what plan-type a historical recurring entry was created as).

function openRecurringFormForPlanType(planType) {
    openRecurringFormForAdd();
    applyPlanTypeToForm(planType);
    recurringModal.dataset.planType = planType;
}

function applyPlanTypeToForm(planType) {
    const numPaymentsField = document.getElementById('recNumPayments').closest('.form-group');
    const endDatePreview = document.getElementById('recEndDatePreview');
    const typeSelect = document.getElementById('recType');
    const titleEl = document.getElementById('recurringFormTitle');
    
    // Reset to default-visible state (matters when reopening the modal for a
    // different plan type without a full page reload).
    numPaymentsField.style.display = '';
    endDatePreview.style.display = '';
    typeSelect.disabled = false;
    payTodayRow.style.display = '';
    
    if (planType === 'subscription') {
        titleEl.textContent = 'New subscription';
        // Subs are discretionary recurring Spending (games, streaming, etc.)
        typeSelect.value = 'Spending';
        // No end date for subscriptions
        numPaymentsField.style.display = 'none';
        endDatePreview.style.display = 'none';
        // "Pay today" defaults ON — the "I just signed up" flow
        setToggled(payTodayToggle, true);
    } else if (planType === 'recurring') {
        titleEl.textContent = 'New recurring item';
        // Catch-all for bills, savings, or non-subscription Spending
        // Type is user-selectable; default to Bills (the most common
        // case for a fresh recurring obligation)
        typeSelect.value = 'Bills';
        numPaymentsField.style.display = 'none';
        endDatePreview.style.display = 'none';
        setToggled(payTodayToggle, false);
    } else if (planType === 'installment') {
        titleEl.textContent = 'New installment';
        // Installments are Bills (commitments you can't easily skip) with an
        // end date — locked so they consistently surface in installment_progress.
        typeSelect.value = 'Bills';
        typeSelect.disabled = true;
        // Number of payments is the whole point of an installment — stays visible
        // Pay-today hidden — installments start next period by convention
        setToggled(payTodayToggle, false);
        payTodayRow.style.display = 'none';
    }
}

// Clear the planType tag when the modal closes so a subsequent open without
// a planType (e.g., from an edit click) doesn't inherit stale state.
const clearPlanTypeOnClose = new MutationObserver(() => {
    if (!recurringModal.classList.contains('active')) {
        delete recurringModal.dataset.planType;
        // Reset field-hiding so the next open starts clean
        const numPaymentsField = document.getElementById('recNumPayments').closest('.form-group');
        const endDatePreview = document.getElementById('recEndDatePreview');
        const typeSelect = document.getElementById('recType');
        numPaymentsField.style.display = '';
        endDatePreview.style.display = '';
        typeSelect.disabled = false;
        payTodayRow.style.display = '';
    }
});
clearPlanTypeOnClose.observe(recurringModal, { attributes: true, attributeFilter: ['class'] });

// ===== End-date computation from "number of payments" =====
//
// The user inputs "Number of payments" (e.g. 6); the system computes the
// end_date as start_date + (N-1) periods. The frequency determines the period.
// This is intentionally inclusive: N payments means N occurrences of the
// recurring entry, the first on start_date, the last on end_date.

function computeEndDateFromNumPayments(startDateStr, frequency, n) {
    if (!startDateStr || isNaN(n) || n < 1) return null;
    const d = new Date(startDateStr + 'T00:00:00');
    const periods = n - 1;
    if (frequency === 'monthly') {
        d.setMonth(d.getMonth() + periods);
    } else if (frequency === 'weekly') {
        d.setDate(d.getDate() + periods * 7);
    } else if (frequency === 'biweekly') {
        d.setDate(d.getDate() + periods * 14);
    } else if (frequency === 'yearly') {
        d.setFullYear(d.getFullYear() + periods);
    }
    return d.toISOString().slice(0, 10);
}

// Reverse direction: given a known start/end_date and frequency, compute the
// implied number of payments. Used to pre-fill the field when editing.
function computeNumPaymentsFromEndDate(startDateStr, endDateStr, frequency) {
    if (!startDateStr || !endDateStr) return '';
    const start = new Date(startDateStr + 'T00:00:00');
    const end = new Date(endDateStr + 'T00:00:00');
    const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return '';
    if (frequency === 'weekly') return Math.round(diffDays / 7) + 1;
    if (frequency === 'biweekly') return Math.round(diffDays / 14) + 1;
    if (frequency === 'yearly') {
        return (end.getFullYear() - start.getFullYear()) + 1;
    }
    // monthly: count months between dates
    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    return months + 1;
}

// Live preview: when the user types a number of payments or changes the start
// date / frequency, show "= ends YYYY-MM-DD" so they can verify the result.
function updateEndDatePreview() {
    const n = parseInt(recNumPaymentsInput.value, 10);
    const amount = parseFloat(recAmountInput.value);
    const startStr = recStartDateInput.value;
    const freq = recFrequencySelect.value;
    if (isNaN(n) || n < 1 || !startStr) {
        recEndDatePreview.textContent = '';
        return;
    }
    const end = computeEndDateFromNumPayments(startStr, freq, n);
    const paymentsWord = `payment${n === 1 ? '' : 's'}`;
    // Include a "total over N payments" math-check when amount is set.
    // Amount represents the per-payment value (consistent with how amount
    // works everywhere else in the app); this preview helps users verify
    // their per-payment division when entering a "split a big purchase" entry.
    if (!isNaN(amount) && amount > 0) {
        const total = (amount * n).toFixed(2);
        recEndDatePreview.textContent = `= ends ${end} • ${n} ${paymentsWord} totaling $${total}`;
    } else {
        recEndDatePreview.textContent = `= ends ${end} (${n} ${paymentsWord})`;
    }
}

recNumPaymentsInput.addEventListener('input', updateEndDatePreview);
recAmountInput.addEventListener('input', updateEndDatePreview);
recStartDateInput.addEventListener('input', updateEndDatePreview);
recFrequencySelect.addEventListener('change', updateEndDatePreview);

document.getElementById('recurringFormSaveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('recurringFormSaveBtn');
    
    // Resolve end_date from the "Number of payments" input.
    // Empty/0/1 means "no end date" — recurring continues indefinitely.
    const numPaymentsRaw = recNumPaymentsInput.value.trim();
    const numPayments = numPaymentsRaw ? parseInt(numPaymentsRaw, 10) : null;
    const startDate = recStartDateInput.value;
    const frequency = document.getElementById('recFrequency').value;
    let endDate = null;
    if (numPayments && numPayments >= 1 && startDate) {
        endDate = computeEndDateFromNumPayments(startDate, frequency, numPayments);
    }
    
    const payload = {
        name: document.getElementById('recName').value.trim(),
        type: document.getElementById('recType').value,
        payee: document.getElementById('recPayee').value.trim(),
        category: document.getElementById('recCategory').value.trim() || null,
        amount: parseFloat(recAmountInput.value),
        account: document.getElementById('recAccount').value.trim() || null,
        description: document.getElementById('recDescription').value.trim() || null,
        frequency,
        day_of_month: document.getElementById('recDayOfMonth').value || null,
        start_date: startDate,
        end_date: endDate,
        // Only meaningful when adding; ignored on PUT
        create_first_payment_today: editingRecurringId === null && isToggled(payTodayToggle),
    };
    
    if (editingRecurringId !== null) {
        payload.is_active = isToggled(recIsActiveBtn);
    }
    
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;
    
    try {
        const url = editingRecurringId === null
            ? `${API_URL}/recurring`
            : `${API_URL}/recurring/${editingRecurringId}`;
        const method = editingRecurringId === null ? 'POST' : 'PUT';
        
        const resp = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const detail = err.details ? '\n\n' + err.details.join('\n') : '';
            throw new Error((err.error || 'Save failed') + detail);
        }
        
        showRecurringList();
        await loadRecurringList();
        await loadSpendingPower();
        await loadRecentTransactions();
        await loadTopCategories();
        await loadGoals();
    } catch (err) {
        alert('Failed to save.\n\n' + err.message);
        console.error(err);
    } finally {
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
    }
});

// HTML for the sun/moon theme toggle button.
// CSS handles which icon to show based on data-theme; both icons are always in the DOM.
const THEME_TOGGLE_HTML = `
    <button type="button" class="theme-toggle" id="themeToggleBtn" title="Toggle dark mode" aria-label="Toggle dark mode">
        <svg viewBox="0 0 24 24" class="icon-sun" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <line x1="12" y1="2" x2="12" y2="5"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="2" y1="12" x2="5" y2="12"/>
            <line x1="19" y1="12" x2="22" y2="12"/>
            <line x1="4.6" y1="4.6" x2="6.7" y2="6.7"/>
            <line x1="17.3" y1="17.3" x2="19.4" y2="19.4"/>
            <line x1="4.6" y1="19.4" x2="6.7" y2="17.3"/>
            <line x1="17.3" y1="6.7" x2="19.4" y2="4.6"/>
        </svg>
        <svg viewBox="0 0 24 24" class="icon-moon" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
        </svg>
    </button>
`;

async function loadTools() {
    const footer = document.getElementById('toolsFooter');
    let toolsMarkup = '';
    try {
        const resp = await fetch(`${API_URL}/tools`);
        const tools = await resp.json();
        if (Array.isArray(tools) && tools.length > 0) {
            const links = tools.map(t =>
                `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.name)}</a>`
            ).join('');
            toolsMarkup = `<span class="tools-footer-label">Tools:</span>${links}`;
        }
    } catch (err) {
        console.error('Failed to load tools:', err);
    }
    // Always render the theme toggle, even if there are no tool links.
    footer.innerHTML = toolsMarkup + THEME_TOGGLE_HTML;
    wireThemeToggle();
}

// ============================================
// Theme management (light / dark / follow-system)
// ============================================
//
// The initial theme is set by an inline script in index.html (before paint, to
// avoid a flash). This block handles the toggle button and the runtime override
// stored in localStorage.

function wireThemeToggle() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    });
}

// If the user has not set an explicit override, follow the OS preference live.
// Once they've toggled manually, their choice persists and OS changes are ignored.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
});

// Refresh button: re-fetch all dynamic data and briefly spin the icon to acknowledge the action
document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    try {
        await Promise.all([
            loadSpendingPower(),
            loadRecentTransactions(),
            loadGoals(),
            loadCategories(),
            loadAccounts(),
        ]);
    } finally {
        // Keep the spin running for at least 600ms (one full rotation) so the feedback feels
        // deliberate even if the requests came back instantly.
        setTimeout(() => btn.classList.remove('spinning'), 600);
    }
});

// ============================================
// Bottom navigation: tab switching (stage 1 of redesign)
// ============================================
//
// Tabs are mutually exclusive: only one .tab-pane has .active at a time, and
// the matching .nav-tab also gets .active. Clicking a nav button switches both.
// The persistent header (above the tabs) isn't affected by this in later stages —
// it stays visible regardless of which tab is showing.

function switchTab(tabName) {
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.dataset.tab === tabName);
    });
    document.querySelectorAll('.nav-tab').forEach(btn => {
        const isActive = btn.dataset.target === tabName;
        btn.classList.toggle('active', isActive);
        if (isActive) {
            btn.setAttribute('aria-current', 'page');
        } else {
            btn.removeAttribute('aria-current');
        }
    });
    // Scroll to top when changing tabs so the new tab starts fresh
    window.scrollTo({ top: 0, behavior: 'instant' });
}

document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.target));
});

// Tap the spending power amount to toggle the detailed breakdown.
// Collapsed by default (per design decision); expanded reveals income/planned/spent math.
const spToggle = document.getElementById('spendingPowerToggle');
const phBreakdown = document.getElementById('phBreakdown');
if (spToggle && phBreakdown) {
    spToggle.addEventListener('click', () => {
        const wasHidden = phBreakdown.hasAttribute('hidden');
        if (wasHidden) {
            phBreakdown.removeAttribute('hidden');
            spToggle.setAttribute('aria-expanded', 'true');
        } else {
            phBreakdown.setAttribute('hidden', '');
            spToggle.setAttribute('aria-expanded', 'false');
        }
    });
}

// ============================================
// Stage 5: More tab content
// ============================================
//
// The More tab has three cards:
//   1. Recurring transactions — list with add/edit/toggle/delete
//   2. All transactions — full history, same swipe interactions as Home
//   3. Settings — baseline, theme, tools
//
// Most of the heavy lifting is reused: the existing recurring modal handles
// add/edit, the existing transaction edit/delete flow handles inline actions.

async function loadMoreRecurringList() {
    const target = document.getElementById('moreRecurringList');
    if (!target) return;
    try {
        const response = await fetch(`${API_URL}/recurring`);
        const items = await response.json();
        
        if (!Array.isArray(items) || items.length === 0) {
            target.innerHTML = '<div class="empty-state">No recurring transactions yet.</div>';
            return;
        }
        
        // Group by type for readability (same grouping as the modal version)
        const groups = {};
        items.forEach(item => {
            if (!groups[item.type]) groups[item.type] = [];
            groups[item.type].push(item);
        });
        
        const typeOrder = ['Income', 'Bills', 'Savings', 'Spending'];
        let html = '';
        typeOrder.forEach(type => {
            if (!groups[type]) return;
            html += `<div class="section-header"><div class="section-title">${type}</div></div>`;
            groups[type].forEach(item => {
                const amount = parseFloat(item.amount).toFixed(2);
                const meta = [
                    item.frequency,
                    item.payee,
                    item.category,
                    item.end_date ? `until ${item.end_date.slice(0, 10)}` : null,
                ].filter(Boolean).join(' · ');
                const inactiveClass = item.is_active ? '' : ' inactive';
                html += `
                    <div class="more-recurring-item${inactiveClass}" data-rec-id="${item.id}">
                        <div class="more-recurring-info">
                            <div class="more-recurring-name">${escapeHtml(item.name)}</div>
                            <div class="more-recurring-meta">${escapeHtml(meta)}${item.is_active ? '' : ' · inactive'}</div>
                            <div class="more-recurring-row-actions">
                                <button type="button" data-action="edit" data-rec-id="${item.id}">Edit</button>
                                <button type="button" data-action="toggle-active" data-rec-id="${item.id}">${item.is_active ? 'Pause' : 'Resume'}</button>
                                <button type="button" class="danger" data-action="delete" data-rec-id="${item.id}">Delete</button>
                            </div>
                        </div>
                        <div class="more-recurring-amount">$${amount}</div>
                    </div>
                `;
            });
        });
        target.innerHTML = html;
    } catch (err) {
        console.error('Failed to load recurring list:', err);
        target.innerHTML = '<div class="empty-state">Could not load.</div>';
    }
}

// Delegated handler for edit/toggle/delete actions in the recurring list
document.getElementById('moreRecurringList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.recId, 10);
    if (isNaN(id)) return;
    
    if (btn.dataset.action === 'edit') {
        try {
            const resp = await fetch(`${API_URL}/recurring`);
            const items = await resp.json();
            const item = items.find(x => x.id === id);
            if (item) {
                openRecurringFormForEdit(item);
                recurringModal.classList.add('active');
            }
        } catch (err) {
            console.error(err);
        }
    } else if (btn.dataset.action === 'toggle-active') {
        try {
            const resp = await fetch(`${API_URL}/recurring`);
            const items = await resp.json();
            const item = items.find(x => x.id === id);
            if (!item) return;
            const updateResp = await fetch(`${API_URL}/recurring/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...item, is_active: !item.is_active }),
            });
            if (!updateResp.ok) throw new Error('Update failed');
            await loadMoreRecurringList();
            await loadSpendingPower();
            await loadGoals();
        } catch (err) {
            alert('Could not change status.');
            console.error(err);
        }
    } else if (btn.dataset.action === 'delete') {
        if (!confirm('Delete this recurring entry? Past generated transactions are NOT deleted.')) return;
        try {
            const resp = await fetch(`${API_URL}/recurring/${id}`, { method: 'DELETE' });
            if (!resp.ok) throw new Error('Delete failed');
            await loadMoreRecurringList();
            await loadSpendingPower();
            await loadGoals();
        } catch (err) {
            alert('Could not delete.');
            console.error(err);
        }
    }
});

// Plan-type picker (stage 4b): each button preconfigures the recurring modal
// for its type. "Open goal" branches to the separate goal modal.
document.querySelectorAll('.plan-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const planType = btn.dataset.planType;
        if (planType === 'open-goal') {
            openGoalModalForAdd();
        } else {
            openRecurringFormForPlanType(planType);
            recurringModal.classList.add('active');
        }
    });
});

// Refresh the More recurring list whenever the modal closes (in case something was edited)
const refreshRecurringOnClose = new MutationObserver(() => {
    if (!recurringModal.classList.contains('active')) {
        loadMoreRecurringList();
    }
});
refreshRecurringOnClose.observe(recurringModal, { attributes: true, attributeFilter: ['class'] });

// All transactions list — full history on More tab, with optional filters
const historyFilters = { type: '', category: '' };

async function loadMoreTransactionsList() {
    const target = document.getElementById('moreTransactionsList');
    if (!target) return;
    try {
        // Build query string from active filters. Limit raised to 50 here since this
        // is the "full history" view and the user filters it themselves.
        const params = new URLSearchParams({ limit: '50' });
        if (historyFilters.type) params.set('type', historyFilters.type);
        if (historyFilters.category) params.set('category', historyFilters.category);
        const response = await fetch(`${API_URL}/transactions/recent?${params}`);
        const transactions = await response.json();
        if (!Array.isArray(transactions) || transactions.length === 0) {
            const filterDesc = historyFilters.type || historyFilters.category
                ? 'No transactions match the current filters.'
                : 'No transactions yet.';
            target.innerHTML = `<div class="empty-state">${filterDesc}</div>`;
            return;
        }
        target.innerHTML = transactions.map(t => `
            <div class="recent-item" data-id="${t.id}">
                <div class="recent-item-edit-bg" data-action="edit" data-id="${t.id}">Edit</div>
                <div class="recent-item-delete-bg" data-action="confirm-delete" data-id="${t.id}">Delete</div>
                <div class="recent-item-content">
                    <div>
                        <div class="recent-desc">${escapeHtml(t.description || t.payee || t.category)}${transactionBadge(t.type)}</div>
                        <div class="recent-cat">${escapeHtml(t.category)} • ${t.transaction_date.slice(0, 10)}</div>
                    </div>
                    <div style="display: flex; align-items: center;">
                        <div class="recent-amount ${recentAmountVariant(t.type)}">
                            ${amountSign(t.type)}${parseFloat(t.amount).toFixed(2)}
                        </div>
                        <button type="button" class="recent-item-edit-btn" data-action="edit" data-id="${t.id}" aria-label="Edit" title="Edit">✎</button>
                        <button type="button" class="recent-item-delete-btn" data-action="confirm-delete" data-id="${t.id}" aria-label="Delete" title="Delete">×</button>
                    </div>
                </div>
            </div>
        `).join('');
        attachSwipeHandlers();
    } catch (err) {
        console.error('Failed to load all transactions:', err);
        target.innerHTML = '<div class="empty-state">Could not load.</div>';
    }
}

// Populate the category filter dropdown from /api/categories.
// Idempotent — replaces all options on each call.
async function populateCategoryFilter() {
    const sel = document.getElementById('historyCategoryFilter');
    if (!sel) return;
    // Don't refetch if we've already populated; categories don't change frequently
    if (sel.dataset.populated === 'true') return;
    try {
        const resp = await fetch(`${API_URL}/categories`);
        const cats = await resp.json();
        // Preserve the "All categories" option
        sel.innerHTML = '<option value="">All categories</option>'
            + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        sel.dataset.populated = 'true';
    } catch (err) {
        console.error('Failed to load categories for filter:', err);
    }
}

// Filter chip clicks (type filter)
document.querySelectorAll('#historyTypeChips .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#historyTypeChips .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        historyFilters.type = chip.dataset.filterType || '';
        loadMoreTransactionsList();
    });
});

// Category filter dropdown
document.getElementById('historyCategoryFilter').addEventListener('change', (e) => {
    historyFilters.category = e.target.value || '';
    loadMoreTransactionsList();
});

// Edit/delete actions on the More-tab transactions list
document.getElementById('moreTransactionsList').addEventListener('click', async (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;
    const id = parseInt(trigger.dataset.id, 10);
    if (isNaN(id)) return;
    
    if (trigger.dataset.action === 'confirm-delete') {
        openDeleteConfirm(id);
    } else if (trigger.dataset.action === 'edit') {
        try {
            const resp = await fetch(`${API_URL}/transactions/recent`);
            const items = await resp.json();
            const t = items.find(x => x.id === id);
            if (t) enterEditMode(t);
        } catch (err) {
            console.error('Failed to load transaction for edit:', err);
        }
    }
});

// Baseline display + edit
async function loadMoreBaseline() {
    const target = document.getElementById('moreBaselineDisplay');
    if (!target) return;
    try {
        const resp = await fetch(`${API_URL}/spending-power`);
        const data = await resp.json();
        const baseline = parseFloat(data.baseline || 0).toFixed(2);
        target.textContent = `$${baseline}`;
    } catch {
        target.textContent = '—';
    }
}

document.getElementById('moreEditBaselineBtn').addEventListener('click', () => {
    document.getElementById('editBaselineBtn').click();  // reuse the existing modal trigger
});

// Theme segmented control (Light / Dark / Auto)
function updateThemeSegments() {
    const saved = localStorage.getItem('theme');
    const active = saved === 'dark' ? 'dark' : saved === 'light' ? 'light' : 'auto';
    document.querySelectorAll('.theme-segment').forEach(seg => {
        seg.classList.toggle('active', seg.dataset.theme === active);
    });
}

document.querySelectorAll('.theme-segment').forEach(seg => {
    seg.addEventListener('click', () => {
        const choice = seg.dataset.theme;
        if (choice === 'auto') {
            localStorage.removeItem('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        } else {
            localStorage.setItem('theme', choice);
            document.documentElement.setAttribute('data-theme', choice);
        }
        updateThemeSegments();
    });
});

// Render tools links into the More tab settings card
async function loadMoreTools() {
    const target = document.getElementById('moreToolsLinks');
    if (!target) return;
    try {
        const resp = await fetch(`${API_URL}/tools`);
        const tools = await resp.json();
        if (!Array.isArray(tools) || tools.length === 0) {
            target.innerHTML = '';
            return;
        }
        target.innerHTML = tools.map(t =>
            `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.name)}</a>`
        ).join('');
    } catch (err) {
        console.error('Failed to load tools:', err);
        target.innerHTML = '';
    }
}

// ============================================
// Stage 6: More tab sub-tabs
// ============================================
//
// Inside the More tab there are three sub-sections (Recurring, History, Settings).
// Each loads its own data when first switched to.

function switchSubTab(name) {
    document.querySelectorAll('.sub-tab').forEach(btn => {
        const isActive = btn.dataset.subtab === name;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.sub-tab-pane').forEach(pane => {
        const isActive = pane.dataset.subtab === name;
        pane.classList.toggle('active', isActive);
        if (isActive) {
            pane.removeAttribute('hidden');
        } else {
            pane.setAttribute('hidden', '');
        }
    });
    // Load the data for the newly visible sub-tab
    loadActiveSubTabData(name);
}

function loadActiveSubTabData(name) {
    if (name === 'history') {
        loadMoreTransactionsList();
        populateCategoryFilter();
    } else if (name === 'settings') {
        loadMoreBaseline();
        loadMoreTools();
    }
}

document.querySelectorAll('.sub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
});

// When the user switches to the More tab from the bottom nav, load whichever
// sub-tab is currently active (Recurring is the default).
const moreRefreshOnSwitch = new MutationObserver(() => {
    const moreTab = document.getElementById('moreTab');
    if (moreTab && moreTab.classList.contains('active')) {
        const activeSub = document.querySelector('.sub-tab.active');
        const name = activeSub ? activeSub.dataset.subtab : 'history';
        loadActiveSubTabData(name);
    }
});
moreRefreshOnSwitch.observe(document.getElementById('moreTab'), {
    attributes: true, attributeFilter: ['class']
});

// When the user switches to the Plan tab from the bottom nav, load the
// recurring-transactions list. Same pattern as moreRefreshOnSwitch above.
const planRefreshOnSwitch = new MutationObserver(() => {
    const planTab = document.getElementById('planTab');
    if (planTab && planTab.classList.contains('active')) {
        loadMoreRecurringList();
    }
});
planRefreshOnSwitch.observe(document.getElementById('planTab'), {
    attributes: true, attributeFilter: ['class']
});

updateThemeSegments();

// Render top spending categories on Home.
// Fetches /api/spending-by-category, displays each with a proportion bar
// where the largest category fills 100%. Hidden when there's no data yet.
async function loadTopCategories() {
    const target = document.getElementById('topCategoriesList');
    if (!target) return;
    try {
        const resp = await fetch(`${API_URL}/spending-by-category?limit=5`);
        const rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            target.innerHTML = '<div class="top-categories-empty">No spending recorded this month yet.</div>';
            return;
        }
        // Find the largest total to use as the bar's max-fill reference
        const maxTotal = rows.reduce((m, r) => Math.max(m, parseFloat(r.total)), 0);
        target.innerHTML = rows.map(r => {
            const total = parseFloat(r.total);
            const pct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
            return `
                <div class="top-cat-item">
                    <div class="top-cat-row">
                        <div class="top-cat-name">${escapeHtml(r.category)}</div>
                        <div class="top-cat-amount">$${total.toFixed(2)}</div>
                    </div>
                    <div class="top-cat-bar"><div class="top-cat-bar-fill" style="width: ${pct.toFixed(1)}%"></div></div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load top categories:', err);
        target.innerHTML = '<div class="top-categories-empty">Could not load.</div>';
    }
}

loadSpendingPower();
loadRecentTransactions();
loadCategories();
loadAccounts();
loadTools();
loadGoals();
loadTopCategories();

setInterval(() => {
    loadSpendingPower();
    loadRecentTransactions();
    loadGoals();
    loadTopCategories();
}, 30000);