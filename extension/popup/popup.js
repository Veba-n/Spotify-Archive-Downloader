
const $ = (sel) => document.querySelector(sel);
const POLL_INTERVAL = 2000; // progress check every 2 seconds

let currentSessionId = null;
let pollTimer = null;

const els = {
    backendDot: $('#backendDot'),
    backendText: $('#backendText'),
    subtitle: $('#subtitle'),
    statusIcon: $('#statusIcon'),
    idleIcon: $('#idleIcon'),
    spinner: $('#spinner'),
    statusTitle: $('#statusTitle'),
    statusMessage: $('#statusMessage'),
    statusCard: $('#statusCard'),
    progressSection: $('#progressSection'),
    progressLabel: $('#progressLabel'),
    progressPercent: $('#progressPercent'),
    progressFill: $('#progressFill'),
    statDone: $('#statDone'),
    statPending: $('#statPending'),
    statFailed: $('#statFailed'),
    statTotal: $('#statTotal'),
    actionBtn: $('#actionBtn'),
    actionText: $('#actionText'),
    sessionsList: $('#sessionsList'),
};

function refreshDynamicTexts() {
    if (typeof loadSessions === 'function') loadSessions();
    if (typeof checkBackend === 'function') checkBackend();

    if (els.statusCard.classList.contains('running')) {
        if (typeof pollProgress === 'function') pollProgress();
    } else if (els.statusTitle.textContent === locales['en']['ready'] || els.statusTitle.textContent === locales['tr']['ready']) {
        setIdleState();
    } else if (els.statusTitle.textContent === locales['en']['completed'] || els.statusTitle.textContent === locales['tr']['completed']) {
        const done = parseInt(els.statDone.textContent) || 0;
        const failed = parseInt(els.statFailed.textContent) || 0;
        setDoneState({ done, failed });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Await i18n initialization slightly later to let it fetch from storage
    setTimeout(async () => {
        await checkBackend();
        await refreshState();
        await loadSessions();
        els.actionBtn.addEventListener('click', handleAction);
    }, 100);
});

async function checkBackend() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'CHECK_BACKEND' }, (res) => {
            const connected = res?.connected ?? false;
            els.backendDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
            els.backendText.textContent = connected ? t('backend_active') : t('backend_offline');
            els.actionBtn.disabled = !connected;
            if (!connected) {
                els.statusTitle.textContent = t('no_backend');
                els.statusMessage.textContent = t('start_backend');
            }
            resolve(connected);
        });
    });
}

async function refreshState() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
            if (state?.isRunning && state?.sessionId) {
                currentSessionId = state.sessionId;

                const lbl = state.lastType === 'scraping' ? t('scanning')
                    : state.lastType === 'chunk_sent' ? t('sending')
                        : state.lastMessage || `${state.trackCount || 0} ${t('tracks_found')}`;

                setRunningState(state.trackCount || 0, lbl);
                startPolling();
            } else if (state?.sessionId && !state?.isRunning && state?.lastType === 'finalized') {
                currentSessionId = state.sessionId;
                startPolling();
            }
            resolve();
        });
    });
}

async function handleAction() {
    els.actionBtn.disabled = true;
    els.actionText.textContent = t('starting');

    chrome.runtime.sendMessage({ action: 'TRIGGER_SCRAPING' }, (res) => {
        if (res?.error) {
            showError(res.error);
            els.actionBtn.disabled = false;
            els.actionText.textContent = t('download_playlist');
            return;
        }

        setRunningState(0, t('scanning'));

        setTimeout(() => {
            chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
                if (state?.sessionId) {
                    currentSessionId = state.sessionId;
                    startPolling();
                }
            });
        }, 1500);
    });
}

