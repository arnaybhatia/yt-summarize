import base64
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

import yt_dlp
from flask import Blueprint, Response, jsonify, request, send_file, stream_with_context
from werkzeug.utils import secure_filename

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None
    ImageOps = None

try:
    import img2pdf
except ImportError:
    img2pdf = None

try:
    import fitz
except ImportError:
    fitz = None

api = Blueprint("api", __name__)
TASK_HISTORY_DIR = os.getenv(
    "TASK_HISTORY_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "task-history"),
)
TASK_HISTORY_FILE = "jobs.json"
TASK_WORKER_COUNT = int(os.getenv("TASK_WORKER_COUNT", "2"))
TASK_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, TASK_WORKER_COUNT))
TASK_HISTORY_LOCK = threading.RLock()

MEDIA_URL_RE = re.compile(r"https://[^\"'<>\\]+")
VSCO_MEDIA_HINT_RE = re.compile(r"\.(?:jpg|jpeg|png|webp|mp4)(?:\?|$)", re.IGNORECASE)
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
DIRECT_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
WHISPER_LINE_RE = re.compile(
    r"^\[(\d{2}):(\d{2}):(\d{2}\.\d{3}) --> (\d{2}):(\d{2}):(\d{2}\.\d{3})\]\s*(.*)$"
)
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
PDF_EXTENSIONS = {"pdf"}
CONVERTIBLE_IMAGE_FORMATS = {
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "png": "PNG",
    "webp": "WEBP",
}
PDF_TO_IMAGE_FORMATS = {"png": "png", "jpg": "jpeg"}
GS_PRESET_MAP = {
    "small": "/ebook",
    "quality": "/printer",
}
FRAME_IMAGE_FORMATS = {"jpg", "png"}
DIRECT_DOWNLOAD_OPTION_IDS = {
    "image-original",
    "video-original",
    "post-original",
    "vsco-images-original",
    "vsco-videos-original",
    "instagram-images-original",
    "instagram-videos-original",
    "instagram-media-original",
}


def _ensure_task_history_dir() -> None:
    os.makedirs(TASK_HISTORY_DIR, exist_ok=True)


def _task_history_path() -> str:
    _ensure_task_history_dir()
    return os.path.join(TASK_HISTORY_DIR, TASK_HISTORY_FILE)


def _load_task_history() -> list[dict]:
    with TASK_HISTORY_LOCK:
        path = _task_history_path()
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                jobs = json.load(f)
            return jobs if isinstance(jobs, list) else []
        except (OSError, json.JSONDecodeError):
            return []


def _save_task_history(jobs: list[dict]) -> None:
    with TASK_HISTORY_LOCK:
        path = _task_history_path()
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(jobs, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)


def _safe_job_id(value: str) -> str:
    safe = secure_filename(value or "")
    if not safe:
        raise ValueError("Job id is required.")
    return safe


def _sanitize_job(job: dict) -> dict:
    allowed = {
        "id", "type", "label", "status", "step", "filename", "artifactUrl",
        "artifactSaved", "transcript", "transcriptView", "errorMsg", "createdAt",
        "updatedAt",
    }
    sanitized = {key: job.get(key) for key in allowed if key in job}
    sanitized["id"] = _safe_job_id(str(sanitized.get("id", "")))
    sanitized["type"] = str(sanitized.get("type") or "generic")[:80]
    sanitized["label"] = str(sanitized.get("label") or "")[:500]
    sanitized["status"] = str(sanitized.get("status") or "pending")[:40]
    sanitized["step"] = sanitized.get("step") if sanitized.get("step") is None else str(sanitized.get("step"))[:300]
    sanitized["filename"] = (
        _sanitize_filename(str(sanitized.get("filename") or ""), "download")
        if sanitized.get("filename")
        else None
    )
    sanitized["transcriptView"] = str(sanitized.get("transcriptView") or "timestamped")[:40]
    sanitized["errorMsg"] = sanitized.get("errorMsg") if sanitized.get("errorMsg") is None else str(sanitized.get("errorMsg"))[:1000]
    sanitized["createdAt"] = str(sanitized.get("createdAt") or "")[:80]
    sanitized["updatedAt"] = str(sanitized.get("updatedAt") or "")[:80]
    transcript = sanitized.get("transcript")
    if isinstance(transcript, dict):
        sanitized["transcript"] = {
            "plain": str(transcript.get("plain") or ""),
            "timestamped": str(transcript.get("timestamped") or ""),
        }
    else:
        sanitized["transcript"] = None
    return sanitized


def _job_artifact_path(job_id: str, filename: str) -> str:
    return os.path.join(TASK_HISTORY_DIR, job_id, _sanitize_filename(filename, "download"))


def _upsert_task_history(job: dict) -> dict:
    with TASK_HISTORY_LOCK:
        jobs = _load_task_history()
        without_job = [item for item in jobs if item.get("id") != job["id"]]
        without_job.append(job)
        without_job.sort(key=lambda item: item.get("createdAt") or item.get("updatedAt") or "")
        _save_task_history(without_job[-200:])
    return job


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _create_task_job(job_type: str, label: str) -> dict:
    now = _now_iso()
    job = {
        "id": uuid.uuid4().hex,
        "type": job_type,
        "label": label,
        "status": "pending",
        "step": "Queued...",
        "filename": None,
        "artifactUrl": None,
        "artifactSaved": False,
        "transcript": None,
        "transcriptView": "timestamped",
        "errorMsg": None,
        "createdAt": now,
        "updatedAt": now,
    }
    return _upsert_task_history(job)


def _get_task_job(job_id: str) -> dict | None:
    safe_id = _safe_job_id(job_id)
    return next((item for item in _load_task_history() if item.get("id") == safe_id), None)


def _update_task_job(job_id: str, **patch) -> dict | None:
    with TASK_HISTORY_LOCK:
        jobs = _load_task_history()
        for job in jobs:
            if job.get("id") == job_id:
                job.update(patch)
                job["updatedAt"] = _now_iso()
                _save_task_history(jobs)
                return job
    return None


def _save_job_artifact(job_id: str, source_path: str, filename: str) -> str:
    safe_id = _safe_job_id(job_id)
    safe_name = _sanitize_filename(filename, "download")
    artifact_dir = os.path.join(TASK_HISTORY_DIR, safe_id)
    os.makedirs(artifact_dir, exist_ok=True)
    destination = _job_artifact_path(safe_id, safe_name)
    shutil.copyfile(source_path, destination)
    return safe_name


def _finish_artifact_job(job_id: str, tmp_dir: str, file_path: str, filename: str) -> None:
    try:
        safe_name = _save_job_artifact(job_id, file_path, filename)
        _update_task_job(
            job_id,
            status="done",
            step=None,
            filename=safe_name,
            artifactUrl=f"/api/jobs/{urllib.parse.quote(job_id)}/artifact",
            artifactSaved=True,
            errorMsg=None,
        )
    finally:
        _cleanup_dir(tmp_dir)


def _run_background_job(job_id: str, worker) -> None:
    _update_task_job(job_id, status="processing", step="Starting...", errorMsg=None)
    try:
        worker(job_id)
    except Exception as e:
        _update_task_job(job_id, status="error", step=None, errorMsg=str(e))


def _submit_background_job(job: dict, worker) -> dict:
    TASK_EXECUTOR.submit(_run_background_job, job["id"], worker)
    return job


def _mark_interrupted_jobs() -> None:
    with TASK_HISTORY_LOCK:
        jobs = _load_task_history()
        changed = False
        for job in jobs:
            if job.get("status") in {"pending", "processing"}:
                job["status"] = "error"
                job["step"] = None
                job["errorMsg"] = "This task was interrupted when the server restarted."
                job["updatedAt"] = _now_iso()
                changed = True
        if changed:
            _save_task_history(jobs)


_mark_interrupted_jobs()


