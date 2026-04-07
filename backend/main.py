import asyncio
import json
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks, HTTPException, Request, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

import database as db
from downloader import run_download_session
from config import MUSIC_OUTPUT_DIR, BACKEND_PORT

import sys
import argparse

# Parse Arguments
parser = argparse.ArgumentParser(description="Spotify Archive Backend")
parser.add_argument("--rsync-lyric", action="store_true", help="Enable AI-powered lyric synchronization (Whisper)")
args, unknown = parser.parse_known_args()

USE_RSYNC = args.rsync_lyric
whisper_model = None

if USE_RSYNC:
    try:
        from faster_whisper import WhisperModel
        import torch
        import logging
        
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        
        try:
            print(f"🎤 Loading Faster-Whisper Model (small) on {device}...")
            whisper_model = WhisperModel("small", device=device, compute_type=compute_type)
            print(f"✅ Faster-Whisper Loaded successfully on {device}.")
        except Exception as e:
            print(f"⚠️ Faster-Whisper CUDA error: {e}. Falling back to CPU...")
            whisper_model = WhisperModel("small", device="cpu", compute_type="int8")
            print("✅ Faster-Whisper Loaded successfully on CPU.")

    except Exception as e:
        print(f"⚠️ Faster-Whisper Critical Error: {e}")
        whisper_model = None
else:
    print("ℹ️ AI Lyric Sync (Whisper) is disabled. Run with --rsync-lyric to enable.")

app = FastAPI(title="Spotify Arşiv Backend", version="1.0.0")

# Allow extension to make requests to localhost:8765
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (CSS, JS, images) from the /static folder
app.mount("/static", StaticFiles(directory="static"), name="static")

db.init_db()

# Auto-scan local files and repair/update DB
from scanner import scan_and_rebuild_db
scan_and_rebuild_db()


@app.on_event("startup")
async def auto_resume_sessions():
    """Automatically resumes incomplete downloads on startup."""
    with db.get_conn() as conn:
        sessions = conn.execute("SELECT * FROM sessions").fetchall()
    
    for session in sessions:
        session_id = session['session_id']
        pending = db.get_resumable_jobs(session_id, limit=2000)
        
        if pending:
            session_dict = dict(session)
            if session_id not in active_sessions:
                active_sessions[session_id] = {
                    'playlist_meta': {
                        'playlist_id': session_dict.get('playlist_id', ''),
                        'name': session_dict.get('playlist_name', ''),
                        'cover_url': session_dict.get('cover_url'),
                        'owner': session_dict.get('owner', ''),
                    },
                    'output_dir': Path(session_dict['output_dir']),
                    'tracks': [],
                    'finalized': True
                }
            
            sess = active_sessions[session_id]
            asyncio.create_task(
                _run_batch(session_id, sess['playlist_meta'], pending, sess['output_dir'])
            )


class PlaylistMeta(BaseModel):
    playlist_id: str
    name: str
    cover_url: Optional[str] = None
    description: Optional[str] = ''
    owner: Optional[str] = ''
    url: Optional[str] = ''
    scraped_at: Optional[str] = ''


class InitSessionRequest(BaseModel):
    session_id: str
    playlist: PlaylistMeta


class TrackData(BaseModel):
    track_id: str
    title: str
    artists: List[str] = []
    artist_str: Optional[str] = ''
    album: Optional[str] = ''
    duration: Optional[str] = ''
    cover_url: Optional[str] = None
    spotify_url: Optional[str] = None


class ChunkRequest(BaseModel):
    session_id: str
    tracks: List[TrackData]
    total_so_far: int
    is_final: bool = False


class FinalizeRequest(BaseModel):
    session_id: str
    total_tracks: int


# Active background job per session
active_sessions: dict = {}


