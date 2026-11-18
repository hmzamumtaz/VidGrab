# YouTube Downloader & Viral Clips

Local web app to:
- Load a YouTube video from a URL
- Download the full video in available qualities (with size estimates)
- Auto-generate "viral" highlight clips from the video (heuristic audio+scene analysis, no AI) with per-clip quality/size and download buttons

## Requirements
- macOS with Python 3.9+
- Bundled `ffmpeg`/`ffprobe` binaries in `bin/` (x86_64)
- Python packages: `flask`, `yt-dlp` (see `requirements.txt`)

This project is configured for this machine with:
- `yt-dlp` at `~/Library/Python/3.9/bin/yt-dlp` (fallback to PATH)
- `ffmpeg`/`ffprobe` in `./bin`

## Run
```bash
cd /Users/nowy/youtube-downloader
python3 app.py
# or
./run.sh
```
Then open http://127.0.0.1:5050

## How it works
- **Metadata/qualities:** fetched via `yt-dlp -J` and parsed from available YouTube formats (resolution labels + estimated sizes).
- **Full download:** `yt-dlp` downloads/merges selected streams to MP4 and serves the file for download.
- **Viral clips (no AI):** downloads a source copy, computes audio energy (RMS) and scene-change density with `ffmpeg`, scores windows to pick highlight segments, then renders each clip as MP4 for download. Clip count/length adapts to video duration.

## Notes
- No external paid APIs or AI services are used.
- Clip generation and full downloads run locally and may take several minutes depending on video length/quality and network speed.
- Output files are saved in `downloads/` (temporary analysis source in `tmp/`).
- YouTube/platform changes can break extraction; update `yt-dlp` if needed: `python3 -m pip install --user -U yt-dlp`.
