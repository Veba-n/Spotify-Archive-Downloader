# Spotify Archive Downloader

A distributed archiving toolchain designed to persistently extract, download, and catalog Spotify playlist metadata and high-fidelity audio streams. The architecture utilizes a decoupled approach: a Manifest V3 Google Chrome extension acts as an autonomous DOM scanner and metadata extraction utility, while a Python-based FastAPI backend manages asynchronous dispatching, download resolution, and ID3v2 tagging execution.

## Architectural Overview

This system is built upon two core subsystems:

### 1. Browser Extension (Client-Side Metadata Extractor)
- **Manifest V3 Implementation**: Ensures strict compliance with modern Chrome extension guidelines by offloading persistence to the Service Worker and ephemeral storage via the `chrome.storage` API.
- **Virtualized DOM Parsing**: Intelligently hooks into the Spotify Web Player's virtualized list containers, extracting track context asynchronously to bypass limits imposed by lazy-loading components.
- **Batched IPC Delivery**: Resolves out-of-memory overhead by dispatching parsed structured track components in bounded chunks to the FastAPI endpoint, mitigating performance degradation on large (900+ track) datasets.

### 2. FastAPI Backend (Job Controller & Streaming Service)
- **High-Concurrency I/O Operations**: Deploys an asynchronous event loop via `asyncio` handling HTTP requests while delegating intensive network requests (like querying streams) to a configurable pool using `ThreadPoolExecutor`.
- **Audio Extraction**: Binds natively to `yt-dlp` resolving metadata queries efficiently via intelligent fallback query algorithms. Audio is subsequently post-processed via `ffmpeg`.
- **Idempotent Data Layer**: Incorporates an SQLite database to ensure fully ACID-compliant operation deduplication. The schema tracks session progression enabling strict auto-resumption constraints without invoking redundant I/O requests.
- **Metadata Encoding (ID3v2 & AAC)**: Implements `mutagen` to forcefully embed deep structural metadata (Album Artwork, Artist parameters, Duration thresholds) matching the targeted bitstream accurately.

## Technical Prerequisites

To compile and execute the environment, the following toolchains must be validated within your system PATH:

* **Python 3.10+**: Baseline requirement for `asyncio` task groupings and robust type hinting.
* **FFmpeg**: Required as a transitive dependency for `yt-dlp` allowing precise audio codec transformations.
  * Ubuntu: `sudo apt install ffmpeg`
  * Arch: `sudo pacman -S ffmpeg`
  * Fedora: `sudo dnf install ffmpeg`
* **Google Chrome / Chromium**: Target execution environment for the Manifest V3 client extension.

## Environment Initialization

### Backend Orchestration
The primary backend daemon requires localized execution to instantiate the SQLite instance and web listener.

1. Clone the project tree:
   ```bash
   git clone https://github.com/Veba-n/Spotify-Archive-Downloader.git
   cd Spotify-Archive-Downloader/backend
   ```
2. Instantiate an isolated Python environment (recommended):
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Fulfill the dependencies payload:
   ```bash
   pip install -r requirements.txt
   ```
4. Initiate the ASGI server pipeline:
   ```bash
   bash start.sh
   # Direct execution: uvicorn main:app --host 127.0.0.1 --port 8765
   ```

### Client Extension Injection
1. Navigate your Chromium-based browser to `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **"Load unpacked"** and target the `/extension` directory within the cloned repository.

## Operation Protocol

1. Initialize the backend daemon ensuring port `8765` is bound and listening.
2. Navigate to an arbitrary Spotify playlist utilizing the Web Player interface.
3. Access the extension interface and provision the **Download Playlist** daemon.
4. The extraction pipeline will iteratively scrub the DOM, submitting RESTful payloads to the local endpoint.
5. Monitor database polling natively within the Extension UI or verify filesystem artifacts in the defined persistent location (Default: `~/Music/SpotifyArchive`).

## Web Player Runtime

The system natively provisions an interactive HTML5 audio streaming application exposed over the endpoint `http://127.0.0.1:8765/player`. This client bypasses localized CORS restrictions to safely dispatch HTTP Range requests against the local HTTP server, permitting asynchronous streaming, track shuffling, and cross-session UI localization support (EN/TR).

## License & Security Statement
This repository is provisioned strictly for educational data-preservation environments. The maintainers invoke no liability for account suspensions resulting from excessively querying protected streaming infrastructure endpoints.