@app.post("/session/init")
async def init_session(req: InitSessionRequest):
    """Start a new download session"""
    now = datetime.utcnow().isoformat()
    safe_name  = req.playlist.name.replace('/', '_').replace('\\', '_')[:80]
    output_dir = MUSIC_OUTPUT_DIR / safe_name

    with db.get_conn() as conn:
        # Check if playlist with same name exists, merge if so
        existing = conn.execute("SELECT session_id FROM sessions WHERE playlist_name=?", (req.playlist.name,)).fetchone()
        final_session_id = existing['session_id'] if existing else req.session_id

        conn.execute("""
            INSERT OR REPLACE INTO sessions
              (session_id, playlist_id, playlist_name, cover_url,
               owner, status, output_dir, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (final_session_id, req.playlist.playlist_id, req.playlist.name,
              req.playlist.cover_url, req.playlist.owner,
              'active', str(output_dir), now, now))

    active_sessions[final_session_id] = {
        'playlist_meta': req.playlist.dict(),
        'output_dir':    output_dir,
        'tracks':        [],
        'finalized':     False
    }
    return {"status": "ok", "session_id": final_session_id, "output_dir": str(output_dir)}


@app.post("/session/chunk")
async def receive_chunk(req: ChunkRequest, background_tasks: BackgroundTasks):
    """
    Receive track chunk from extension, add to DB.
    Starts downloading immediately (does not wait for finalize).
    """
    # If session not in memory, try to recover from DB
    if req.session_id not in active_sessions:
        with db.get_conn() as conn:
            session = conn.execute(
                "SELECT * FROM sessions WHERE session_id=?", (req.session_id,)
            ).fetchone()
        if not session:
            raise HTTPException(404, "Session bulunamadı")
        session_dict = dict(session)
        active_sessions[req.session_id] = {
            'playlist_meta': {
                'playlist_id': session_dict.get('playlist_id', ''),
                'name': session_dict.get('playlist_name', ''),
                'cover_url': session_dict.get('cover_url'),
                'owner': session_dict.get('owner', ''),
            },
            'output_dir': Path(session_dict['output_dir']),
            'tracks': [],
            'finalized': False
        }

    tracks_dicts = [t.dict() for t in req.tracks]
    # Save artists list
    for t in tracks_dicts:
        if not t.get('artists'):
            t['artists'] = [t.get('artist_str', 'Bilinmiyor')]

    db.upsert_tracks(req.session_id, tracks_dicts)
    active_sessions[req.session_id]['tracks'].extend(tracks_dicts)

    # Check current status of these tracks from DB and queue PENDING or FAILED ones
    track_ids = [t['track_id'] for t in tracks_dicts]
    with db.get_conn() as conn:
        placeholders = ','.join('?' * len(track_ids))
        
        # Reset status to pending if any are failed
        conn.execute(f"""
            UPDATE jobs SET status='pending', retry_count=0 
            WHERE session_id=? AND status='failed' AND track_id IN ({placeholders})
        """, [req.session_id] + track_ids)
        
        pendings = conn.execute(f"""
            SELECT track_id FROM jobs 
            WHERE session_id=? AND status='pending' AND track_id IN ({placeholders})
        """, [req.session_id] + track_ids).fetchall()
        pending_ids = set(r['track_id'] for r in pendings)

    jobs_to_run = [t for t in tracks_dicts if t['track_id'] in pending_ids]

    # Send incoming tracks directly to download queue (fetching from DB from scratch causes race conditions)
    if jobs_to_run:
        sess = active_sessions[req.session_id]
        background_tasks.add_task(
            _run_batch,
            req.session_id,
            sess['playlist_meta'],
            jobs_to_run,
            sess['output_dir']
        )

    return {
        "status":         "queued",
        "accepted":       len(tracks_dicts),
        "total_received": req.total_so_far,
        "is_final":       req.is_final
    }


@app.post("/session/finalize")
async def finalize_session(req: FinalizeRequest):
    """Called when extension finishes scraping"""
    if req.session_id in active_sessions:
        active_sessions[req.session_id]['finalized'] = True

    with db.get_conn() as conn:
        # Find the actual count of (new) tracks added to this session
        actual_count = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE session_id=?", 
            (req.session_id,)
        ).fetchone()[0]

        conn.execute("""
            UPDATE sessions SET total_tracks=?, status='finalizing', updated_at=?
            WHERE session_id=?
        """, (actual_count, datetime.utcnow().isoformat(), req.session_id))

    return {"status": "ok", "total_tracks": actual_count, "scraped_tracks": req.total_tracks}


@app.get("/session/{session_id}/progress")
async def get_progress(session_id: str):
    """For the popup to poll progress"""
    return db.get_session_progress(session_id)


@app.get("/sessions")
async def list_sessions():
    """List all past sessions"""
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    return [dict(r) for r in rows]


@app.delete("/sessions/clear")
async def clear_sessions():
    """Clear all download history"""
    db.clear_all_data()
    active_sessions.clear()
    return {"status": "ok", "message": "All data cleared"}


@app.get("/health")
async def health():
    return {"status": "running", "version": "1.0.0"}


@app.post("/session/{session_id}/resume")
async def resume_session(session_id: str, background_tasks: BackgroundTasks):
    """
    Resume partial or failed downloads from where they left off.
    Converts FAILED/DOWNLOADING/TAGGING to PENDING and restarts the download.
    """
    # Get session info
    with db.get_conn() as conn:
        session = conn.execute(
            "SELECT * FROM sessions WHERE session_id=?", (session_id,)
        ).fetchone()

    if not session:
        raise HTTPException(404, "Session bulunamadı")

    session_dict = dict(session)

    # Reset failed jobs and get pending ones
    pending = db.get_resumable_jobs(session_id, limit=100)

    if not pending:
        return {"status": "nothing_to_resume", "message": "No tracks to resume — all downloaded"}

    # Add to Active sessions (if missing)
    if session_id not in active_sessions:
        active_sessions[session_id] = {
            'playlist_meta': {
                'playlist_id': session_dict.get('playlist_id', ''),
                'name': session_dict.get('playlist_name', ''),
                'cover_url': session_dict.get('cover_url'),
                'owner': session_dict.get('owner', ''),
            },
            'output_dir': Path(session_dict['output_dir']),
            'tracks': [],
            'finalized': True
        }

    sess = active_sessions[session_id]
    background_tasks.add_task(
        _run_batch, session_id, sess['playlist_meta'], pending, sess['output_dir']
    )

    return {
        "status": "resumed",
        "pending_count": len(pending),
        "session_id": session_id
    }


@app.get("/session/{session_id}/tracks")
def get_session_tracks(session_id: str):
    """List downloaded tracks for Web Player"""
    tracks = db.get_completed_tracks(session_id)
    return {"tracks": tracks}


@app.get("/stream/{track_id}")
def stream_track(track_id: str, request: Request):
    """Stream track over the web (supports HTTP Range)"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_path FROM jobs WHERE track_id=?", (track_id,)).fetchone()
    if not row or not row['output_path']:
        raise HTTPException(status_code=404, detail="Track not found")
    file_path = Path(row['output_path'])
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    # FileResponse automatically supports HTTP Range requests
    return FileResponse(file_path, media_type="audio/mpeg")