def _cleanup_dir(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _find_files(directory: str) -> list[str]:
    return [
        os.path.join(directory, fname)
        for fname in sorted(os.listdir(directory))
        if os.path.isfile(os.path.join(directory, fname))
    ]


def _sanitize_filename(value: str, fallback: str) -> str:
    safe = "".join(c for c in (value or fallback) if c.isalnum() or c in " ._-").strip()
    return safe or fallback


def _require_dependency(dep, label: str) -> None:
    if dep is None:
        raise ValueError(f"{label} is not installed on the server.")


def _file_ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _validate_upload(filename: str, allowed_exts: set[str], label: str) -> str:
    ext = _file_ext(filename or "")
    if ext not in allowed_exts:
        allowed = ", ".join(sorted(allowed_exts))
        raise ValueError(f"{label} must be one of: {allowed}.")
    return ext


def _safe_upload_name(filename: str, fallback: str) -> str:
    cleaned = secure_filename(filename or "") or fallback
    return _sanitize_filename(cleaned, fallback)


def _save_uploads(files, allowed_exts: set[str], tmp_dir: str, fallback_prefix: str) -> list[dict]:
    saved = []
    for idx, storage in enumerate(files, start=1):
        if not storage or not (storage.filename or "").strip():
            continue
        ext = _validate_upload(storage.filename, allowed_exts, "Uploaded file")
        safe_name = _safe_upload_name(storage.filename, f"{fallback_prefix}_{idx}.{ext}")
        path = os.path.join(tmp_dir, safe_name)
        storage.save(path)
        if not os.path.getsize(path):
            raise ValueError("Uploaded file is empty.")
        saved.append({"path": path, "filename": safe_name, "ext": ext})
    if not saved:
        raise ValueError("No files were uploaded.")
    return saved


def _save_single_upload(field_name: str, allowed_exts: set[str], tmp_dir: str, fallback_name: str) -> dict:
    storage = request.files.get(field_name)
    if not storage or not (storage.filename or "").strip():
        raise ValueError("No file was uploaded.")
    ext = _validate_upload(storage.filename, allowed_exts, "Uploaded file")
    safe_name = _safe_upload_name(storage.filename, fallback_name)
    path = os.path.join(tmp_dir, safe_name)
    storage.save(path)
    if not os.path.getsize(path):
        raise ValueError("Uploaded file is empty.")
    return {"path": path, "filename": safe_name, "ext": ext}


def _parse_ordered_uploads(files: list[dict], order_tokens: str) -> list[dict]:
    if not order_tokens.strip():
        return files

    ordered_names = [token.strip() for token in order_tokens.split(",") if token.strip()]
    if len(ordered_names) != len(files):
        raise ValueError("Image order does not match the uploaded file list.")

    by_name = {item["filename"]: item for item in files}
    if set(ordered_names) != set(by_name):
        raise ValueError("Image order includes unknown filenames.")

    return [by_name[name] for name in ordered_names]


def _coerce_rgb(image):
    if image.mode in {"RGB", "L"}:
        return image.convert("RGB")
    if image.mode == "RGBA":
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def _convert_image_file(src_path: str, target_format: str, output_path: str) -> None:
    _require_dependency(Image, "Pillow")
    with Image.open(src_path) as img:
        img = ImageOps.exif_transpose(img)
        save_kwargs = {}
        if target_format in {"jpg", "jpeg"}:
            img = _coerce_rgb(img)
            save_kwargs.update({"format": "JPEG", "quality": 92, "optimize": True})
        elif target_format == "png":
            save_kwargs.update({"format": "PNG", "optimize": True})
        elif target_format == "webp":
            img = _coerce_rgb(img)
            save_kwargs.update({"format": "WEBP", "quality": 90, "method": 6})
        else:
            raise ValueError("Unsupported target image format.")
        img.save(output_path, **save_kwargs)


def _images_to_pdf(files: list[dict], output_path: str) -> None:
    _require_dependency(img2pdf, "img2pdf")
    with open(output_path, "wb") as f:
        f.write(img2pdf.convert([item["path"] for item in files]))


def _pdf_to_images(pdf_path: str, target_format: str, mode: str, page_value: str, tmp_dir: str) -> tuple[str, str]:
    _require_dependency(fitz, "PyMuPDF")
    image_ext = target_format.lower()
    if image_ext not in PDF_TO_IMAGE_FORMATS:
        raise ValueError("Target format must be png or jpg.")

    doc = fitz.open(pdf_path)
    try:
        if doc.page_count == 0:
            raise ValueError("PDF has no pages.")

        if mode == "single":
            if not page_value.strip():
                raise ValueError("Page number is required for single-page export.")
            try:
                page_number = int(page_value)
            except ValueError as exc:
                raise ValueError("Page number must be an integer.") from exc
            if page_number < 1 or page_number > doc.page_count:
                raise ValueError(f"Page number must be between 1 and {doc.page_count}.")
            page_indexes = [page_number - 1]
        elif mode == "all":
            page_indexes = list(range(doc.page_count))
        elif mode == "pages":
            if not page_value.strip():
                raise ValueError("Page list is required for pages export.")
            try:
                page_numbers = [int(p.strip()) for p in page_value.split(",") if p.strip()]
            except ValueError as exc:
                raise ValueError("Page list must be comma-separated integers.") from exc
            if not page_numbers:
                raise ValueError("Page list is empty.")
            invalid = [n for n in page_numbers if n < 1 or n > doc.page_count]
            if invalid:
                raise ValueError(f"Invalid page numbers: {invalid}. PDF has {doc.page_count} pages.")
            page_indexes = [n - 1 for n in page_numbers]
        else:
            raise ValueError("Mode must be 'single', 'all', or 'pages'.")

        created = []
        for page_idx in page_indexes:
            page = doc.load_page(page_idx)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            out_name = f"page-{page_idx + 1:03d}.{image_ext}"
            out_path = os.path.join(tmp_dir, out_name)
            pix.save(out_path)
            if image_ext == "jpg":
                jpg_path = os.path.join(tmp_dir, f"page-{page_idx + 1:03d}.jpg")
                _convert_image_file(out_path, "jpg", jpg_path)
                os.remove(out_path)
                out_path = jpg_path
            created.append(out_path)

        if len(created) == 1:
            return created[0], os.path.basename(created[0])

        archive_path = os.path.join(tmp_dir, "pdf-pages.zip")
        _zip_files(created, archive_path)
        return archive_path, "pdf-pages.zip"
    finally:
        doc.close()


def _compress_pdf(pdf_path: str, preset: str, tmp_dir: str) -> tuple[str, str]:
    gs_preset = GS_PRESET_MAP.get(preset)
    if not gs_preset:
        raise ValueError("Compression preset must be small or quality.")

    ghostscript = shutil.which("gs")
    if not ghostscript:
        raise ValueError("Ghostscript is not installed on the server.")

    output_path = os.path.join(tmp_dir, "compressed.pdf")
    cmd = [
        ghostscript,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        f"-dPDFSETTINGS={gs_preset}",
        f"-sOutputFile={output_path}",
        pdf_path,
    ]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0 or not os.path.exists(output_path):
        raise ValueError(run.stderr.strip() or "PDF compression failed.")
    return output_path, "compressed.pdf"


def _guess_platform(url: str, extractor_key: str | None = None) -> str:
    lower_url = url.lower()
    lower_key = (extractor_key or "").lower()
    if "vsco" in lower_url or "vsco" in lower_key:
        return "vsco"
    if "instagram" in lower_url or "instagram" in lower_key:
        return "instagram"
    if "tiktok" in lower_url or "tiktok" in lower_key:
        return "tiktok"
    if "youtube" in lower_url or "youtu.be" in lower_url or "youtube" in lower_key:
        return "youtube"
    return "media"


def _base_ydl_opts() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extract_flat": False,
        "http_headers": {"User-Agent": DEFAULT_UA},
    }

    cookie_file = os.getenv("YTDLP_COOKIES_FILE", "").strip()
    if cookie_file:
        if not os.path.exists(cookie_file):
            raise ValueError(f"YTDLP_COOKIES_FILE does not exist: {cookie_file}")
        opts["cookiefile"] = cookie_file

    cookies_from_browser = os.getenv("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if cookies_from_browser:
        # Accept "browser" or "browser:profile" to mirror the common yt-dlp CLI shape.
        browser_parts = [part.strip() or None for part in cookies_from_browser.split(":", 1)]
        opts["cookiesfrombrowser"] = tuple(browser_parts)

    return opts


def _fetch_yt_info(url: str) -> dict:
    with yt_dlp.YoutubeDL(_base_ydl_opts()) as ydl:
        return ydl.extract_info(url, download=False)


def _pick_best_format(formats: list[dict], *, ext: str | None = None, height: int | None = None) -> dict | None:
    candidates = []
    for fmt in formats:
        if fmt.get("vcodec") in {None, "none"}:
            continue
        if ext and fmt.get("ext") != ext:
            continue
        fmt_height = fmt.get("height") or 0
        if height and fmt_height != height:
            continue
        candidates.append(fmt)

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda fmt: (
            fmt.get("height") or 0,
            fmt.get("fps") or 0,
            fmt.get("tbr") or 0,
            fmt.get("filesize") or 0,
        ),
    )


