import { Store } from './Store.js';

// ══════════════════════════════════════════════════════════════════════════════
// LyricsCache  —  IndexedDB-backed lyrics cache
//   Second load = instant (no re-scrape). Keyed by Genius URL.
// ══════════════════════════════════════════════════════════════════════════════
const LyricsCache = {
    _db: null,

    async _open() {
        if (this._db) return this._db;
        return new Promise((res, rej) => {
            const req = indexedDB.open('sa_lyrics_v1', 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore('lyr', { keyPath: 'k' });
            req.onsuccess = e => { this._db = e.target.result; res(this._db); };
            req.onerror = () => rej(req.error);
        });
    },

    async get(key) {
        try {
            const db = await this._open();
            return new Promise(res => {
                const r = db.transaction('lyr').objectStore('lyr').get(key);
                r.onsuccess = () => res(r.result?.v ?? null);
                r.onerror = () => res(null);
            });
        } catch { return null; }
    },

    async set(key, val) {
        try {
            const db = await this._open();
            return new Promise(res => {
                const tx = db.transaction('lyr', 'readwrite');
                tx.objectStore('lyr').put({ k: key, v: val, ts: Date.now() });
                tx.oncomplete = () => res(true);
                tx.onerror = () => res(false);
            });
        } catch { return false; }
    }
};


// ══════════════════════════════════════════════════════════════════════════════
// LyricsManager  —  Genius fetch · scrape · render · DetailsPanel extras
// ══════════════════════════════════════════════════════════════════════════════
export const LyricsManager = {
    currentTrackId: null,
    currentData: null,
    config: null,

    async fetchConfig() {
        try {
            const res = await fetch('/api/config');
            this.config = await res.json();
            console.log('Backend Config Loaded:', this.config);
        } catch (e) {
            console.error('Failed to fetch backend config:', e);
            this.config = { rsync_enabled: false }; // Secure fallback
        }
    },

    // ── Main entry ──────────────────────────────────────────────────────────
    async update() {
        if (!Store.currentTrack) return;
        const track = Store.currentTrack;
        const isNew = this.currentTrackId !== track.track_id;

        if (isNew) {
            this.currentTrackId = track.track_id;
            this.currentData = null;
            LyricSyncEngine.stop();
            LyricTranscriptEngine.stop();

            if (Store.lyricsOpen) this.renderLoading();

            try {
                const data = await this.fetchFromGenius(track.title, window.parseArtists(track.artists));
                if (data) {
                    this.currentData = data;
                    this.fetchExtraInfo(data.songId, data.artistId);
                    if (Store.lyricsOpen) await this._loadRender();
                } else if (Store.lyricsOpen) {
                    this.renderError('Lyrics not found');
                }
            } catch (e) {
                console.error('Lyrics fetch error:', e);
                if (Store.lyricsOpen) this.renderError('Failed to fetch lyrics.');
            }

        } else if (Store.lyricsOpen && !this.currentData?.lyrics) {
            if (!this.currentData) {
                this.renderLoading();
                const data = await this.fetchFromGenius(track.title, window.parseArtists(track.artists));
                if (data) {
                    this.currentData = data;
                    this.fetchExtraInfo(data.songId, data.artistId);
                    await this._loadRender();
                } else {
                    this.renderError('Lyrics not found');
                }
            } else {
                await this._loadRender();
            }
        }
    },

    async _loadRender() {
        if (!this.currentData?.url) return;
        if (this.currentData.lyrics) { this.renderLyrics(this.currentData); return; }

        this.renderLoading();

        // IndexedDB cache check
        const cacheKey = 'lyr:' + this.currentData.url;
        const cached = await LyricsCache.get(cacheKey);
        if (cached) {
            this.currentData.lyrics = cached;
            this.renderLyrics(this.currentData);
            return;
        }

        try {
            const lyrics = await this.fetchLyricsText(this.currentData.url);
            this.currentData.lyrics = lyrics;
            if (lyrics) LyricsCache.set(cacheKey, lyrics);
            this.renderLyrics(this.currentData);
        } catch {
            this.renderError('Failed to extract lyrics.');
        }
    },

    // ── Genius API search ───────────────────────────────────────────────────
    async fetchFromGenius(title, artist) {
        const key = Store.geniusApiKey;
        if (!key) return null;

        const q = encodeURIComponent(`${title} ${artist}`);
        const res = await fetch(`https://api.genius.com/search?q=${q}&access_token=${key}`);
        const json = await res.json();
        if (json.meta.status !== 200 || !json.response.hits.length) return null;

        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s]/g, '').trim();
        const nT = norm(title), nA = norm(artist);

        let best = null, bestScore = -1;
        for (const hit of json.response.hits.slice(0, 5)) {
            const r = hit.result;
            const rT = norm(r.title), rA = norm(r.primary_artist.name);
            let s = 0;
            if (rT.includes(nT) || nT.includes(rT)) s += 3;
            if (rA.includes(nA) || nA.includes(rA)) s += 2;
            if (/remix|live|karaoke|cover|instrumental/i.test(rT)) s -= 2;
            if (s > bestScore) { bestScore = s; best = r; }
        }
        if (!best) best = json.response.hits[0].result;

        return {
            title: best.title, artist: best.primary_artist.name,
            image: best.header_image_url, url: best.url,
            songId: best.id, artistId: best.primary_artist.id, lyrics: null
        };
    },

    // ── Genius extra info (bio + song description) ──────────────────────────
    async fetchExtraInfo(songId, artistId) {
        const key = Store.geniusApiKey;
        if (!key) return;
        try {
            const [sRes, aRes] = await Promise.all([
                fetch(`https://api.genius.com/songs/${songId}?access_token=${key}&text_format=plain`),
                fetch(`https://api.genius.com/artists/${artistId}?access_token=${key}&text_format=plain`)
            ]);
            const sJson = await sRes.json(), aJson = await aRes.json();
            const info = {
                songInfo: sJson.response?.song?.description?.plain || '',
                artistBio: aJson.response?.artist?.biography?.plain || ''
            };
            if (info.artistBio === '?') info.artistBio = '';
            if (info.songInfo === '?') info.songInfo = '';
            import('../components/DetailsPanel.js').then(m => m.DetailsPanel.updateExtraInfo(info));
        } catch (e) { console.error('fetchExtraInfo:', e); }
    },

    // ── Genius scrape via backend proxy ─────────────────────────────────────
    async fetchLyricsText(geniusUrl) {
        try {
            const res = await fetch(`/api/lyrics/proxy?url=${encodeURIComponent(geniusUrl)}`);
            const json = await res.json();
            const doc = new DOMParser().parseFromString(json.contents, 'text/html');

            let containers = doc.querySelectorAll('[class^="Lyrics__Container"], [data-lyrics-container="true"], .lyrics');
            if (!containers.length) return null;

            let txt = '';
            containers.forEach(c => {
                // Remove non-lyric metadata (Bio, Description, Ads, Socials)
                c.querySelectorAll('script, style, [class*="SongDescription"], [class*="LyricsFooter"], [class*="Header"], [class*="Share"]').forEach(s => s.remove());

                let content = c.innerHTML
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/div>/gi, '\n')
                    .replace(/<[^>]+>/g, '');
                let lines = content.split('\n').map(l => l.trim());

                // Strip leading junk
                while (lines.length) {
                    const l = lines[0].toLowerCase();
                    if (l.match(/^\d*\s*contributors?$/) || l.endsWith(' lyrics') ||
                        l.match(/^\[.*lyrics\]$/) || l.includes('translations') || l === '')
                        lines.shift();
                    else break;
                }
                // Strip trailing junk
                while (lines.length) {
                    const l = lines[lines.length - 1].toLowerCase();
                    if (l.match(/^\d*\s*embed$/) || l === 'share url' || l === 'copy embed code' || l === '')
                        lines.pop();
                    else break;
                }
                txt += lines.join('\n') + '\n\n';
            });
            return txt.trim() || null;
        } catch (e) { console.error('Scraping error:', e); return null; }
    },

    // ── Render helpers ──────────────────────────────────────────────────────
    renderLoading() {
        const el = document.getElementById('lyrics-text');
        if (el) el.innerHTML = '<div class="phrase active">Searching for lyrics...</div>';
        const cr = document.getElementById('lyrics-credit');
        if (cr) cr.innerText = '';
    },

    renderLyrics(data) {
        const textElem = document.getElementById('lyrics-text');
        const creditElem = document.getElementById('lyrics-credit');
        if (!textElem) return;

        if (data.lyrics) {
            const bracketRe = /^\[.*\]$/;
            let lyricIdx = 0;
            const html = data.lyrics.split('\n').map(l => l.trim()).map(line => {
                if (!line) return '';
                if (bracketRe.test(line))
                    return `<div class="lyric-section-label">${line}</div>`;

                // Wrap each word in a span for karaoke-level highlighting
                const words = line.split(/(\s+)/).map(part => {
                    if (part.trim().length === 0) return part; // Keep whitespace as is
                    return `<span class="word">${part}</span>`;
                }).join('');

                return `<div class="lyric-line" data-index="${lyricIdx++}">${words}</div>`;
            }).join('');
            textElem.innerHTML = html;
            if (LyricSyncEngine)
                LyricSyncEngine.start(lyricIdx, Store.currentTrack?.track_id);
            this._injectOffsetUI();
            // 1. Gated STT Start: Only if backend supports it
            if (LyricTranscriptEngine && this.config?.rsync_enabled) {
                LyricTranscriptEngine.start();
                LyricSyncEngine.syncEnabled = true; // Auto-enable if fresh sync is possible
            } else if (!LyricSyncEngine.isBaked) {
                LyricSyncEngine.syncEnabled = false; // Lite mode fallback
            }

            // 2. Button Visibility & State Sync
            const btn = document.getElementById('btn-toggle-sync');
            const lyricsView = document.getElementById('lyrics-view');
            const rsyncReady = this.config && this.config.rsync_enabled;
            const shouldShowSync = rsyncReady || LyricSyncEngine.isBaked;

            if (btn) {
                if (shouldShowSync) {
                    btn.style.display = 'flex';
                    btn.classList.toggle('active', LyricSyncEngine.syncEnabled);
                    if (lyricsView) lyricsView.classList.toggle('sync-disabled', !LyricSyncEngine.syncEnabled);

                    btn.onclick = (e) => {
                        e.stopPropagation();
                        LyricSyncEngine.syncEnabled = !LyricSyncEngine.syncEnabled;
                        btn.classList.toggle('active', LyricSyncEngine.syncEnabled);
                        if (lyricsView) lyricsView.classList.toggle('sync-disabled', !LyricSyncEngine.syncEnabled);
                        if (LyricSyncEngine.syncEnabled) LyricSyncEngine.lastKnownTime = -1;
                    };
                } else {
                    btn.style.display = 'none';
                    if (lyricsView) lyricsView.classList.add('sync-disabled'); // Force Reading Mode in Lite
                }
            }
        } else {
            textElem.innerHTML = `
                <div class="phrase active">${data.title}</div>
                <div class="phrase">${data.artist}</div>
                <div style="margin-top:20px;font-size:0.5em;opacity:0.7;">
                    Lyrics could not be extracted automatically.<br>
                    <a href="${data.url}" target="_blank" style="color:var(--primary);text-decoration:none;">
                        View on Genius →
                    </a>
                </div>`;
        }

        if (creditElem) {
            creditElem.innerHTML = `
                Lyrics via <a href="${data.url}" target="_blank"
                    style="color:inherit;text-decoration:underline;">Genius</a>
                <br><span style="font-size:0.8em;opacity:0.6;">${data.artist}</span>`;
        }
    },

    // ── Sync-offset control bar (injected below lyrics) ─────────────────────
    _injectOffsetUI() {
        const lv = document.getElementById('lyrics-view');
        if (!lv) return;
        lv.style.position = 'relative';

        let ctrl = document.getElementById('lyrics-sync-ctrl');
        if (!ctrl) {
            ctrl = document.createElement('div');
            ctrl.id = 'lyrics-sync-ctrl';
            ctrl.style.cssText = [
                'position:absolute', 'bottom:76px', 'left:50%',
                'transform:translateX(-50%)',
                'display:none', 'align-items:center', 'gap:5px',
                'background:rgba(0,0,0,0.60)',
                'backdrop-filter:blur(12px) saturate(160%)',
                '-webkit-backdrop-filter:blur(12px) saturate(160%)',
                'border:1px solid rgba(255,255,255,0.10)',
                'border-radius:20px', 'padding:5px 14px',
                'font-size:0.70em', 'color:rgba(255,255,255,0.58)',
                'z-index:20', 'user-select:none', 'white-space:nowrap',
                'pointer-events:auto'
            ].join(';');
            lv.appendChild(ctrl);
        }

        const bs = 'background:none;border:none;color:inherit;cursor:pointer;padding:1px 7px;font-size:1.2em;line-height:1;opacity:0.75;';
        ctrl.innerHTML = `
            <span id="sync-quality-dot"
                style="width:6px;height:6px;border-radius:50%;background:#555;display:inline-block;flex-shrink:0;"></span>
            <button style="${bs}" id="sync-earlier" title="Sync earlier  [ key">◀</button>
            <span id="sync-offset-display"
                style="min-width:46px;text-align:center;font-variant-numeric:tabular-nums;">±0.0s</span>
            <button style="${bs}" id="sync-later"   title="Sync later  ] key">▶</button>
            <button style="${bs}" id="sync-reset"   title="Reset offset  \\ key">⟳</button>`;

        document.getElementById('sync-earlier').onclick = () => LyricSyncEngine.adjustOffset(-0.5);
        document.getElementById('sync-later').onclick = () => LyricSyncEngine.adjustOffset(0.5);
        document.getElementById('sync-reset').onclick = () => LyricSyncEngine.adjustOffset(0, true);
    },

    renderError(msg) {
        const el = document.getElementById('lyrics-text');
        if (!el) return;
        if (!Store.geniusApiKey) {
            el.innerHTML = `
                <div class="phrase active" style="font-size:0.8em;">Genius API Key Missing</div>
                <div style="font-size:0.5em;opacity:0.7;margin-top:20px;">
                    Add your Genius API key in settings to view lyrics.<br>
                    <a href="https://genius.com/api-clients/new" target="_blank"
                       style="color:var(--primary);text-decoration:none;display:block;margin-top:10px;">
                        Get API Key →
                    </a>
                </div>`;
        } else {
            el.innerHTML = `<div class="phrase" style="color:#ff5555;">${msg}</div>`;
        }
    }
};