@app.get("/player", response_class=HTMLResponse)
def serve_player():
    """Web Player Interface"""
    player_path = Path("static/player.html")
    if player_path.exists():
        return player_path.read_text(encoding="utf-8")
    return "<h1>Player dosyası (static/player.html) bulunamadı.</h1>"


@app.get("/api/lyrics/proxy")
async def proxy_lyrics(url: str):
    """Proxy Genius lyrics page to avoid CORS issues"""
    import aiohttp
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail="Failed to fetch lyrics from Genius")
            html = await resp.text()
            return {"contents": html}

@app.get("/local-cover/{playlist_name}/{track_id}")
def serve_local_cover(playlist_name: str, track_id: str):
    """To serve covers after Local DB scan"""
    from fastapi.responses import Response
    playlist_dir = MUSIC_OUTPUT_DIR / playlist_name
    # Clean 'file_' prefix in track_id if present
    clean_id = track_id.replace("file_", "")
    track_cover = playlist_dir / ".covers" / f"{clean_id}.jpg"
    if track_cover.exists():
        return FileResponse(track_cover, media_type="image/jpeg")
    
    playlist_cover = playlist_dir / "cover.jpg"
    if playlist_cover.exists():
        return FileResponse(playlist_cover, media_type="image/jpeg")
        
    return Response(status_code=404)

async def _run_batch(session_id, playlist_meta, tracks, output_dir):
    """Download tracks in chunk in parallel"""
    await run_download_session(session_id, playlist_meta, tracks, output_dir)


@app.get("/api/config")
async def get_config():
    """Return runtime configuration and feature flags to the frontend"""
    return {
        "rsync_enabled": USE_RSYNC,
        "whisper_status": "ready" if whisper_model is not None else "disabled"
    }

# --- STT Lyrics Sync Endpoints ---