def _build_video_options(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    heights = sorted(
        {
            fmt.get("height")
            for fmt in formats
            if fmt.get("vcodec") not in {None, "none"} and fmt.get("height")
        },
        reverse=True,
    )
    options = []
    seen = set()

    for height in heights:
        selector = (
            f"bestvideo[ext=mp4][height<={height}]+bestaudio[ext=m4a]/"
            f"best[ext=mp4][height<={height}]/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        )
        key = ("mp4", height)
        if key in seen:
            continue
        seen.add(key)
        options.append(
            {
                "id": f"video-mp4-{height}",
                "kind": "video",
                "container": "mp4",
                "label": f"MP4 {height}p",
                "selector": selector,
                "height": height,
            }
        )

    best_overall = _pick_best_format(formats)
    if best_overall:
        ext = best_overall.get("ext") or "video"
        height = best_overall.get("height") or "best"
        options.append(
            {
                "id": f"video-best-{ext}-{height}",
                "kind": "video",
                "container": ext,
                "label": f"Best available ({ext.upper()} {height}p)" if isinstance(height, int) else f"Best available ({ext.upper()})",
                "selector": "bestvideo+bestaudio/best",
                "height": best_overall.get("height"),
            }
        )

    return options[:8]


def _build_audio_options() -> list[dict]:
    bitrates = [320, 192, 128]
    return [
        {
            "id": f"audio-mp3-{bitrate}",
            "kind": "audio",
            "container": "mp3",
            "bitrate": bitrate,
            "label": f"MP3 {bitrate} kbps",
            "selector": "bestaudio/best",
        }
        for bitrate in bitrates
    ]


def _guess_mime_type(ext: str | None, fallback: str = "application/octet-stream") -> str:
    ext = (ext or "").lower()
    return {
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "mkv": "video/x-matroska",
        "m4v": "video/mp4",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "mp3": "audio/mpeg",
        "m4a": "audio/mp4",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
    }.get(ext, fallback)


def _entry_ext(entry: dict) -> str:
    url = entry.get("url", "")
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    if "." in path:
        return path.rsplit(".", 1)[-1]
    return (entry.get("ext") or "").lower()


def _normalize_entries(info: dict) -> list[dict]:
    entries = info.get("entries") or []
    if isinstance(entries, list):
        return [entry for entry in entries if entry]
    return [entry for entry in entries if entry]


def _infer_media_type(item: dict) -> str | None:
    ext = _entry_ext(item)
    if ext in DIRECT_IMAGE_EXTENSIONS:
        return "image"
    if ext in {"mp4", "webm", "mov", "mkv"}:
        return "video"

    formats = item.get("formats") or []
    if any(fmt.get("vcodec") not in {None, "none"} for fmt in formats):
        return "video"
    if item.get("vcodec") not in {None, "none"}:
        return "video"
    return None


def _build_original_option(item: dict, default_label: str = "Original media") -> dict | None:
    media_type = _infer_media_type(item)
    ext = _entry_ext(item)
    if media_type == "image":
        return {
            "id": "image-original",
            "kind": "image",
            "container": ext or "jpg",
            "label": "Original image" if default_label == "Original media" else default_label,
            "selector": "best",
        }
    if media_type == "video":
        return {
            "id": "video-original",
            "kind": "video",
            "container": ext or "mp4",
            "label": "Original video" if default_label == "Original media" else default_label,
            "selector": "best",
        }
    return None


def _collect_media_entries(info: dict) -> list[dict]:
    entries = _normalize_entries(info)
    if not entries:
        media_type = _infer_media_type(info)
        if media_type and info.get("url"):
            entries = [info]

    collected = []
    for entry in entries:
        media_type = entry.get("media_type") or _infer_media_type(entry)
        if media_type not in {"image", "video"}:
            continue
        collected.append(
            {
                "url": entry.get("url"),
                "ext": _entry_ext(entry),
                "media_type": media_type,
                "http_headers": entry.get("http_headers") or {},
            }
        )
    return [entry for entry in collected if entry.get("url")]


def _pick_progressive_format(
    formats: list[dict],
    *,
    ext: str | None = None,
    max_height: int | None = None,
) -> dict | None:
    candidates = []
    for fmt in formats:
        if fmt.get("vcodec") in {None, "none"}:
            continue
        if fmt.get("acodec") in {None, "none"}:
            continue
        if not fmt.get("url"):
            continue
        if ext and fmt.get("ext") != ext:
            continue
        height = fmt.get("height") or 0
        if max_height and height and height > max_height:
            continue
        candidates.append(fmt)

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda fmt: (
            fmt.get("height") or 0,
            fmt.get("fps") or 0,
            fmt.get("tbr") or 0,
            fmt.get("filesize") or 0,
        ),
    )


def _iter_preview_formats(formats: list[dict], *, max_height: int | None = None) -> list[dict]:
    candidates = []
    seen = set()
    for fmt in formats:
        if fmt.get("vcodec") in {None, "none"}:
            continue
        if not fmt.get("url"):
            continue
        height = fmt.get("height") or 0
        if max_height and height and height > max_height:
            continue
        key = (
            fmt.get("format_id"),
            fmt.get("ext"),
            fmt.get("height"),
            fmt.get("fps"),
            fmt.get("url"),
        )
        if key in seen:
            continue
        seen.add(key)
        candidates.append(fmt)

    candidates.sort(
        key=lambda fmt: (
            fmt.get("height") or 0,
            fmt.get("fps") or 0,
            fmt.get("tbr") or 0,
            fmt.get("filesize") or 0,
        ),
        reverse=True,
    )
    return candidates


def _encode_preview_token(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_preview_token(token: str) -> dict:
    padded = token + "=" * (-len(token) % 4)
    raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    return json.loads(raw.decode("utf-8"))


def _build_preview_info(info: dict) -> dict | None:
    entries = _collect_media_entries(info)
    direct_video = next((entry for entry in entries if entry.get("media_type") == "video"), None)
    if direct_video:
        token = _encode_preview_token(
            {
                "url": direct_video["url"],
                "http_headers": direct_video.get("http_headers") or {},
                "mime_type": _guess_mime_type(direct_video.get("ext"), "video/mp4"),
            }
        )
        return {
            "stream_url": f"/api/video-preview?token={urllib.parse.quote(token)}",
            "mime_type": _guess_mime_type(direct_video.get("ext"), "video/mp4"),
            "label": "Original video preview",
            "default_quality_id": "original",
            "qualities": [
                {
                    "id": "original",
                    "label": "Original",
                    "stream_url": f"/api/video-preview?token={urllib.parse.quote(token)}",
                    "mime_type": _guess_mime_type(direct_video.get("ext"), "video/mp4"),
                }
            ],
        }

    formats = info.get("formats") or []
    preview_candidates = _iter_preview_formats(formats, max_height=720)
    if not preview_candidates:
        return None

    preview_qualities = []
    seen_heights = set()
    for fmt in preview_candidates:
        height = fmt.get("height")
        has_audio = fmt.get("acodec") not in {None, "none"}
        label = f"{height}p" if height else (fmt.get("ext") or "Source").upper()
        if not has_audio:
            label += " (video only)"
        quality_id = str(height or fmt.get("format_id") or len(preview_qualities) + 1)
        if height and height in seen_heights:
            continue
        mime_type = _guess_mime_type(fmt.get("ext"), "video/mp4")
        token = _encode_preview_token(
            {
                "url": fmt["url"],
                "http_headers": fmt.get("http_headers") or {},
                "mime_type": mime_type,
            }
        )
        preview_qualities.append(
            {
                "id": quality_id,
                "label": label,
                "stream_url": f"/api/video-preview?token={urllib.parse.quote(token)}",
                "mime_type": mime_type,
                "height": height,
                "has_audio": has_audio,
            }
        )
        if height:
            seen_heights.add(height)
        if len(preview_qualities) >= 5:
            break

    if not preview_qualities:
        return None

    preview_format = (
        next((item for item in preview_qualities if item.get("height") == 360), None)
        or next((item for item in preview_qualities if item.get("height") and item["height"] < 360), None)
        or next((item for item in reversed(preview_qualities) if item.get("height") and item["height"] > 360), None)
        or preview_qualities[0]
    )
    height = preview_format.get("height")
    return {
        "stream_url": preview_format["stream_url"],
        "mime_type": preview_format["mime_type"],
        "label": f"Streaming preview ({height}p)" if height else "Streaming preview",
        "height": height,
        "default_quality_id": preview_format["id"],
        "qualities": preview_qualities,
    }


def _append_media_bucket_options(options: list[dict], entries: list[dict], prefix: str = "media") -> None:
    image_count = sum(1 for entry in entries if entry["media_type"] == "image")
    video_count = sum(1 for entry in entries if entry["media_type"] == "video")

    if image_count:
        ext = next((entry["ext"] for entry in entries if entry["media_type"] == "image" and entry.get("ext")), "jpg")
        options.append(
            {
                "id": f"{prefix}-images-original",
                "kind": "image",
                "container": "zip" if image_count > 1 else ext,
                "label": "Original image" if image_count == 1 else f"Original images ({image_count})",
            }
        )

    if video_count:
        ext = next((entry["ext"] for entry in entries if entry["media_type"] == "video" and entry.get("ext")), "mp4")
        options.append(
            {
                "id": f"{prefix}-videos-original",
                "kind": "video",
                "container": "zip" if video_count > 1 else ext,
                "label": "Original video" if video_count == 1 else f"Original videos ({video_count})",
            }
        )

    if image_count and video_count:
        options.append(
            {
                "id": f"{prefix}-media-original",
                "kind": "mixed",
                "container": "zip",
                "label": f"Original post media ({image_count + video_count})",
            }
        )


def _extract_vsco_media(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else "VSCO media"

    raw_urls = []
    for match in MEDIA_URL_RE.findall(html):
        cleaned = match.replace("\\u002F", "/").replace("\\/", "/")
        cleaned = cleaned.replace("&amp;", "&")
        if "vsco" not in cleaned.lower():
            continue
        if VSCO_MEDIA_HINT_RE.search(cleaned):
            raw_urls.append(cleaned)

    seen = set()
    entries = []
    for media_url in raw_urls:
        normalized = media_url.split('"')[0]
        normalized = normalized.split("'")[0]
        if normalized in seen:
            continue
        seen.add(normalized)

        ext = _entry_ext({"url": normalized})
        if ext in DIRECT_IMAGE_EXTENSIONS:
            media_type = "image"
        elif ext == "mp4":
            media_type = "video"
        else:
            continue

        entries.append(
            {
                "url": normalized,
                "ext": ext,
                "media_type": media_type,
            }
        )

    if not entries:
        raise ValueError("No downloadable VSCO media found on this page.")

    return {
        "title": title,
        "platform": "vsco",
        "extractor_key": "VSCO",
        "entries": entries,
    }


def _get_media_info(url: str) -> dict:
    if "vsco.co" in url.lower():
        return _extract_vsco_media(url)

    info = _fetch_yt_info(url)
    info["platform"] = _guess_platform(url, info.get("extractor_key"))
    return info


def _build_media_options(url: str) -> dict:
    info = _get_media_info(url)
    platform = info.get("platform") or _guess_platform(url, info.get("extractor_key"))
    entries = _collect_media_entries(info)
    has_gallery = bool(entries)

    options = []
    if platform not in {"vsco", "instagram"}:
        options.extend(_build_audio_options())
        if info.get("formats"):
            options.extend(_build_video_options(info))

    if platform == "vsco":
        _append_media_bucket_options(options, entries, "vsco")
    elif platform == "instagram" and entries:
        _append_media_bucket_options(options, entries, "instagram")
        if info.get("formats"):
            options.extend(_build_video_options(info))
    elif has_gallery:
        if len(entries) == 1:
            original_option = _build_original_option(entries[0])
            if original_option:
                options.append(original_option)
        else:
            options.append(
                {
                    "id": "post-original",
                    "kind": "mixed",
                    "container": "zip",
                    "label": f"Original post media ({len(entries)})",
                }
            )

    if not options:
        original_option = _build_original_option(info)
        if original_option:
            options.append(original_option)

    return {
        "title": info.get("title") or "Media",
        "platform": platform,
        "is_gallery": has_gallery,
        "preview": _build_preview_info(info),
        "options": options,
        "transcription_recommendation": (
            "Browser Whisper is faster on most setups. Raspberry Pi transcription is available if whisper.cpp is installed."
        ),
    }


def _timestamp_to_seconds(hours: str, minutes: str, seconds: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _parse_whisper_output(stdout: str) -> dict:
    chunks = []
    texts = []
    for line in stdout.splitlines():
        match = WHISPER_LINE_RE.match(line.strip())
        if not match:
            continue
        start_h, start_m, start_s, end_h, end_m, end_s, text = match.groups()
        cleaned = text.strip()
        if not cleaned:
            continue
        chunks.append(
            {
                "timestamp": [
                    _timestamp_to_seconds(start_h, start_m, start_s),
                    _timestamp_to_seconds(end_h, end_m, end_s),
                ],
                "text": cleaned,
            }
        )
        texts.append(cleaned)
    if not chunks:
        raise ValueError("whisper.cpp completed but returned no transcript segments.")
    return {"text": " ".join(texts).strip(), "chunks": chunks}


def _download_direct_file(url: str, destination: str, headers: dict | None = None) -> None:
    req_headers = {"User-Agent": DEFAULT_UA, **(headers or {})}
    req = urllib.request.Request(url, headers=req_headers)
    with urllib.request.urlopen(req, timeout=60) as resp, open(destination, "wb") as f:
        shutil.copyfileobj(resp, f)


def _download_audio_source(url: str) -> tuple[str, str, str]:
    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "audio.%(ext)s")
    ydl_opts = {
        **_base_ydl_opts(),
        "format": "bestaudio[abr<=96]/bestaudio/best",
        "outtmpl": output_template,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "64",
            }
        ],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", "audio")

    audio_files = _find_files(tmp_dir)
    if not audio_files:
        _cleanup_dir(tmp_dir)
        raise ValueError("Audio download produced no file.")

    return tmp_dir, audio_files[0], title


def _run_pi_whisper(audio_path: str) -> dict:
    whisper_bin = os.getenv("WHISPER_CPP_BIN", "/usr/local/bin/whisper-cli")
    whisper_model = os.getenv("WHISPER_CPP_MODEL", "")
    if not whisper_model:
        raise ValueError("WHISPER_CPP_MODEL is not set.")
    if not os.path.exists(whisper_bin):
        raise ValueError(f"whisper.cpp binary not found: {whisper_bin}")
    if not os.path.exists(whisper_model):
        raise ValueError(f"whisper.cpp model not found: {whisper_model}")

    tmp_dir = tempfile.mkdtemp()
    wav_path = os.path.join(tmp_dir, "audio.wav")
    ffmpeg_cmd = [
        "ffmpeg",
        "-y",
        "-i",
        audio_path,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav_path,
    ]
    ffmpeg_run = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
    if ffmpeg_run.returncode != 0:
        _cleanup_dir(tmp_dir)
        raise ValueError(ffmpeg_run.stderr.strip() or "ffmpeg conversion failed.")

    thread_count = os.getenv("WHISPER_THREADS") or str(max(1, (os.cpu_count() or 2) - 1))
    whisper_cmd = [
        whisper_bin,
        "--model",
        whisper_model,
        "--file",
        wav_path,
        "--threads",
        thread_count,
    ]
    language = os.getenv("WHISPER_LANGUAGE", "").strip()
    if language:
        whisper_cmd.extend(["--language", language])

    whisper_run = subprocess.run(whisper_cmd, capture_output=True, text=True)
    _cleanup_dir(tmp_dir)
    if whisper_run.returncode != 0:
        raise ValueError(whisper_run.stderr.strip() or whisper_run.stdout.strip() or "whisper.cpp failed.")

    return _parse_whisper_output(whisper_run.stdout)


def _whisper_status() -> dict:
    whisper_bin = os.getenv("WHISPER_CPP_BIN", "/usr/local/bin/whisper-cli")
    whisper_model = os.getenv("WHISPER_CPP_MODEL", "")

    if not whisper_model:
        return {"ready": False, "status": "WHISPER_CPP_MODEL is not set.", "device": "PI"}
    if not os.path.exists(whisper_bin):
        return {"ready": False, "status": f"whisper.cpp binary not found: {whisper_bin}", "device": "PI"}
    if not os.path.exists(whisper_model):
        return {"ready": False, "status": f"whisper.cpp model not found: {whisper_model}", "device": "PI"}
    return {"ready": True, "status": "Transcription ready", "device": "PI"}


def _zip_files(files: list[str], archive_path: str) -> str:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in files:
            zf.write(file_path, arcname=os.path.basename(file_path))
    return archive_path


def _extract_frames_at_timestamps(
    video_path: str,
    *,
    timestamps: list[float],
    target_format: str,
    tmp_dir: str,
) -> tuple[str, str]:
    """Extract one frame per timestamp (in seconds) from video_path."""
    if target_format not in FRAME_IMAGE_FORMATS:
        raise ValueError("Frame format must be jpg or png.")
    if not timestamps:
        raise ValueError("At least one timestamp is required.")
    if len(timestamps) > 50:
        raise ValueError("Maximum 50 timestamps allowed.")

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise ValueError("ffmpeg is not installed on the server.")

    created = []
    for i, t in enumerate(timestamps):
        out_path = os.path.join(tmp_dir, f"frame-{i + 1:03d}.{target_format}")
        cmd = [
            ffmpeg_bin, "-y",
            "-ss", f"{t:.3f}",
            "-i", video_path,
            "-vframes", "1",
            "-vsync", "vfr",
        ]
        if target_format == "jpg":
            cmd += ["-q:v", "2"]
        cmd.append(out_path)
        run = subprocess.run(cmd, capture_output=True, text=True)
        if run.returncode != 0:
            raise ValueError(run.stderr.strip() or f"Frame extraction failed at {t:.1f}s.")
        if os.path.exists(out_path):
            created.append(out_path)

    if not created:
        raise ValueError("No frames were extracted from this video.")

    if len(created) == 1:
        return created[0], os.path.basename(created[0])

    archive_path = os.path.join(tmp_dir, "frames.zip")
    _zip_files(created, archive_path)
    return archive_path, "frames.zip"


def _clip_video_segment(
    video_path: str,
    *,
    start_time: float,
    end_time: float,
    tmp_dir: str,
) -> tuple[str, str]:
    if start_time < 0:
        raise ValueError("Clip start time must be 0 or greater.")
    if end_time <= start_time:
        raise ValueError("Clip end time must be greater than the start time.")

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise ValueError("ffmpeg is not installed on the server.")

    output_path = os.path.join(tmp_dir, "clip.mp4")
    duration = end_time - start_time
    cmd = [
        ffmpeg_bin,
        "-y",
        "-ss",
        f"{start_time:.3f}",
        "-i",
        video_path,
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        output_path,
    ]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0 or not os.path.exists(output_path):
        raise ValueError(run.stderr.strip() or "Video clipping failed.")
    return output_path, "clip.mp4"


def _build_download_filename(title: str, suffix: str, ext: str) -> str:
    base = _sanitize_filename(title, "download")
    suffix_part = f"_{suffix}" if suffix else ""
    return f"{base}{suffix_part}.{ext}"


def _download_with_ytdlp(url: str, option: dict, title: str) -> tuple[str, str, str]:
    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, "download.%(ext)s")
    kind = option.get("kind")
    container = option.get("container")

    ydl_opts = {
        **_base_ydl_opts(),
        "outtmpl": output_template,
        "format": option.get("selector") or "best",
        "merge_output_format": "mp4" if kind == "video" and container == "mp4" else None,
    }

    if kind == "audio":
        bitrate = str(option.get("bitrate") or 320)
        ydl_opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": bitrate,
            }
        ]
        ydl_opts["keepvideo"] = False
    elif option.get("id") == "post-original":
        ydl_opts["format"] = "best"

    ydl_opts = {k: v for k, v in ydl_opts.items() if v is not None}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(url, download=True)

    files = _find_files(tmp_dir)
    if not files:
        _cleanup_dir(tmp_dir)
        raise ValueError("Download produced no files.")

    if len(files) == 1:
        file_path = files[0]
        ext = os.path.splitext(file_path)[1].lstrip(".").lower() or container or "bin"
        return tmp_dir, file_path, _build_download_filename(title, option.get("id", kind), ext)

    archive_path = os.path.join(tmp_dir, "bundle.zip")
    _zip_files(files, archive_path)
    return tmp_dir, archive_path, _build_download_filename(title, option.get("kind", "media"), "zip")


