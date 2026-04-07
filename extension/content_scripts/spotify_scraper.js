// SPOTIFY SCRAPER - Content Script
// Fetches playlist in chunks, scrolls to pull all of them
// Optimized for large playlists (900+ tracks)

const CHUNK_SIZE = 50;           // How many tracks to send per request
const SCROLL_DELAY = 1200;       // Wait time for Spotify lazy load (ms)
const SCROLL_DELAY_RETRY = 2000; // Wait longer if no new content loads
const BACKEND_URL = 'http://localhost:8765';

class SpotifyScraper {
  constructor() {
    this.scrapedTracks = new Map(); // Map to prevent duplicates
    this.playlistMeta = {};
    this.isRunning = false;
    this.sessionId = null;
  }

  async startScraping() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // 1. Get playlist metadata
      this.playlistMeta = this.extractPlaylistMeta();
      // Fixed session_id (To resume in the same list)
      this.sessionId = `session_${this.playlistMeta.playlist_id}`;

      // 2. Init session with backend
      await this.initSession();

      // 3. Extract and send visible tracks
      await this.scrapeWithScrolling();

      // 4. Finalize session
      await this.finalizeSession();

    } catch (err) {
      console.error('[Scraper] Hata:', err);
      this.sendStatusUpdate('error', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  extractPlaylistMeta() {
    const url = window.location.href;
    const playlistId = url.match(/playlist\/([a-zA-Z0-9]+)/)?.[1]
      || url.match(/album\/([a-zA-Z0-9]+)/)?.[1];

    // Extract metadata from Spotify DOM
    const titleEl = document.querySelector('[data-testid="playlist-page"] h1')
      || document.querySelector('[data-testid="album-page"] h1')
      || document.querySelector('h1[class*="Type"]')
      || document.querySelector('h1');

    const coverEl = document.querySelector('[data-testid="cover-art-image"]')
      || document.querySelector('img[class*="cover"]')
      || document.querySelector('[data-testid="playlist-image"] img');

    const descEl = document.querySelector('[data-testid="playlist-description"]');

    const ownerEl = document.querySelector('[data-testid="playlist-page"] [href*="/user/"]')
      || document.querySelector('[data-testid="playlist-page"] [href*="/artist/"]')
      || document.querySelector('[data-testid="album-page"] [href*="/artist/"]');

    return {
      playlist_id: playlistId || `local_${Date.now()}`,
      name: titleEl?.innerText?.trim() || 'Bilinmeyen Playlist',
      cover_url: coverEl?.src || null,
      description: descEl?.innerText?.trim() || '',
      owner: ownerEl?.innerText?.trim() || 'Bilinmiyor',
      url: url,
      scraped_at: new Date().toISOString()
    };
  }

  async scrapeWithScrolling() {
    // Find Spotify's actual scroll container
    const scrollContainer = this.findScrollContainer();
    console.log('[Scraper] Scroll container:', scrollContainer?.tagName, scrollContainer?.className);

    let lastCount = 0;
    let lastSentCount = 0;
    let noNewContentStreak = 0;
    const MAX_STREAK = 10; // Be patient for large playlists
    const SCROLL_STEP = Math.floor(window.innerHeight * 0.7); // Smaller steps

    while (noNewContentStreak < MAX_STREAK) {
      // Extract visible tracks
      const newTracks = this.extractVisibleTracks();
      const prevSize = this.scrapedTracks.size;

      newTracks.forEach(t => this.scrapedTracks.set(t.track_id, t));

      const gained = this.scrapedTracks.size - prevSize;

      // Send chunk if large enough
      if (this.scrapedTracks.size - lastSentCount >= CHUNK_SIZE) {
        await this.sendChunk(lastSentCount, false);
        lastSentCount = this.scrapedTracks.size;
      }

      if (gained === 0) {
        noNewContentStreak++;

        // Scroll up slightly and down again on empty round
        // To trigger Spotify's virtualization
        if (noNewContentStreak >= 3 && noNewContentStreak < MAX_STREAK) {
          this.doScroll(scrollContainer, -SCROLL_STEP * 2);
          await this.sleep(500);
          this.doScroll(scrollContainer, SCROLL_STEP * 3);
          await this.sleep(SCROLL_DELAY_RETRY);
          continue;
        }

        // Wait longer if no new content arrives
        await this.sleep(SCROLL_DELAY_RETRY);
      } else {
        noNewContentStreak = 0;
        await this.sleep(SCROLL_DELAY);
      }

      // Aşağı scroll
      this.doScroll(scrollContainer, SCROLL_STEP);

      // Report progress
      this.sendStatusUpdate('scraping', `${this.scrapedTracks.size} şarkı bulundu...`);
    }

    // Send the final remaining chunk
    if (this.scrapedTracks.size > lastSentCount) {
      await this.sendChunk(lastSentCount, true); // final=true
    }

    console.log(`[Scraper] Tamamlandı: ${this.scrapedTracks.size} şarkı toplandı`);
  }

  findScrollContainer() {
    // 1. Most reliable: Find viewport wrapping tracklist
    const tracklist = document.querySelector('[data-testid="playlist-tracklist"]');
    if (tracklist) {
      const vp = tracklist.closest('[data-overlayscrollbars-viewport]') ||
        tracklist.closest('.os-viewport') ||
        tracklist.closest('[data-overlayscrollbars]');
      if (vp) return vp;
    }

    // 2. Scrollable node of main view
    const mainViewScroll = document.querySelector('.main-view-container__scroll-node') ||
      document.querySelector('main')?.closest('[data-overlayscrollbars-viewport]') ||
      document.querySelector('main')?.parentElement;

    if (mainViewScroll && mainViewScroll.scrollHeight > mainViewScroll.clientHeight) {
      return mainViewScroll;
    }

    // 3. Fallback
    return document.querySelector('main') || document.scrollingElement || document.documentElement;
  }

  doScroll(container, amount) {
    if (container && container !== document.documentElement) {
      container.scrollBy({ top: amount, behavior: 'auto' });
    } else {
      window.scrollBy({ top: amount, behavior: 'auto' });
    }
  }

  extractVisibleTracks() {
    const tracks = [];

    // Spotify track row selectors
    const rowSelectors = [
      '[data-testid="tracklist-row"]',
      '[class*="tracklist-row"]',
      '[role="row"][aria-rowindex]'
    ];

    let rows = [];
    for (const sel of rowSelectors) {
      rows = document.querySelectorAll(sel);
      if (rows.length > 0) break;
    }

    rows.forEach((row, index) => {
      try {
        // Track Title
        const titleEl = row.querySelector('[data-testid="internal-track-link"]')
          || row.querySelector('[class*="trackName"]')
          || row.querySelector('a[href*="/track/"]');

        // Artist(s)
        const artistEls = row.querySelectorAll('[href*="/artist/"]');
        const artists = Array.from(artistEls).map(el => el.innerText.trim()).filter(Boolean);

        // Album
        const albumEl = row.querySelector('[href*="/album/"]');

        // Duration
        const durationEl = row.querySelector('[class*="duration"]')
          || row.querySelector('[data-testid="tracklist-duration"]');

        // Track ID (href'ten)
        const trackLink = row.querySelector('a[href*="/track/"]');
        const trackId = trackLink?.href?.match(/track\/([a-zA-Z0-9]+)/)?.[1]
          || `track_${this.scrapedTracks.size + index}`;

        // Cover (visible at row start in some playlists)
        const imgEl = row.querySelector('img');

        if (titleEl) {
          tracks.push({
            track_id: trackId,
            title: titleEl.innerText?.trim() || 'Bilinmeyen',
            artists: artists.length > 0 ? artists : ['Bilinmiyor'],
            artist_str: artists.join(', '),
            album: albumEl?.innerText?.trim() || '',
            duration: durationEl?.innerText?.trim() || '',
            cover_url: imgEl?.src || this.playlistMeta.cover_url || null,
            spotify_url: trackLink?.href || null,
          });
        }
      } catch (e) {
        // Skip if single row errors out
      }
    });

    return tracks;
  }

  async initSession() {
    const res = await fetch(`${BACKEND_URL}/session/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        playlist: this.playlistMeta
      })
    });
    if (!res.ok) throw new Error('Session başlatılamadı — Backend çalışıyor mu?');

    // Adapt real session_id from backend (might change if deduplicated)
    const data = await res.json();
    if (data.session_id) {
      this.sessionId = data.session_id;
    }

    this.sendStatusUpdate('session_started', `Session: ${this.sessionId}`);
  }

  async sendChunk(startIndex, isFinal = false) {
    const allTracks = Array.from(this.scrapedTracks.values());
    const tracksArray = allTracks.slice(startIndex);

    const res = await fetch(`${BACKEND_URL}/session/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        tracks: tracksArray,
        total_so_far: allTracks.length,
        is_final: isFinal
      })
    });

    if (res.ok) {
      this.sendStatusUpdate('chunk_sent', `${tracksArray.length} şarkı iletildi`);
    }
  }

  async finalizeSession() {
    await fetch(`${BACKEND_URL}/session/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        total_tracks: this.scrapedTracks.size
      })
    });
    this.sendStatusUpdate('finalized', `Toplam ${this.scrapedTracks.size} şarkı gönderildi`);
  }

  sendStatusUpdate(type, message) {
    chrome.runtime.sendMessage({
      type,
      message,
      sessionId: this.sessionId,
      trackCount: this.scrapedTracks.size
    });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// Listen for extension messages
const scraper = new SpotifyScraper();
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.action === 'START_SCRAPING') {
    scraper.startScraping();
    respond({ status: 'started' });
  }
  if (msg.action === 'GET_STATUS') {
    respond({
      isRunning: scraper.isRunning,
      count: scraper.scrapedTracks.size,
      sessionId: scraper.sessionId
    });
  }
  return true; // For async response
});
