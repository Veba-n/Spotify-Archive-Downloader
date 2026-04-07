import { Store } from '../modules/Store.js';
import { Modal } from '../modules/Modal.js';

export const Tracklist = {
    sortKey: null,
    sortAsc: true,

    init() {
        document.getElementById('track-search-input').addEventListener('input', e => this.filter(e.target.value));
        document.querySelectorAll('.track-list thead th[data-sort]').forEach(th => {
            th.onclick = () => this.sort(th.dataset.sort);
        });
    },

    render(tracks) {
        const tbody = document.getElementById('track-body');
        tbody.innerHTML = '';
        if (tracks.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);">${window.t('js_no_match')}</td></tr>`;
            return;
        }

        tracks.forEach((t, i) => {
            const idx = Store.currentTracks.indexOf(t);
            const tr = document.createElement('tr');
            tr.className = 'track-row';
            if (idx === Store.currentTrackIndex) tr.classList.add('playing');
            tr.onclick = () => window.player.playTrack(idx);

            const artist = window.parseArtists(t.artists);
            tr.innerHTML = `
                <td>
                    <div class="track-num">
                        <span class="num">${idx + 1}</span>
                        <svg class="play-icon" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/>
                        </svg>
                        <div class="eq-bars"><span></span><span></span><span></span><span></span></div>
                    </div>
                </td>
                <td>
                    <div class="track-cell-title">
                        <img src="${t.cover_url || ''}" onerror="this.style.background='#282828'">
                        <div class="info">
                            <p class="track-title">${t.title}</p>
                            <p class="track-artist">${artist}</p>
                        </div>
                    </div>
                </td>
                <td class="track-album">${t.album || ''}</td>
                <td class="track-duration">${t.duration || ''}</td>
                <td>
                    <div class="track-actions">
                        <button class="btn-action edit" data-id="${t.track_id}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
                        </button>
                        <button class="btn-action delete" data-id="${t.track_id}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>
                    </div>
                </td>`;

            tr.querySelector('.edit').onclick = (e) => { e.stopPropagation(); this.openEditModal(t); };
            tr.querySelector('.delete').onclick = (e) => { e.stopPropagation(); this.openDeleteModal(t); };
            tbody.appendChild(tr);
        });
    },

    filter(q) {
        const query = q.toLowerCase();
        const filtered = Store.currentTracks.filter(t => {
            const artist = window.parseArtists(t.artists).toLowerCase();
            return (t.title && t.title.toLowerCase().includes(query)) ||
                artist.includes(query) ||
                (t.album && t.album.toLowerCase().includes(query));
        });
        this.render(filtered);
    },

    sort(key) {
        if (this.sortKey === key) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.sortKey = key;
            this.sortAsc = true;
        }

        Store.currentTracks.sort((a, b) => {
            let valA = a[key] || '';
            let valB = b[key] || '';
            if (key === 'artists') {
                valA = window.parseArtists(a.artists);
                valB = window.parseArtists(b.artists);
            }
            if (valA < valB) return this.sortAsc ? -1 : 1;
            if (valA > valB) return this.sortAsc ? 1 : -1;
            return 0;
        });

        // Update UI headers
        document.querySelectorAll('.track-list thead th').forEach(th => {
            th.classList.remove('active', 'asc');
            if (th.dataset.sort === key) {
                th.classList.add('active');
                if (this.sortAsc) th.classList.add('asc');
            }
        });

        this.render(Store.currentTracks);
    },

    _pendingCoverFile: null,

    openEditModal(track) {
        this._pendingCoverFile = null;
        document.getElementById('edit-title').value = track.title || '';
        document.getElementById('edit-artists').value = window.parseArtists(track.artists);
        document.getElementById('edit-album').value = track.album || '';

        // Cover preview
        const preview = document.getElementById('edit-cover-preview');
        preview.src = track.cover_url || '';
        const fileInput = document.getElementById('edit-cover-file');
        const area = document.getElementById('edit-cover-area');

        area.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                this._pendingCoverFile = file;
                preview.src = URL.createObjectURL(file);
            }
        };

        Modal.show('modal-edit-track', async () => {
            const title = document.getElementById('edit-title').value;
            const artistsStr = document.getElementById('edit-artists').value;
            const album = document.getElementById('edit-album').value;
            const artists = artistsStr.split(',').map(a => a.trim()).filter(a => a);

            // Save metadata
            const body = { title, artists, album };
            const res = await fetch(`/api/track/${track.track_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            // Upload cover if changed
            if (this._pendingCoverFile) {
                const formData = new FormData();
                formData.append('file', this._pendingCoverFile);
                await fetch(`/api/track/${track.track_id}/cover`, {
                    method: 'POST',
                    body: formData
                });
                track.cover_url = track.cover_url + '?t=' + Date.now();
            }

            if (res.ok) {
                track.title = title;
                track.artists = JSON.stringify(artists);
                track.album = album;
                this.render(Store.currentTracks);
                return true;
            }
            return false;
        });
    },

    openDeleteModal(track) {
        document.getElementById('confirm-msg').innerText = `Are you sure you want to delete "${track.title}"? This will remove the file from your disk permanently.`;
        Modal.show('modal-confirm', async () => {
            const res = await fetch(`/api/track/${track.track_id}`, { method: 'DELETE' });
            if (res.ok) {
                Store.currentTracks = Store.currentTracks.filter(t => t.track_id !== track.track_id);
                this.render(Store.currentTracks);
                return true;
            }
            return false;
        });
    }
};
