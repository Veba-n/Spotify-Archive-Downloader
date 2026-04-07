import { Store } from './modules/Store.js';
import { ComponentLoader } from './modules/ComponentLoader.js';
import { PlayerEngine } from './modules/PlayerEngine.js';
import { Sidebar } from './components/Sidebar.js';
import { Tracklist } from './components/Tracklist.js';
import { DetailsPanel } from './components/DetailsPanel.js';
import { Controls } from './components/Controls.js';
import { Modal } from './modules/Modal.js';
import { LyricsManager } from './modules/LyricsManager.js';
import { Visualizer } from './modules/Visualizer.js';


const locales = {
    en: {
        p_archive: "Music Archive", p_search_pl: "Search playlist...", p_welcome: "Select a playlist from the left",
        p_playlist_label: "Playlist", p_my_list: "My List", p_search_tr: "Search tracks...",
        p_th_track: "Track", p_th_album: "Album", p_th_duration: "Duration",
        p_details_title: "Now Playing", p_archived_at: "Archived At",
        p_settings: "Settings", p_lang: "Language", p_genius_key: "Genius API Key",
        p_artist_bio: "Artist Biography", p_song_info: "About this Song",
        p_genius_help: "Used for fetching lyrics.", p_btn_cancel: "Cancel", p_btn_save: "Save Settings",
        p_now_playing: "Now Playing",


        js_no_archive: "No archived playlists yet", js_unknown: "Unknown", js_down: "Downloaded",
        js_tracks: "Tracks", js_no_match: "No matching tracks found.", js_failed: "Track failed to load",
        js_failed_skip: "Track failed to load — skipping", js_rep_off: "Repeat Off", js_rep_list: "Repeat List", js_rep_trk: "Repeat Track",
        js_settings_saved: "Settings saved"
    },
    tr: {
        p_archive: "Müzik Arşivi", p_search_pl: "Playlist ara...", p_welcome: "Sol taraftan bir çalma listesi seçin",
        p_playlist_label: "Çalma Listesi", p_my_list: "Listem", p_search_tr: "Şarkılarda ara...",
        p_th_track: "Şarkı", p_th_album: "Albüm", p_th_duration: "Süre",
        p_details_title: "Şu An Çalıyor", p_archived_at: "Arşivlenme",
        p_settings: "Ayarlar", p_lang: "Dil", p_genius_key: "Genius API Anahtarı",
        p_artist_bio: "Sanatçı Biyografisi", p_song_info: "Şarkı Hakkında",
        p_genius_help: "Şarkı sözlerini çekmek için kullanılır.", p_btn_cancel: "İptal", p_btn_save: "Ayarları Kaydet",
        p_now_playing: "Şu An Çalıyor",


        js_no_archive: "Henüz arşivlenmiş liste yok", js_unknown: "Bilinmiyor", js_down: "İndirildi",
        js_tracks: "Şarkı", js_no_match: "Eşleşen şarkı bulunamadı", js_failed: "Şarkı yüklenemedi",
        js_failed_skip: "Şarkı yüklenemedi — atlanıyor", js_rep_off: "Tekrar Kapalı", js_rep_list: "Liste Tekrar", js_rep_trk: "Şarkı Tekrar",
        js_settings_saved: "Ayarlar kaydedildi"
    }
};