@app.get("/api/lyrics/sync/stream")
async def stream_lyrics_sync(track_id: str, language: str = None, prompt: str = None):
    """Process full audio track locally and yield segments directly to the frontend"""
    sync_file = Path(MUSIC_OUTPUT_DIR) / f"{track_id}.sync.json"
    
    # 1. Check if we already mapped this song previously (Allow baked maps even if Whisper is off)
    if sync_file.exists():
        async def sync_generator():
            try:
                import json
                import asyncio
                with open(sync_file, "r") as f:
                    data = json.load(f)
                    # If it's a baked 'is_aligned' map, yield the whole thing immediately
                    if data.get("is_aligned"):
                        yield f"data: {json.dumps(data)}\n\n"
                    else:
                        # Otherwise yield raw segments
                        for seg in data.get("segments", []):
                            yield f"data: {json.dumps(seg)}\n\n"
                            await asyncio.sleep(0.01)
                yield "event: DONE\ndata: {}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
        return StreamingResponse(sync_generator(), media_type="text/event-stream")
    
    # 2. If no baked data, we NEED Whisper to perform fresh transcription
    if whisper_model is None:
        raise HTTPException(
            status_code=403, 
            detail="AI Synchronizer is disabled for this session. Start with --rsync-lyric to enable."
        )
        
    # 2. Locate the audio source
    import glob
    # Local files often have 'file_' prefix from scanner
    search_id = track_id[5:] if track_id.startswith("file_") else track_id
    
    # Use recursive glob for subdirectories
    matches = glob.glob(f"{MUSIC_OUTPUT_DIR}/**/*{search_id}*.*", recursive=True)
    valid_exts = {".mp3", ".webm", ".m4a", ".opus", ".ogg", ".wav"}
    matches = [m for m in matches if Path(m).suffix.lower() in valid_exts]
    
    if not matches:
        raise HTTPException(status_code=404, detail="Track local audio not found")
    
    audio_path = matches[0]

    # 3. Stream Whisper predictions directly to client as they decode
    async def whisper_generator():
        import threading
        import json
        import asyncio
        loop = asyncio.get_event_loop()
        queue = asyncio.Queue()
        
        def run_whisper():
            try:
                segments, info = whisper_model.transcribe(
                    audio_path,
                    beam_size=5,
                    language=language,
                    initial_prompt=prompt,
                    condition_on_previous_text=False,
                    vad_filter=False, # Disabled to prevent total audio erasure on loud tracks
                    word_timestamps=True
                )
                
                final_segments = []
                for s in segments:
                    words = []
                    if s.words:
                        words = [{"start": w.start, "end": w.end, "word": w.word.strip()} for w in s.words]
                        
                    seg_dict = {
                        "start": s.start, 
                        "end": s.end, 
                        "text": s.text.strip(),
                        "words": words
                    }
                    if not seg_dict["text"]: continue
                    
                    final_segments.append(seg_dict)
                    loop.call_soon_threadsafe(queue.put_nowait, ("data", seg_dict))
                    
                with open(sync_file, "w") as f:
                    json.dump({"segments": final_segments}, f)
                    
                loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
            except Exception as e:
                import logging
                logging.error(f"Streaming STT Error: {e}")
                loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)))

        thread = threading.Thread(target=run_whisper)
        thread.start()
        
        while True:
            ev_type, payload = await queue.get()
            if ev_type == "done":
                yield "event: DONE\ndata: {}\n\n"
                break
            elif ev_type == "error":
                yield f"data: {json.dumps({'error': str(payload)})}\n\n"
                break
            else:
                yield f"data: {json.dumps(payload)}\n\n"
                
    return StreamingResponse(whisper_generator(), media_type="text/event-stream")

@app.post("/api/lyrics/sync/save")
async def save_lyrics_sync(request: Request):
    """Save a manually adjusted or high-confidence sync map to disk"""
    try:
        data = await request.json()
        track_id = data.get("track_id")
        lines = data.get("lines")
        
        if not track_id or not lines:
            raise HTTPException(status_code=400, detail="Missing track_id or lines")
            
        sync_file = Path(MUSIC_OUTPUT_DIR) / f"{track_id}.sync.json"
        
        with open(sync_file, "w") as f:
            import json
            json.dump({
                "track_id": track_id,
                "is_aligned": True,
                "lines": lines,
                "saved_at": datetime.now().isoformat()
            }, f)
            
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Library Management ---

class TrackUpdate(BaseModel):
    title: str
    artists: list
    album: str

