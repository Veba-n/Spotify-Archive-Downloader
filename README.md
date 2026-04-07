**Language / Dil:** English &nbsp;|&nbsp; [Türkçe](README.tr.md)

---

# Spotify Archive Downloader

A self-hosted, two-part system for archiving Spotify playlists and playing them back through a premium web interface. The project consists of a Chrome extension that scrapes Spotify playlist metadata and a local Python backend that downloads, tags, and serves the audio library.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Chrome Extension](#chrome-extension)
- [Backend](#backend)
  - [Downloader](#downloader)
  - [Audio Tagger](#audio-tagger)
  - [Local Library Scanner](#local-library-scanner)
  - [REST API](#rest-api)
- [Web Player](#web-player)
  - [Playback Engine](#playback-engine)
  - [Playback Controls](#playback-controls)
  - [Session & State Persistence](#session--state-persistence)
  - [Audio Visualizer](#audio-visualizer)
  - [Lyrics Integration](#lyrics-integration)
  - [Tracklist](#tracklist)
  - [Details Panel](#details-panel)
  - [Sidebar & Library Navigation](#sidebar--library-navigation)
  - [Library Management](#library-management)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Internationalization](#internationalization)
- [Installation](#installation)
- [Configuration](#configuration)
- [Requirements](#requirements)

---

## Overview

Spotify Archive Downloader solves a practical problem: Spotify does not allow offline listening outside of its own application, and the local files feature is notably limited. This tool lets you build a permanent, DRM-free personal archive of any Spotify playlist you own or follow, stored as high-quality MP3 files on your local machine, complete with embedded artwork and ID3 metadata, all accessible through a browser-based music player that rivals the original Spotify experience in terms of interface polish.

The Chrome extension reads track data directly from Spotify's web interface without requiring API credentials. The backend receives this metadata, finds and downloads matching audio from YouTube Music or standard YouTube using `yt-dlp`, tags the resulting files with mutagen, and exposes the library through a FastAPI HTTP server. The web player runs entirely in the browser against this local server.

---

## Architecture

```
Spotify Web (browser)
        |
  Chrome Extension
        | (HTTP POST chunks)
        v
  FastAPI Backend (port 8765)
        |-- SQLite Database (sessions, jobs)
        |-- yt-dlp + FFmpeg (audio download + transcode)
        |-- mutagen (ID3/MP4/FLAC tagging)
        |-- Local filesystem (~/Music/SpotifyArchive/)
        |
  Web Player (/player)
        |-- PlayerEngine (HTMLAudioElement + Web Audio API)
        |-- Visualizer (Canvas 2D, real-time FFT)
        |-- LyricsManager (Genius API + server-side proxy)
        |-- Store (localStorage-backed state)
```

---

## Chrome Extension

The browser extension runs on `open.spotify.com` and provides a persistent popup interface for managing archive operations.

**Scraping mechanism.** The extension reads the DOM of any open Spotify playlist page, extracting track IDs, titles, artists, album names, durations, and cover art URLs. It does not use the Spotify API and requires no OAuth credentials.

**Chunked transfer.** Tracks are not sent all at once. The extension sends them to the backend in chunks as the playlist scrolls into view, allowing downloads to start immediately while the page is still being scraped. This means a 1000-track playlist begins downloading the first tracks within seconds, not after the full page has loaded.

**Session lifecycle.** On starting an archive, the extension sends a `POST /session/init` followed by multiple `POST /session/chunk` requests and a final `POST /session/finalize`. If the same playlist name already exists in the backend database, the session is merged rather than duplicated, preventing redundant downloads.

**Progress polling.** The popup polls `GET /session/{id}/progress` at regular intervals, displaying the number of completed, pending, and failed tracks in real time.

**Failure recovery.** If a track with a previous `failed` status is encountered in a new chunk, the backend automatically resets its status to `pending` and retries the download.

---

## Backend

The backend is a FastAPI application running on `localhost:8765`. It manages the database, download queue, file tagging, and serves the web player and audio streams.

### Downloader

The core download pipeline in `downloader.py` handles the full lifecycle of a single track: cover image acquisition, audio download, and ID3 tagging.

**Parallel download queue.** Downloads run through a `ThreadPoolExecutor` with a configurable number of workers (`CONCURRENT_WORKERS`, default: 8) and an `asyncio.Semaphore` to limit the number of simultaneous `yt-dlp` processes. This allows large playlists to be downloaded at high throughput without blocking the main event loop or saturating the network.

**YouTube Music priority with fallback.** For each track, the downloader first searches YouTube Music using the search query `{artist} - {title}` via `ytmsearch:`. If that fails, it falls back to a standard YouTube search for `{artist} - {title} official audio`. This two-stage approach maximizes the probability of finding a clean, music-only audio source.

**Best audio quality selection.** `yt-dlp` is configured with `format: bestaudio/best` and transcodes the result to the target codec (default: MP3, quality 0 = highest) via FFmpeg. No thumbnail, JSON info, or metadata is written by `yt-dlp` itself; all tagging is handled separately by the tagger module.

**Cover image resolution upgrading.** Raw cover URLs from Spotify often contain small image size codes. The downloader automatically rewrites these to request the 640x640 (`b273`) variant, with sequential fallback to 300x300 and 64x64 if the larger variant is unavailable. A minimum response size of 500 bytes is enforced to detect and reject malformed image responses.

**Per-track cover with playlist fallback.** Each track's individual cover is downloaded and cached under `{playlist_dir}/.covers/{track_id}.jpg`. If a track has no cover, the playlist-level cover (`cover.jpg`) is used as a fallback for embedding.

**Automatic startup resumption.** On every server start, the `auto_resume_sessions` event handler queries the database for any sessions that have pending, downloading, or tagging jobs and automatically re-queues them as background tasks. This means interrupted download sessions recover without any manual intervention.

**Manual session resume endpoint.** `POST /session/{id}/resume` resets all failed and stuck-in-progress jobs for a session back to `pending` and kicks off a new download batch. This gives the user an on-demand retry mechanism without re-scraping Spotify.

### Audio Tagger

`tagger.py` provides format-aware ID3 metadata embedding using mutagen.

**Supported formats:** MP3 (ID3v2.3), M4A/AAC (MP4 atoms), FLAC (Vorbis comments + embedded picture block).

**Embedded fields:** track title, primary artist(s) (semicolon-delimited for multi-artist tracks), album artist (TPE2 for MP3), album name, and front cover artwork (APIC / covr / Picture block).

**Duration extraction.** After writing tags, the tagger reads the actual audio duration from the transcoded file using `mutagen.mp3.MP3.info.length` (or the equivalent for M4A/FLAC) and returns it as a `MM:SS` string. This value is stored in the database and displayed by the web player.

**Live re-tagging.** When the user edits track metadata through the web player's edit modal, the backend calls `tag_audio_file` on the existing file on disk, ensuring the embedded tags inside the audio file always reflect what the player displays.

### Local Library Scanner

`scanner.py` runs at startup via `scan_and_rebuild_db()` and ensures that any audio files placed in the output directory outside the normal download pipeline are recognized and available in the player.

**Directory traversal.** The scanner walks every subdirectory of `MUSIC_OUTPUT_DIR`. Each subdirectory becomes a playlist session with a `local_` prefix session ID.

**Tag extraction.** For each audio file (MP3, M4A, AAC, FLAC, Opus, WebM, OGG), the scanner reads embedded tags using mutagen to extract title, artist(s), album, and duration.

**Embedded cover extraction.** If an embedded cover image is found (APIC for MP3, `covr` for M4A, `pictures` for FLAC), it is written to the `.covers/` subdirectory alongside the audio files, using the correct extension (jpg or png based on MIME type). This extracted cover is then served by the `/local-cover/` endpoint and displayed in the player.

**Idempotency.** Already-indexed tracks are skipped on subsequent scanner runs to prevent redundant database writes.

### REST API

The backend exposes a complete REST API consumed by both the Chrome extension and the web player.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/init` | Initialize a new download session |
| POST | `/session/chunk` | Receive a batch of track metadata |
| POST | `/session/finalize` | Mark session scraping as complete |
| GET | `/session/{id}/progress` | Real-time download progress |
| POST | `/session/{id}/resume` | Retry failed/incomplete downloads |
| GET | `/sessions` | List all archived playlists |
| DELETE | `/sessions/clear` | Wipe all data and stop all sessions |
| GET | `/session/{id}/tracks` | Get completed tracks for the player |
| GET | `/stream/{track_id}` | HTTP range-aware audio streaming |
| GET | `/player` | Serve the web player HTML |
| GET | `/api/lyrics/proxy` | Server-side proxy to bypass Genius CORS |
| GET | `/local-cover/{playlist}/{track_id}` | Serve extracted cover images |
| PATCH | `/api/track/{track_id}` | Update track metadata + re-tag file |
| DELETE | `/api/track/{track_id}` | Delete track from disk and database |
| POST | `/api/track/{track_id}/cover` | Upload and embed new cover art |
| DELETE | `/api/session/{session_id}` | Delete entire playlist archive |
| PATCH | `/api/session/{session_id}` | Rename a playlist session |
| POST | `/api/session/{session_id}/cover` | Upload new playlist cover image |

**HTTP Range streaming.** The `/stream/{track_id}` endpoint uses FastAPI's `FileResponse`, which natively handles `Range` requests. This means the player can seek to any position in a track without buffering the entire file, essential for large archives.

---

## Web Player

The web player is a single-page application served at `http://localhost:8765/player`. It is built with vanilla JavaScript using an ES module architecture. State management is centralized in the `Store` module, and all persistent preferences are backed by `localStorage`.

### Playback Engine

`PlayerEngine.js` wraps a native `HTMLAudioElement` and a `Web Audio API` graph.

**Audio context initialization.** The `AudioContext` is created lazily on the first user interaction (not at page load) to comply with browser autoplay policies. The audio element is connected to an `AnalyserNode` (FFT size 512) which feeds the visualizer. The analyser output is then connected to the audio destination so the visualizer does not interrupt playback.

**Cross-origin configuration.** The audio element's `crossOrigin` attribute is set to `"anonymous"` to allow the Web Audio API to process the stream when the server includes appropriate CORS headers.

**Track loading and UI synchronization.** `playTrack(idx)` sets the audio source to `/stream/{track_id}`, triggers playback, and simultaneously updates the now-playing cover, title, artist text, the playing row highlight in the tracklist, the fullscreen visualizer overlay, the OS-level `MediaSession` metadata (used by system media controls and lock screen displays), and kicks off the `LyricsManager` fetch for the new track.

**Error handling with automatic skip.** If a track fails to load (`onerror`), a toast notification is shown and the player automatically skips to the next track after 1.5 seconds, so playback continues uninterrupted through large playlists even when occasional tracks are corrupted or missing.

**Shuffle with Fisher-Yates.** When shuffle is enabled, `Controls.buildShuffle()` generates a new random permutation of all track indices using the Fisher-Yates algorithm. The currently playing track is placed at position zero of the shuffle order so it is not replayed immediately at the start of a shuffle session.

**Repeat modes.** Three repeat modes cycle in order: off (0), repeat list (1), repeat track (2). In repeat track mode, `nextTrack()` resets `currentTime` to zero and calls `play()` rather than advancing the index.

**Smart previous track.** If the current playback position is greater than 3 seconds, `prevTrack()` restarts the current track instead of going to the previous one. This matches the standard behavior of dedicated music players.

### Playback Controls

`Controls.js` wires all interactive playback controls.

**Progress bar seeking.** Mouse dragging on the progress bar sets `audio.currentTime` relative to the bar width. While dragging, the `isDraggingProgress` flag in `Store` prevents `onTimeUpdate` from overwriting the visual fill, eliminating jitter during scrubbing.

**Volume control.** The volume bar mirrors the progress bar interaction model. Volume changes are persisted to `localStorage` under `sa_volume`. On page load, `PlayerEngine` reads this value and restores the previous volume level automatically.

**Mute toggle with memory.** Clicking the volume icon stores the current volume in `_prevVol` and sets volume to zero. Clicking again restores the stored value. The volume icon visually reflects four discrete states: muted, low (0-33%), medium (33-66%), and high (66-100%) by toggling CSS classes on the SVG element.

**Lyrics panel toggle.** If no Genius API key is configured, clicking the lyrics button opens the settings modal instead of the panel, guiding the user to configure the key first.

**Visualizer toggle.** Opening the visualizer starts the `Visualizer.draw()` animation loop and updates the overlay with the current track info. Closing it cancels the animation frame and clears the canvas.

**Panel visibility persistence.** The open/closed state of the sidebar, details panel, lyrics panel, and visualizer is stored in `localStorage` and restored on every page load without the user having to reconfigure their layout.

### Session & State Persistence

All playback state is persisted to `localStorage` through `Store.savePlaybackState()`, called every time a track changes.

**Restored state on startup:**
- Last active playlist session (`player_last_session`)
- Last playing track (`player_last_track`)
- Playback timestamp, updated every 2 seconds during playback (`player_last_time`)
- Shuffle on/off state (`player_shuffle`)
- Repeat mode (0/1/2) (`player_repeat`)
- Volume level (`sa_volume`)
- Open/closed state of sidebar, details panel, lyrics panel, and visualizer

**Restore without autoplay.** `App.restoreTrack()` reconstructs the full player UI state (cover, title, artist, tracklist highlight, details panel, `MediaSession` metadata, lyrics) for the last-played track and seeks to the last known playback time, but does not auto-play. The user presses play to resume. This avoids the jarring experience of audio starting unexpectedly on page load.

**Language persistence.** The selected interface language is stored in `localStorage` under `player_lang` and applied on startup before any UI is rendered.

### Audio Visualizer

`Visualizer.js` implements a real-time, canvas-based radial ring visualizer driven by the Web Audio API's `AnalyserNode`.

**Multi-ring organic structure.** The visualizer renders 10 concentric rings, each with independently randomized parameters: phase offset, rotation speed multiplier, and a chaos factor that scales distortion amplitude. This produces a unique, organic appearance for every session.

**Dual-mode animation.** Each ring blends smoothly between two distortion modes using a normalized `activeBlend` scalar:

- *Idle mode* (no audio signal): the rings are driven by layered sinusoidal functions with different frequencies and amplitudes, creating a slow, breathing, organic motion that remains visually engaging even when music is paused.
- *Active mode* (audio playing): frequency bin data from the `AnalyserNode` is mapped onto each ring. Each ring reads a different region of the frequency spectrum, modulated by its individual chaos factor and a secondary sinusoidal frequency modulator. Inner rings receive a line-width boost proportional to volume, making the center pulse visibly with bass transients.

**Seam tapering.** The first and last 24 segments of each ring's path are linearly faded to prevent a visible seam where the closed path meets itself.

**Smooth idle-to-active transition.** `activeBlend` does not snap between states. When a signal is detected (RMS energy above a threshold), it ramps toward 1.0 at a rate of 6% per frame. When the signal drops, an `idleFade` counter of 110 frames delays the ramp-down, holding the active look briefly after a beat. Once the counter expires, `activeBlend` eases back to 0 at 4% per frame. This eliminates any flicker or hard cut between the two visual modes.

**Responsive canvas sizing.** A `ResizeObserver` on the container element keeps the canvas dimensions in sync with the container's layout rectangle, ensuring correct rendering when the window is resized or the visualizer is expanded to fullscreen.

**Draggable floating widget.** The visualizer container can be freely repositioned on screen by dragging its dedicated handle. CSS transitions are disabled during the drag to prevent input lag, then restored on mouse-up.

**Scale cycling.** A scale button cycles the visualizer widget through five scale levels (0.8x, 1.0x, 1.25x, 1.6x, 2.0x) using a CSS custom property `--viz-scale`. Returning to 1.0x resets the position to the default corner anchor.

**Fullscreen immersive mode.** A fullscreen button toggles the `is-fullscreen` CSS class on the container and the `viz-fullscreen-active` class on `document.body`. The transition is cross-faded through a 250ms opacity animation to prevent a hard visual cut. In fullscreen mode, the current track title and artist are displayed as a text overlay. A dedicated close button exits fullscreen mode with the same fade transition.

**Color response.** Ring stroke color transitions from green toward cyan-white as volume increases. The green channel is boosted from 215 to 255, and a blue channel from 0 to 180 is introduced, producing a signature glow effect at high volumes. Ring opacity scales with both the active blend level and the current volume, making the visualization feel physically connected to the audio energy.

### Lyrics Integration & AI Sync

`LyricsManager.js` fetches and displays song lyrics from the Genius API, with the backend providing an optional **AI-powered synchronization engine (Whisper)** for frame-perfect karaoke playback.

**AI Lyric Synchronization (Opt-in).** By default, the backend runs in **Lite Mode**, which consumes minimal resources. To enable AI sync, start the backend with the `--rsync-lyric` flag:
```bash
./start.sh --rsync-lyric
```
In this mode, the backend utilizes `faster-whisper` (running on CUDA if available) to align Genius lyrics with the audio stream in real-time.

**Word-Level Karaoke.** When AI sync is active, the player provides a premium karaoke experience with word-level highlighting and smooth auto-scrolling. The engine uses character-rate extrapolation to ensure perfectly timed transitions even for fast-paced tracks.

**Baked Sync Maps.** Once a song is synchronized successfully, the results are "baked" into a `.sync.json` file. Subsequent playbacks—even in **Lite Mode**—use these baked maps to provide instant, frame-perfect synchronization with zero CPU/GPU overhead.

**Reading Mode.** A "Magic Sparkles" toggle in the immersive header allows users to switch between **Karaoke** (auto-sync) and **Reading Mode** (manual scroll with sharp white text).

**Server-side lyrics proxy.** Genius renders lyrics in client-side JavaScript, making direct fetch-based scraping impossible due to CORS restrictions. To work around this, the player requests the Genius page through the backend at `GET /api/lyrics/proxy?url=...`, which fetches the full HTML server-side and returns it as JSON.

**Garbage line filtering.** After extracting raw text from the HTML, the manager strips common UI artifacts from both the top and bottom of the lyrics block: contributor counts, translation labels, "X Lyrics" headers, "Embed" footers, "Share URL" prompts, and "Copy Embed Code" strings.

**Graceful degradation.** If lyrics text cannot be extracted from the HTML (e.g., due to a Genius page structure change), the panel displays the song title and artist with a direct link to the Genius page for manual viewing.

**Deferred loading.** If the lyrics panel is closed when a new track starts, `LyricsManager.update()` only performs the Genius search and metadata fetch (to populate the Details Panel's artist bio and song info). The full lyrics text is fetched only when the panel is opened, minimizing unnecessary network traffic.

### Tracklist

`Tracklist.js` renders the interactive list of tracks for the currently loaded playlist.

**Row-level playback.** Clicking any row in the tracklist calls `PlayerEngine.playTrack(idx)`. The active track's row receives a `playing` CSS class, causing the row number to be replaced by an animated equalizer bar animation (four bars with independent CSS keyframe animations).

**Real-time text search.** An input field above the tracklist instantly filters visible rows by matching the query string against track title, artist name, and album name simultaneously, with no button press required.

**Multi-column sorting.** Column headers for track number, title, album, and duration are clickable. Clicking a header sorts the tracklist by that field; clicking again reverses the order. The active sort column is indicated by a CSS class on the header cell. Sorting mutates `Store.currentTracks` in place so the play order follows the visual order.

**Track editing.** Each row has an edit action button that opens a modal pre-populated with the track's current title, artists, album, and cover art. The artist field accepts a comma-delimited string. On save, the changes are sent to `PATCH /api/track/{id}` which updates both the database and the embedded ID3 tags in the audio file on disk. If a new cover image is selected in the modal, it is separately uploaded to `POST /api/track/{id}/cover` where it is embedded into the audio file using mutagen.

**Track deletion.** A delete action button opens a confirmation modal. On confirmation, `DELETE /api/track/{id}` removes the audio file from disk and the record from the database. The tracklist re-renders immediately without a page reload.

**Empty state.** If the search filter produces no matches, a centered "No matching tracks found" message is displayed in place of the table rows.

### Details Panel

`DetailsPanel.js` manages a collapsible side panel that shows extended information about the currently playing track.

**Displayed fields:** full-resolution cover art, track title, artist name, album name, track duration, archive date (formatted with the browser's locale), and a direct link to the track's original Spotify URL when available.

**Genius-powered extended info.** When `LyricsManager` completes its `fetchExtraInfo` call for the current track, `DetailsPanel.updateExtraInfo()` receives the Genius song description (about the song) and the artist biography, displaying them in dedicated collapsible sections. These sections remain hidden until data is available, preventing layout shift.

**Cover art replacement.** Clicking the cover art in the details panel opens a file picker. Selecting a new image uploads it to `POST /api/track/{id}/cover`, which embeds it into the audio file on disk. The UI refreshes the cover in both the details panel and the tracklist row immediately without a page reload.

**Panel toggle.** The panel state (open/closed) is persisted in `localStorage`. Clicking the album art thumbnail in the now-playing bar also toggles the panel. The panel slides in and out via a CSS class toggle.

### Sidebar & Library Navigation

`Sidebar.js` manages the left-side playlist browser.

**Session list.** All archived playlists are listed as cards with their cover image, name, and a track count in the format `{done}/{total} Downloaded`. Sessions with zero completed tracks are filtered out.

**Playlist search.** A search input at the top of the sidebar filters the visible playlist cards in real time by playlist name.

**Active state.** The currently loaded playlist's card receives an `active` CSS class.

**Playlist header.** When a playlist is loaded, the main content area displays the playlist cover, name, total track count, and the total formatted duration (`X hr Y min` or `Y min Z sec`).

**Playlist editing.** Each playlist card has an edit button that opens a modal for renaming the playlist and replacing its cover image. The name change is sent to `PATCH /api/session/{id}`. A new cover is uploaded to `POST /api/session/{id}/cover`. If the edited playlist is currently active, the header title and cover update live without reloading.

**Playlist deletion.** A delete button opens a confirmation modal. On confirmation, `DELETE /api/session/{id}` removes all associated audio files from disk and all database records for that session. If the deleted playlist is currently playing, the page reloads.

**Sidebar collapse.** The sidebar can be hidden via a toggle button in the control bar. The collapsed state is persisted to `localStorage`.

**Settings modal.** The settings button (gear icon) opens a modal for selecting the interface language (English or Turkish) and entering the Genius API key. Changes are applied immediately on save.

### Library Management

Beyond the per-track operations described in the Tracklist and Details Panel sections, the backend provides additional library-level management endpoints.

**Complete archive deletion.** `DELETE /sessions/clear` wipes the entire SQLite database and clears all in-memory session state, providing a clean-slate reset without touching files.

**Session recovery endpoint.** `POST /session/{id}/resume` is designed for situations where the server was interrupted mid-download, tracks stalled in `downloading` or `tagging` states, or individual tracks failed. It resets the affected jobs and immediately dispatches a new background download batch.

### Keyboard Shortcuts

Global keyboard shortcuts are bound in `App.bindGlobalEvents()`. All shortcuts are disabled when an input field is focused.

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Arrow Right | Seek forward 5 seconds |
| Arrow Left | Seek backward 5 seconds |
| Arrow Up | Increase volume by 5% |
| Arrow Down | Decrease volume by 5% |

### Internationalization

The player supports English and Turkish interface languages. All user-visible strings are defined in a `locales` object in `app.js`. The active language is stored in `localStorage` and applied at startup. Switching languages re-renders the entire UI, including playlist duration labels and tracklist headers, without a page reload.

Translation keys cover: all sidebar labels, tracklist column headers, playback state strings, error messages, toast notifications, settings modal labels, and repeat mode labels.

---

## Installation

**Prerequisites:**
- Python 3.10 or later
- FFmpeg (must be accessible in `PATH`)
- Google Chrome or Chromium

**Backend setup:**

```bash
cd backend
pip install -r requirements.txt
./start.sh
```

The backend starts on `http://localhost:8765`. The web player is accessible at `http://localhost:8765/player`.

**Extension setup:**

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and select the `extension/` directory
4. Navigate to any Spotify playlist and click the extension icon to begin archiving

---

## Configuration

All backend parameters are set in `backend/config.py`.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MUSIC_OUTPUT_DIR` | `~/Music/SpotifyArchive` | Root directory for all downloaded audio |
| `CONCURRENT_WORKERS` | `8` | Number of parallel yt-dlp download threads |
| `MAX_RETRIES` | `3` | Per-track retry attempts on failure |
| `AUDIO_FORMAT` | `mp3` | Output audio format (`mp3`, `m4a`, `flac`, `opus`) |
| `AUDIO_QUALITY` | `0` | yt-dlp quality setting (0 = best, 9 = worst) |
| `PREFERRED_CODEC` | `mp3` | FFmpeg codec for transcoding |
| `BACKEND_PORT` | `8765` | Local server port |
| `SEARCH_TEMPLATE` | `ytmsearch:{artist} - {title}` | Primary search query (YouTube Music) |
| `FALLBACK_TEMPLATE` | `ytsearch:{artist} - {title} official audio` | Fallback search query (YouTube) |

---

## Requirements

```
fastapi
uvicorn
yt-dlp
mutagen
aiohttp
```

Python dependencies are listed in `backend/requirements.txt`. FFmpeg must be installed separately via your system package manager (`apt install ffmpeg`, `brew install ffmpeg`, etc.).