def _download_vsco_media(url: str, option: dict, title: str) -> tuple[str, str, str]:
    info = _extract_vsco_media(url)
    return _download_direct_media_entries(info, option, title)


def _download_direct_media_entries(info: dict, option: dict, title: str) -> tuple[str, str, str]:
    entries = _collect_media_entries(info)
    option_id = option.get("id", "")

    if option.get("kind") == "image" or option_id.endswith("-images-original"):
        entries = [entry for entry in entries if entry["media_type"] == "image"]
    elif option.get("kind") == "video" or option_id.endswith("-videos-original"):
        entries = [entry for entry in entries if entry["media_type"] == "video"]

    if not entries:
        raise ValueError("No matching media found for that option.")

    tmp_dir = tempfile.mkdtemp()
    downloaded = []
    for idx, entry in enumerate(entries, start=1):
        ext = entry["ext"] or ("jpg" if entry["media_type"] == "image" else "mp4")
        dest = os.path.join(tmp_dir, f"{idx:02d}.{ext}")
        _download_direct_file(entry["url"], dest, entry.get("http_headers"))
        downloaded.append(dest)

    if len(downloaded) == 1:
        ext = os.path.splitext(downloaded[0])[1].lstrip(".").lower()
        suffix = "image" if entries[0]["media_type"] == "image" else "video"
        return tmp_dir, downloaded[0], _build_download_filename(title, suffix, ext)

    archive_path = os.path.join(tmp_dir, "media-bundle.zip")
    _zip_files(downloaded, archive_path)
    suffix = option.get("kind", "media")
    if suffix == "mixed":
        suffix = "media"
    elif suffix == "image":
        suffix = "images"
    elif suffix == "video":
        suffix = "videos"
    return tmp_dir, archive_path, _build_download_filename(title, suffix, "zip")


