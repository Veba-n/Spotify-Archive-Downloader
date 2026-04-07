import json
import logging
from pathlib import Path
from uuid import uuid4
import mutagen
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.flac import FLAC
import database as db
from config import MUSIC_OUTPUT_DIR

log = logging.getLogger("scanner")
logging.basicConfig(level=logging.INFO)

def scan_and_rebuild_db():
    if not isinstance(MUSIC_OUTPUT_DIR, Path):
        output_dir = Path(MUSIC_OUTPUT_DIR)
    else:
        output_dir = MUSIC_OUTPUT_DIR

    if not output_dir.exists():
        return

    log.info(f"📁 Scanning existing files: {output_dir}")
    
    with db.get_conn() as conn:
        for playlist_dir in output_dir.iterdir():
            if not playlist_dir.is_dir() or playlist_dir.name.startswith('.'):
                continue
                
            session_id = f"local_{playlist_dir.name}"
            
            # Check if session exists
            sess = conn.execute("SELECT session_id FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if not sess:
                playlist_cover_url = f"/local-cover/{playlist_dir.name}/dummy"
                conn.execute("""
                    INSERT INTO sessions (session_id, playlist_name, status, cover_url, total_tracks, done_count, output_dir)
                    VALUES (?, ?, 'active', ?, 0, 0, ?)
                """, (session_id, playlist_dir.name, playlist_cover_url, str(playlist_dir)))
            
            track_count = 0
            
            for file_path in playlist_dir.iterdir():
                if file_path.suffix.lower() not in ['.mp3', '.m4a', '.aac', '.flac', '.opus', '.webm', '.ogg']:
                    continue
                    
                track_id = f"file_{file_path.stem}"
                
                # Skip if already exists
                if conn.execute("SELECT 1 FROM jobs WHERE track_id=?", (track_id,)).fetchone():
                    track_count += 1
                    continue
                    
                # Read Tags
                title = file_path.stem
                artists = ["Unknown Artist"]
                album = ""
                duration = 0
                
                try:
                    ext = file_path.suffix.lower()
                    cover_data = None
                    cover_ext = 'jpg'
                    
                    if ext == '.mp3':
                        audio = MP3(file_path)
                        duration = int(audio.info.length) if audio.info else 0
                        if audio.tags:
                            title = audio.tags.get('TIT2', [title])[0]
                            artists = str(audio.tags.get('TPE1', [''])[0]).split('; ') or artists
                            album = str(audio.tags.get('TALB', [''])[0])
                            
                            pics = audio.tags.getall('APIC')
                            if pics:
                                cover_data = pics[0].data
                                if 'png' in pics[0].mime: cover_ext = 'png'
                                
                    elif ext in ['.m4a', '.aac', '.mp4']:
                        audio = MP4(file_path)
                        duration = int(audio.info.length) if audio.info else 0
                        title = audio.tags.get('\xa9nam', [title])[0]
                        artists = audio.tags.get('\xa9ART', [''])[0].split('; ') or artists
                        album = audio.tags.get('\xa9alb', [''])[0]
                        
                        covrs = audio.tags.get('covr')
                        if covrs:
                            cover_data = bytes(covrs[0])
                            # usually m4a covers are jpeg or png check magic bytes
                            if cover_data.startswith(b'\x89PNG'): cover_ext = 'png'
                            
                    elif ext == '.flac':
                        audio = FLAC(file_path)
                        duration = int(audio.info.length) if audio.info else 0
                        title = audio.tags.get('title', [title])[0]
                        artists = audio.tags.get('artist', [''])[0].split('; ') or artists
                        album = audio.tags.get('album', [''])[0]
                        
                        if audio.pictures:
                            cover_data = audio.pictures[0].data
                            if 'png' in audio.pictures[0].mime: cover_ext = 'png'
                            
                    if cover_data:
                        covers_dir = playlist_dir / ".covers"
                        covers_dir.mkdir(exist_ok=True)
                        track_cover_path = covers_dir / f"{track_id.replace('file_', '')}.{cover_ext}"
                        if not track_cover_path.exists():
                            track_cover_path.write_bytes(cover_data)
                except Exception as e:
                    pass
                
                # Check cover image
                cover_url = f"/local-cover/{playlist_dir.name}/{track_id}"
                
                # Convert duration to MM:SS
                dur_str = f"{duration//60}:{int(duration%60):02d}" if duration > 0 else "0:00"
                
                conn.execute("""
                    INSERT INTO jobs (session_id, track_id, title, artists, album, duration, cover_url, output_path, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done')
                """, (session_id, track_id, str(title), json.dumps(artists), str(album), dur_str, cover_url, str(file_path)))
                track_count += 1
            
            # Update session counts
            conn.execute("""
                UPDATE sessions SET total_tracks=?, done_count=? WHERE session_id=?
            """, (track_count, track_count, session_id))
            
    log.info("✅ Local file scan completed.")