function setRunningState(count, message) {
    els.statusCard.classList.add('running');
    els.idleIcon.classList.add('hidden');
    els.spinner.classList.remove('hidden');
    els.statusTitle.textContent = t('running');
    els.statusMessage.textContent = message || `${count} ${t('processing')}`;
    els.actionBtn.disabled = true;
    els.actionText.textContent = t('download_continuing');
    els.progressSection.classList.remove('hidden');
}

function setIdleState() {
    els.statusCard.classList.remove('running');
    els.idleIcon.classList.remove('hidden');
    els.spinner.classList.add('hidden');
    els.statusTitle.textContent = t('ready');
    els.statusMessage.textContent = t('ready_msg');
    els.actionBtn.disabled = false;
    els.actionText.textContent = t('download_playlist');
}

function setDoneState(stats) {
    els.statusCard.classList.remove('running');
    els.idleIcon.classList.remove('hidden');
    els.spinner.classList.add('hidden');
    els.statusTitle.textContent = t('completed');
    const done = stats?.done || 0;
    const failed = stats?.failed || 0;
    els.statusMessage.textContent = `${done} ${t('downloaded')}${failed > 0 ? `, ${failed} ${t('failed')}` : ''}`;
    els.actionBtn.disabled = false;
    els.actionText.textContent = t('start_new');
}

function showError(message) {
    els.statusCard.classList.remove('running');
    els.idleIcon.classList.remove('hidden');
    els.spinner.classList.add('hidden');
    els.statusTitle.textContent = t('error');
    els.statusMessage.textContent = message;
}

function startPolling() {
    if (!pollTimer) {
        pollTimer = setInterval(pollProgress, POLL_INTERVAL);
        pollProgress();
    }
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function pollProgress() {
    if (!currentSessionId) return;

    chrome.runtime.sendMessage(
        { action: 'GET_PROGRESS', sessionId: currentSessionId },
        (data) => {
            if (!data || !data.stats) return;

            if (!data.session || Object.keys(data.session).length === 0) {
                stopPolling();
                setDoneState({ done: 0, failed: 0 });
                els.statusMessage.textContent = t('session_not_found');
                chrome.storage.local.clear();
                return;
            }

            const stats = data.stats;
            const done = stats.done || 0;
            const pending = (stats.pending || 0) + (stats.queued || 0);
            const downloading = stats.downloading || 0;
            const tagging = stats.tagging || 0;
            const failed = stats.failed || 0;
            const total = done + pending + downloading + tagging + failed;

            els.statDone.textContent = done;
            els.statPending.textContent = pending + downloading + tagging;
            els.statFailed.textContent = failed;
            els.statTotal.textContent = total;

            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            els.progressFill.style.width = `${pct}%`;
            els.progressPercent.textContent = `${pct}%`;

            if (downloading > 0) {
                let lbl_dn = currentLang === 'tr' ? ' şarkı indiriliyor...' : ' tracks downloading...';
                els.progressLabel.textContent = `${downloading} ${lbl_dn}`;
            } else if (tagging > 0) {
                els.progressLabel.textContent = t('tagging');
            } else if (pending > 0) {
                els.progressLabel.textContent = t('waiting_queue');
            }

            const isFinalizing = data.session?.status === 'finalizing';
            if (pending === 0 && downloading === 0 && tagging === 0 && isFinalizing) {
                stopPolling();

                if (total === 0) {
                    setDoneState({ done: 0, failed: 0 });
                    els.statusMessage.textContent = t('playlist_uptodate');
                } else {
                    setDoneState(stats);
                }

                loadSessions();
                chrome.storage.local.set({
                    spotify_archive_state: {
                        sessionId: null, isRunning: false, trackCount: 0,
                        lastMessage: '', lastType: 'idle', backendConnected: true
                    }
                });
            }
        }
    );
}

async function loadSessions() {
    chrome.runtime.sendMessage({ action: 'GET_SESSIONS' }, (sessions) => {
        if (!sessions || sessions.length === 0) {
            els.sessionsList.innerHTML = `<p class="empty-text">${t('no_downloads')}</p>`;
            return;
        }

        els.sessionsList.innerHTML = sessions.slice(0, 10).map(s => {
            const statusLabel = getStatusLabel(s);
            const date = s.created_at ? new Date(s.created_at).toLocaleDateString(currentLang === 'tr' ? 'tr-TR' : 'en-US', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            }) : '';

            const canResume = statusLabel.resumable;
            const resumeBtn = canResume
                ? `<button class="btn-resume" data-session-id="${s.session_id}">▶ ${t('resume')}</button>`
                : '';

            return `
        <div class="session-item">
          <div class="session-info">
            <div class="session-name">${escapeHtml(s.playlist_name || t('unknown'))}</div>
            <div class="session-meta">${date} · ${s.done_count || 0}/${s.total_tracks || '?'} ${t('track')}</div>
          </div>
          <div class="session-actions">
            ${resumeBtn}
            <span class="session-status ${statusLabel.cls}">${statusLabel.text}</span>
          </div>
        </div>
      `;
        }).join('');

        document.querySelectorAll('.btn-resume').forEach(btn => {
            if (btn.id === 'resetAppBtn') return;
            btn.addEventListener('click', () => {
                const sid = btn.getAttribute('data-session-id');
                if (sid) resumeSession(sid);
            });
        });
    });
}

