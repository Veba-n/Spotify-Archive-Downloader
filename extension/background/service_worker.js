// SERVICE WORKER - Background Script
// Message bridge between content script and popup, state management

const BACKEND_URL = 'http://localhost:8765';

// Current session state (persistent state)
const STATE_KEY = 'spotify_archive_state';

async function getState() {
    const data = await chrome.storage.local.get(STATE_KEY);
    return data[STATE_KEY] || {
        sessionId: null,
        isRunning: false,
        trackCount: 0,
        lastMessage: '',
        lastType: 'idle',
        backendConnected: false
    };
}

async function updateState(updates) {
    const state = await getState();
    const newState = { ...state, ...updates };
    await chrome.storage.local.set({ [STATE_KEY]: newState });
    return newState;
}

async function checkBackend() {
    try {
        const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            await updateState({ backendConnected: true });
            return true;
        }
    } catch (e) {
        // Connection error
    }
    await updateState({ backendConnected: false });
    return false;
}

// Periodic backend check (every 30 seconds)
chrome.alarms.create('checkBackend', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'checkBackend') {
        await checkBackend();
    }
});

// Check on startup
checkBackend();

async function fetchProgress(sessionId) {
    if (!sessionId) return null;
    try {
        const res = await fetch(`${BACKEND_URL}/session/${sessionId}/progress`);
        if (res.ok) return await res.json();
    } catch (e) {
        // Connection error
    }
    return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (['session_started', 'scraping', 'chunk_sent', 'finalized', 'error'].includes(msg.type)) {
        getState().then(state => {
            updateState({
                sessionId: msg.sessionId || state.sessionId,
                lastMessage: msg.message || '',
                lastType: msg.type,
                trackCount: msg.trackCount || state.trackCount,
                isRunning: (msg.type !== 'finalized' && msg.type !== 'error')
            });
        });
        return false; // Async response not needed
    }

    if (msg.action === 'GET_STATE') {
        getState().then(state => sendResponse(state));
        return true;
    }

    if (msg.action === 'CHECK_BACKEND') {
        checkBackend().then(ok => sendResponse({ connected: ok }));
        return true;
    }

    if (msg.action === 'GET_PROGRESS') {
        getState().then(state => {
            fetchProgress(msg.sessionId || state.sessionId)
                .then(data => sendResponse(data));
        });
        return true;
    }

    if (msg.action === 'GET_SESSIONS') {
        fetch(`${BACKEND_URL}/sessions`)
            .then(r => r.json())
            .then(data => sendResponse(data))
            .catch(() => sendResponse([]));
        return true;
    }

    if (msg.action === 'TRIGGER_SCRAPING') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'START_SCRAPING' }, (res) => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ error: 'Spotify sayfası bulunamadı. Lütfen bir playlist açın.' });
                    } else {
                        updateState({ isRunning: true }).then(() => sendResponse(res));
                    }
                });
            } else {
                sendResponse({ error: 'Aktif sekme bulunamadı' });
            }
        });
        return true;
    }

    if (msg.action === 'RESUME_SESSION') {
        const sessionId = msg.sessionId;
        fetch(`${BACKEND_URL}/session/${sessionId}/resume`, { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'resumed') {
                    updateState({ sessionId: sessionId, isRunning: true })
                        .then(() => sendResponse(data));
                } else {
                    sendResponse(data);
                }
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});
