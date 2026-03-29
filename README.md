# yt-summarize

Personal media tool for a Raspberry Pi host.

## Recommended Architecture

For the fastest setup on your hardware:

- Run the Flask app and `yt-dlp` on the Raspberry Pi.
- Open the UI from your main computer.
- Let Whisper run in your browser on that computer, not on the Pi.

That keeps the Pi focused on network fetches, file extraction, and downloads while your faster machine handles transcription.

## Current Behavior

- Transcription audio is fetched by the Pi and transcribed in your browser.
- Download options are fetched from the Pi before downloading.
- You can choose:
  - MP3 quality options
  - MP4 video quality options
  - Original image/media bundles where applicable
- VSCO support is handled with a best-effort direct-media extractor for public pages.

## Supported Targets

- YouTube
- Instagram
- TikTok
- VSCO public media pages

## Raspberry Pi Setup

```bash
sudo apt update
sudo apt install -y python3 python3-venv ffmpeg
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open the app from your computer at:

```text
http://<raspberry-pi-ip>:5000/
```

## Optional Environment Variables

```bash
HOST=0.0.0.0
PORT=5000
FLASK_DEBUG=0
FLASK_THREADED=1
```

## Notes

- `yt-dlp` site support can change over time, especially for Instagram, TikTok, and VSCO.
- Highest-quality downloads depend on what the source platform exposes for the specific post or video.
