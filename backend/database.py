import sqlite3
import json
from datetime import datetime
from pathlib import Path
from enum import Enum

DB_PATH = Path.home() / ".spotify_archive" / "jobs.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


class JobStatus(str, Enum):
    PENDING     = "pending"
    QUEUED      = "queued"
    DOWNLOADING = "downloading"
    TAGGING     = "tagging"
    DONE        = "done"
    FAILED      = "failed"
    SKIPPED     = "skipped"  # Already downloaded


def get_conn():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create database tables"""
    with get_conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id    TEXT PRIMARY KEY,
            playlist_id   TEXT,
            playlist_name TEXT,
            cover_url     TEXT,
            owner         TEXT,
            status        TEXT DEFAULT 'active',
            total_tracks  INTEGER DEFAULT 0,
            done_count    INTEGER DEFAULT 0,
            fail_count    INTEGER DEFAULT 0,
            output_dir    TEXT,
            created_at    TEXT,
            updated_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS jobs (
            job_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id   TEXT,
            track_id     TEXT UNIQUE,
            title        TEXT,
            artists      TEXT,  -- JSON array
            album        TEXT,
            duration     TEXT,
            cover_url    TEXT,
            spotify_url  TEXT,
            status       TEXT DEFAULT 'pending',
            retry_count  INTEGER DEFAULT 0,
            output_path  TEXT,
            error_msg    TEXT,
            created_at   TEXT,
            updated_at   TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
        CREATE INDEX IF NOT EXISTS idx_jobs_session   ON jobs(session_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_track_id  ON jobs(track_id);
        """)


def upsert_tracks(session_id: str, tracks: list):
    """Add new tracks, if local file update its ID with Spotify ID"""
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        for t in tracks:
            # Is there a previously registered track with the same name? (Scanner might have assigned fake ID 'file_...')
            existing = conn.execute(
                "SELECT track_id, status FROM jobs WHERE session_id=? AND title=?",
                (session_id, t['title'])
            ).fetchone()

            if existing:
                # If fake ID and new incoming is real ID, update
                if existing['track_id'].startswith("file_") and not str(t['track_id']).startswith("file_"):
                    # The important thing is to preserve status so it's not downloaded again
                    conn.execute("""
                        UPDATE jobs 
                        SET track_id=?, spotify_url=?, updated_at=?
                        WHERE session_id=? AND title=?
                    """, (t['track_id'], t.get('spotify_url',''), now, session_id, t['title']))
                continue # No need to re-INSERT existing

            # Adding from scratch
            conn.execute("""
                INSERT OR IGNORE INTO jobs
                (session_id, track_id, title, artists, album, duration, cover_url, spotify_url, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, t['track_id'], t['title'],
                json.dumps(t.get('artists', [])),
                t.get('album', ''), t.get('duration', ''),
                t.get('cover_url'), t.get('spotify_url'),
                JobStatus.PENDING, now, now
            ))


def get_pending_jobs(session_id: str, limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM jobs
            WHERE session_id=? AND status=?
            ORDER BY job_id ASC LIMIT ?
        """, (session_id, JobStatus.PENDING, limit)).fetchall()
    return [dict(r) for r in rows]


def update_job_status(track_id: str, status: str,
                      output_path: str = None, error_msg: str = None, duration: str = None):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute("""
            UPDATE jobs SET status=?, output_path=?, error_msg=?, updated_at=?
            WHERE track_id=?
        """, (status, output_path, error_msg, now, track_id))
        if duration:
            conn.execute("UPDATE jobs SET duration=? WHERE track_id=?", (duration, track_id))

        # Update session counters
        if status == JobStatus.DONE:
            conn.execute("""
                UPDATE sessions SET done_count=done_count+1, updated_at=?
                WHERE session_id=(SELECT session_id FROM jobs WHERE track_id=?)
            """, (now, track_id))
        elif status == JobStatus.FAILED:
            conn.execute("""
                UPDATE sessions SET fail_count=fail_count+1, updated_at=?
                WHERE session_id=(SELECT session_id FROM jobs WHERE track_id=?)
            """, (now, track_id))


def get_session_progress(session_id: str):
    with get_conn() as conn:
        session = conn.execute(
            "SELECT * FROM sessions WHERE session_id=?", (session_id,)
        ).fetchone()
        stats = conn.execute("""
            SELECT status, COUNT(*) as count
            FROM jobs WHERE session_id=?
            GROUP BY status
        """, (session_id,)).fetchall()
    return {
        'session': dict(session) if session else {},
        'stats':   {r['status']: r['count'] for r in stats}
    }


def get_resumable_jobs(session_id: str, limit: int = 100):
    """
    Change failed/incomplete jobs to PENDING and return them.
    Used for the Resume feature.
    """
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        # Reset failed, downloading, or tagging jobs
        conn.execute("""
            UPDATE jobs SET status=?, updated_at=?
            WHERE session_id=? AND status IN (?,?,?)
        """, (JobStatus.PENDING, now, session_id,
              JobStatus.FAILED, JobStatus.DOWNLOADING, JobStatus.TAGGING))

        # Recalculate fail/done counters
        counts = conn.execute("""
            SELECT
                SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
            FROM jobs WHERE session_id=?
        """, (session_id,)).fetchone()
        conn.execute("""
            UPDATE sessions SET done_count=?, fail_count=?, status='active', updated_at=?
            WHERE session_id=?
        """, (counts['done'] or 0, counts['failed'] or 0, now, session_id))

    return get_pending_jobs(session_id, limit)


def get_completed_tracks(session_id: str):
    """
    Returns successfully downloaded (done) tracks for a given session.
    Used for Web Player.
    """
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT track_id, title, artists, album, duration, cover_url, output_path
            FROM jobs 
            WHERE session_id=? AND status=?
            ORDER BY job_id ASC
        """, (session_id, JobStatus.DONE)).fetchall()
    return [dict(r) for r in rows]


def clear_all_data():
    """Clear all download history and dbs"""
    with get_conn() as conn:
        conn.execute("DELETE FROM jobs")
        conn.execute("DELETE FROM sessions")
