# yt-summarize

Personal media and file-tool app for a Raspberry Pi host.

## Current Architecture

Everything runs on the Raspberry Pi:

- `yt-dlp` extracts media and handles downloads.
- `whisper.cpp` runs transcription on the Pi.
- Pillow, img2pdf, PyMuPDF, and Ghostscript power the image/PDF tools.
- The browser is only the UI.

## Features

- YouTube, Instagram, and TikTok downloads with selectable MP3 and MP4 quality options.
- VSCO public-page image and video download support.
- Server-side transcript generation with plain and timestamped output.
- Image-to-PDF conversion with manual upload ordering.
- Image format conversion for `jpg/jpeg`, `png`, and `webp`.
- PDF page export to `png` or `jpg`, either one page or all pages.
- PDF compression with `smaller files` and `higher quality` presets.

## Dependencies

- Python 3.10+
- `ffmpeg`
- `ghostscript`
- `yt-dlp` via `pip`
- `whisper.cpp` installed on the Pi with a downloaded model

## App Setup

```bash
sudo apt update
sudo apt install -y python3 python3-venv ffmpeg ghostscript git cmake build-essential
cd /home/strifedeeno/yt-summarize
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## whisper.cpp Setup

Official whisper.cpp docs state that the project supports Raspberry Pi, that `whisper-cli` can be built with CMake, and that it expects 16-bit WAV input; they also document model sizes from `tiny` through `large`, with `tiny` and `base` being the practical Pi choices. Sources: [whisper.cpp README](https://github.com/ggml-org/whisper.cpp), [Quick start section](https://github.com/ggml-org/whisper.cpp#quick-start).

Example setup:

```bash
cd /home/strifedeeno
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh base.en
```

## Run The App

Set the whisper.cpp binary and model path before starting:

```bash
cd /home/strifedeeno/yt-summarize
source .venv/bin/activate
export WHISPER_CPP_BIN=/home/strifedeeno/whisper.cpp/build/bin/whisper-cli
export WHISPER_CPP_MODEL=/home/strifedeeno/whisper.cpp/models/ggml-base.en.bin
export HOST=0.0.0.0
export PORT=5000
python app.py
```

Then open:

```text
http://<raspberry-pi-ip>:5000/
```

## Utility Tool Notes

- Accepted image uploads: `jpg`, `jpeg`, `png`, `webp`
- Accepted document uploads: `pdf`
- Multi-file image conversions download as a `.zip`
- PDF page export returns one image for single-page mode and a `.zip` for all-pages mode
- `Smaller files` compression is more aggressive and may reduce image quality
- `Higher quality` compression keeps more detail but may reduce file size less
- If Ghostscript is missing, the PDF compression endpoint returns a dependency error

## Systemd

Add these environment lines to your service:

```ini
Environment=WHISPER_CPP_BIN=/home/strifedeeno/whisper.cpp/build/bin/whisper-cli
Environment=WHISPER_CPP_MODEL=/home/strifedeeno/whisper.cpp/models/ggml-base.en.bin
```

## Notes

- `yt-dlp` site support can change over time, especially for Instagram, TikTok, and VSCO.
- Highest-quality downloads still depend on what the platform exposes for the specific media item.
- On a Pi, `base.en` is usually a better tradeoff than larger models for English-only transcription.
