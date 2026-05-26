const API_URL = 'http://localhost:3000/api/v1/payments';

// DOM Elements
const form = document.getElementById('paymentForm');
const idempotencyKeyInput = document.getElementById('idempotencyKey');
const refreshKeyBtn = document.getElementById('refreshKeyBtn');
const submitBtn = document.getElementById('submitBtn');
const btnText = submitBtn.querySelector('.btn-text');
const spinner = submitBtn.querySelector('.spinner');
const eventLogs = document.getElementById('eventLogs');
const activePaymentId = document.getElementById('activePaymentId');
const finalStatusLabel = document.getElementById('finalStatusLabel');

// State
let pollingInterval = null;
let currentPaymentId = null;
let seenEventIds = new Set();

// Utility: Generate UUID v4 for Idempotency
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function refreshIdempotencyKey() {
    idempotencyKeyInput.value = generateUUID();
}

// Initial setup
refreshIdempotencyKey();
refreshKeyBtn.addEventListener('click', refreshIdempotencyKey);

// Update UI Stepper
function updateStepper(status) {
    const steps = ['CREATED', 'PENDING', 'PROCESSING', 'FINAL'];
    
    // Reset all steps
    document.querySelectorAll('.step').forEach(el => {
        el.className = 'step'; // Reset classes
        el.classList.add('active'); // Keep them visible
    });
    document.querySelectorAll('.step-line').forEach(el => {
        el.classList.remove('active');
    });

    const isSuccess = status === 'SUCCESS';
    const isFailed = status === 'FAILED';
    const isFinal = isSuccess || isFailed;

    if (isFinal) {
        finalStatusLabel.textContent = isSuccess ? 'Success' : 'Failed';
        document.querySelector('[data-step="FINAL"]').classList.add(isSuccess ? 'completed' : 'failed');
        document.querySelectorAll('.step-line').forEach(el => el.classList.add('active'));
        document.querySelectorAll('.step:not([data-step="FINAL"])').forEach(el => el.classList.add('completed'));
        return;
    }

    finalStatusLabel.textContent = 'Result';

    // Mark steps up to current status as completed
    const currentIndex = steps.indexOf(status);
    if (currentIndex >= 0) {
        for (let i = 0; i <= currentIndex; i++) {
            const stepEl = document.querySelector(`[data-step="${steps[i]}"]`);
            if (stepEl) stepEl.classList.add('completed');
            
            if (i > 0) {
                const lines = document.querySelectorAll('.step-line');
                if (lines[i-1]) lines[i-1].classList.add('active');
            }
        }
    }
}

// Add Log Entry
function addLogEntry(event) {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);

    // Remove empty state if present
    const emptyState = eventLogs.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = new Date(event.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
    
    let actionText = '';
    let details = '';
    let logClass = 'log-content';

    if (event.eventType === 'state_change') {
        actionText = `State changed from ${event.fromStatus || 'NULL'} to <strong>${event.toStatus}</strong>`;
        if (event.toStatus === 'SUCCESS') logClass = 'log-success';
        if (event.toStatus === 'FAILED') logClass = 'log-error';
    } else if (event.eventType === 'gateway_response') {
        const isSuccess = event.eventData && event.eventData.success;
        actionText = `Gateway responded: <strong>${isSuccess ? 'Approved' : 'Declined'}</strong>`;
        logClass = isSuccess ? 'log-success' : 'log-error';
        details = JSON.stringify(event.eventData);
    } else {
        actionText = `Event: ${event.eventType}`;
    }

    entry.innerHTML = `
        <div class="log-time">${time}</div>
        <div class="${logClass}">
            ${actionText}
            ${details ? `<span class="log-details">${details}</span>` : ''}
        </div>
    `;

    eventLogs.insertBefore(entry, eventLogs.firstChild);
}

// Set Loading State
function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    if (isLoading) {
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
    } else {
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');
    }
}

// Start Polling Payment Status
function startPolling(paymentId) {
    if (pollingInterval) clearInterval(pollingInterval);
    
    activePaymentId.textContent = `ID: ${paymentId}`;
    let pollCount = 0;
    const MAX_POLLS = 60; // Stop polling after 60 seconds max
    
    pollingInterval = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            setLoading(false);
            console.warn('Max polling limit reached.');
            return;
        }

        try {
            const res = await fetch(`${API_URL}/${paymentId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const json = await res.json();
            
            if (json.success && json.data) {
                const payment = json.data;
                
                try {
                    updateStepper(payment.status);

                    if (payment.events && payment.events.length > 0) {
                        [...payment.events].reverse().forEach(addLogEntry);
                    }
                } catch (uiError) {
                    console.error('Error updating UI:', uiError);
                }

                if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
                    clearInterval(pollingInterval);
                    pollingInterval = null;
                    setLoading(false);
                }
            }
        } catch (error) {
            console.error('Polling error:', error);
            // If we get consecutive errors, we should probably stop, but we'll rely on MAX_POLLS for now.
        }
    }, 1000); // Poll every second
}

// Form Submit Handler
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const amount = parseFloat(document.getElementById('amount').value);
    const currency = document.getElementById('currency').value;
    const customerEmail = document.getElementById('customerEmail').value;
    const idempotencyKey = idempotencyKeyInput.value;

    setLoading(true);
    
    // Reset UI
    eventLogs.innerHTML = '';
    seenEventIds.clear();
    updateStepper('CREATED');

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-idempotency-key': idempotencyKey
            },
            body: JSON.stringify({
                amount,
                currency,
                customerEmail,
                merchantId: 'antigravity_demo_123',
                description: 'Demo payment from Antigravity UI'
            })
        });

        const json = await res.json();

        if (json.success && json.data) {
            currentPaymentId = json.data.id;
            
            // Log the initial creation event manually if it's not instantly returned
            addLogEntry({
                id: 'client-init-' + Date.now(),
                eventType: 'state_change',
                fromStatus: null,
                toStatus: 'CREATED',
                createdAt: new Date().toISOString()
            });

            // Start polling for background job updates
            startPolling(currentPaymentId);
        } else {
            alert('Error creating payment: ' + (json.error || json.message));
            setLoading(false);
        }
    } catch (error) {
        alert('Network error: ' + error.message);
        setLoading(false);
    }
});