// ══════════════════════════════════════════════════════════════════════════════
// LyricSyncEngine  v4  —  Anchor-Based Elastic Sync
//
// Core algorithm breakthrough over v3:
//
//   v3 problem: fixed introSkipSec estimated from energy average → wrong for most songs.
//               Songs with 20s+ intros still drift 10-15s because the ratio-map
//               assumes lyrics start at ~5% of total duration.
//
//   v4 solution: ANCHOR SYSTEM
//     ┌──────────────────────────────────────────────────────────────────────┐
//     │ 1. firstVocalPhase — continuously scan for first real vocal onset.   │
//     │    When found: anchor[0] = {audioTime: T_vocal, lineIdx: 0}.         │
//     │    This pins line 0 to the ACTUAL moment vocals start.               │
//     │                                                                      │
//     │ 2. _rebuildAbsTimes() — distribute all line times proportionally     │
//     │    between consecutive anchors (elastic time segments).              │
//     │    Between anchor A and anchor B: weight-based distribution over     │
//     │    the exact audio duration of that segment.                         │
//     │                                                                      │
//     │ 3. As snaps accumulate, more anchors → narrower segments → higher    │
//     │    accuracy. After ~5 snaps the map is essentially correct.          │
//     │                                                                      │
//     │ 4. seekDetection — if user scrubs, rebuild time map from new pos.    │
//     │                                                                      │
//     │ 5. userOffset — per-track ±offset persisted to localStorage.         │
//     └──────────────────────────────────────────────────────────────────────┘
//
// Tunable constants (documented with reasoning below):
//   SMOOTH_ALPHA          0.30   EMA factor. Lower = smoother but more lag.
//   FLUX_MULTIPLIER       1.65   onset thr = avgFlux * this. Lower = more snaps.
//   FLUX_MIN_THRESHOLD    5.5    absolute floor — prevents spurious onsets in silence.
//   ONSET_CONFIRM_FRAMES  2      need N consecutive above-threshold frames.
//   ONSET_COOLDOWN_FRAMES 28     ~460ms@60fps. Min gap between two snaps.
//   SNAP_LEAD_SEC         2.2    snap window before expected line start (s).
//   SNAP_LAG_SEC          1.8    snap window after expected line start (s).
//   DRIFT_THRESHOLD       0.06   ratio from absEnd before drift correction.
//   INSTRUMENTAL_GAP_SEC  6.0    gap longer than this → instrumental-mode CSS.
//   FIRST_VOCAL_SCAN_SEC  35     max seconds before giving up on 1st vocal scan.
//   FIRST_VOCAL_MIN_E     20     min vocal-band energy to count as vocal onset.
//   FIRST_VOCAL_CONFIRM   3      consecutive frames for 1st-vocal confirmation.
//   MAX_ANCHORS           25     older anchors are pruned (FIFO).
// ══════════════════════════════════════════════════════════════════════════════
export const LyricSyncEngine = {

    // ── Tunable constants ──────────────────────────────────────────────────
    SMOOTH_ALPHA: 0.30,
    FLUX_MULTIPLIER: 1.65,
    FLUX_MIN_THRESHOLD: 5.5,
    ONSET_CONFIRM_FRAMES: 2,
    ONSET_COOLDOWN_FRAMES: 28,
    SNAP_LEAD_SEC: 2.2,
    SNAP_LAG_SEC: 1.8,
    DRIFT_THRESHOLD: 0.06,
    INSTRUMENTAL_GAP_SEC: 6.0,
    FIRST_VOCAL_SCAN_SEC: 35,
    FIRST_VOCAL_MIN_E: 20,
    FIRST_VOCAL_CONFIRM: 3,
    MAX_ANCHORS: 300,
    DEBUG: false,

    // ── State ──────────────────────────────────────────────────────────────
    animationId: null,
    trackId: null,
    totalLines: 0,
    activeIndex: -1,

    // linesData[i] = { idx, text, weight, absStart, absEnd }
    //   absStart/absEnd are in absolute audio seconds.
    //   Set to -1 until first anchor exists.
    linesData: [],
    totalWeight: 0,

    // Anchor system
    anchors: [],   // [{audioTime, lineIdx}] sorted by audioTime
    firstVocalFound: false,
    firstVocalCount: 0,    // consecutive onset frames in 1st-vocal scan
    firstOnsetPhase: true, // true until first vocal anchor confirmed

    // User sync offset (seconds, positive = audio is ahead of lyrics)
    userOffset: 0,
    _keysBound: false,

    // Frequency analysis
    prevSpectrum: null,
    smoothSpectrum: null,
    bands: {
        bass: { sum: 0, peak: 0 },
        vocal: { sum: 0, peak: 0 },
        treble: { sum: 0, peak: 0 }
    },
    fluxHistory: [],
    onsetCooldown: 0,
    onsetFrameCount: 0,

    // State flags
    inInstrumental: false,
    lastKnownTime: -1,

    // ─────────────────────────────────────────────────────────────────────
    log(tag, msg) {
        if (!this.DEBUG) return;
        const pe = window.PlayerEngine?.audio;
        const t = pe ? pe.currentTime : 0;
        const mm = Math.floor(t / 60);
        const ss = String(Math.floor(t % 60)).padStart(2, '0');
        console.log(
            `%c[LSE %c${mm}:${ss}%c] [${tag}] ${msg}`,
            'color:#1ed760;font-weight:bold;', 'color:#fff;', 'color:inherit;'
        );
    },

    syncEnabled: true,       // User toggle for auto-scroll/highlight

    // ── loadBakedMap()  ──────────────────────────────────────────────────
    //   Directly populates the line offsets from a pre-calculated sync file.
    loadBakedMap(bakedLines) {
        if (!this.linesData || !bakedLines) return;
        this.log('LOAD', `Incoming baked map: ${bakedLines.length} lines`);

        this.isBaked = true;
        this.firstOnsetPhase = false;
        this.firstVocalFound = true;

        bakedLines.forEach((baked, i) => {
            if (this.linesData[i]) {
                this.linesData[i].absStart = baked.absStart;
                this.linesData[i].absEnd = baked.absEnd;
                if (baked.wordTimes) this.linesData[i].wordTimes = baked.wordTimes;
                this.linesData[i].isMatched = true;
            }
        });

        // Quality check: ensure line0 has a valid absStart
        if (this.linesData[0].absStart === -1) {
            this.isBaked = false; // Corrupt map fallback
            this.log('LOAD', 'Baked map corrupt (line 0 missing time). Falling back to STT.');
            return;
        }

        this._updateQualityDot();
    },

    // ── start()  ─────────────────────────────────────────────────────────
    //   Called by LyricsManager.renderLyrics() after DOM is populated.
    start(totalLines, trackId) {
        // Only log warning if AI sync is intended. Otherwise just log info.
        const isAI = window.LyricsManager?.config?.rsync_enabled;
        if (isAI) console.warn('🎤 [LyricSyncEngine] AI Sync Active! lines:', totalLines);
        else console.log('[LyricSyncEngine] Init (Lite Mode) - lines:', totalLines);
        this.stop();

        this.totalLines = totalLines;
        this.trackId = trackId;
        this.activeIndex = -1;
        this.prevSpectrum = null;
        this.smoothSpectrum = null;
        this.fluxHistory = [];
        this.onsetCooldown = 0;
        this.onsetFrameCount = 0;
        this.inInstrumental = false;
        this.anchors = [];
        this.firstVocalFound = false;
        this.firstVocalCount = 0;
        this.firstOnsetPhase = true;
        this.isBaked = false;
        this.syncEnabled = true; // Default to sync on, but renderLyrics will check config
        this.lastKnownTime = -1;

        for (const k of Object.keys(this.bands)) this.bands[k] = { sum: 0, peak: 0 };

        // Restore per-track user offset
        this.userOffset = parseFloat(localStorage.getItem(`lyr_off_${trackId}`) || '0');
        this._updateOffsetDisplay();
        this._bindOffsetKeys();

        this._buildWeights();

        // If audio is already mid-song (lyrics panel opened during playback)
        const audio = window.PlayerEngine?.audio;
        if (audio && !isNaN(audio.duration) && audio.currentTime > 6) {
            this._midSongInit(audio.currentTime, audio.duration);
        }

        if (totalLines > 0 && (this.syncEnabled || this.isBaked)) {
            this.log('INIT', `${totalLines} lines · ${Math.round(this.totalWeight)} weight units`);
            this._loop();
        } else if (totalLines > 0) {
            this.log('INIT', 'Lite Mode (Static)');
        }
    },

    stop() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        this.animationId = null;
    },

    // ── addExternalAnchor()  ──────────────────────────────────────────────
    //   Called by LyricTranscriptEngine when a high-confidence STT match
    //   is found. Injects a verified anchor into the time map, immediately
    //   correcting any accumulated drift.
    //
    //   Guards:
    //   • Skips if an anchor already exists within 3s or 2 lines (dedup).
    //   • Anchors are sorted by audioTime after insertion.
    //   • HIGH confidence (>= 0.15) overcomes all heuristic data.
    addExternalAnchor(lineIdx, audioTime, confidence = 1.0) {
        if (this.isBaked) return; // Never anchor over a gold-standard baked map
        if (lineIdx < 0 || lineIdx >= this.linesData.length) return;

        const isHighConfidence = confidence >= 0.15;

        // If high confidence, wipe any nearby heuristic/snap anchors to let STT lead
        if (isHighConfidence) {
            this.anchors = this.anchors.filter(a => {
                // Keep other STT anchors, but wipe heuristics for this line or nearby time
                if (a.src === 'stt') return a.lineIdx !== lineIdx;
                return Math.abs(a.audioTime - audioTime) > 3.0 && a.lineIdx !== lineIdx;
            });

            if (lineIdx <= 1) {
                this.firstVocalFound = true;
                this.firstOnsetPhase = false;
            }
        } else {
            // Dedup for suggestions: skip if a close anchor already exists
            for (const a of this.anchors) {
                if (Math.abs(a.audioTime - audioTime) < 1.0) return;
                if (a.lineIdx === lineIdx) return;
            }
        }

        // Update linesData for baking confidence
        if (this.linesData[lineIdx]) {
            this.linesData[lineIdx].isMatched = true;
        }

        this.anchors.push({
            audioTime,
            lineIdx,
            src: isHighConfidence ? 'stt' : 'assist',
            conf: confidence
        });
        this.anchors.sort((a, b) => a.audioTime - b.audioTime);

        if (this.anchors.length > this.MAX_ANCHORS) this.anchors.shift();

        // If we anchor line 0 or 1, we are definitely out of the "pre-vocal" phase
        if (lineIdx <= 1 && !this.firstVocalFound) {
            this.firstVocalFound = true;
            this.firstOnsetPhase = false;
        }

        this._rebuildAbsTimes();
        this._updateQualityDot();
        this.log('ANCHOR', `+[${audioTime.toFixed(2)}s → L${lineIdx}]${force ? ' (FORCE)' : ''} total=${this.anchors.length}`);
    },

    // ── _buildWeights()  ─────────────────────────────────────────────────
    //   Compute per-line weights from text complexity.
    //   Weights determine proportional time within each anchor segment.
    //
    //   Weight formula:
    //     w = max(MIN_W, charLen * 0.45 + wordCount * 3.2 + sylCount * 1.1)
    //   Section breaks (lyric-section-label) contribute GAP_W to the pool
    //   without becoming their own sync line — they just add time around them.
    _buildWeights() {
        this.linesData = [];
        this.totalWeight = 0;

        const CHAR_W = 0.45, WORD_W = 3.2, SYL_W = 1.1;
        const MIN_W = 5, GAP_W = 7;

        const allChildren = Array.from(document.getElementById('lyrics-text')?.children || []);
        let idx = 0;
        let cumW = 0;

        for (const el of allChildren) {
            if (el.classList.contains('lyric-section-label')) {
                cumW += GAP_W;
            } else if (el.classList.contains('lyric-line')) {
                const text = el.innerText?.trim() || '';
                const words = text.split(/\s+/).filter(Boolean);
                const syls = (text.match(/[aeıioöuüAEIİOÖUÜaeiou]/g) || []).length;
                const w = Math.max(MIN_W, text.length * CHAR_W + words.length * WORD_W + syls * SYL_W);

                this.linesData.push({
                    idx,
                    text,
                    weight: w,
                    cumWeightBefore: cumW,   // for proportional interpolation
                    absStart: -1,
                    absEnd: -1
                });
                cumW += w;
                idx++;
            }
        }
        this.totalWeight = cumW;
        this.log('WEIGHTS', `${this.linesData.length} lines · totalWeight=${Math.round(cumW)}`);
    },

    // ── _rebuildAbsTimes()  ──────────────────────────────────────────────
    //   THE key operation in v4.
    //   Uses the anchors array as fixed time constraints.
    //   Between consecutive anchors lines are distributed by weight ratio.
    //   After the last anchor we use (songDuration − outroSec) as an
    //   implicit end-anchor so all remaining lines get real times.
    _rebuildAbsTimes() {
        if (this.isBaked) return; // Skip weight distribution for baked tracks
        if (!this.linesData.length || !this.anchors.length) return;

        const audio = window.PlayerEngine?.audio;
        const totalDur = audio?.duration || 0;
        if (!totalDur) return;

        const outroSec = Math.min(8, totalDur * 0.038);
        const songEnd = totalDur - outroSec;

        // Work on a sorted copy + implicit end sentinel
        const sorted = [...this.anchors].sort((a, b) => a.lineIdx - b.lineIdx);
        const allA = [...sorted, { audioTime: songEnd, lineIdx: this.totalLines }];

        // ── Segment pass ─────────────────────────────────────────────────
        for (let i = 0; i < allA.length - 1; i++) {
            const aS = allA[i], aE = allA[i + 1];
            if (aS.lineIdx >= aE.lineIdx) continue;

            const segLines = this.linesData.filter(l => l.idx >= aS.lineIdx && l.idx < aE.lineIdx);
            if (!segLines.length) continue;

            const segW = segLines.reduce((s, l) => s + l.weight, 0) || 1;
            const segDur = Math.max(0.1, aE.audioTime - aS.audioTime);
            const tS = aS.audioTime;

            let cum = 0;
            for (const line of segLines) {
                line.absStart = tS + (cum / segW) * segDur;
                line.absEnd = tS + ((cum + line.weight) / segW) * segDur;
                cum += line.weight;
            }
        }

        // ── Lines before first real anchor ───────────────────────────────
        const firstReal = sorted[0];
        if (firstReal.lineIdx > 0) {
            const before = this.linesData.filter(l => l.idx < firstReal.lineIdx);
            if (before.length) {
                const bW = before.reduce((s, l) => s + l.weight, 0) || 1;
                // Estimate a reasonable time window before the first anchor
                // using the avg seconds-per-weight of the first segment
                const firstSeg = this.linesData.filter(l => l.idx >= firstReal.lineIdx && l.idx < (allA[1]?.lineIdx ?? this.totalLines));
                const fsW = firstSeg.reduce((s, l) => s + l.weight, 0) || bW;
                const fsDur = Math.max(0.1, (allA[1]?.audioTime ?? songEnd) - firstReal.audioTime);
                const spw = fsDur / fsW;  // seconds per weight unit in first segment
                const tWin = Math.min(firstReal.audioTime, bW * spw);
                const tBStart = firstReal.audioTime - tWin;

                let cum = 0;
                for (const line of before) {
                    line.absStart = tBStart + (cum / bW) * tWin;
                    line.absEnd = tBStart + ((cum + line.weight) / bW) * tWin;
                    cum += line.weight;
                }
            }
        }

        this.log('REBUILD', `anchors=${sorted.length} · line0@${this.linesData[0]?.absStart.toFixed(2)}s`);
    },

    // ── _addAnchor()  ────────────────────────────────────────────────────
    //   Add a confirmed sync point and rebuild the time map.
    _addAnchor(audioTime, lineIdx) {
        // Prevent duplicate or invalid anchors
        const last = this.anchors[this.anchors.length - 1];
        if (last && last.audioTime >= audioTime) return;  // time must advance
        if (last && last.lineIdx >= lineIdx) return;  // lines must advance

        this.anchors.push({ audioTime, lineIdx });
        if (this.anchors.length > this.MAX_ANCHORS) this.anchors.shift();
        this._rebuildAbsTimes();
        this._updateQualityDot();
        this.log('ANCHOR', `+[${audioTime.toFixed(2)}s → L${lineIdx}] total=${this.anchors.length}`);
    },

    // ── _midSongInit()  ──────────────────────────────────────────────────
    //   When the lyrics panel is opened mid-song, we can't wait for first-
    //   vocal detection.  Instead we place two heuristic anchors:
    //     anchor[0]: first line at heuristic intro end (4% of duration)
    //     anchor[1]: current position mapped by proportional weight
    _midSongInit(currentTime, duration) {
        this.firstOnsetPhase = false;
        this.firstVocalFound = true;

        const outroSec = Math.min(8, duration * 0.038);
        const introSec = Math.min(15, duration * 0.04);
        const activeDur = duration - introSec - outroSec;

        // Estimate which line we're at right now via weight ratio
        const ratio = Math.max(0, Math.min(1, (currentTime - introSec) / activeDur));
        const targetCum = ratio * this.totalWeight;

        let guessLine = 0;
        let cum = 0;
        for (const line of this.linesData) {
            cum += line.weight;
            if (cum >= targetCum) { guessLine = line.idx; break; }
        }

        this.anchors = [
            { audioTime: introSec, lineIdx: 0, src: 'heuristic' },
            { audioTime: currentTime, lineIdx: guessLine, src: 'heuristic' }
        ];
        this._rebuildAbsTimes();
        this._setActiveIndex(guessLine);
        this.log('MID_OPEN', `t=${currentTime.toFixed(1)}s → L${guessLine}`);
    },

    // ── adjustOffset()  ──────────────────────────────────────────────────
    //   User-controlled timing correction.
    //   Positive offset: lyrics appear earlier relative to audio.
    //   Negative offset: lyrics appear later relative to audio.
    adjustOffset(delta, reset = false) {
        this.userOffset = reset ? 0 : Math.max(-20, Math.min(20, this.userOffset + delta));
        if (this.trackId)
            localStorage.setItem(`lyr_off_${this.trackId}`, this.userOffset);
        this._updateOffsetDisplay();
        this.log('OFFSET', `${this.userOffset.toFixed(1)}s`);
    },

    _updateOffsetDisplay() {
        const el = document.getElementById('sync-offset-display');
        if (!el) return;
        const v = this.userOffset;
        el.textContent = `${v > 0 ? '+' : v < 0 ? '' : '±'}${v.toFixed(1)}s`;
        el.style.color = v !== 0 ? 'rgba(30,215,96,0.95)' : 'rgba(255,255,255,0.58)';
    },

    _updateQualityDot() {
        const dot = document.getElementById('sync-quality-dot');
        if (!dot) return;
        const n = this.anchors.length;
        dot.style.background = n >= 4 ? '#1ed760' : n >= 2 ? '#f0a030' : '#888';
        dot.title = `Sync anchors: ${n}`;
    },

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    _bindOffsetKeys() {
        if (this._keysBound) return;
        this._keysBound = true;
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || !Store.lyricsOpen) return;
            if (e.code === 'BracketLeft') { e.preventDefault(); this.adjustOffset(-0.5); }
            if (e.code === 'BracketRight') { e.preventDefault(); this.adjustOffset(0.5); }
            if (e.code === 'Backslash') { e.preventDefault(); this.adjustOffset(0, true); }
        });
    },

    // ── _loop()  —  main RAF loop ─────────────────────────────────────────
    _loop() {
        this.animationId = requestAnimationFrame(() => this._loop());

        if (!window.Store?.lyricsOpen) return;

        const _PE = window.PlayerEngine;
        if (!_PE?.analyser || !_PE?.audio) return;

        const audio = _PE.audio;
        if (audio.paused || audio.readyState < 2 || !audio.duration) return;

        const now = audio.currentTime;

        // ── 1. Seek detection ──────────────────────────────────────────
        if (this.lastKnownTime >= 0 && Math.abs(now - this.lastKnownTime) > 2.8) {
            this.log('SEEK', `${this.lastKnownTime.toFixed(1)}s → ${now.toFixed(1)}s`);
            this._handleSeek(now, audio.duration);
        }
        this.lastKnownTime = now;

        // ── 2. Spectrum smoothing ──────────────────────────────────────
        const analyser = _PE.analyser;
        const binCount = analyser.frequencyBinCount;
        const rawData = new Uint8Array(binCount);
        analyser.getByteFrequencyData(rawData);

        if (!this.smoothSpectrum || this.smoothSpectrum.length !== binCount) {
            this.smoothSpectrum = new Float32Array(rawData);
            this.prevSpectrum = new Float32Array(rawData);
        }
        for (let i = 0; i < binCount; i++) {
            this.smoothSpectrum[i] += (rawData[i] - this.smoothSpectrum[i]) * this.SMOOTH_ALPHA;
        }

        // ── 3. Multi-band energy ───────────────────────────────────────
        const sampleRate = _PE.ctx?.sampleRate || 44100;
        const binHz = sampleRate / (analyser.fftSize || 512);

        const bassFrom = Math.floor(60 / binHz);
        const bassTo = Math.min(Math.floor(250 / binHz), binCount);
        const vocalFrom = Math.floor(250 / binHz);
        const vocalTo = Math.min(Math.floor(4000 / binHz), binCount);
        const trebleFrom = Math.floor(4000 / binHz);
        const trebleTo = Math.min(Math.floor(12000 / binHz), binCount);

        this._updateBand('bass', bassFrom, bassTo);
        this._updateBand('vocal', vocalFrom, vocalTo);
        this._updateBand('treble', trebleFrom, trebleTo);

        const vocalE = this.bands.vocal.sum;
        const bassE = this.bands.bass.sum;

        // ── 4. Spectral flux  (vocal-dominant, wideband secondary) ─────
        let vFlux = 0, wFlux = 0;
        if (this.prevSpectrum) {
            for (let i = vocalFrom; i < vocalTo; i++) {
                const d = this.smoothSpectrum[i] - this.prevSpectrum[i];
                if (d > 0) vFlux += d;
            }
            vFlux /= Math.max(1, vocalTo - vocalFrom);

            for (let i = bassFrom; i < trebleTo; i++) {
                const d = this.smoothSpectrum[i] - this.prevSpectrum[i];
                if (d > 0) wFlux += d;
            }
            wFlux /= Math.max(1, trebleTo - bassFrom);
        }
        this.prevSpectrum.set(this.smoothSpectrum);

        const flux = vFlux * 0.72 + wFlux * 0.28;

        this.fluxHistory.push(flux);
        if (this.fluxHistory.length > 90) this.fluxHistory.shift();
        const avgFlux = this.fluxHistory.reduce((a, b) => a + b, 0) / this.fluxHistory.length;
        const fluxThr = Math.max(avgFlux * this.FLUX_MULTIPLIER, this.FLUX_MIN_THRESHOLD);

        // ── 5. Onset confidence gate ───────────────────────────────────
        if (this.onsetCooldown > 0) this.onsetCooldown--;
        const aboveThr = flux > fluxThr && vocalE > 11;
        this.onsetFrameCount = aboveThr ? this.onsetFrameCount + 1 : 0;
        const isOnset = (this.onsetFrameCount >= this.ONSET_CONFIRM_FRAMES) &&
            (this.onsetCooldown === 0);

        // ── 6. First-vocal detection phase ─────────────────────────────
        //   We stay in this phase until the first real vocal onset is
        //   confirmed.  Only visual pulse runs here — no snapping yet.
        if (this.firstOnsetPhase) {
            this._detectFirstVocal(now, vocalE, flux, fluxThr);
            this._applyVisualPulse(vocalE, bassE);
            return;
        }

        // ── 7. Adjusted time (with user offset) ───────────────────────
        const adjT = now + this.userOffset;

        // ── 8. Sync Logic (Snap vs Baked) ─────────────────────────────
        this._runSnapLogic(now, adjT, isOnset, flux, fluxThr, vocalE, bassE);
    },

    // ── _runSnapLogic()  ───────────────────────────────────────────────
    _runSnapLogic(now, adjT, isOnset, flux, fluxThr, vocalE, bassE) {
        let expectedIdx = -1;
        let foundLine = null;

        for (const line of this.linesData) {
            if (line.absStart < 0) continue; // not yet mapped

            // Time-map: is this the current expected line?
            if (adjT >= line.absStart && adjT <= line.absEnd) {
                expectedIdx = line.idx;
                foundLine = line;
            }

            if (this.isBaked) continue; // Skip snapping for baked maps

            // Snap: onset detected AND we're within the snap window for this line
            if (
                isOnset &&
                this.activeIndex < line.idx &&
                adjT >= line.absStart - this.SNAP_LEAD_SEC &&
                adjT <= line.absStart + this.SNAP_LAG_SEC
            ) {
                this.log('SNAP', `"${line.text.slice(0, 32)}" flux=${flux.toFixed(1)} thr=${fluxThr.toFixed(1)}`);
                this.onsetCooldown = this.ONSET_COOLDOWN_FRAMES;
                this.onsetFrameCount = 0;
                this._addAnchor(now, line.idx);
                this._setActiveIndex(line.idx);
                expectedIdx = line.idx;
                foundLine = line;
                break;
            }
        }

        // ── 9. Force-advance if time map says we're behind ─────────────
        if (expectedIdx !== -1 && expectedIdx !== this.activeIndex) {
            if (this.activeIndex < expectedIdx) {
                this.log('FORCE', `L${this.activeIndex} → L${expectedIdx} "${foundLine?.text?.slice(0, 28)}"`);
                this._setActiveIndex(expectedIdx);
            }
        }

        // ── 10. Drift correction ───────────────────────────────────────
        if (expectedIdx === -1 && this.activeIndex >= 0) {
            const activeLine = this.linesData[this.activeIndex];
            if (activeLine && activeLine.absEnd > 0) {
                const overrun = adjT - activeLine.absEnd;
                const lineDur = activeLine.absEnd - activeLine.absStart;
                if (overrun > lineDur + 1.0) {
                    let closest = null, minDist = Infinity;
                    for (const l of this.linesData) {
                        if (l.idx <= this.activeIndex || l.absStart < 0) continue;
                        const d = Math.abs(l.absStart - adjT);
                        if (d < minDist) { minDist = d; closest = l; }
                    }
                    if (closest && minDist < 9) {
                        this.log('DRIFT', `overrun=${overrun.toFixed(1)}s → L${closest.idx} "${closest.text.slice(0, 28)}"`);
                        this._setActiveIndex(closest.idx);
                    }
                }
            }
        }

        // ── 11. Instrumental gap detection ────────────────────────────
        if (expectedIdx === -1 && this.activeIndex >= 0) {
            const next = this.linesData[this.activeIndex + 1];
            if (next && next.absStart > 0) {
                const gap = next.absStart - adjT;
                if (gap > this.INSTRUMENTAL_GAP_SEC && !this.inInstrumental) {
                    this.inInstrumental = true;
                    document.getElementById('lyrics-text')?.classList.add('instrumental-mode');
                    this.log('GAP', `${gap.toFixed(1)}s gap → instrumental mode`);
                }
            }
        } else if (expectedIdx !== -1 && this.inInstrumental) {
            this.inInstrumental = false;
            document.getElementById('lyrics-text')?.classList.remove('instrumental-mode');
            this.log('GAP', 'vocals resumed');
        }

        // ── 12. Karaoke word highlighting + visual pulse ───────────────
        if (this.activeIndex !== -1 && this.linesData[this.activeIndex]) {
            this._updateWordHighlighting(adjT);
        }
        this._applyVisualPulse(vocalE, bassE);
    },

    _updateWordHighlighting(adjT) {
        const line = this.linesData[this.activeIndex];
        if (!line?.wordTimes?.length) return;

        const container = document.getElementById('lyrics-text');
        const lineEl = container.querySelector(`[data-index="${this.activeIndex}"]`);
        if (!lineEl) return;

        const wordSpans = lineEl.querySelectorAll('.word');
        line.wordTimes.forEach((wt, i) => {
            if (wordSpans[i]) {
                const isActive = adjT >= wt.start && adjT <= wt.end;
                if (wordSpans[i].classList.contains('active') !== isActive) {
                    wordSpans[i].classList.toggle('active', isActive);
                }
            }
        });
    },

    // ── _detectFirstVocal()  ─────────────────────────────────────────────
    //   Phase 1 of v4.  Runs every frame until first vocal onset confirmed.
    //
    //   Why 3 consecutive frames?
    //     Instrumental transients (drum hit, piano chord) tend to cause 1-2
    //     frame spikes. Vocal syllables sustain for ≥3 frames at 60fps.
    //     This eliminates most false positives during intros.
    //
    //   Fallback:
    //     If no vocal onset found before FIRST_VOCAL_SCAN_SEC, we assume the
    //     song has an extremely clean intro or very quiet vocals, and anchor
    //     line 0 at the current audio time.
    _detectFirstVocal(now, vocalE, flux, fluxThr) {
        // Skip the first 1.5s to avoid start-of-track transients
        if (now < 1.5) return;

        if (now > this.FIRST_VOCAL_SCAN_SEC) {
            this.log('FIRST_VOCAL', `Timeout at ${now.toFixed(1)}s — anchoring to current pos`);
            this._confirmFirstVocal(Math.max(0.5, now));
            return;
        }

        // Vocal onset: energy in vocal band + significant flux
        // The vocalE > bassE * 0.8 condition helps avoid pure bass/drum hits
        const isVocalBurst = vocalE > this.FIRST_VOCAL_MIN_E &&
            flux > fluxThr * 1.05 &&
            vocalE > this.bands.bass.sum * 0.75;

        if (isVocalBurst) {
            this.firstVocalCount++;
            if (this.firstVocalCount >= this.FIRST_VOCAL_CONFIRM) {
                // Slight lag compensation (~50ms onset delay from smoothing)
                const onsetTime = Math.max(0, now - 0.06);
                this.log('FIRST_VOCAL', `Detected at ${onsetTime.toFixed(2)}s (vE=${vocalE.toFixed(1)})`);
                this._confirmFirstVocal(onsetTime);
            }
        } else {
            this.firstVocalCount = 0;
        }
    },

    _confirmFirstVocal(time) {
        this.firstVocalFound = true;
        this.firstOnsetPhase = false;
        this.firstVocalCount = 0;
        this.onsetFrameCount = 0;
        // Keep existing STT anchors — only reset heuristics
        const keepStt = this.anchors.filter(a => a.src === 'stt');
        this.anchors = [{ audioTime: time, lineIdx: 0, src: 'heuristic' }, ...keepStt];
        this.anchors.sort((a, b) => a.audioTime - b.audioTime);
        this._rebuildAbsTimes();
        this._updateQualityDot();
    },

    // ── _handleSeek()  ────────────────────────────────────────────────────
    //   Called when a large time jump is detected.
    //   Prunes anchors that are no longer valid, then places a new
    //   heuristic anchor at the seek target.
    _handleSeek(newTime, duration) {
        if (this.isBaked) {
            const adjT = newTime + this.userOffset;
            let closest = null, minDist = Infinity;
            for (const l of this.linesData) {
                const d = Math.abs(l.absStart - adjT);
                if (d < minDist) { minDist = d; closest = l; }
            }
            if (closest) this._setActiveIndex(closest.idx);
            return;
        }

        // If abs times haven't been built yet, reset to first-vocal scan
        if (!this.linesData.length || this.linesData[0].absStart < 0) {
            this.anchors = [];
            this.firstVocalFound = false;
            this.firstOnsetPhase = true;
            this.firstVocalCount = 0;
            return;
        }

        // Prune anchors that are after the seek point (they're no longer trustworthy)
        this.anchors = this.anchors.filter(a => a.audioTime < newTime - 0.5);

        // Find the closest mapped line to the new position
        const adjT = newTime + this.userOffset;
        let closest = null, minDist = Infinity;
        for (const l of this.linesData) {
            if (l.absStart < 0) continue;
            const d = Math.abs(l.absStart - adjT);
            if (d < minDist) { minDist = d; closest = l; }
        }

        if (closest) {
            // Add a soft anchor at the seek position
            this.anchors.push({ audioTime: newTime, lineIdx: closest.idx, src: 'heuristic' });
            if (this.anchors.length > this.MAX_ANCHORS) this.anchors.shift();
            this._rebuildAbsTimes();
            this._setActiveIndex(closest.idx);
            this.log('SEEK', `Anchored to L${closest.idx} dist=${minDist.toFixed(1)}s`);
        } else {
            // Totally unmapped — rebuild from scratch as mid-song init
            this.anchors = [];
            this._midSongInit(newTime, duration);
        }
        this._updateQualityDot();
    },

    // ── _updateBand()  ────────────────────────────────────────────────────
    _updateBand(name, from, to) {
        let sum = 0;
        const count = Math.max(1, to - from);
        for (let i = from; i < to; i++) sum += this.smoothSpectrum[i];
        const band = this.bands[name];
        band.sum = sum / count;
        band.peak = Math.max(band.peak * 0.975, band.sum);
    },

    // ── _applyVisualPulse()  ──────────────────────────────────────────────
    //   Scale + glow on the active lyric line driven by vocal + bass energy.
    //   Scale capped at 1.13× to avoid layout shifts.
    //   Glow colour shifts white when vocal energy is very high.
    _applyVisualPulse(vocalE, bassE) {
        const el = document.querySelector(`.lyric-line[data-index="${this.activeIndex}"]`);
        if (!el) return;

        const vNorm = Math.min(1, vocalE / 110);
        const bNorm = Math.min(1, bassE / Math.max(this.bands.bass.peak, 70));
        const scale = Math.min(1.13, 1 + vNorm * 0.10 + bNorm * 0.03);
        const gClr = vNorm > 0.85 ? '255,255,255' : '30,215,96';
        const gAlpha = (vNorm * 0.62).toFixed(2);

        el.style.transform = `scale(${scale.toFixed(3)})`;
        el.style.textShadow = [
            `0 0 ${(vNorm * 9).toFixed(1)}px rgba(255,255,255,${(vNorm * 0.9).toFixed(2)})`,
            `0 0 ${(vNorm * 38).toFixed(1)}px rgba(${gClr},${gAlpha})`
        ].join(', ');
    },

    // ── _setActiveIndex()  ────────────────────────────────────────────────
    _setActiveIndex(idx) {
        if (!this.syncEnabled) return;
        if (this.activeIndex === idx) return;
        this.activeIndex = idx;

        const container = document.getElementById('lyrics-text');
        if (!container) return;

        container.querySelectorAll('.lyric-line').forEach(el => {
            el.classList.remove('active', 'past');
            const i = parseInt(el.getAttribute('data-index'));
            if (i < idx) el.classList.add('past');
            if (i === idx) el.classList.add('active');
            if (i !== idx) { el.style.transform = ''; el.style.textShadow = ''; }
        });

        container.querySelector(`.lyric-line[data-index="${idx}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// LyricTranscriptEngine  —  STT-driven sync anchor injector
//
//  Runs in parallel with LyricSyncEngine.  The energy engine handles frame-
//  level tracking; this engine provides high-confidence ground-truth anchors
//  every ~8 seconds by transcribing the actual audio and matching the result
//  against the lyric text.
//
//  Pipeline:
//   1. Tap the existing AudioContext via a MediaStreamDestinationNode
//      (no extra latency, no microphone permission required).
//   2. MediaRecorder captures rolling CHUNK_MS chunks with OVERLAP_MS rewind
//      so lyric boundaries are never clipped between chunks.
//   3. POST /api/transcribe { audio: Blob, start_time, end_time }
//      Expected response: { text: "…" }
//      (Whisper, Vosk, or any STT — see backend notes below.)
//   4. Transcript is split into tokens, then a sliding window of 1–WINDOW_SIZE
//      consecutive lyric lines is tested for similarity.
//   5. Similarity = Jaccard(words) * 0.55 + Jaccard(bigrams) * 0.45
//      Bigrams reward word-order matches (critical for chorus repetitions).
//   6. Best match above MIN_SIMILARITY → addExternalAnchor() on LyricSyncEngine.
//
//  Backend endpoint contract  (/api/transcribe):
//   Method : POST
//   Body   : FormData { audio: Blob (webm/opus), start_time: str, end_time: str }
//   Returns: { text: "transcribed lyrics here" }
//            or { transcript: "…" }  (both accepted)
//   Errors : any non-2xx response is silently ignored.
//
//  If the endpoint returns 404 on a HEAD check, the engine disables itself for
//  the entire session — zero overhead when backend support is absent.
// ══════════════════════════════════════════════════════════════════════════════
export const LyricTranscriptEngine = {

    // ── Tunable constants ──────────────────────────────────────────────────
    MIN_SIMILARITY: 0.18,    // Lowered for Rap/Fast-vocal tolerance
    MIN_WORDS: 2,            // Lowered to catch short rap phrases
    WINDOW_SIZE: 5,          // Increased to improve context matching
    ENDPOINT: '/api/lyrics/sync/stream',
    SAVE_ENDPOINT: '/api/lyrics/sync/save',
    DEBUG: true,

    // ── State ──────────────────────────────────────────────────────────────
    active: false,
    _source: null,           // EventSource
    language: null,          // Pre-detected language hint for STT
    prompt: null,            // Vocabulary context for STT
    lastMatchedIdx: -1,      // Sequential "Puzzle" tracker

    // ─────────────────────────────────────────────────────────────────────
    log(tag, msg) {
        if (!this.DEBUG) return;
        console.log(`%c[LTE][${tag}] ${msg}`, 'color:#e14d8e;font-weight:bold;');
    },

    // ── start()  ─────────────────────────────────────────────────────────
    //   Called by LyricsManager.renderLyrics() after DOM is ready.
    async start() {
        console.warn('🔥 [LyricTranscriptEngine] START SSE CALLED!');
        this.stop();
        this.active = true;
        this.lastMatchedIdx = -1; // Reset puzzle tracker

        const trackId = window.Store?.currentTrack?.track_id;
        if (!trackId) return;

        // 1. Pre-detect language from stored lyrics (improves Whisper accuracy/speed)
        const lines = window.LyricSyncEngine?.linesData || [];
        const fullText = lines.map(l => l.text).join(' ');
        this.language = this._detectLanguage(fullText);
        this.prompt = fullText.slice(0, 400); // 400 chars of context
        if (this.language) this.log('LANG', `Language locked to: ${this.language}`);

        const params = new URLSearchParams({ track_id: trackId });
        if (this.language) params.append('language', this.language);
        if (this.prompt) params.append('prompt', this.prompt);

        this.log('INIT', `Connecting to SSE Stream for ${trackId}`);
        this._source = new EventSource(`${this.ENDPOINT}?${params.toString()}`);

        this._source.addEventListener('DONE', () => {
            this.log('STREAM', 'Completed.');
            this._saveSync();
            this.stop();
        });

        this._source.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.error) {
                    this.log('ERR', data.error);
                    this.stop();
                    return;
                }

                // If the server returns a pre-baked Aligned Map, use it and stop!
                if (data.is_aligned && data.lines) {
                    this.log('LOAD', 'Unified Sync Map loaded from disk. STT bypassed.');
                    window.LyricSyncEngine?.loadBakedMap(data.lines);
                    this.stop();
                    return;
                }

                if (data.text) {
                    this.log('TRANSCRIPT', `[${data.start.toFixed(1)}s - ${data.end.toFixed(1)}s] "${data.text.slice(0, 80)}"`);
                    this._matchAndAnchor(data.text, data.start, data.end, data.words || []);
                }
            } catch (err) { }
        };

        this._source.onerror = () => {
            if (this.active) {
                this.log('ERR', 'SSE Connection lost or failed.');
                this.stop();
            }
        };
    },

    // ── stop()  ──────────────────────────────────────────────────────────
    stop() {
        this.active = false;
        if (this._source) {
            this._source.close();
            this._source = null;
        }
    },

    // ── _matchAndAnchor()  ───────────────────────────────────────────────
    //   Slide a window of 1–WINDOW_SIZE consecutive lyric lines over
    //   the transcript, pick the best-scoring window, then anchor its
    //   first line at startTime (with a small lead compensation).
    //
    //   Time-range guard:
    //     If absStart has been computed by LyricSyncEngine, we skip lines
    //     clearly outside [startTime - 8s, endTime + 8s].  This avoids
    //     false positives from repeated chorus lines elsewhere in the song.
    _matchAndAnchor(transcript, startTime, endTime, words = []) {
        const syncEngine = window.LyricSyncEngine;
        const lines = syncEngine.linesData;
        if (!lines?.length) return;

        const tWords = this._tokenize(transcript);
        if (tWords.length < this.MIN_WORDS) return;

        const TIME_GUARD = 8; // seconds either side
        let bestScore = 0, bestStartIdx = -1, bestWindowSize = 1;

        for (let w = 1; w <= Math.min(this.WINDOW_SIZE, lines.length); w++) {
            for (let i = 0; i <= lines.length - w; i++) {
                const first = lines[i];
                const last = lines[i + w - 1];

                // 1. Time-range guard (only when abs times are known)
                if (first.absStart > 0 && first.absStart > endTime + TIME_GUARD) break;
                if (last.absEnd > 0 && last.absEnd < startTime - TIME_GUARD) continue;

                const combined = lines.slice(i, i + w).map(l => l.text).join(' ');
                const lWords = this._tokenize(combined);

                // 2. Base Similarity (Bigram-Weighted for repetitive lines)
                let score = this._similarity(tWords, lWords);

                // 3. Sequential Puzzle Bias (Prevents jumping to similar lines elsewhere)
                if (this.lastMatchedIdx !== -1) {
                    const dist = Math.abs(i - (this.lastMatchedIdx + 1));
                    if (dist > 15) {
                        score *= 0.70; // Heavy penalty for "jumping" more than 15 lines
                    } else if (dist > 1) {
                        score *= (1.0 - (dist * 0.015)); // Linear penalty for distance
                    } else if (dist === 0) {
                        score *= 1.12; // Bonus for the EXACT next line (Sequential Puzzle Piece)
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestStartIdx = i;
                    bestWindowSize = w;
                }
            }
        }

        if (bestScore < this.MIN_SIMILARITY || bestStartIdx === -1) {
            this.log('MATCH', `No confident match (best=${bestScore.toFixed(3)})`);
            return;
        }

        const bestLines = lines.slice(bestStartIdx, bestStartIdx + bestWindowSize);
        this.log('MATCH',
            `L${bestStartIdx}+${bestWindowSize}  score=${bestScore.toFixed(3)} ` +
            `"${bestLines[0].text.slice(0, 40)}..."`
        );

        // --- High-Precision Word Alignment (Karaoke Sync) ---
        const wWords = words.filter(w => w.word.trim().length > 0);
        let currentWindowStartTime = startTime;

        bestLines.forEach((line, offset) => {
            const lineIdx = bestStartIdx + offset;
            const lWords = this._tokenize(line.text);

            let lineOnset = -1;
            let lineOffset = -1;

            if (wWords.length > 0) {
                // ── Precise Word Mapping & Boundary Extrapolation ────────────────
                // We don't just take min/max; we see WHERE in the line the matches are.
                let firstMatch = null, lastMatch = null;
                let matchedGeniusIndices = [];

                lWords.forEach((lw, lIdx) => {
                    const match = wWords.find(ww => {
                        const sstW = ww.word.toLowerCase().replace(/[.,!?;:]/g, '');
                        const genW = lw.toLowerCase();
                        return sstW === genW || (sstW.length >= 3 && genW.length >= 3 && sstW.slice(0, 3) === genW.slice(0, 3));
                    });
                    if (match) {
                        matchedGeniusIndices.push(lIdx);
                        if (!firstMatch || match.start < firstMatch.start) firstMatch = match;
                        if (!lastMatch || match.end > lastMatch.end) lastMatch = match;
                    }
                });

                if (firstMatch && lastMatch) {
                    // How many characters did we actually "confirm"?
                    const matchedText = lWords.filter((_, i) => matchedGeniusIndices.includes(i)).join('');
                    const totalText = lWords.join('');
                    const matchedDur = Math.max(0.1, lastMatch.end - firstMatch.start);

                    // Estimate "seconds per character" for this specific speaker/line
                    const spc = matchedDur / Math.max(1, matchedText.length);

                    // Extrapolate Start: If we missed the first word, move start back by SPG * chars_missed
                    const charsBefore = lWords.filter((_, i) => i < Math.min(...matchedGeniusIndices)).join('').length;
                    lineOnset = Math.max(startTime, firstMatch.start - (charsBefore * spc));

                    // Extrapolate End: If we missed the last word, move end forward
                    const charsAfter = lWords.filter((_, i) => i > Math.max(...matchedGeniusIndices)).join('').length;
                    lineOffset = Math.min(endTime, lastMatch.end + (charsAfter * spc));
                }
            }

            // Final fallback to interpolation if no words matched for this specific line
            const finalStart = (lineOnset !== -1) ? lineOnset : currentWindowStartTime;

            // Anchor each line in the window with our Jaccard confidence score
            syncEngine.addExternalAnchor(lineIdx, finalStart, bestScore);
            this.lastMatchedIdx = lineIdx; // Update sequential tracker

            // Calculate duration
            let finalDur;
            if (lineOnset !== -1 && lineOffset !== -1) {
                finalDur = lineOffset - lineOnset;
            } else {
                const totalWordsInWindow = bestLines.reduce((acc, bl) => acc + this._tokenize(bl.text).length, 0);
                finalDur = (lWords.length / totalWordsInWindow) * (endTime - startTime);
            }

            if (syncEngine.linesData[lineIdx]) {
                syncEngine.linesData[lineIdx].absEnd = finalStart + finalDur;
                syncEngine.linesData[lineIdx].isMatched = true;

                // Store word-level timestamps for Karaoke highlighting
                if (lineOnset !== -1) {
                    syncEngine.linesData[lineIdx].wordTimes = wWords
                        .filter(ww => {
                            const sstW = ww.word.toLowerCase().replace(/[.,!?;:]/g, '');
                            return lWords.some(lw => {
                                const genW = lw.toLowerCase();
                                return sstW === genW || (sstW.length >= 3 && genW.length >= 3 && sstW.slice(0, 3) === genW.slice(0, 3));
                            });
                        })
                        .map(ww => ({ start: ww.start, end: ww.end }));
                }
            }

            // Increment fallback tracker
            currentWindowStartTime = finalStart + finalDur;
        });
    },

    // ── _saveSync()  ─────────────────────────────────────────────────────
    //   POSTs the current state of aligned lyrics to the backend for baking.
    async _saveSync() {
        const syncEngine = window.LyricSyncEngine;
        if (!syncEngine || !syncEngine.linesData.length) return;

        // Bake if we have enough high-precision anchors from the STT engine
        const sttAnchors = (syncEngine.anchors || []).filter(a => a.src === 'stt');
        const uniqueLinesAnchored = new Set(sttAnchors.map(a => a.lineIdx)).size;
        const ratio = uniqueLinesAnchored / syncEngine.linesData.length;

        if (ratio < 0.15) {
            this.log('SAVE', `Skipping bake — only ${(ratio * 100).toFixed(0)}% STT signal.`);
            return;
        }

        const trackId = window.Store?.currentTrack?.track_id;
        if (!trackId) return;

        this.log('SAVE', `Baking sync map (${(ratio * 100).toFixed(0)}% confidence)...`);

        try {
            await fetch(this.SAVE_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    track_id: trackId,
                    lines: syncEngine.linesData
                })
            });
            this.log('SAVE', 'Successfully baked to disk.');
        } catch (e) {
            this.log('SAVE', `Failed: ${e.message}`);
        }
    },

    // ── _detectLanguage()  ───────────────────────────────────────────────
    //   Lightweight heuristic language detector on lyric text.
    _detectLanguage(text) {
        if (!text || text.length < 10) return null;
        text = text.toLowerCase();

        const count = (regex) => (text.match(regex) || []).length;

        const trC = count(/[şğüöıçı]/g);
        if (trC > 5) return 'tr';

        const esC = count(/[ñáéíóú¿¡]/g);
        if (esC > 5) return 'es';

        const enW = count(/\b(the|you|and|it|is|in|me|to|my|love|i|that)\b/g);
        const frW = count(/\b(je|tu|il|elle|le|la|de|un|une|et|à|pour|dans)\b/g);
        const deW = count(/\b(der|die|das|und|sein|in|ein|zu|haben|ich|werden|sie|von)\b/g);

        if (deW > 8 && deW > enW) return 'de';
        if (frW > 8 && frW > enW) return 'fr';
        if (enW > 8) return 'en';

        return null;
    },

    // ── _tokenize()  ─────────────────────────────────────────────────────
    //   Strips accents, punctuation, and short stop-words.
    //   Works for EN, TR, ES, FR, DE and most Latin-script languages.
    _tokenize(text) {
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1);        // drop single-char noise
    },

    // ── _similarity()  ───────────────────────────────────────────────────
    //   Combined Jaccard similarity on unigrams + bigrams.
    //   Bigrams reward correct word-order (vital for repeated chorus lines).
    //
    //   score = Jaccard(words) * 0.55  +  Jaccard(bigrams) * 0.45
    _similarity(aWords, bWords) {
        if (!aWords.length || !bWords.length) return 0;

        // Unigram Jaccard with Phonetic/Prefix Boost
        const aSet = new Set(aWords);
        const bSet = new Set(bWords);
        const originalBSize = bSet.size;
        let inter = 0;

        // 1. Exact matches first
        for (const w of Array.from(aSet)) {
            if (bSet.has(w)) {
                inter++;
                aSet.delete(w);
                bSet.delete(w);
            }
        }
        // 2. Partial prefix matches (Rap optimization)
        for (const w of aSet) {
            if (w.length < 3) continue;
            for (const target of bSet) {
                if (target.length >= 3 && w.slice(0, 3) === target.slice(0, 3)) {
                    inter += 0.5; // Partial credit for "Ben" vs "Abden" phonetic overlap
                    bSet.delete(target);
                    break;
                }
            }
        }
        const union = aWords.length + originalBSize - inter;
        const jaccard = union > 0 ? inter / union : 0;

        // Bigram Jaccard
        const bigrams = arr => {
            const s = new Set();
            for (let i = 0; i < arr.length - 1; i++) s.add(`${arr[i]}\x00${arr[i + 1]}`);
            return s;
        };
        const aBi = bigrams(aWords), bBi = bigrams(bWords);
        let biInter = 0;
        for (const b of aBi) if (bBi.has(b)) biInter++;
        const biUnion = aBi.size + bBi.size - biInter;
        const biScore = biUnion > 0 ? biInter / biUnion : 0;

        // Sequence Sensitivity: Bigrams get 65% weight to distinguish repetitive lines
        return jaccard * 0.35 + biScore * 0.65;
    }
};

window.LyricsManager = LyricsManager;
window.LyricSyncEngine = LyricSyncEngine;
window.LyricTranscriptEngine = LyricTranscriptEngine;