@app.patch("/api/track/{track_id}")
async def update_track(track_id: str, data: TrackUpdate):
    """Update track metadata in DB and on disk"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_path, cover_url FROM jobs WHERE track_id=?", (track_id,)).fetchone()
    
    if not row or not row['output_path']:
        raise HTTPException(404, "Track not found")
    
    file_path = Path(row['output_path'])
    if file_path.exists():
        # Update ID3 Tags
        try:
            from tagger import tag_audio_file
            # We need a local cover path if we want to preserve it during re-tagging
            # For now, tag_audio_file will skip cover if cover_path is None
            tag_audio_file(str(file_path), data.title, data.artists, data.album)
        except Exception as e:
            logging.error(f"Failed to update tags: {e}")
    
    db.update_track_metadata(track_id, data.title, data.artists, data.album)
    return {"status": "ok"}


@app.delete("/api/track/{track_id}")
async def delete_track(track_id: str):
    """Delete track from disk and DB"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_path FROM jobs WHERE track_id=?", (track_id,)).fetchone()
    
    if row and row['output_path']:
        file_path = Path(row['output_path'])
        if file_path.exists():
            file_path.unlink()
            # Also clean up local cover if it's in a .covers folder
            if ".covers" in str(file_path.parent):
                pass # Already handled by folder structure usually
    
    db.delete_track(track_id)
    return {"status": "ok"}


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """Delete entire playlist folder and DB records"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_dir FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    
    if row and row['output_dir']:
        path = Path(row['output_dir'])
        if path.exists() and path.is_dir():
            import shutil
            shutil.rmtree(path)
    
    db.delete_session(session_id)
    return {"status": "ok"}


class SessionUpdate(BaseModel):
    playlist_name: str

@app.patch("/api/session/{session_id}")
async def update_session(session_id: str, data: SessionUpdate):
    """Rename a playlist session"""
    now = datetime.utcnow().isoformat()
    with db.get_conn() as conn:
        conn.execute("UPDATE sessions SET playlist_name=?, updated_at=? WHERE session_id=?",
                     (data.playlist_name, now, session_id))
    return {"status": "ok"}


@app.post("/api/session/{session_id}/cover")
async def update_session_cover(session_id: str, file: UploadFile = File(...)):
    """Upload new cover for a playlist"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_dir, playlist_name FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    
    if not row:
        raise HTTPException(404, "Session not found")
    
    import shutil
    output_dir = Path(row['output_dir']) if row['output_dir'] else MUSIC_OUTPUT_DIR / row['playlist_name']
    cover_path = output_dir / "cover.jpg"
    
    with open(cover_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    # Update cover_url in DB
    now = datetime.utcnow().isoformat()
    cover_url = f"/local-cover/{row['playlist_name']}/dummy"
    with db.get_conn() as conn:
        conn.execute("UPDATE sessions SET cover_url=?, updated_at=? WHERE session_id=?",
                     (cover_url, now, session_id))
    
    return {"status": "ok", "cover_url": cover_url}

@app.post("/api/track/{track_id}/cover")
async def update_cover(track_id: str, file: UploadFile = File(...)):
    """Upload new cover image, embed into file and update local cache"""
    with db.get_conn() as conn:
        row = conn.execute("SELECT output_path, session_id FROM jobs WHERE track_id=?", (track_id,)).fetchone()
    
    if not row or not row['output_path']:
        raise HTTPException(404, "Track not found")
    
    file_path = Path(row['output_path'])
    if not file_path.exists():
        raise HTTPException(404, "Audio file not found")

    # Save temp cover
    temp_dir = Path("temp_covers")
    temp_dir.mkdir(exist_ok=True)
    temp_cover = temp_dir / f"{track_id}_{file.filename}"
    
    with open(temp_cover, "wb") as buffer:
        import shutil
        shutil.copyfileobj(file.file, buffer)

    try:
        from tagger import tag_audio_file
        tag_audio_file(str(file_path), cover_path=str(temp_cover))
        
        # If it's a local archive file, also update the extracted cover in .covers
        # to ensure UI refresh
        if "local_" in row['session_id']:
            clean_id = track_id.replace("file_", "")
            # We need to find the session folder
            with db.get_conn() as conn:
                sess = conn.execute("SELECT output_dir FROM sessions WHERE session_id=?", (row['session_id'],)).fetchone()
            if sess:
                target_cover = Path(sess['output_dir']) / ".covers" / f"{clean_id}.jpg"
                if target_cover.parent.exists():
                    shutil.copy2(temp_cover, target_cover)
                    
    finally:
        if temp_cover.exists():
            temp_cover.unlink()

    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    print(f"🎵 Spotify Archive Backend starting → port {BACKEND_PORT}")
    print(f"📁 Output directory: {MUSIC_OUTPUT_DIR}")
    uvicorn.run("main:app", host="127.0.0.1", port=BACKEND_PORT, reload=False)