// Reset Button Event Listener
document.getElementById('resetAppBtn').addEventListener('click', () => {
    if (confirm(t('reset_confirm'))) {
        chrome.storage.local.clear();
        fetch('http://localhost:8765/sessions/clear', { method: 'DELETE' })
            .then(() => {
                stopPolling();
                currentSessionId = null;
                setDoneState({ done: 0, failed: 0 });
                els.statusTitle.textContent = t('cleared');
                els.statusMessage.textContent = t('cleared_msg');
                loadSessions();
            })
            .catch(err => {
                showError(t('failed_reset') + err.message);
                chrome.storage.local.clear();
            });
    }
});

// Listen to Archive (Web Player) Buttons
const listenHandler = () => {
    chrome.tabs.create({ url: 'http://127.0.0.1:8765/player' });
};
const listenBtnInfo = document.getElementById('listenBtn');
const listenBtnList = document.getElementById('listenAppBtn');
if (listenBtnInfo) listenBtnInfo.addEventListener('click', listenHandler);
if (listenBtnList) listenBtnList.addEventListener('click', listenHandler);


function getStatusLabel(session) {
    const { status, done_count, fail_count, total_tracks } = session;
    const done = done_count || 0;
    const fail = fail_count || 0;
    const total = total_tracks || 0;

    if (total > 0 && done >= total && fail === 0) {
        return { text: t('status_done'), cls: 'done', resumable: false };
    }
    if (status === 'active') {
        return { text: t('status_active'), cls: 'active', resumable: false };
    }
    if (fail > 0) {
        return { text: t('status_partial'), cls: 'failed', resumable: true };
    }
    if (total > 0 && done < total) {
        return { text: t('status_partial'), cls: 'failed', resumable: true };
    }
    return { text: t('status_done'), cls: 'done', resumable: false };
}

function resumeSession(sessionId) {
    const btns = document.querySelectorAll('.btn-resume');
    btns.forEach(b => b.disabled = true);

    currentSessionId = sessionId;
    setRunningState(0, t('resuming'));

    chrome.runtime.sendMessage({ action: 'RESUME_SESSION', sessionId }, (res) => {
        if (res?.error) {
            showError(res.error);
            return;
        }
        if (res?.status === 'nothing_to_resume') {
            setDoneState({ done: 0, failed: 0 });
            els.statusMessage.textContent = t('all_downloaded');
            return;
        }

        let rs_dn = currentLang === 'tr' ? ' şarkı yeniden indiriliyor...' : ' tracks re-downloading...';
        setRunningState(res?.pending_count || 0, `${res?.pending_count || 0}${rs_dn}`);
        startPolling();
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
