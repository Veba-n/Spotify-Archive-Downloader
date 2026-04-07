import asyncio
import json
import re
import logging
import aiohttp
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import yt_dlp

from config import (
    CONCURRENT_WORKERS, AUDIO_FORMAT, PREFERRED_CODEC,
    AUDIO_QUALITY, SEARCH_TEMPLATE, FALLBACK_TEMPLATE
)
from database import update_job_status, JobStatus
from tagger import tag_audio_file

log = logging.getLogger("downloader")
logging.basicConfig(level=logging.INFO)

# Shared thread pool (CONCURRENT_WORKERS parallel jobs)
executor = ThreadPoolExecutor(max_workers=CONCURRENT_WORKERS)

# Spotify CDN size codes - large to small
_SIZE_CODES = ['b273', '1e02', '4851']  # 640x640, 300x300, 64x64
_SIZE_PATTERN = re.compile(r'(ab67[a-z0-9]{4}0000)(b273|1e02|4851|d72c)')


def sanitize_filename(name: str) -> str:
    """Clean forbidden characters in filename"""
    return re.sub(r'[\\/*?:"<>|]', '_', name).strip()


def _make_cover_variants(url: str) -> list[str]:
    """Generate HD -> Medium -> Small sequential tries from a cover URL"""
    if not url:
        return []
    m = _SIZE_PATTERN.search(url)
    if not m:
        return [url]  # Unrecognized format, try as is
    prefix, _ = m.group(1), m.group(2)
    return [_SIZE_PATTERN.sub(f'{prefix}{code}', url) for code in _SIZE_CODES]


async def download_cover(url: str, dest: Path, session: aiohttp.ClientSession,
                         force: bool = False):
    """Download cover photo. If force=True, redownload existing file."""
    if not url:
        return
    if dest.exists() and not force:
        return
    try:
        # Create size variants from URL and try sequentially
        variants = _make_cover_variants(url)
        for variant_url in variants:
            async with session.get(variant_url) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    if len(data) > 500:  # Is it a valid image?
                        dest.write_bytes(data)
                        log.info(f"[Cover] ✅ {dest.name} ← {variant_url[:80]}...")
                        return
                    else:
                        log.warning(f"[Cover] ⚠️ Very small response ({len(data)}B): {variant_url[:80]}")
                else:
                    log.warning(f"[Cover] ❌ HTTP {resp.status}: {variant_url[:80]}")
        log.error(f"[Cover] No variant worked: {url[:80]}")
    except Exception as e:
        log.error(f"[Cover] Download error: {e}")


def upgrade_cover_url(url: str) -> str:
    """Force Spotify small cover URLs to high quality (640x640)"""
    if not url:
        return url
    return _SIZE_PATTERN.sub(lambda m: f'{m.group(1)}b273', url)


def _yt_dlp_download(track: dict, output_dir: Path) -> str:
    """
    Download track with yt-dlp (synchronous, runs in thread).
    Returns file path on success.
    """
    artists = json.loads(track['artists']) if isinstance(track['artists'], str) \
              else track['artists']
    artist_str = ', '.join(artists[:2])  # First 2 artists are enough
    safe_name  = sanitize_filename(f"{artist_str} - {track['title']}")
    out_tmpl   = str(output_dir / f"{safe_name}.%(ext)s")

    # First search YouTube Music, if not found fallback to regular YouTube
    queries = [
        SEARCH_TEMPLATE.format(artist=artist_str, title=track['title']),
        FALLBACK_TEMPLATE.format(artist=artist_str, title=track['title']),
    ]

    ydl_opts = {
        'format':            'bestaudio/best',
        'outtmpl':           out_tmpl,
        'quiet':             True,
        'no_warnings':       True,
        'noplaylist':        True,
        'max_downloads':     1,
        'retries':           2,
        'fragment_retries':  2,
        'socket_timeout':    15,
        'postprocessors': [{
            'key':              'FFmpegExtractAudio',
            'preferredcodec':   PREFERRED_CODEC,
            'preferredquality': AUDIO_QUALITY,
        }],
        # Prevent yt-dlp from embedding metadata, we will do it with mutagen
        'writethumbnail':    False,
        'writeinfojson':     False,
        'embedthumbnail':    False,
        'addmetadata':       False,
    }

    last_error = "Unknown hata"
    for query in queries:
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([query])

            # Find the generated file
            for ext in [AUDIO_FORMAT, 'm4a', 'webm', 'opus']:
                candidate = output_dir / f"{safe_name}.{ext}"
                if candidate.exists():
                    return str(candidate)
        except yt_dlp.utils.MaxDownloadsReached:
            # 1 track downloaded, normal
            for ext in [AUDIO_FORMAT, 'm4a', 'webm', 'opus']:
                candidate = output_dir / f"{safe_name}.{ext}"
                if candidate.exists():
                    return str(candidate)
        except Exception as e:
            last_error = str(e)
            continue  # Try fallback query

    raise RuntimeError(f"Could not download: {last_error}")


