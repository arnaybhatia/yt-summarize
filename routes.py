import os
import tempfile
import yt_dlp
from flask import Blueprint, request, jsonify, Response, send_file

api = Blueprint("api", __name__)


def _find_file(directory: str) -> str | None:
    """Return the first file found in a directory, or None."""
    for fname in os.listdir(directory):
        full = os.path.join(directory, fname)
        if os.path.isfile(full):
            return full
    return None


# ─── Fetch Audio (for browser-side Whisper) ──────────────────────────────────
@api.route("/api/fetch-audio", methods=["POST"])
def fetch_audio():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "audio.%(ext)s")

    ydl_opts = {
        # Best audio quality available
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "audio")
            ext = info.get("ext", "webm")

        audio_path = _find_file(tmp_dir)
        if not audio_path:
            return jsonify({"error": "Audio download produced no file."}), 500

        mime_map = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg",
                    "opus": "audio/ogg", "webm": "audio/webm", "wav": "audio/wav"}
        mime = mime_map.get(ext, "audio/webm")

        with open(audio_path, "rb") as f:
            audio_bytes = f.read()

        # Cleanup
        try:
            os.remove(audio_path)
            os.rmdir(tmp_dir)
        except Exception:
            pass

        return Response(
            audio_bytes,
            mimetype=mime,
            headers={
                "X-Video-Title": title.encode("ascii", "replace").decode(),
                "Access-Control-Expose-Headers": "X-Video-Title",
            },
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Download Video (highest quality) ────────────────────────────────────────
@api.route("/api/download-video", methods=["POST"])
def download_video():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "video.%(ext)s")

    ydl_opts = {
        # Prefer H.264 (avc1) — universally playable. Falls back through avc → mp4 → best.
        "format": "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        # Write auto subtitles and embed them as soft subs
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "postprocessors": [
            {
                "key": "FFmpegSubtitlesConvertor",
                "format": "srt",
            },
            {
                "key": "FFmpegEmbedSubtitle",
            },
        ],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "video")

        video_path = _find_file(tmp_dir)
        if not video_path:
            return jsonify({"error": "Video download produced no file."}), 500

        ext = os.path.splitext(video_path)[1].lstrip(".")
        safe_title = "".join(c for c in title if c.isalnum() or c in " _-").strip()
        filename = f"{safe_title or 'video'}.{ext}"

        with open(video_path, "rb") as f:
            video_bytes = f.read()

        try:
            os.remove(video_path)
            os.rmdir(tmp_dir)
        except Exception:
            pass

        return Response(
            video_bytes,
            mimetype="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(len(video_bytes)),
            },
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
