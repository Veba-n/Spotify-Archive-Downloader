import { Store } from './Store.js';
import { PlayerEngine } from './PlayerEngine.js';

export const Visualizer = {
    canvas: null,
    ctx: null,
    animationId: null,
    rings: 10,
    smoothData: null,
    idleFade: 0,
    ringOffsets: [],
    ringPhases: [],
    ringSpeeds: [],
    ringChaos: [],

    // Smooth transition state
    activeBlend: 0,       // 0 = fully idle, 1 = fully active
    prevVolume: 0,

    init() {
        this.container = document.getElementById('visualizer-container');
        this.canvas = document.getElementById('visualizer-canvas');
        if (!this.canvas || !this.container) return;
        this.ctx = this.canvas.getContext('2d');

        // Use ResizeObserver for frame-perfect aspect ratio syncing
        this.resizeObserver = new ResizeObserver(() => {
            const rect = this.container.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        });
        this.resizeObserver.observe(this.container);

        this._initRingParams();
        this._setupHUDEvents();
    },


    _setupHUDEvents() {
        const container = document.getElementById('visualizer-container');
        const dragBtn = document.getElementById('viz-drag');
        const fullBtn = document.getElementById('viz-full');
        const scaleBtn = document.getElementById('viz-scale');

        let isDragging = false;
        let startX, startY, startLeft, startBottom;

        dragBtn.onmousedown = (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const style = window.getComputedStyle(container);
            startLeft = parseInt(style.left);
            startBottom = parseInt(style.bottom);
            container.style.transition = 'none'; // Disable transition during drag
            e.preventDefault();
        };

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            container.style.left = (startLeft + dx) + 'px';
            container.style.bottom = (startBottom - dy) + 'px';
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                container.style.transition = ''; // Restore transition
            }
        });

        fullBtn.onclick = () => {
            container.style.opacity = '0';
            setTimeout(() => {
                container.classList.toggle('is-fullscreen');
                document.body.classList.toggle('viz-fullscreen-active');
                container.style.opacity = '1';
            }, 250);
        };



        let scaleIdx = 1; // Default to 1.0 (index 1)
        const scales = [0.8, 1.0, 1.25, 1.6, 2.0];
        scaleBtn.onclick = () => {
            scaleIdx = (scaleIdx + 1) % scales.length;
            container.style.setProperty('--viz-scale', scales[scaleIdx]);
            if (scaleIdx === 1) { // When back to 1.0, optionally reset position
                container.style.left = '';
                container.style.bottom = '';
            }
        };
    },

    updateTrackInfo(track) {
        if (!track) return;
        const artists = window.parseArtists ? window.parseArtists(track.artists) : track.artists;
        const infoStr = `${track.title} — ${artists}`;
        document.querySelectorAll('.imm-track-info').forEach(el => {
            el.innerText = infoStr;
        });
    },




    _initRingParams() {
        this.ringOffsets = Array.from({ length: this.rings }, () => Math.random());
        // Each ring gets a unique phase, speed multiplier, and chaos factor
        this.ringPhases = Array.from({ length: this.rings }, () => Math.random() * Math.PI * 2);
        this.ringSpeeds = Array.from({ length: this.rings }, () => 0.4 + Math.random() * 0.9);
        this.ringChaos = Array.from({ length: this.rings }, () => 0.5 + Math.random() * 1.5);
    },

    start() {
        if (this.animationId) return;
        this.draw();
    },

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.smoothData = null;
        this.activeBlend = 0;
        this.prevVolume = 0;
    },

    draw() {
        if (!Store.visualizerOpen) {
            this.stop();
            return;
        }

        this.animationId = requestAnimationFrame(() => this.draw());

        const analyser = PlayerEngine.analyser;
        let currentVolume = 0;

        if (analyser) {
            const rawData = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(rawData);

            if (!this.smoothData || this.smoothData.length !== rawData.length) {
                this.smoothData = new Float32Array(rawData.length);
            }

            let sum = 0;
            for (let i = 0; i < rawData.length; i++) {
                this.smoothData[i] += (rawData[i] - this.smoothData[i]) * 0.38;
                sum += this.smoothData[i];
            }
            currentVolume = sum / rawData.length;
        }

        // Smooth idle ↔ active blend (time-based, not frame-based)
        const hasSignal = currentVolume > 4;
        if (hasSignal) {
            this.idleFade = 110;
            this.activeBlend += (1 - this.activeBlend) * 0.06;
        } else if (this.idleFade > 0) {
            this.idleFade--;
            // Blend fades out over ~1.8s after signal drops
            this.activeBlend += (1 - this.activeBlend) * 0.03;
        } else {
            this.activeBlend += (0 - this.activeBlend) * 0.04;
        }

        this.prevVolume = currentVolume;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const cx = this.canvas.width / 2;
        const cy = this.canvas.height / 2;

        // Radius breathes with volume, but decoupled from canvas size to prevent clipping
        const volumeBoost = Math.min(currentVolume / 60, 1);
        const baseRadius = 45 + volumeBoost * 25;
        const ringSpacing = 3 + this.activeBlend * 3;

        for (let r = 0; r < this.rings; r++) {
            this.drawRing(cx, cy, baseRadius + r * ringSpacing, r, volumeBoost);
        }
    },

    drawRing(cx, cy, radius, index, volumeBoost) {
        const segments = 180;
        const time = Date.now() * 0.001;
        const blend = this.activeBlend;
        const chaos = this.ringChaos[index];
        const speed = this.ringSpeeds[index];
        const phase = this.ringPhases[index];
        const offset = this.ringOffsets[index];
        const data = this.smoothData;

        this.ctx.beginPath();

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const t = time * speed;

            // ── Idle distortion: layered sinusoids with unique per-ring chaos ──
            const idleDist =
                Math.sin(t * 0.35 + angle * 1.3 + phase) * 6 * chaos +
                Math.sin(t * 0.62 - angle * 2.7 + phase * 1.4) * 4 * chaos +
                Math.sin(t * 1.05 + angle * 5.1 - phase * 0.7) * 2 * chaos +
                Math.sin(t * 1.80 - angle * 8.0 + index * 0.9) * 1.2 +
                Math.cos(t * 0.28 + angle * 3.3 + index * 1.1) * 2.5 * chaos;

            // ── Active distortion from frequency data ──
            let activeDist = 0;
            if (data) {
                const maxIdx = Math.floor(data.length / 3.5);
                const progress = ((i / segments) + offset) % 1.0;
                const dataIdx = Math.floor(progress * maxIdx) + index * 3;
                const raw = data[dataIdx % data.length] / 255;

                // Extra chaos: slight randomized modulation on top of freq data
                const freqMod = Math.sin(t * 2.1 + angle * 6 + index * 1.3) * 0.18 + 1;
                activeDist = raw * 42 * chaos * freqMod;


                // Smooth seam taper
                const taper = 24;
                if (i < taper) activeDist *= i / taper;
                else if (i > segments - taper) activeDist *= (segments - i) / taper;
            }

            // ── High-freq micro-wiggle (always on) ──
            const wiggle = Math.sin(t * 7.5 + angle * 14 + index * 0.7) * (1.5 + chaos * 1.5);

            // ── Blend idle ↔ active ──
            const distortion = idleDist * (1 - blend) + activeDist * blend + wiggle;

            const r = radius + distortion;
            const px = cx + Math.cos(angle) * r;
            const py = cy + Math.sin(angle) * r;

            i === 0 ? this.ctx.moveTo(px, py) : this.ctx.lineTo(px, py);
        }

        this.ctx.closePath();

        // ── Color: green → cyan-white as volume rises ──
        const g = Math.round(215 + volumeBoost * 40);
        const b = Math.round(volumeBoost * 180);
        const baseAlpha = blend > 0.05
            ? (0.55 - index * 0.045) * (0.4 + volumeBoost * 0.6)
            : (0.18 - index * 0.016);

        this.ctx.strokeStyle = `rgba(30, ${g}, ${b}, ${Math.max(0.03, baseAlpha)})`;

        // ── Line width pulses with volume on inner rings ──
        const widthBoost = index < 3 ? volumeBoost * 1.8 : 0;
        this.ctx.lineWidth = 1.0 + widthBoost;

        this.ctx.stroke();
    }
};