def _download_direct_video_files(info: dict) -> tuple[str, list[str]]:
    entries = [entry for entry in _collect_media_entries(info) if entry["media_type"] == "video"]
    if not entries:
        raise ValueError("No video source was found for frame extraction.")

    tmp_dir = tempfile.mkdtemp()
    downloaded = []
    for idx, entry in enumerate(entries, start=1):
        ext = entry["ext"] or "mp4"
        dest = os.path.join(tmp_dir, f"video-{idx:02d}.{ext}")
        _download_direct_file(entry["url"], dest, entry.get("http_headers"))
        downloaded.append(dest)
    return tmp_dir, downloaded


def _send_temp_file(tmp_dir: str, path: str, download_name: str):
    response = send_file(path, as_attachment=True, download_name=download_name, conditional=True, etag=False)
    response.call_on_close(lambda: _cleanup_dir(tmp_dir))
    return response


def _request_value(name: str, default=""):
    if request.is_json:
        data = request.get_json(silent=True) or {}
        return data.get(name, default)
    return request.form.get(name, default)


def _resolve_request_option() -> tuple[str, dict, str]:
    if request.is_json:
        data = request.get_json(silent=True) or {}
        url = str(data.get("url", "")).strip()
        option = data.get("option") or {}
        title = str(data.get("title", "download"))
        return url, option, title

    url = str(request.form.get("url", "")).strip()
    option_value = str(request.form.get("value", "")).strip()
    option_kind = str(request.form.get("kind", "")).strip().lower()
    if url and option_value:
        meta = _build_media_options(url)
        option = next((item for item in meta.get("options", []) if item.get("id") == option_value), {})
        if option_kind and option and option.get("kind") != option_kind:
            option = {}
        title = str(meta.get("title") or "download")
        return url, option, title
    return url, {}, "download"


