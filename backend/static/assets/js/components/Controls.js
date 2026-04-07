import { Store } from '../modules/Store.js';
import { PlayerEngine } from '../modules/PlayerEngine.js';
import { DetailsPanel } from './DetailsPanel.js';
import { Sidebar } from './Sidebar.js';
import { Visualizer } from '../modules/Visualizer.js';


export const Controls = {
    init() {
        const $ = id => document.getElementById(id);

        $('btn-play').onclick = () => PlayerEngine.togglePlay();
        $('btn-prev').onclick = () => PlayerEngine.prevTrack();
        $('btn-next').onclick = () => PlayerEngine.nextTrack();

        $('btn-shuffle').onclick = () => {
            Store.shuffleOn = !Store.shuffleOn;
            $('btn-shuffle').classList.toggle('active', Store.shuffleOn);
            if (Store.shuffleOn) this.buildShuffle();
            Store.savePlaybackState();
        };


        $('btn-repeat').onclick = () => {
            Store.repeatMode = (Store.repeatMode + 1) % 3;
            const btn = $('btn-repeat');
            btn.classList.toggle('active', Store.repeatMode > 0);
            btn.dataset.mode = Store.repeatMode;
            btn.title = [window.t('js_rep_off'), window.t('js_rep_list'), window.t('js_rep_trk')][Store.repeatMode];
            Store.savePlaybackState();
        };


        // Progress Bar (Main)
        const bar = $('progress-bar');
        bar.onmousedown = e => { Store.isDraggingProgress = true; this.seek(e); };
        document.addEventListener('mousemove', e => { if (Store.isDraggingProgress) this.seek(e); });
        document.addEventListener('mouseup', () => { Store.isDraggingProgress = false; });

        // Close buttons for immersive views
        const closeLyrics = $('btn-close-lyrics');
        if (closeLyrics) closeLyrics.onclick = () => {
            Store.lyricsOpen = false;
            this.updateLyricsUI(false);
        };
        const closeVizFull = $('btn-close-viz-full');
        if (closeVizFull) closeVizFull.onclick = () => {
            const container = $('visualizer-container');
            if (container) {
                container.style.opacity = '0';
                setTimeout(() => {
                    container.classList.remove('is-fullscreen');
                    document.body.classList.remove('viz-fullscreen-active');
                    container.style.opacity = '1';
                }, 250);
            }
        };




        // Volume Bar
        const volBar = $('volume-bar');
        volBar.onmousedown = e => { Store.isDraggingVolume = true; this.setVolume(e); };
        document.addEventListener('mousemove', e => { if (Store.isDraggingVolume) this.setVolume(e); });
        document.addEventListener('mouseup', () => { Store.isDraggingVolume = false; });

        $('btn-vol').onclick = () => this.toggleMute();

        // Details Toggle from Cover
        $('cover-wrap').onclick = () => DetailsPanel.toggle();

        const detailsToggle = $('btn-details-toggle');
        detailsToggle.onclick = () => {
            DetailsPanel.toggle();
            this.updateDetailsToggleState();
        };

        const sidebarToggle = $('btn-sidebar-toggle');
        sidebarToggle.onclick = () => {
            Sidebar.toggle();
            this.updateSidebarToggleState();
        };

        const lyricsToggle = $('btn-lyrics-toggle');
        lyricsToggle.onclick = () => {
            if (!Store.geniusApiKey) {
                Sidebar.openSettingsModal();
                return;
            }
            const open = Store.toggleLyrics();
            this.updateLyricsUI(open);

            if (open && typeof window.LyricsManager !== 'undefined') {
                window.LyricsManager.update();
            }
        };

        $('btn-viz-toggle').onclick = () => {
            const open = Store.toggleVisualizer();
            this.updateVisualizerUI(open);
            if (open) {
                Visualizer.start();
                Visualizer.updateTrackInfo(Store.currentTrack);
            } else {
                Visualizer.stop();
            }
        };



        this.updateVolumeUI();
        this.updateDetailsToggleState();
        this.updateSidebarToggleState();
        this.updateLyricsUI(Store.lyricsOpen);
        this.updateVisualizerUI(Store.visualizerOpen);

        if (Store.visualizerOpen) {
            Visualizer.start();
        }
    },



    updateLyricsUI(open) {
        const btn = document.getElementById('btn-lyrics-toggle');
        const view = document.getElementById('lyrics-view');
        const content = document.querySelector('.content');
        if (btn) btn.classList.toggle('active', open);
        if (view) view.style.display = open ? 'flex' : 'none';
        if (content) content.classList.toggle('lyrics-active', open);
        document.body.classList.toggle('lyrics-page-open', open);
    },

    updateVisualizerUI(open) {
        const btn = document.getElementById('btn-viz-toggle');
        const container = document.getElementById('visualizer-container');
        if (btn) btn.classList.toggle('active', open);
        if (container) container.classList.toggle('hidden', !open);
    },





    updateDetailsToggleState() {
        const detailsToggle = document.getElementById('btn-details-toggle');
        if (detailsToggle) {
            detailsToggle.classList.toggle('active', Store.detailsOpen);
        }
    },

    updateSidebarToggleState() {
        const sidebarToggle = document.getElementById('btn-sidebar-toggle');
        if (sidebarToggle) {
            sidebarToggle.classList.toggle('active', Store.sidebarOpen);
        }
    },

    buildShuffle() {
        if (!Store.currentTracks.length) return;
        Store.shuffleOrder = [...Array(Store.currentTracks.length).keys()];
        // Fisher-Yates shuffle
        for (let i = Store.shuffleOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [Store.shuffleOrder[i], Store.shuffleOrder[j]] = [Store.shuffleOrder[j], Store.shuffleOrder[i]];
        }
        // Force the current playing track to be at the "start" of shuffle so it doesn't repeat or skip
        if (Store.currentTrackIndex !== -1) {
            const currentIdxInShuffle = Store.shuffleOrder.indexOf(Store.currentTrackIndex);
            if (currentIdxInShuffle !== -1) {
                [Store.shuffleOrder[0], Store.shuffleOrder[currentIdxInShuffle]] = [Store.shuffleOrder[currentIdxInShuffle], Store.shuffleOrder[0]];
            }
        }
    },

    seek(e) {
        const bar = document.getElementById('progress-bar');
        const r = bar.getBoundingClientRect();
        const p = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
        if (!isNaN(PlayerEngine.audio.duration)) PlayerEngine.audio.currentTime = PlayerEngine.audio.duration * p;
        document.getElementById('progress-fill').style.width = (p * 100) + '%';
    },



    setVolume(e) {
        const bar = document.getElementById('volume-bar');
        const r = bar.getBoundingClientRect();
        const p = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
        PlayerEngine.audio.volume = p;
        this.updateVolumeUI();
        localStorage.setItem('sa_volume', p);
    },

    updateVolumeUI() {
        const v = PlayerEngine.audio.volume;
        document.getElementById('volume-fill').style.width = (v * 100) + '%';
        const svg = document.getElementById('vol-icon');

        svg.classList.remove('level-low', 'level-mid', 'level-high', 'is-muted');

        if (v === 0) {
            svg.classList.add('is-muted');
        } else if (v <= 0.33) {
            svg.classList.add('level-low');
        } else if (v <= 0.66) {
            svg.classList.add('level-mid');
        } else {
            svg.classList.add('level-high');
        }
    },

    toggleMute() {
        const a = PlayerEngine.audio;
        if (a.volume > 0) { a._prevVol = a.volume; a.volume = 0; }
        else { a.volume = a._prevVol || 1; }
        this.updateVolumeUI();
        localStorage.setItem('sa_volume', a.volume);
    }
};