window.t = (k) => locales[Store.lang][k] || k;
window.parseArtists = (a) => { try { return JSON.parse(a).join(', '); } catch (e) { return a || ''; } };
window.formatTime = (s) => { if (isNaN(s)) return '0:00'; return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`; };
window.showToast = (msg, isError = false) => {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '') + ' show';
    setTimeout(() => t.classList.remove('show'), 3000);
};

export const App = {
    async init() {
        // Load initial templates
        await ComponentLoader.load('sidebar', '/static/components/Sidebar.html');
        await ComponentLoader.load('playlist-view', '/static/components/Tracklist.html');
        await ComponentLoader.load('details-panel', '/static/components/DetailsPanel.html');

        // Initialize modules
        PlayerEngine.init();
        Sidebar.init();
        Tracklist.init();
        DetailsPanel.init();
        Controls.init();
        Visualizer.init();


        this.setLang(Store.lang);
        await Store.fetchSessions();
        Sidebar.render();

        // Restore State
        const lastSessionId = localStorage.getItem('player_last_session');
        if (lastSessionId) {
            const sess = Store.allSessions.find(s => s.session_id === lastSessionId);
            if (sess) {
                await this.loadPlaylist(sess);
                const lastTrackId = localStorage.getItem('player_last_track');
                if (lastTrackId) {
                    const trackIdx = Store.currentTracks.findIndex(t => t.track_id === lastTrackId);
                    if (trackIdx !== -1) {
                        this.restoreTrack(trackIdx);
                    }
                }
            }
        }

        this.bindGlobalEvents();
    },


    setLang(l) {
        Store.setLang(l);
        document.querySelectorAll('[data-i18n]').forEach(el => { el.innerText = window.t(el.getAttribute('data-i18n')); });
        document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = window.t(el.getAttribute('data-i18n-ph')); });

        Sidebar.render();
        if (Store.currentTracks.length) {
            const totalDurationSec = Store.currentTracks.reduce((acc, t) => {
                const parts = (t.duration || '0:00').split(':');
                return acc + (parseInt(parts[0]) * 60) + (parseInt(parts[1] || 0));
            }, 0);
            const totalTimeStr = this.formatPlaylistDuration(totalDurationSec);
            document.getElementById('header-meta').innerText = `${Store.currentTracks.length} ${window.t('js_tracks')} • ${totalTimeStr}`;
            Tracklist.render(Store.currentTracks);
        }
    },

    async loadPlaylist(sess) {
        Store.currentSession = sess;
        document.querySelectorAll('.playlist-item').forEach(i => i.classList.remove('active'));
        // Find the element and add active class? Actually Sidebar.render handles it if re-rendered, 
        // but for performance we can just do it here or re-filter.
        Sidebar.filter(document.getElementById('search-input').value);

        document.getElementById('welcome-msg').style.display = 'none';
        document.getElementById('playlist-view').style.display = 'block';
        document.getElementById('header-cover').src = sess.cover_url || '';
        document.getElementById('header-title').innerText = sess.playlist_name || window.t('js_unknown');

        const tracks = await Store.loadSessionTracks(sess.session_id);
        const totalDurationSec = tracks.reduce((acc, t) => {
            const parts = (t.duration || '0:00').split(':');
            return acc + (parseInt(parts[0]) * 60) + (parseInt(parts[1] || 0));
        }, 0);

        const totalTimeStr = this.formatPlaylistDuration(totalDurationSec);
        document.getElementById('header-meta').innerText = `${tracks.length} ${window.t('js_tracks')} • ${totalTimeStr}`;

        document.getElementById('track-search-input').value = '';
        Tracklist.render(tracks);

        if (Store.shuffleOn) {
            Controls.buildShuffle();
        }
    },

    formatPlaylistDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h} hr ${m} min`;
        return `${m} min ${s} sec`;
    },

    restoreTrack(idx) {
        Store.currentTrackIndex = idx;
        Store.currentTrack = Store.currentTracks[idx];
        const t = Store.currentTracks[idx];
        const artist = window.parseArtists(t.artists);

        // Prepare audio but do not auto-play
        PlayerEngine.audio.src = `/stream/${t.track_id}`;

        // Restore time
        const lastTime = localStorage.getItem('player_last_time');
        if (lastTime) {
            PlayerEngine.audio.currentTime = parseFloat(lastTime);
        }


        // Update UI
        document.getElementById('now-cover').style.display = 'block';
        document.getElementById('now-cover').src = t.cover_url || '';
        document.getElementById('now-title').innerText = t.title;
        document.getElementById('now-artist').innerText = artist;
        document.getElementById('btn-viz-toggle').classList.add('visible');

        // Update visualizer info
        Visualizer.updateTrackInfo(t);

        // Highlight in tracklist
        document.querySelectorAll('.track-row').forEach((r, i) => r.classList.toggle('playing', i === idx));

        DetailsPanel.update(t);

        if (window.LyricsManager) {
            window.LyricsManager.update();
        }

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title,
                artist,
                album: t.album || '',
                artwork: t.cover_url ? [{ src: t.cover_url }] : []
            });
        }
    },

    bindGlobalEvents() {

        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;
            switch (e.code) {
                case 'Space': e.preventDefault(); PlayerEngine.togglePlay(); break;
                case 'ArrowRight': if (!isNaN(PlayerEngine.audio.duration)) PlayerEngine.audio.currentTime = Math.min(PlayerEngine.audio.duration, PlayerEngine.audio.currentTime + 5); break;
                case 'ArrowLeft': PlayerEngine.audio.currentTime = Math.max(0, PlayerEngine.audio.currentTime - 5); break;
                case 'ArrowUp': e.preventDefault(); PlayerEngine.audio.volume = Math.min(1, PlayerEngine.audio.volume + 0.05); Controls.updateVolumeUI(); break;
                case 'ArrowDown': e.preventDefault(); PlayerEngine.audio.volume = Math.max(0, PlayerEngine.audio.volume - 0.05); Controls.updateVolumeUI(); break;
            }
        });

        window.setLang = (l) => this.setLang(l);
    }
};

window.app = App;
window.player = PlayerEngine;
window.LyricsManager = LyricsManager;
window.Visualizer = Visualizer;


document.addEventListener('DOMContentLoaded', () => App.init());
