import { Store } from './Store.js';
import { DetailsPanel } from '../components/DetailsPanel.js';
import { Tracklist } from '../components/Tracklist.js';
import { Visualizer } from './Visualizer.js';


export const PlayerEngine = {
    audio: null,
    ctx: null,
    analyser: null,
    source: null,

    init() {
        this.audio = document.getElementById('audio-player');
        // Allow cross-origin for visualizer if needed, though here it's same-origin proxy
        this.audio.crossOrigin = "anonymous";

        const savedVol = localStorage.getItem('sa_volume');
        this.audio.volume = savedVol !== null ? parseFloat(savedVol) : 1;


        this.audio.onplay = () => this.onPlay();
        this.audio.onpause = () => this.onPause();
        this.audio.onended = () => this.nextTrack();
        this.audio.onerror = () => {
            window.showToast(window.t('js_failed_skip'), true);
            setTimeout(() => this.nextTrack(), 1500);
        };
        this.audio.ontimeupdate = () => this.onTimeUpdate();

    },

    setupAudioContext() {
        if (this.ctx) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.source = this.ctx.createMediaElementSource(this.audio);
        this.source.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
    },

    playTrack(idx) {

        if (idx < 0 || idx >= Store.currentTracks.length) {
            if (Store.repeatMode === 1) idx = 0; else return;
        }
        Store.currentTrackIndex = idx;
        Store.currentTrack = Store.currentTracks[idx];
        const t = Store.currentTracks[idx];
        const artist = window.parseArtists(t.artists);

        this.setupAudioContext();
        this.audio.src = `/stream/${t.track_id}`;
        this.audio.play().catch(() => window.showToast(window.t('js_failed'), true));


        // Update UI
        document.getElementById('now-cover').style.display = 'block';
        document.getElementById('now-cover').src = t.cover_url || '';
        document.getElementById('now-title').innerText = t.title;
        document.getElementById('now-artist').innerText = artist;
        document.getElementById('btn-viz-toggle').classList.add('visible');

        // Update visualizer fullscreen info
        Visualizer.updateTrackInfo(t);



        document.getElementById('cover-wrap').classList.add('playing');
        document.getElementById('cover-wrap').classList.remove('paused');

        document.querySelectorAll('.track-row').forEach((r, i) => r.classList.toggle('playing', i === idx));

        DetailsPanel.update(t);

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title,
                artist,
                album: t.album || '',
                artwork: t.cover_url ? [{ src: t.cover_url }] : []
            });
        }

        if (window.LyricsManager) {
            window.LyricsManager.update();
        }

        Store.savePlaybackState();
    },



    nextTrack() {
        if (Store.repeatMode === 2) { this.audio.currentTime = 0; this.audio.play(); return; }
        if (Store.shuffleOn) {
            const ni = Store.shuffleOrder.indexOf(Store.currentTrackIndex);
            this.playTrack(Store.shuffleOrder[(ni + 1) % Store.shuffleOrder.length]);
        } else {
            this.playTrack(Store.currentTrackIndex + 1);
        }
    },

    prevTrack() {
        if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
        if (Store.shuffleOn) {
            const ni = Store.shuffleOrder.indexOf(Store.currentTrackIndex);
            this.playTrack(Store.shuffleOrder[(ni - 1 + Store.shuffleOrder.length) % Store.shuffleOrder.length]);
        } else {
            this.playTrack(Math.max(0, Store.currentTrackIndex - 1));
        }
    },

    togglePlay() {
        this.setupAudioContext();
        if (this.audio.paused) {
            if (this.audio.src) this.audio.play();
            else if (Store.currentTracks.length) this.playTrack(0);
        } else {
            this.audio.pause();
        }
    },


    onPlay() {
        document.getElementById('icon-play').style.display = 'none';
        document.getElementById('icon-pause').style.display = 'block';
        document.getElementById('cover-wrap').classList.add('playing');
        document.getElementById('cover-wrap').classList.remove('paused');
    },

    onPause() {
        document.getElementById('icon-play').style.display = 'block';
        document.getElementById('icon-pause').style.display = 'none';
        document.getElementById('cover-wrap').classList.remove('playing');
        document.getElementById('cover-wrap').classList.add('paused');
    },

    onTimeUpdate() {
        if (Store.isDraggingProgress) return;
        const p = (this.audio.currentTime / this.audio.duration) * 100 || 0;
        document.getElementById('progress-fill').style.width = p + '%';
        document.getElementById('time-current').innerText = window.formatTime(this.audio.currentTime);
        if (!isNaN(this.audio.duration)) {
            document.getElementById('time-total').innerText = window.formatTime(this.audio.duration);
        }

        // Persist time every 2 seconds
        if (Math.floor(this.audio.currentTime) % 2 === 0) {
            localStorage.setItem('player_last_time', this.audio.currentTime);
        }
    }


};
