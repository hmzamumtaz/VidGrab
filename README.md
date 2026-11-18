# VidGrab

VidGrab is a local YouTube downloader and viral clip generator built with Flask, `yt-dlp`, and `ffmpeg/ffprobe`.

- **No AI**
- **No paid or external APIs** (beyond fetching public YouTube pages/media via `yt-dlp`)
- Runs locally on your machine

## Features

- **Premium web UI** inspired by modern downloader tools (dark, responsive workspace)
- **Full video downloads** with quality options detected from available YouTube formats before download (e.g. 144p–4K/2160p, 1440p, 1080p, 720p when available)
- **Viral Clips Studio** for long videos:
  - analyzes the full source video locally using audio-energy and scene-change heuristics
  - generates **multiple** high-potential clip candidates (more clips for longer videos)
  - faster processing via concurrent fragment downloads, tuned analysis, and streamlined rendering
  - per-clip preview, duration/quality/size info
- **Automated copyright safety gating (best-effort, no AI/external databases):**
  - metadata-based pre-check (license/category/track/artist/album/title signals)
  - clip generation is blocked when potential copyright risk is detected
  - clip downloads are only enabled when the automated pre-check passes
  - **not legal advice and not a guarantee of copyright clearance**
- **Playback reliability:** downloads/clips are validated and remuxed/transcoded to compatible MP4 (H.264/AAC, `+faststart`) when needed
- **Job progress UI:** async jobs with live progress polling for downloads and clip generation

## Project structure

- `app.py` – Flask backend, job/progress system, yt-dlp/ffmpeg integration, quality detection, download/clip pipelines, heuristic analysis and safety checks
- `templates/index.html` – UI
- `static/app.js` – frontend logic
- `static/style.css` – styling
- `bin/` – bundled local binaries (macOS): `yt-dlp_macos`, `ffmpeg`, `ffprobe`
- `api/index.py`, `vercel.json` – Vercel serverless entry/routing (limited; see below)

## Requirements

- macOS/Linux with Python 3.9+ recommended
- `ffmpeg`/`ffprobe` available (bundled macOS binaries in `bin/` or system-installed)
- `yt-dlp` (bundled `bin/yt-dlp_macos` on macOS or system `yt-dlp`)
- Python deps: see `requirements.txt`

Install Python deps:

```bash
pip3 install -r requirements.txt
```

## Run locally

```bash
cd /Users/nowy/youtube-downloader
python3 app.py
```

Or use the included launch scripts:

```bash
./run.sh
# or double-click start.command on macOS
```

Then open: [http://127.0.0.1:5050](http://127.0.0.1:5050)

> Note: the first load/download can take 1–2 minutes while `yt-dlp` initializes on some systems.

## How it works

### Quality detection
VidGrab inspects available YouTube formats via `yt-dlp` metadata and builds selectable quality options (with compatibility-focused MP4 format selection and size estimates when available).

### Viral clip generation (heuristic, no AI)
1. Downloads a source copy for analysis (with retries/fallback formats)
2. Analyzes audio energy and scene changes locally
3. Scores and selects multiple diverse segments (count scales with video duration)
4. Renders clips to browser-friendly MP4

“Viral potential” is an estimate based on local heuristics (energy/scene dynamics), not a guarantee.

### Copyright safety gate (heuristic, no AI/external APIs)
- Runs automated metadata checks before clip generation/download
- Blocks clip generation/download when risk signals are detected (e.g. music/track metadata, restrictive/unknown license signals, official music indicators)
- Allows clip downloads only when pre-check passes
- **Important:** This cannot detect all copyrighted material and does **not** guarantee legal clearance. Only use content you have the rights to download, edit, and share.

## Vercel deployment (limited)

This repo includes `vercel.json` and `api/index.py` for serverless routing, but full functionality is **not reliable on Vercel** because:
- serverless execution time limits can interrupt `yt-dlp`/`ffmpeg` jobs
- filesystem is ephemeral (`/tmp`) and in-memory job state is not persistent across instances
- bundled binaries in `bin/` are macOS builds and will not run on Vercel’s Linux runtime
- `ffmpeg/ffprobe` may not be available in the runtime

For full download/clip processing, run locally or on a persistent server/VM with Python + ffmpeg.

## Legal

Only download or create clips from videos you own or have permission to use. You are responsible for complying with YouTube’s Terms of Service, copyright law, and applicable local regulations.
