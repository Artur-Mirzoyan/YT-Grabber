"""
Needs ffmpeg on PATH (the Docker image already includes it).

Environment variables (all optional):
  API_KEY   If set, the extension must send it in the X-API-Key header.
  HOST      Bind address when run directly (default 127.0.0.1).
  PORT      Port (default 5000).
"""
import hmac
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, request, send_from_directory
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
    try:
        import static_ffmpeg
        static_ffmpeg.add_paths()
    except Exception as e:
        print(f"Could not set up ffmpeg automatically: {e}")

app = Flask(__name__)

API_KEY = os.environ.get("API_KEY", "")
DOWNLOAD_DIR = Path(__file__).parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)
MAX_AGE_SECONDS = 60 * 60  # delete finished files after 1 hour
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

JOBS: dict[str, dict] = {}


def authorized() -> bool:
    if not API_KEY:
        return True
    return hmac.compare_digest(request.headers.get("X-API-Key", ""), API_KEY)


def cleanup_old_jobs():
    now = time.time()
    for job in DOWNLOAD_DIR.iterdir():
        if job.is_dir() and now - job.stat().st_mtime > MAX_AGE_SECONDS:
            shutil.rmtree(job, ignore_errors=True)
            JOBS.pop(job.name, None)


def build_options(fmt: str, job_dir: Path) -> dict:
    opts = {
        "outtmpl": str(job_dir / "%(title).150B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
    }
    if fmt == "mp3":
        opts.update(
            format="bestaudio/best",
            postprocessors=[
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
            ],
        )
    else:
        opts.update(
            format=(
                "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]"
                "/b[vcodec^=avc1][ext=mp4]"
                "/bv*[vcodec^=avc1]+ba"
                "/bv*+ba/b"
            ),
            merge_output_format="mp4",
        )
    return opts


@app.get("/api/health")
def health():
    if not authorized():
        return jsonify(error="Unauthorized"), 401
    return jsonify(ok=True, ffmpeg=bool(shutil.which("ffmpeg") and shutil.which("ffprobe")))


def run_job(job_id: str, url: str, fmt: str, job_dir: Path):
    """Runs in a background thread and keeps JOBS[job_id] up to date."""
    job = JOBS[job_id]
    finished_files = 0

    def progress_hook(d):
        nonlocal finished_files
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            streams = len((d.get("info_dict") or {}).get("requested_formats") or []) or 1
            frac = d.get("downloaded_bytes", 0) / total if total else 0
            pct = min((finished_files + frac) / streams, 1) * 90  # downloads fill 0-90%
            job.update(stage="Downloading", percent=round(max(pct, job["percent"] or 0), 1))
        elif d["status"] == "finished":
            finished_files += 1

    def postprocessor_hook(d):
        if d["status"] == "started":
            job.update(stage="Converting", percent=92)
        elif d["status"] == "finished":
            job.update(percent=98)

    opts = build_options(fmt, job_dir)
    opts["progress_hooks"] = [progress_hook]
    opts["postprocessor_hooks"] = [postprocessor_hook]

    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
        files = [f for f in job_dir.iterdir() if f.suffix == f".{fmt}"]
        if not files:
            raise RuntimeError("Download finished but no output file was found")
        job.update(state="done", stage="Done", percent=100, filename=files[0].name)
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        job.update(state="error", error=str(e))


@app.post("/api/convert")
def convert():
    if not authorized():
        return jsonify(error="Unauthorized: check the API key in the extension settings"), 401

    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    fmt = (data.get("format") or "").lower()

    if fmt not in ("mp4", "mp3"):
        return jsonify(error="format must be 'mp4' or 'mp3'"), 400
    if (urlparse(url).hostname or "").lower() not in ALLOWED_HOSTS:
        return jsonify(error="Not a YouTube URL"), 400

    cleanup_old_jobs()
    job_id = uuid.uuid4().hex
    job_dir = DOWNLOAD_DIR / job_id
    job_dir.mkdir()
    JOBS[job_id] = {"state": "working", "stage": "Starting", "percent": 0, "filename": None, "error": None}
    threading.Thread(target=run_job, args=(job_id, url, fmt, job_dir), daemon=True).start()
    return jsonify(job_id=job_id), 202


@app.get("/api/status/<job_id>")
def status(job_id):
    if not authorized():
        return jsonify(error="Unauthorized"), 401
    job = JOBS.get(job_id) if JOB_ID_RE.match(job_id) else None
    if job is None:
        return jsonify(error="Unknown job (the server may have restarted)"), 404
    return jsonify(job)


@app.get("/api/file/<job_id>")
def get_file(job_id):
    if not JOB_ID_RE.match(job_id):
        return jsonify(error="Bad id"), 400
    job_dir = DOWNLOAD_DIR / job_id
    files = list(job_dir.iterdir()) if job_dir.is_dir() else []
    if not files:
        return jsonify(error="File not found or expired"), 404
    return send_from_directory(job_dir, files[0].name, as_attachment=True)


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)))
