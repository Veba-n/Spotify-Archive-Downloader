import { Store } from '../modules/Store.js';

export const DetailsPanel = {
    init() {
        const panel = document.getElementById('details-panel');
        if (Store.detailsOpen) panel.classList.remove('closed');
        else panel.classList.add('closed');

        document.getElementById('btn-close-details').onclick = () => this.toggle();

        const coverInput = document.getElementById('cover-upload-input');
        const coverImg = document.getElementById('details-cover');

        coverImg.parentElement.onclick = () => coverInput.click();

        coverInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file || !Store.currentTrack) return;

            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(`/api/track/${Store.currentTrack.track_id}/cover`, {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                // Refresh both cover instances in UI
                const newUrl = `${Store.currentTrack.cover_url}?t=${Date.now()}`;
                coverImg.src = newUrl;
                Store.currentTrack.cover_url = newUrl;
                // Force tracklist refresh
                window.app.tracklist.render(Store.currentTracks);
            }
        };
    },

    toggle() {
        const open = Store.toggleDetails();
        const panel = document.getElementById('details-panel');
        panel.classList.toggle('closed', !open);
    },

    update(track) {
        if (!track) return;
        const artist = window.parseArtists(track.artists);
        document.getElementById('details-cover').src = track.cover_url || '';
        document.getElementById('details-title').innerText = track.title;
        document.getElementById('details-artist').innerText = artist;
        document.getElementById('details-album').innerText = track.album || '---';
        document.getElementById('details-duration').innerText = track.duration || '---';

        // Clear Extra Info
        document.getElementById('section-artist-bio').style.display = 'none';
        document.getElementById('section-song-info').style.display = 'none';

        // Date formatting
        const date = track.created_at ? new Date(track.created_at).toLocaleDateString() : '---';
        document.getElementById('details-date').innerText = date;

        const spotifyLink = document.getElementById('details-spotify');
        if (spotifyLink) {
            if (track.spotify_url) {
                spotifyLink.href = track.spotify_url;
                spotifyLink.style.display = 'flex';
            } else {
                spotifyLink.style.display = 'none';
            }
        }
    },


    updateExtraInfo(info) {
        if (!info) return;

        if (info.artistBio && info.artistBio !== '?') {
            document.getElementById('section-artist-bio').style.display = 'block';
            document.getElementById('details-artist-bio').innerText = info.artistBio;
        }

        if (info.songInfo && info.songInfo !== '?') {
            document.getElementById('section-song-info').style.display = 'block';
            document.getElementById('details-song-info').innerText = info.songInfo;
        }
    }
};