async def process_track(track: dict, output_dir: Path,
                        playlist_cover_path: Path, http_session: aiohttp.ClientSession):
    """Full flow for a single track: download cover -> audio -> tag"""
    track_id = track['track_id']

    try:
        update_job_status(track_id, JobStatus.DOWNLOADING)

        # Download each track's own cover
        track_cover = None
        raw_cover_url = track.get('cover_url')
        track_cover_url = upgrade_cover_url(raw_cover_url)

        log.info(f"[Track] {track['title']} | raw_cover={raw_cover_url and raw_cover_url[-30:]} → upgraded={track_cover_url and track_cover_url[-30:]}")

        if track_cover_url:
            covers_dir = output_dir / ".covers"
            covers_dir.mkdir(exist_ok=True)
            track_cover = covers_dir / f"{sanitize_filename(track_id)}.jpg"
            await download_cover(track_cover_url, track_cover, http_session, force=True)
            if not track_cover.exists():
                track_cover = None

        # If track has no cover, fallback to playlist cover
        final_cover = track_cover if track_cover and track_cover.exists() \
                      else (playlist_cover_path if playlist_cover_path.exists() else None)
        log.info(f"[Track] {track['title']} | final_cover={'TRACK' if track_cover else 'PLAYLIST'}")

        # Run yt-dlp in thread pool (does not block event loop)
        loop = asyncio.get_event_loop()
        file_path = await loop.run_in_executor(
            executor, _yt_dlp_download, track, output_dir
        )

        # ID3 tagging
        update_job_status(track_id, JobStatus.TAGGING)
        artists = json.loads(track['artists']) if isinstance(track['artists'], str) \
                  else track['artists']
        dur_str = tag_audio_file(
            file_path  = file_path,
            title      = track['title'],
            artists    = artists,
            album      = track.get('album', ''),
            cover_path = str(final_cover) if final_cover else None,
        )

        update_job_status(track_id, JobStatus.DONE, output_path=file_path, duration=dur_str)
        return True

    except Exception as e:
        update_job_status(track_id, JobStatus.FAILED, error_msg=str(e))
        return False


async def run_download_session(session_id: str, playlist_meta: dict,
                               tracks: list, output_dir: Path):
    """
    Download all tracks with parallel workers.
    Limit concurrent jobs with Semaphore.
    """
    semaphore = asyncio.Semaphore(CONCURRENT_WORKERS)

    if isinstance(output_dir, str):
        output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    async with aiohttp.ClientSession() as http_session:
        # Download playlist cover (as fallback)
        playlist_cover_path = output_dir / "cover.jpg"
        cover_url = playlist_meta.get('cover_url') if isinstance(playlist_meta, dict) \
                    else getattr(playlist_meta, 'cover_url', None)
        cover_url = upgrade_cover_url(cover_url)
        await download_cover(cover_url, playlist_cover_path, http_session)

        async def bounded_process(track):
            async with semaphore:
                return await process_track(track, output_dir, playlist_cover_path, http_session)

        # Start all tracks simultaneously (limited by semaphore)
        tasks = [bounded_process(t) for t in tracks]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    done   = sum(1 for r in results if r is True)
    failed = sum(1 for r in results if r is not True)
    return {'done': done, 'failed': failed, 'total': len(tracks)}

