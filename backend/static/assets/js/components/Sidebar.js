import { Store } from '../modules/Store.js';
import { Modal } from '../modules/Modal.js';

export const Sidebar = {
    init() {
        this.render();
        const sidebar = document.getElementById('sidebar');
        if (Store.sidebarOpen) sidebar.classList.remove('closed');
        else sidebar.classList.add('closed');

        document.getElementById('search-input').addEventListener('input', e => this.filter(e.target.value));
        document.getElementById('btn-settings').onclick = () => this.openSettingsModal();
    },

    toggle() {
        const open = Store.toggleSidebar();
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('closed', !open);
    },

    render() {
        const sessions = Store.allSessions;
        const container = document.getElementById('playlist-container');
        if (!sessions.length) {
            container.innerHTML = `<div class="sidebar-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" opacity="0.4">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
                <span>${window.t('js_no_archive')}</span>
            </div>`;
            return;
        }
        this.filter('');
    },

    filter(q) {
        const container = document.getElementById('playlist-container');
        container.innerHTML = '';
        const filtered = q ? Store.allSessions.filter(s => (s.playlist_name || '').toLowerCase().includes(q.toLowerCase())) : Store.allSessions;

        filtered.forEach(sess => {
            const el = document.createElement('div');
            el.className = 'playlist-item';
            if (Store.currentSession && Store.currentSession.session_id === sess.session_id) el.classList.add('active');

            el.innerHTML = `
                <img src="${sess.cover_url || ''}" onerror="this.style.background='#282828';this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23555%22><path d=%22M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z%22/></svg>'">
                <div class="playlist-info">
                    <div class="playlist-title">${sess.playlist_name || window.t('js_unknown')}</div>
                    <div class="playlist-meta">${sess.done_count}/${sess.total_tracks} ${window.t('js_down')}</div>
                </div>
                <div class="playlist-actions">
                    <button class="btn-playlist-edit" title="Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"></path></svg>
                    </button>
                    <button class="btn-playlist-delete" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>`;

            // Playlist item click => load playlist
            el.onclick = () => window.app.loadPlaylist(sess);

            // Edit button
            el.querySelector('.btn-playlist-edit').onclick = (e) => {
                e.stopPropagation();
                this.openEditSessionModal(sess);
            };

            // Delete button
            el.querySelector('.btn-playlist-delete').onclick = (e) => {
                e.stopPropagation();
                this.openDeleteSessionModal(sess);
            };

            container.appendChild(el);
        });
    },

    _pendingPlaylistCover: null,

    openEditSessionModal(sess) {
        this._pendingPlaylistCover = null;
        document.getElementById('edit-playlist-name').value = sess.playlist_name || '';

        // Cover preview
        const preview = document.getElementById('edit-playlist-cover-preview');
        preview.src = sess.cover_url || '';
        const fileInput = document.getElementById('edit-playlist-cover-file');
        const area = document.getElementById('edit-playlist-cover-area');

        area.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                this._pendingPlaylistCover = file;
                preview.src = URL.createObjectURL(file);
            }
        };

        Modal.show('modal-edit-playlist', async () => {
            const newName = document.getElementById('edit-playlist-name').value.trim();
            if (!newName) return false;

            // Rename
            const res = await fetch(`/api/session/${sess.session_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playlist_name: newName })
            });

            // Upload cover if changed
            if (this._pendingPlaylistCover) {
                const formData = new FormData();
                formData.append('file', this._pendingPlaylistCover);
                await fetch(`/api/session/${sess.session_id}/cover`, {
                    method: 'POST',
                    body: formData
                });
                sess.cover_url = sess.cover_url + '?t=' + Date.now();
            }

            if (res.ok) {
                sess.playlist_name = newName;
                this.filter(document.getElementById('search-input').value);
                // Also update header if this is the current session
                if (Store.currentSession && Store.currentSession.session_id === sess.session_id) {
                    document.getElementById('header-title').innerText = newName;
                    if (this._pendingPlaylistCover) {
                        document.getElementById('header-cover').src = sess.cover_url;
                    }
                }
                return true;
            }
            return false;
        });
    },

    openDeleteSessionModal(sess) {
        document.getElementById('confirm-msg').innerText = `Are you sure you want to delete the archive "${sess.playlist_name}"? All downloaded tracks and the folder will be deleted permanently.`;
        Modal.show('modal-confirm', async () => {
            const res = await fetch(`/api/session/${sess.session_id}`, { method: 'DELETE' });
            if (res.ok) {
                Store.allSessions = Store.allSessions.filter(s => s.session_id !== sess.session_id);
                this.render();
                if (Store.currentSession && Store.currentSession.session_id === sess.session_id) {
                    location.reload();
                }
                return true;
            }
            return false;
        });
    },

    openSettingsModal() {
        let tempLang = Store.lang;
        const geniusInput = document.getElementById('settings-genius-key');
        geniusInput.value = Store.geniusApiKey;

        const updateLangButtons = (lang) => {
            document.getElementById('set-lang-en').classList.toggle('active', lang === 'en');
            document.getElementById('set-lang-tr').classList.toggle('active', lang === 'tr');
        };

        updateLangButtons(tempLang);

        document.getElementById('set-lang-en').onclick = () => { tempLang = 'en'; updateLangButtons('en'); };
        document.getElementById('set-lang-tr').onclick = () => { tempLang = 'tr'; updateLangButtons('tr'); };

        Modal.show('modal-settings', async () => {
            const newKey = geniusInput.value.trim();
            Store.setGeniusApiKey(newKey);

            if (tempLang !== Store.lang) {
                window.app.setLang(tempLang);
            }

            window.showToast(window.t('js_settings_saved'));
            return true;
        });
    }
};