def _resolve_media_option(url: str, option_value: str, option_kind: str = "") -> tuple[dict, str]:
    meta = _build_media_options(url)
    option = next((item for item in meta.get("options", []) if item.get("id") == option_value), {})
    if option_kind and option and option.get("kind") != option_kind:
        option = {}
    return option, str(meta.get("title") or "download")


def _format_timecode(seconds: float) -> str:
    total_ms = max(0, round(float(seconds or 0) * 1000))
    hours = total_ms // 3600000
    minutes = (total_ms % 3600000) // 60000
    secs = (total_ms % 60000) / 1000
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def _format_timestamped_transcript(chunks: list[dict]) -> str:
    lines = []
    for chunk in chunks:
        start, end = (chunk.get("timestamp") or [0, 0])[:2]
        text = str(chunk.get("text") or "").strip()
        if text:
            lines.append(f"[{_format_timecode(start)} --> {_format_timecode(end)}] {text}")
    return "\n".join(lines)


def _run_download_media_job(job_id: str, url: str, option_value: str, option_kind: str) -> None:
    _update_task_job(job_id, step="Resolving media...")
    option, title = _resolve_media_option(url, option_value, option_kind)
    if not option:
        raise ValueError("No download option provided.")

    _update_task_job(job_id, label=title, step="Downloading media...")
    platform = _guess_platform(url)
    if platform == "vsco":
        tmp_dir, file_path, filename = _download_vsco_media(url, option, title)
    elif option.get("id") in DIRECT_DOWNLOAD_OPTION_IDS:
        tmp_dir, file_path, filename = _download_direct_media_entries(_get_media_info(url), option, title)
    else:
        tmp_dir, file_path, filename = _download_with_ytdlp(url, option, title)
    _finish_artifact_job(job_id, tmp_dir, file_path, filename)


def _run_transcribe_job(job_id: str, url: str) -> None:
    tmp_dir = None
    try:
        _update_task_job(job_id, step="Fetching audio...")
        tmp_dir, audio_path, title = _download_audio_source(url)
        _update_task_job(job_id, label=title, step="Transcribing on Pi...")
        result = _run_pi_whisper(audio_path)
        _update_task_job(
            job_id,
            status="done",
            step=None,
            transcript={
                "plain": result.get("text") or "",
                "timestamped": _format_timestamped_transcript(result.get("chunks") or []),
            },
            transcriptView="timestamped",
            errorMsg=None,
        )
    finally:
        if tmp_dir:
            _cleanup_dir(tmp_dir)


def _download_video_for_job(url: str, option: dict, title: str) -> tuple[str, str]:
    platform = _guess_platform(url)
    if platform == "vsco" or option.get("id") in DIRECT_DOWNLOAD_OPTION_IDS:
        tmp_dir, video_paths = _download_direct_video_files(_get_media_info(url))
        video_path = video_paths[0] if video_paths else None
    else:
        tmp_dir, video_path, _filename = _download_with_ytdlp(url, option, title)
        if os.path.splitext(video_path)[1].lower() == ".zip":
            _cleanup_dir(tmp_dir)
            raise ValueError("This task requires a single video download option.")
    if not video_path:
        _cleanup_dir(tmp_dir)
        raise ValueError("Could not download video.")
    return tmp_dir, video_path


def _run_extract_frames_job(job_id: str, url: str, option_value: str, target_format: str, timestamps: list[float]) -> None:
    _update_task_job(job_id, step="Resolving video...")
    option, title = _resolve_media_option(url, option_value, "video")
    if not option:
        raise ValueError("Frame extraction requires a video option.")
    if target_format not in FRAME_IMAGE_FORMATS:
        target_format = "jpg"
    if not timestamps:
        raise ValueError("At least one timestamp is required.")

    _update_task_job(job_id, label=f"{title} · frames", step="Downloading video...")
    tmp_dir, video_path = _download_video_for_job(url, option, title)
    try:
        _update_task_job(job_id, step="Extracting frames...")
        output_path, output_name = _extract_frames_at_timestamps(
            video_path,
            timestamps=timestamps,
            target_format=target_format,
            tmp_dir=tmp_dir,
        )
        download_name = _build_download_filename(title, "frames", output_name.rsplit(".", 1)[-1])
        _finish_artifact_job(job_id, tmp_dir, output_path, download_name)
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


def _run_clip_video_job(job_id: str, url: str, option_value: str, start_time: float, end_time: float) -> None:
    _update_task_job(job_id, step="Resolving video...")
    option, title = _resolve_media_option(url, option_value, "video")
    if not option:
        raise ValueError("Video clipping requires a video option.")

    _update_task_job(job_id, label=f"{title} · clip", step="Downloading video...")
    tmp_dir, video_path = _download_video_for_job(url, option, title)
    try:
        _update_task_job(job_id, step="Saving clip...")
        output_path, output_name = _clip_video_segment(
            video_path,
            start_time=start_time,
            end_time=end_time,
            tmp_dir=tmp_dir,
        )
        download_name = _build_download_filename(title, "clip", output_name.rsplit(".", 1)[-1])
        _finish_artifact_job(job_id, tmp_dir, output_path, download_name)
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


def _run_image_convert_job(job_id: str, upload: dict, target_format: str, tmp_dir: str) -> None:
    try:
        _update_task_job(job_id, step="Converting image...")
        base = os.path.splitext(upload["filename"])[0]
        out_name = f"{base}.{target_format}"
        out_path = os.path.join(tmp_dir, out_name)
        _convert_image_file(upload["path"], target_format, out_path)
        _finish_artifact_job(job_id, tmp_dir, out_path, out_name)
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


def _run_images_to_pdf_job(job_id: str, uploads: list[dict], order: str, tmp_dir: str) -> None:
    try:
        _update_task_job(job_id, step="Building PDF...")
        ordered = _parse_ordered_uploads(uploads, order)
        pdf_path = os.path.join(tmp_dir, "images.pdf")
        _images_to_pdf(ordered, pdf_path)
        _finish_artifact_job(job_id, tmp_dir, pdf_path, "images.pdf")
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


def _run_pdf_to_images_job(job_id: str, upload: dict, target_format: str, mode: str, page_value: str, tmp_dir: str) -> None:
    try:
        _update_task_job(job_id, step="Exporting PDF pages...")
        output_path, download_name = _pdf_to_images(upload["path"], target_format, mode, page_value, tmp_dir)
        _finish_artifact_job(job_id, tmp_dir, output_path, download_name)
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


def _run_compress_pdf_job(job_id: str, upload: dict, preset: str, tmp_dir: str) -> None:
    try:
        _update_task_job(job_id, step="Compressing PDF...")
        output_path, download_name = _compress_pdf(upload["path"], preset, tmp_dir)
        _finish_artifact_job(job_id, tmp_dir, output_path, download_name)
    except Exception:
        _cleanup_dir(tmp_dir)
        raise


@api.route("/api/media-options", methods=["POST"])
def media_options():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    try:
        return jsonify(_build_media_options(url))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api.route("/api/jobs", methods=["GET"])
def list_jobs():
    jobs = _load_task_history()
    return jsonify({"jobs": list(reversed(jobs))})


