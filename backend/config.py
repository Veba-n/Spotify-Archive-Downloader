from pathlib import Path

MUSIC_OUTPUT_DIR   = Path.home() / "Music" / "SpotifyArchive"
CONCURRENT_WORKERS = 8        # Number of parallel downloads (Warning: High values may lead to YouTube rate limits)
MAX_RETRIES        = 3        # Number of retries on failure
AUDIO_FORMAT       = "mp3"    # Supported formats: mp3 | m4a | flac | opus
AUDIO_QUALITY      = "0"      # for yt-dlp: 0=best, 9=worst
PREFERRED_CODEC    = "mp3"
BACKEND_PORT       = 8765

SEARCH_TEMPLATE    = "ytmsearch:{artist} - {title}"  # YouTube Music first
FALLBACK_TEMPLATE  = "ytsearch:{artist} - {title} official audio"
