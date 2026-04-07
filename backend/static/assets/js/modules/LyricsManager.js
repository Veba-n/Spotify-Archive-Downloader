import { Store } from './Store.js';

export const LyricsManager = {
    currentTrackId: null,
    currentData: null,

    async update() {
        if (!Store.currentTrack) return;

        const track = Store.currentTrack;
        const isNewTrack = this.currentTrackId !== track.track_id;

        if (isNewTrack) {
            this.currentTrackId = track.track_id;
            this.currentData = null;
            if (Store.lyricsOpen) this.renderLoading();

            try {
                const data = await this.fetchFromGenius(track.title, window.parseArtists(track.artists));
                if (data) {
                    this.currentData = data;
                    // Always try to fetch extra info for DetailsPanel
                    this.fetchExtraInfo(data.songId, data.artistId);

                    if (Store.lyricsOpen) {
                        await this.loadAndRenderLyrics();
                    }
                } else if (Store.lyricsOpen) {
                    this.renderError(window.t('js_lyrics_not_found') || 'Lyrics not found');
                }
            } catch (err) {
                console.error('Lyrics fetch error:', err);
                if (Store.lyricsOpen) this.renderError('Failed to fetch lyrics.');
            }
        } else if (Store.lyricsOpen && !this.currentData?.lyrics) {
            // Panel was opened for same track, but lyrics aren't loaded yet
            if (!this.currentData) {
                // We might have failed search before, or it's still searching
                this.renderLoading();
                const data = await this.fetchFromGenius(track.title, window.parseArtists(track.artists));
                if (data) {
                    this.currentData = data;
                    this.fetchExtraInfo(data.songId, data.artistId);
                    await this.loadAndRenderLyrics();
                } else {
                    this.renderError(window.t('js_lyrics_not_found') || 'Lyrics not found');
                }
            } else {
                await this.loadAndRenderLyrics();
            }
        }
    },

    async loadAndRenderLyrics() {
        if (!this.currentData || !this.currentData.url) return;
        if (this.currentData.lyrics) {
            this.renderLyrics(this.currentData);
            return;
        }

        this.renderLoading();
        try {
            const lyrics = await this.fetchLyricsText(this.currentData.url);
            this.currentData.lyrics = lyrics;
            this.renderLyrics(this.currentData);
        } catch (e) {
            this.renderError('Failed to extract lyrics.');
        }
    },

    async fetchFromGenius(title, artist) {
        const key = Store.geniusApiKey;
        if (!key) return null;

        const query = encodeURIComponent(`${title} ${artist}`);
        const url = `https://api.genius.com/search?q=${query}&access_token=${key}`;

        const res = await fetch(url);
        const json = await res.json();

        if (json.meta.status !== 200 || !json.response.hits.length) {
            return null;
        }

        const bestMatch = json.response.hits[0].result;
        return {
            title: bestMatch.title,
            artist: bestMatch.primary_artist.name,
            image: bestMatch.header_image_url,
            url: bestMatch.url,
            songId: bestMatch.id,
            artistId: bestMatch.primary_artist.id,
            lyrics: null
        };
    },

    async fetchExtraInfo(songId, artistId) {
        const key = Store.geniusApiKey;
        if (!key) return;

        try {
            const [songRes, artistRes] = await Promise.all([
                fetch(`https://api.genius.com/songs/${songId}?access_token=${key}&text_format=plain`),
                fetch(`https://api.genius.com/artists/${artistId}?access_token=${key}&text_format=plain`)
            ]);

            const songJson = await songRes.json();
            const artistJson = await artistRes.json();

            const info = {
                songInfo: songJson.response?.song?.description?.plain || '',
                artistBio: artistJson.response?.artist?.biography?.plain || ''
            };

            if (info.artistBio === '?') info.artistBio = '';
            if (info.songInfo === '?') info.songInfo = '';

            // Update DetailsPanel
            import('../components/DetailsPanel.js').then(module => {
                module.DetailsPanel.updateExtraInfo(info);
            });
        } catch (e) {
            console.error('Error fetching extra info:', e);
        }
    },

    async fetchLyricsText(geniusUrl) {
        try {
            const proxyUrl = `/api/lyrics/proxy?url=${encodeURIComponent(geniusUrl)}`;
            const res = await fetch(proxyUrl);
            const json = await res.json();
            const html = json.contents;

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            let containers = doc.querySelectorAll('[class^="Lyrics__Container"], .lyrics');
            if (containers.length === 0) return null;

            let lyricsText = '';
            containers.forEach(c => {
                c.querySelectorAll('script, style').forEach(s => s.remove());

                let content = c.innerHTML
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/div>/gi, '\n')
                    .replace(/<[^>]+>/g, ''); // Strip remaining tags

                let lines = content.split('\n').map(l => l.trim());

                // Remove top garbage
                while (lines.length > 0) {
                    let line = lines[0].toLowerCase();
                    let isGarbage =
                        line.match(/^\d*\s*contributors?$/) ||
                        line.endsWith(' lyrics') ||
                        line.match(/^\[.*için şar[kq]ı sözleri\]$/) ||
                        line.match(/^\[.*lyrics\]$/) ||
                        line.includes('translations') ||
                        line === '';

                    if (isGarbage) {
                        lines.shift();
                    } else {
                        break;
                    }
                }

                // Remove bottom garbage
                while (lines.length > 0) {
                    let line = lines[lines.length - 1].toLowerCase();
                    let isGarbage =
                        line.match(/^\d*\s*embed$/) ||
                        line === 'share url' ||
                        line === 'copy embed code' ||
                        line === '';

                    if (isGarbage) {
                        lines.pop();
                    } else {
                        break;
                    }
                }

                lyricsText += lines.join('\n') + '\n\n';
            });

            return lyricsText.trim() || null;
        } catch (e) {
            console.error('Scraping error:', e);
            return null;
        }
    },

    renderLoading() {
        const textElem = document.getElementById('lyrics-text');
        const creditElem = document.getElementById('lyrics-credit');
        if (textElem) textElem.innerHTML = '<div class="phrase active">Searching for lyrics...</div>';
        if (creditElem) creditElem.innerText = '';
    },

    renderLyrics(data) {
        const textElem = document.getElementById('lyrics-text');
        const creditElem = document.getElementById('lyrics-credit');
        if (!textElem) return;

        if (data.lyrics) {
            textElem.innerText = data.lyrics;
        } else {
            textElem.innerHTML = `
                <div class="phrase active">${data.title}</div>
                <div class="phrase">${data.artist}</div>
                <div style="margin-top: 20px; font-size: 0.5em; opacity: 0.7;">
                    Lyrics text could not be extracted automatically.<br>
                    <a href="${data.url}" target="_blank" style="color: var(--primary); text-decoration: none;">View full lyrics on Genius</a>
                </div>
            `;
        }

        if (creditElem) {
            creditElem.innerHTML = `
                Lyrics provided by <a href="${data.url}" target="_blank" style="color: inherit; text-decoration: underline;">Genius</a>
                <br><span style="font-size: 0.8em; opacity: 0.6;">Artist: ${data.artist}</span>
            `;
        }
    },

    renderError(msg) {
        const textElem = document.getElementById('lyrics-text');
        if (!textElem) return;

        if (!Store.geniusApiKey) {
            textElem.innerHTML = `
                <div class="phrase active" style="font-size: 0.8em;">Genius API Key Missing</div>
                <div style="font-size: 0.5em; opacity: 0.7; margin-top: 20px;">
                    Please add your Genius API key in settings to view lyrics.<br>
                    <a href="https://genius.com/api-clients/new" target="_blank" style="color: var(--primary); text-decoration: none; display: block; margin-top: 10px;">Get API Key Here &rarr;</a>
                </div>
            `;
        } else {
            textElem.innerHTML = `<div class="phrase" style="color: #ff5555;">${msg}</div>`;
        }
    }
};

window.LyricsManager = LyricsManager;
