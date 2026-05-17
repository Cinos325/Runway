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
    } catch (err) {
        console.error('Failed to load spending power:', err);
    }
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
    } catch (err) {
        console.error('Failed to load categories:', err);
    }
}

async function loadAccounts() {
    try {
        const response = await fetch(`${API_URL}/accounts`);
        const accounts = await response.json();
        setupAutocomplete('account', 'accountList', accounts);
    } catch (err) {
        console.error('Failed to load accounts:', err);
    }
}

// ============================================
// Goals card (installments + savings goals)
// ============================================

async function loadGoals() {
    // Fetch both in parallel
    const [installments, savingsGoals] = await Promise.all([
        fetchJSON(`${API_URL}/installments`).catch(err => { console.error(err); return []; }),
        fetchJSON(`${API_URL}/goals`).catch(err => { console.error(err); return []; }),
    ]);
    
    renderInstallments(installments);
    renderSavingsGoals(savingsGoals);
    
    // Hide the whole card if both subsections are empty
    const card = document.getElementById('goalsCard');
    const hasContent = installments.length > 0 || savingsGoals.length > 0;
    card.classList.toggle('empty', !hasContent);
}

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
    return await resp.json();
}

function renderInstallments(items) {
    const section = document.getElementById('installmentsSection');
    const list = document.getElementById('installmentsList');
    if (!Array.isArray(items) || items.length === 0) {
        section.classList.add('empty');
        return;
    }
    section.classList.remove('empty');
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
                <span>${it.payments_made} of ${it.total_periods} payments • ends ${it.end_date}</span>
                <span class="installment-status ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function renderSavingsGoals(items) {
    const section = document.getElementById('savingsGoalsSection');
    const list = document.getElementById('savingsGoalsList');
    if (!Array.isArray(items) || items.length === 0) {
        section.classList.add('empty');
        return;
    }
    section.classList.remove('empty');
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
const goalIsActiveBtn = document.getElementById('goalIsActive');
let editingGoalId = null;

function openGoalModalForAdd() {
    editingGoalId = null;
    document.getElementById('goalModalTitle').textContent = 'New savings goal';
    goalNameInput.value = '';
    goalTargetInput.value = '';
    goalCategoryInput.value = '';
    goalNotesInput.value = '';
    setToggled(goalIsActiveBtn, true);
    document.getElementById('goalEditOnlyRows').style.display = 'none';
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
    setToggled(goalIsActiveBtn, true);  // editing implies still active
    document.getElementById('goalEditOnlyRows').style.display = '';
    document.getElementById('goalEditButtons').style.display = 'grid';
    goalModal.classList.add('active');
}

goalIsActiveBtn.addEventListener('click', () => setToggled(goalIsActiveBtn, !isToggled(goalIsActiveBtn)));

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
    if (editingGoalId !== null) {
        payload.is_active = isToggled(goalIsActiveBtn);
    }
    
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
    const today = new Date().toISOString().slice(0, 10);
    try {
        const resp = await fetch(`${API_URL}/goals/${editingGoalId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: goalNameInput.value.trim(),
                target_amount: parseFloat(goalTargetInput.value),
                match_category: goalCategoryInput.value.trim(),
                notes: goalNotesInput.value.trim() || null,
                is_active: false,
                completed_at: today,
            }),
        });
        if (!resp.ok) throw new Error('Update failed');
        goalModal.classList.remove('active');
        await loadGoals();
    } catch (err) {
        alert('Failed to mark complete.');
        console.error(err);
    }
});

async function loadRecentTransactions() {
    try {
        const response = await fetch(`${API_URL}/transactions/recent`);
        const transactions = await response.json();
        displayRecentTransactions(transactions);
    } catch (err) {
        console.error('Failed to load recent transactions:', err);
    }
}

document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentType = this.dataset.type;
    });
});

// ===== Edit mode state and helpers =====
let editingTransactionId = null;
let editingOriginalDate = null;  // preserved when editing so we can update without losing original date
const formCard = document.getElementById('formCard');
const editBannerText = document.getElementById('editBannerText');

function setTypeButton(type) {
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    const target = document.querySelector(`.type-btn[data-type="${type}"]`);
    if (target) target.classList.add('active');
    currentType = type;
}

function enterEditMode(t) {
    editingTransactionId = t.id;
    editingOriginalDate = t.transaction_date.slice(0, 10);
    
    // Pre-fill form fields
    setTypeButton(t.type);
    document.getElementById('amount').value = parseFloat(t.amount).toFixed(2);
    document.getElementById('category').value = t.category || '';
    document.getElementById('description').value = t.description || '';
    document.getElementById('payee').value = t.payee || '';
    document.getElementById('account').value = t.account || '';
    
    // Visual edit-mode markers
    formCard.classList.add('editing');
    editBannerText.textContent = `Editing transaction from ${editingOriginalDate}`;
    const submitBtn = document.querySelector('.submit-btn');
    submitBtn.textContent = 'Update Transaction';
    
    // Scroll the form into view (and close any open swipe row)
    closeAllSwipes();
    formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exitEditMode() {
    editingTransactionId = null;
    editingOriginalDate = null;
    formCard.classList.remove('editing');
    const form = document.getElementById('transactionForm');
    form.reset();
    setTypeButton('Spending');
    const submitBtn = document.querySelector('.submit-btn');
    submitBtn.textContent = 'Add Transaction';
}

document.getElementById('cancelEditBtn').addEventListener('click', exitEditMode);

document.getElementById('transactionForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const submitBtn = this.querySelector('.submit-btn');
    const isEditing = editingTransactionId !== null;
    const originalLabel = isEditing ? 'Update Transaction' : 'Add Transaction';
    submitBtn.textContent = 'Saving...';
    submitBtn.disabled = true;
    
    const transaction = {
        // For new transactions, use today; for edits, preserve the original date.
        // (To let the user change the date during edit, expose a date input — not done here.)
        transaction_date: isEditing
            ? editingOriginalDate
            : new Date().toISOString().split('T')[0],
        type: currentType,
        amount: parseFloat(document.getElementById('amount').value),
        category: document.getElementById('category').value,
        description: document.getElementById('description').value,
        payee: document.getElementById('payee').value,
        account: document.getElementById('account').value
    };
    
    try {
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
        successMsg.style.display = 'block';
        setTimeout(() => { successMsg.style.display = 'none'; }, 3000);
        
        await loadSpendingPower();
        await loadRecentTransactions();
        await loadGoals();
        
        if (isEditing) {
            exitEditMode();
        } else {
            this.reset();
            setTypeButton('Spending');
        }
    } catch (err) {
        alert('Failed to save.\n\n' + err.message);
        console.error(err);
    } finally {
        submitBtn.textContent = originalLabel;
        submitBtn.disabled = false;
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
                    <div class="recent-desc">${escapeHtml(t.description || t.payee || t.category)}</div>
                    <div class="recent-cat">${escapeHtml(t.category)} • ${t.transaction_date}</div>
                </div>
                <div style="display: flex; align-items: center;">
                    <div class="recent-amount ${t.type === 'Income' ? 'income' : 'spending'}">
                        ${t.type === 'Income' ? '+' : '-'}${parseFloat(t.amount).toFixed(2)}
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
const installmentsToggle = document.getElementById('installmentsToggle');
const installmentsFields = document.getElementById('installmentsFields');
const installmentsBlock = document.getElementById('installmentsBlock');
const installmentCount = document.getElementById('installmentCount');
const installmentPreview = document.getElementById('installmentPreview');
const recActiveRow = document.getElementById('recActiveRow');
const recAmountInput = document.getElementById('recAmount');
const payTodayToggle = document.getElementById('payTodayToggle');
const payTodayRow = document.getElementById('payTodayRow');
const recIsActiveBtn = document.getElementById('recIsActive');
const recTypeSelect = document.getElementById('recType');

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
installmentsToggle.addEventListener('click', () => {
    const newState = !isToggled(installmentsToggle);
    setToggled(installmentsToggle, newState);
    installmentsFields.style.display = newState ? '' : 'none';
    updateInstallmentPreview();
});

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
    document.getElementById('recStartDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('recEndDate').value = '';
    setToggled(recIsActiveBtn, true);
    installmentsToggle.classList.remove('active');
    installmentsToggle.setAttribute('aria-pressed', 'false');
    installmentsFields.style.display = 'none';
    installmentCount.value = '';
    installmentPreview.textContent = '';
    setToggled(payTodayToggle, false);
}

function openRecurringFormForAdd() {
    editingRecurringId = null;
    clearRecurringForm();
    document.getElementById('recurringFormTitle').textContent = 'Add recurring transaction';
    installmentsBlock.style.display = '';
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
    document.getElementById('recStartDate').value = item.start_date ? item.start_date.slice(0, 10) : '';
    document.getElementById('recEndDate').value = item.end_date ? item.end_date.slice(0, 10) : '';
    setToggled(recIsActiveBtn, !!item.is_active);
    installmentsBlock.style.display = 'none';
    recActiveRow.style.display = '';
    payTodayRow.style.display = 'none';  // can't retroactively pay today on edit
    showRecurringForm();
}

// Installment live preview
function updateInstallmentPreview() {
    if (!isToggled(installmentsToggle)) {
        installmentPreview.textContent = '';
        return;
    }
    const total = parseFloat(recAmountInput.value);
    const n = parseInt(installmentCount.value, 10);
    if (isNaN(total) || isNaN(n) || n < 2 || total <= 0) {
        installmentPreview.textContent = '';
        return;
    }
    const per = (total / n).toFixed(2);
    installmentPreview.textContent = `$${per} × ${n} payments`;
}
recAmountInput.addEventListener('input', updateInstallmentPreview);
installmentCount.addEventListener('input', updateInstallmentPreview);

// After N payments, end_date = start + (N-1) * period.
function computeInstallmentEndDate(startDateStr, frequency, n) {
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

document.getElementById('recurringFormSaveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('recurringFormSaveBtn');
    
    const payload = {
        name: document.getElementById('recName').value.trim(),
        type: document.getElementById('recType').value,
        payee: document.getElementById('recPayee').value.trim(),
        category: document.getElementById('recCategory').value.trim() || null,
        amount: parseFloat(recAmountInput.value),
        account: document.getElementById('recAccount').value.trim() || null,
        description: document.getElementById('recDescription').value.trim() || null,
        frequency: document.getElementById('recFrequency').value,
        day_of_month: document.getElementById('recDayOfMonth').value || null,
        start_date: document.getElementById('recStartDate').value,
        end_date: document.getElementById('recEndDate').value || null,
        // Only meaningful when adding; ignored on PUT
        create_first_payment_today: editingRecurringId === null && isToggled(payTodayToggle),
    };
    
    // Apply installment logic if toggled (only valid when adding)
    if (editingRecurringId === null && isToggled(installmentsToggle)) {
        const n = parseInt(installmentCount.value, 10);
        if (isNaN(n) || n < 2) {
            alert('Number of installments must be 2 or more.');
            return;
        }
        if (isNaN(payload.amount) || payload.amount <= 0) {
            alert('Enter the total purchase amount in Amount.');
            return;
        }
        if (!payload.start_date) {
            alert('Enter a start date (the first payment date).');
            return;
        }
        payload.amount = parseFloat((payload.amount / n).toFixed(2));
        payload.end_date = computeInstallmentEndDate(payload.start_date, payload.frequency, n);
    }
    
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

loadSpendingPower();
loadRecentTransactions();
loadCategories();
loadAccounts();
loadTools();
loadGoals();

setInterval(() => {
    loadSpendingPower();
    loadRecentTransactions();
    loadGoals();
}, 30000);