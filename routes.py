import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile

import yt_dlp
from flask import Blueprint, jsonify, request, send_file
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
        else:
            raise ValueError("Mode must be single or all.")

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
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "extract_flat": False,
        "http_headers": {"User-Agent": DEFAULT_UA},
    }


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


def _entry_ext(entry: dict) -> str:
    url = entry.get("url", "")
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    if "." in path:
        return path.rsplit(".", 1)[-1]
    return (entry.get("ext") or "").lower()


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
    entries = info.get("entries") or []
    has_gallery = bool(entries)

    options = []
    if platform != "vsco":
        options.extend(_build_audio_options())
        if info.get("formats"):
            options.extend(_build_video_options(info))

    if platform == "vsco":
        image_count = sum(1 for entry in entries if entry.get("media_type") == "image")
        video_count = sum(1 for entry in entries if entry.get("media_type") == "video")
        if image_count:
            options.append(
                {
                    "id": "vsco-images-original",
                    "kind": "image",
                    "container": "zip" if image_count > 1 else "jpg",
                    "label": "Original image" if image_count == 1 else f"Original images ({image_count})",
                }
            )
        if video_count:
            options.append(
                {
                    "id": "vsco-videos-original",
                    "kind": "video",
                    "container": "zip" if video_count > 1 else "mp4",
                    "label": "Original video" if video_count == 1 else f"Original videos ({video_count})",
                }
            )
    elif has_gallery:
        options.append(
            {
                "id": "post-original",
                "kind": "mixed",
                "container": "zip",
                "label": f"Original post media ({len(entries)})",
            }
        )

    return {
        "title": info.get("title") or "Media",
        "platform": platform,
        "is_gallery": has_gallery,
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


def _download_direct_file(url: str, destination: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_UA})
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


def _zip_files(files: list[str], archive_path: str) -> str:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in files:
            zf.write(file_path, arcname=os.path.basename(file_path))
    return archive_path


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
    entries = info["entries"]

    if option["kind"] == "image":
        entries = [entry for entry in entries if entry["media_type"] == "image"]
    elif option["kind"] == "video":
        entries = [entry for entry in entries if entry["media_type"] == "video"]

    if not entries:
        raise ValueError("No matching VSCO media found for that option.")

    tmp_dir = tempfile.mkdtemp()
    downloaded = []
    for idx, entry in enumerate(entries, start=1):
        ext = entry["ext"] or ("jpg" if entry["media_type"] == "image" else "mp4")
        dest = os.path.join(tmp_dir, f"{idx:02d}.{ext}")
        _download_direct_file(entry["url"], dest)
        downloaded.append(dest)

    if len(downloaded) == 1:
        ext = os.path.splitext(downloaded[0])[1].lstrip(".").lower()
        suffix = "image" if option["kind"] == "image" else "video"
        return tmp_dir, downloaded[0], _build_download_filename(title, suffix, ext)

    archive_path = os.path.join(tmp_dir, "vsco-media.zip")
    _zip_files(downloaded, archive_path)
    suffix = "images" if option["kind"] == "image" else "videos"
    return tmp_dir, archive_path, _build_download_filename(title, suffix, "zip")


def _send_temp_file(tmp_dir: str, path: str, download_name: str):
    response = send_file(path, as_attachment=True, download_name=download_name, conditional=True, etag=False)
    response.call_on_close(lambda: _cleanup_dir(tmp_dir))
    return response


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
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
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
    data = request.get_json() or {}
    url = data.get("url", "").strip()
    option = data.get("option") or {}
    title = data.get("title", "download")

    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not option:
        return jsonify({"error": "No download option provided."}), 400

    try:
        platform = _guess_platform(url)
        if platform == "vsco":
            tmp_dir, file_path, filename = _download_vsco_media(url, option, title)
        else:
            tmp_dir, file_path, filename = _download_with_ytdlp(url, option, title)
        return _send_temp_file(tmp_dir, file_path, filename)
    except Exception as e:
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
