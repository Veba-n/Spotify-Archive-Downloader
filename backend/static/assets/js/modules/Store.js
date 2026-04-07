export const Store = {
    lang: localStorage.getItem('player_lang') || 'en',
    allSessions: [],
    currentSession: null,
    currentTracks: [],
    currentTrackIndex: -1,
    currentTrack: null,
    shuffleOn: localStorage.getItem('player_shuffle') === 'true',
    repeatMode: parseInt(localStorage.getItem('player_repeat') || '0'), // 0=off, 1=all, 2=one
    shuffleOrder: [],
    isDraggingProgress: false,
    isDraggingVolume: false,
    detailsOpen: localStorage.getItem('player_details_open') !== 'false',
    sidebarOpen: localStorage.getItem('player_sidebar_open') !== 'false',
    lyricsOpen: localStorage.getItem('player_lyrics_open') === 'true',
    visualizerOpen: localStorage.getItem('player_viz_open') === 'true',
    geniusApiKey: localStorage.getItem('genius_api_key') || '',
    lastTime: parseFloat(localStorage.getItem('player_last_time') || '0'),





    async fetchSessions() {
        const res = await fetch('/sessions');
        const data = await res.json();
        this.allSessions = (data.sessions || data).filter(s => s.done_count > 0);
        return this.allSessions;
    },

    async loadSessionTracks(sessionId) {
        const res = await fetch(`/session/${sessionId}/tracks`);
        const data = await res.json();
        this.currentTracks = data.tracks;
        return this.currentTracks;
    },

    setLang(l) {
        this.lang = l;
        localStorage.setItem('player_lang', l);
    },

    toggleDetails() {
        this.detailsOpen = !this.detailsOpen;
        localStorage.setItem('player_details_open', this.detailsOpen);
        return this.detailsOpen;
    },

    toggleSidebar() {
        this.sidebarOpen = !this.sidebarOpen;
        localStorage.setItem('player_sidebar_open', this.sidebarOpen);
        return this.sidebarOpen;
    },

    toggleLyrics() {
        this.lyricsOpen = !this.lyricsOpen;
        localStorage.setItem('player_lyrics_open', this.lyricsOpen);
        return this.lyricsOpen;
    },

    toggleVisualizer() {
        this.visualizerOpen = !this.visualizerOpen;
        localStorage.setItem('player_viz_open', this.visualizerOpen);
        return this.visualizerOpen;
    },

    savePlaybackState() {
        if (this.currentSession) localStorage.setItem('player_last_session', this.currentSession.session_id);
        if (this.currentTrack) localStorage.setItem('player_last_track', this.currentTrack.track_id);
        localStorage.setItem('player_shuffle', this.shuffleOn);
        localStorage.setItem('player_repeat', this.repeatMode);
        if (window.player && window.player.audio) {
            localStorage.setItem('player_last_time', window.player.audio.currentTime);
        }
    },





    setGeniusApiKey(key) {
        this.geniusApiKey = key;
        localStorage.setItem('genius_api_key', key);
    }
};