@api.route("/api/jobs", methods=["POST"])
def save_job():
    try:
        if request.content_type and request.content_type.startswith("multipart/form-data"):
            raw_job = request.form.get("job", "{}")
            job = _sanitize_job(json.loads(raw_job))
            artifact = request.files.get("artifact")
            if artifact and artifact.filename:
                filename = _sanitize_filename(job.get("filename") or artifact.filename, "download")
                job["filename"] = filename
                job["artifactUrl"] = f"/api/jobs/{urllib.parse.quote(job['id'])}/artifact"
                job["artifactSaved"] = True
                artifact_dir = os.path.join(TASK_HISTORY_DIR, job["id"])
                os.makedirs(artifact_dir, exist_ok=True)
                artifact.save(_job_artifact_path(job["id"], filename))
        else:
            payload = request.get_json(silent=True) or {}
            job = _sanitize_job(payload.get("job") or payload)

        _upsert_task_history(job)
        return jsonify({"job": job})
    except (ValueError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api.route("/api/jobs/<job_id>/artifact", methods=["GET"])
def job_artifact(job_id):
    try:
        safe_id = _safe_job_id(job_id)
        job = next((item for item in _load_task_history() if item.get("id") == safe_id), None)
        if not job or not job.get("filename"):
            return jsonify({"error": "Artifact not found."}), 404

        path = _job_artifact_path(safe_id, job["filename"])
        if not os.path.exists(path):
            return jsonify({"error": "Artifact not found."}), 404
        return send_file(path, as_attachment=True, download_name=job["filename"], conditional=True, etag=False)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


def _queued_response(job: dict):
    return jsonify({"job": job}), 202


@api.route("/api/jobs/start/download-media", methods=["POST"])
def start_download_media_job():
    url = str(request.form.get("url", "")).strip()
    option_value = str(request.form.get("value", "")).strip()
    option_kind = str(request.form.get("kind", "")).strip().lower()
    label = str(request.form.get("label", "")).strip() or url or "Media download"
    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option_value:
        return jsonify({"error": "No download option provided."}), 400

    job = _create_task_job("download-media", label)
    _submit_background_job(job, lambda job_id: _run_download_media_job(job_id, url, option_value, option_kind))
    return _queued_response(job)


@api.route("/api/jobs/start/transcribe", methods=["POST"])
def start_transcribe_job():
    url = str(request.form.get("url", "")).strip()
    label = str(request.form.get("label", "")).strip() or url or "Transcription"
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    job = _create_task_job("transcribe", label)
    _submit_background_job(job, lambda job_id: _run_transcribe_job(job_id, url))
    return _queued_response(job)


@api.route("/api/jobs/start/extract-frames", methods=["POST"])
def start_extract_frames_job():
    url = str(request.form.get("url", "")).strip()
    option_value = str(request.form.get("value", "")).strip()
    target_format = request.form.get("target_format", "jpg").strip().lower()
    timestamps_raw = request.form.get("timestamps", "").strip()
    label = str(request.form.get("label", "")).strip() or "Extract frames"
    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option_value:
        return jsonify({"error": "No media option provided."}), 400
    try:
        timestamps = [float(t.strip()) for t in timestamps_raw.split(",") if t.strip()]
    except ValueError:
        return jsonify({"error": "Invalid timestamps format."}), 400
    if not timestamps:
        return jsonify({"error": "No valid timestamps provided."}), 400

    job = _create_task_job("extract-frames", label)
    _submit_background_job(
        job,
        lambda job_id: _run_extract_frames_job(job_id, url, option_value, target_format, timestamps),
    )
    return _queued_response(job)


@api.route("/api/jobs/start/clip-video", methods=["POST"])
def start_clip_video_job():
    url = str(request.form.get("url", "")).strip()
    option_value = str(request.form.get("value", "")).strip()
    label = str(request.form.get("label", "")).strip() or "Video clip"
    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option_value:
        return jsonify({"error": "No media option provided."}), 400
    try:
        start_time = float(request.form.get("start_time", "").strip())
        end_time = float(request.form.get("end_time", "").strip())
    except ValueError:
        return jsonify({"error": "Clip times must be valid numbers."}), 400

    job = _create_task_job("clip-video", label)
    _submit_background_job(
        job,
        lambda job_id: _run_clip_video_job(job_id, url, option_value, start_time, end_time),
    )
    return _queued_response(job)


@api.route("/api/jobs/start/tools/image-convert", methods=["POST"])
def start_image_convert_job():
    tmp_dir = tempfile.mkdtemp()
    try:
        target_format = request.form.get("target_format", "").strip().lower()
        if target_format not in CONVERTIBLE_IMAGE_FORMATS:
            raise ValueError("Target format must be jpg, png, or webp.")
        uploads = _save_uploads(request.files.getlist("files"), IMAGE_EXTENSIONS, tmp_dir, "image")
        upload = uploads[0]
        label = f"{upload['filename']} → {target_format.upper()}"
        job = _create_task_job("convert-image", label)
        _submit_background_job(job, lambda job_id: _run_image_convert_job(job_id, upload, target_format, tmp_dir))
        return _queued_response(job)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/jobs/start/tools/images-to-pdf", methods=["POST"])
def start_images_to_pdf_job():
    tmp_dir = tempfile.mkdtemp()
    try:
        uploads = _save_uploads(request.files.getlist("files"), IMAGE_EXTENSIONS, tmp_dir, "image")
        order = request.form.get("order", "")
        label = f"{len(uploads)} images → PDF"
        job = _create_task_job("images-to-pdf", label)
        _submit_background_job(job, lambda job_id: _run_images_to_pdf_job(job_id, uploads, order, tmp_dir))
        return _queued_response(job)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/jobs/start/tools/pdf-to-images", methods=["POST"])
def start_pdf_to_images_job():
    tmp_dir = tempfile.mkdtemp()
    try:
        upload = _save_single_upload("file", PDF_EXTENSIONS, tmp_dir, "document.pdf")
        target_format = request.form.get("target_format", "").strip().lower()
        mode = request.form.get("mode", "").strip().lower()
        page_value = request.form.get("page", "").strip()
        job = _create_task_job("pdf-to-images", upload["filename"])
        _submit_background_job(
            job,
            lambda job_id: _run_pdf_to_images_job(job_id, upload, target_format, mode, page_value, tmp_dir),
        )
        return _queued_response(job)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/jobs/start/tools/compress-pdf", methods=["POST"])
def start_compress_pdf_job():
    tmp_dir = tempfile.mkdtemp()
    try:
        upload = _save_single_upload("file", PDF_EXTENSIONS, tmp_dir, "document.pdf")
        preset = request.form.get("preset", "").strip().lower()
        job = _create_task_job("compress-pdf", upload["filename"])
        _submit_background_job(job, lambda job_id: _run_compress_pdf_job(job_id, upload, preset, tmp_dir))
        return _queued_response(job)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/video-preview", methods=["GET"])
def video_preview():
    token = str(request.args.get("token", "")).strip()
    if not token:
        return jsonify({"error": "Missing preview token."}), 400

    try:
        payload = _decode_preview_token(token)
        source_url = str(payload.get("url", "")).strip()
        if not source_url:
            return jsonify({"error": "Preview token is invalid."}), 400

        upstream_headers = {"User-Agent": DEFAULT_UA, **(payload.get("http_headers") or {})}
        range_header = request.headers.get("Range")
        if range_header:
            upstream_headers["Range"] = range_header

        req = urllib.request.Request(source_url, headers=upstream_headers)
        upstream = urllib.request.urlopen(req, timeout=60)

        status_code = getattr(upstream, "status", 200) or 200
        response = Response(
            stream_with_context(iter(lambda: upstream.read(64 * 1024), b"")),
            status=status_code,
            mimetype=str(payload.get("mime_type") or upstream.headers.get_content_type() or "video/mp4"),
            direct_passthrough=True,
        )

        for header in ("Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
            value = upstream.headers.get(header)
            if value:
                response.headers[header] = value
        response.headers.setdefault("Accept-Ranges", "bytes")
        response.call_on_close(upstream.close)
        return response
    except urllib.error.HTTPError as e:
        return jsonify({"error": e.reason or "Preview request failed."}), e.code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api.route("/api/model-status", methods=["GET"])
def model_status():
    return jsonify(_whisper_status())


@api.route("/api/fetch-audio", methods=["POST"])
def fetch_audio():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    try:
        tmp_dir, audio_path, title = _download_audio_source(url)
        ext = os.path.splitext(audio_path)[1].lstrip(".").lower() or "mp3"
        mime_map = {
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "ogg": "audio/ogg",
            "opus": "audio/ogg",
            "webm": "audio/webm",
            "wav": "audio/wav",
        }
        response = send_file(
            audio_path,
            mimetype=mime_map.get(ext, "application/octet-stream"),
            as_attachment=False,
            download_name=_build_download_filename(title, "audio", ext),
            conditional=True,
            etag=False,
        )
        response.headers["X-Video-Title"] = title.encode("ascii", "replace").decode()
        response.headers["Access-Control-Expose-Headers"] = "X-Video-Title"
        response.call_on_close(lambda: _cleanup_dir(tmp_dir))
        return response
    except Exception as e:
        if "tmp_dir" in locals():
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/transcribe-server", methods=["POST"])
def transcribe_server():
    url = str(_request_value("url", "")).strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400

    try:
        tmp_dir, audio_path, title = _download_audio_source(url)
        result = _run_pi_whisper(audio_path)
        _cleanup_dir(tmp_dir)
        return jsonify({"title": title, "result": result, "engine": "whisper.cpp"})
    except Exception as e:
        if "tmp_dir" in locals():
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/download-media", methods=["POST"])
def download_media():
    url, option, title = _resolve_request_option()

    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option:
        return jsonify({"error": "No download option provided."}), 400

    try:
        platform = _guess_platform(url)
        if platform == "vsco":
            tmp_dir, file_path, filename = _download_vsco_media(url, option, title)
        elif option.get("id") in DIRECT_DOWNLOAD_OPTION_IDS:
            tmp_dir, file_path, filename = _download_direct_media_entries(_get_media_info(url), option, title)
        else:
            tmp_dir, file_path, filename = _download_with_ytdlp(url, option, title)
        return _send_temp_file(tmp_dir, file_path, filename)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api.route("/api/extract-frames", methods=["POST"])
def extract_frames():
    tmp_dir = None
    try:
        url, option, title = _resolve_request_option()
        if not url:
            return jsonify({"error": "No URL provided."}), 400
        if not option:
            return jsonify({"error": "No media option provided."}), 400
        if option.get("kind") != "video":
            return jsonify({"error": "Frame extraction requires a video option."}), 400

        target_format = request.form.get("target_format", "jpg").strip().lower()
        if target_format not in FRAME_IMAGE_FORMATS:
            target_format = "jpg"

        timestamps_raw = request.form.get("timestamps", "").strip()
        if not timestamps_raw:
            return jsonify({"error": "No timestamps provided."}), 400
        try:
            timestamps = [float(t.strip()) for t in timestamps_raw.split(",") if t.strip()]
        except ValueError:
            return jsonify({"error": "Invalid timestamps format."}), 400
        if not timestamps:
            return jsonify({"error": "No valid timestamps provided."}), 400
        if len(timestamps) > 50:
            return jsonify({"error": "Maximum 50 timestamps allowed."}), 400

        platform = _guess_platform(url)
        if platform == "vsco" or option.get("id") in DIRECT_DOWNLOAD_OPTION_IDS:
            tmp_dir, video_paths = _download_direct_video_files(_get_media_info(url))
            video_path = video_paths[0] if video_paths else None
        else:
            tmp_dir, video_path, _filename = _download_with_ytdlp(url, option, title)
            if os.path.splitext(video_path)[1].lower() == ".zip":
                raise ValueError("Frame extraction requires a single video download option.")

        if not video_path:
            raise ValueError("Could not download video for frame extraction.")

        output_path, output_name = _extract_frames_at_timestamps(
            video_path,
            timestamps=timestamps,
            target_format=target_format,
            tmp_dir=tmp_dir,
        )
        download_name = _build_download_filename(title, "frames", output_name.rsplit(".", 1)[-1])
        return _send_temp_file(tmp_dir, output_path, download_name)
    except ValueError as e:
        if tmp_dir:
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if tmp_dir:
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/clip-video", methods=["POST"])
def clip_video():
    tmp_dir = None
    try:
        url, option, title = _resolve_request_option()
        if not url:
            return jsonify({"error": "No URL provided."}), 400
        if not option:
            return jsonify({"error": "No media option provided."}), 400
        if option.get("kind") != "video":
            return jsonify({"error": "Video clipping requires a video option."}), 400

        try:
            start_time = float(request.form.get("start_time", "").strip())
            end_time = float(request.form.get("end_time", "").strip())
        except ValueError:
            return jsonify({"error": "Clip times must be valid numbers."}), 400

        platform = _guess_platform(url)
        if platform == "vsco" or option.get("id") in DIRECT_DOWNLOAD_OPTION_IDS:
            tmp_dir, video_paths = _download_direct_video_files(_get_media_info(url))
            video_path = video_paths[0] if video_paths else None
        else:
            tmp_dir, video_path, _filename = _download_with_ytdlp(url, option, title)
            if os.path.splitext(video_path)[1].lower() == ".zip":
                raise ValueError("Video clipping requires a single video download option.")

        if not video_path:
            raise ValueError("Could not download video for clipping.")

        output_path, output_name = _clip_video_segment(
            video_path,
            start_time=start_time,
            end_time=end_time,
            tmp_dir=tmp_dir,
        )
        download_name = _build_download_filename(title, "clip", output_name.rsplit(".", 1)[-1])
        return _send_temp_file(tmp_dir, output_path, download_name)
    except ValueError as e:
        if tmp_dir:
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if tmp_dir:
            _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/tools/images-to-pdf", methods=["POST"])
def tools_images_to_pdf():
    tmp_dir = tempfile.mkdtemp()
    try:
        uploads = _save_uploads(request.files.getlist("files"), IMAGE_EXTENSIONS, tmp_dir, "image")
        ordered = _parse_ordered_uploads(uploads, request.form.get("order", ""))
        pdf_path = os.path.join(tmp_dir, "images.pdf")
        _images_to_pdf(ordered, pdf_path)
        return _send_temp_file(tmp_dir, pdf_path, "images.pdf")
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/tools/image-convert", methods=["POST"])
def tools_image_convert():
    tmp_dir = tempfile.mkdtemp()
    try:
        target_format = request.form.get("target_format", "").strip().lower()
        if target_format not in CONVERTIBLE_IMAGE_FORMATS:
            raise ValueError("Target format must be jpg, png, or webp.")
        uploads = _save_uploads(request.files.getlist("files"), IMAGE_EXTENSIONS, tmp_dir, "image")

        output_paths = []
        for item in uploads:
            base = os.path.splitext(item["filename"])[0]
            out_name = f"{base}.{target_format}"
            out_path = os.path.join(tmp_dir, out_name)
            _convert_image_file(item["path"], target_format, out_path)
            output_paths.append(out_path)

        if len(output_paths) == 1:
            return _send_temp_file(tmp_dir, output_paths[0], os.path.basename(output_paths[0]))

        archive_path = os.path.join(tmp_dir, "converted-images.zip")
        _zip_files(output_paths, archive_path)
        return _send_temp_file(tmp_dir, archive_path, "converted-images.zip")
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/tools/pdf-to-images", methods=["POST"])
def tools_pdf_to_images():
    tmp_dir = tempfile.mkdtemp()
    try:
        upload = _save_single_upload("file", PDF_EXTENSIONS, tmp_dir, "document.pdf")
        target_format = request.form.get("target_format", "").strip().lower()
        mode = request.form.get("mode", "").strip().lower()
        page_value = request.form.get("page", "").strip()
        output_path, download_name = _pdf_to_images(upload["path"], target_format, mode, page_value, tmp_dir)
        return _send_temp_file(tmp_dir, output_path, download_name)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500


@api.route("/api/tools/compress-pdf", methods=["POST"])
def tools_compress_pdf():
    tmp_dir = tempfile.mkdtemp()
    try:
        upload = _save_single_upload("file", PDF_EXTENSIONS, tmp_dir, "document.pdf")
        preset = request.form.get("preset", "").strip().lower()
        output_path, download_name = _compress_pdf(upload["path"], preset, tmp_dir)
        return _send_temp_file(tmp_dir, output_path, download_name)
    except ValueError as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _cleanup_dir(tmp_dir)
        return jsonify({"error": str(e)}), 500
