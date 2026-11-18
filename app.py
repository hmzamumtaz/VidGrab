import json
import os
import re
import subprocess
import threading
import time
import uuid
import math
import shutil
import sys
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, request, render_template, send_file, abort

BASE_DIR = Path(__file__).resolve().parent
BIN_DIR = BASE_DIR / "bin"
IS_VERCEL = bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV") or os.environ.get("NOW_REGION"))

# Use writable storage on serverless/read-only environments
DATA_DIR = Path(os.environ.get("VIDGRAB_DATA_DIR", "/tmp/vidgrab" if IS_VERCEL or not os.access(str(BASE_DIR), os.W_OK) else str(BASE_DIR)))
DOWNLOADS_DIR = DATA_DIR / "downloads"
TMP_DIR = DATA_DIR / "tmp"
for d in (DOWNLOADS_DIR, TMP_DIR):
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        # last resort fallback
        pass


def _which(name):
    return shutil.which(name)


def _is_executable(p):
    return bool(p and os.path.isfile(p) and os.access(p, os.X_OK))


def _dequarantine(path):
    try:
        if path and os.path.exists(path):
            subprocess.run(["xattr", "-dr", "com.apple.quarantine", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def resolve_ffmpeg():
    for c in [str(BIN_DIR / "ffmpeg"), _which("ffmpeg")]:
        if _is_executable(c):
            _dequarantine(c)
            return c
    return str(BIN_DIR / "ffmpeg")


def resolve_ffprobe():
    for c in [str(BIN_DIR / "ffprobe"), _which("ffprobe")]:
        if _is_executable(c):
            _dequarantine(c)
            return c
    return str(BIN_DIR / "ffprobe")


def resolve_ytdlp():
    candidates = []
    # Prefer system/pip yt-dlp on Linux/serverless; prefer bundled mac binary on macOS
    if sys.platform == "darwin":
        candidates += [str(BIN_DIR / "yt-dlp_macos"), str(BIN_DIR / "yt-dlp")]
    candidates += [_which("yt-dlp")]
    if sys.platform != "darwin":
        candidates += [str(BIN_DIR / "yt-dlp_macos"), str(BIN_DIR / "yt-dlp")]
    candidates += [os.path.expanduser("~/Library/Python/3.9/bin/yt-dlp")]
    for c in candidates:
        if _is_executable(c):
            _dequarantine(c)
            return c
    # fallback to python module invocation path marker handled elsewhere? return best guess
    found = _which("yt-dlp")
    if found:
        return found
    return str(BIN_DIR / "yt-dlp_macos")


FFMPEG = resolve_ffmpeg()
FFPROBE = resolve_ffprobe()
YTDLP = resolve_ytdlp()

app = Flask(__name__)

YOUTUBE_RE = re.compile(r'(https?://)?(www\.)?(youtube\.com|youtu\.be)/.+', re.IGNORECASE)
COMMON_YTDLP_ARGS = ['--ignore-config', '--no-cache-dir', '--no-progress']


def ytdlp_auth_args():
    args = []
    cookies = os.environ.get('VIDGRAB_COOKIES') or os.environ.get('YTDLP_COOKIES')
    if not cookies:
        for p in [DATA_DIR / 'cookies.txt', BASE_DIR / 'cookies.txt']:
            try:
                if p.exists() and p.is_file():
                    cookies = str(p)
                    break
            except Exception:
                pass
    if cookies:
        try:
            if os.path.exists(str(cookies)):
                args += ['--cookies', str(cookies)]
        except Exception:
            pass
    cfb = os.environ.get('VIDGRAB_COOKIES_FROM_BROWSER') or os.environ.get('YTDLP_COOKIES_FROM_BROWSER')
    if cfb:
        args += ['--cookies-from-browser', str(cfb).strip()]
    jsr = os.environ.get('VIDGRAB_JS_RUNTIMES') or os.environ.get('YTDLP_JS_RUNTIMES')
    if jsr:
        args += ['--js-runtimes', str(jsr).strip()]
    return args


YTDLP_PLAYER_CLIENT_STRATEGIES = [
    [],
    ['--extractor-args', 'youtube:player_client=default,ios,android'],
    ['--extractor-args', 'youtube:player_client=web_embedded,ios,android'],
    ['--extractor-args', 'youtube:player_client=tv_embedded,mediaconnect'],
    ['--extractor-args', 'youtube:player_client=tv,ios'],
]


def is_youtube_bot_check_error(text):
    t = (text or '').lower()
    return ('sign in to confirm' in t and "not a bot" in t) or 'use --cookies-from-browser or --cookies' in t


def friendly_ytdlp_error(msg):
    msg = (msg or '').strip()
    if is_youtube_bot_check_error(msg):
        hint = (
            "YouTube requested sign-in/bot verification for this request. "
            "If this persists, export YouTube cookies to cookies.txt in the app folder "
            "or set VIDGRAB_COOKIES / VIDGRAB_COOKIES_FROM_BROWSER, then retry."
        )
        if msg:
            return f"{hint} Details: {msg}"[:900]
        return hint
    return msg

JOBS = {}
JOBS_LOCK = threading.Lock()


def now_ts():
    return time.time()


def create_job(job_type):
    job_id = uuid.uuid4().hex[:12]
    job = {
        'id': job_id,
        'type': job_type,
        'status': 'queued',
        'progress': 0,
        'phase': 'queued',
        'message': 'Queued...',
        'result': None,
        'error': None,
        'created_at': now_ts(),
        'updated_at': now_ts(),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    return job_id


def update_job(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(fields)
        job['updated_at'] = now_ts()


def get_job(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        return dict(job)


def cleanup_old_jobs(max_age=7200):
    cutoff = now_ts() - max_age
    with JOBS_LOCK:
        old = [jid for jid, j in JOBS.items() if j.get('created_at', 0) < cutoff]
        for jid in old:
            JOBS.pop(jid, None)


def run_cmd(cmd, timeout=None):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout or '', p.stderr or '', None
    except subprocess.TimeoutExpired:
        return 124, '', '', f'Command timed out after {timeout}s'
    except Exception as e:
        return 1, '', str(e), str(e)


def fmt_bytes(n):
    if n is None:
        return None
    try:
        n = float(n)
    except Exception:
        return None
    if n <= 0:
        return None
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if n < 1024:
            if unit == 'B':
                return f"{int(n)} {unit}"
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def fmt_duration(sec):
    if sec is None:
        return "--:--"
    try:
        sec = int(round(float(sec)))
    except Exception:
        return "--:--"
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def quality_label(height):
    if not height:
        return "Best Available"
    try:
        h = int(height)
    except Exception:
        return "Best Available"
    if h >= 2160:
        return f"4K ({h}p)"
    if h >= 1440:
        return "1440p"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    if h >= 360:
        return "360p"
    return f"{h}p"


def _extract_error(err, out, extra=None):
    parts = []
    if extra:
        parts.append(str(extra))
    msg = ((err or "") + "\n" + (out or "")).strip()
    if msg:
        lines = [l.strip() for l in msg.splitlines() if l.strip()]
        if lines:
            err_lines = [l for l in lines if l.lower().startswith('error')]
            chosen = err_lines[-1] if err_lines else lines[-1]
            chosen = re.sub(r'^ERROR:\s*', '', chosen, flags=re.IGNORECASE)
            parts.append(chosen)
    if not parts:
        return "Unknown error while processing video."
    return ' | '.join(parts)[:700]


def ytdlp_base_cmd():
    # Prefer executable binary/script
    if YTDLP and os.path.exists(YTDLP):
        try:
            if not os.access(YTDLP, os.X_OK):
                os.chmod(YTDLP, 0o755)
        except Exception:
            pass
        # if it's our mac binary but we're not on mac, try system/module
        if sys.platform != "darwin" and os.path.basename(YTDLP) == "yt-dlp_macos":
            alt = _which("yt-dlp")
            if alt:
                return [alt] + COMMON_YTDLP_ARGS
            return [sys.executable, "-m", "yt_dlp"] + COMMON_YTDLP_ARGS
        return [YTDLP] + COMMON_YTDLP_ARGS
    alt = _which("yt-dlp")
    if alt:
        return [alt] + COMMON_YTDLP_ARGS
    # fallback to module
    return [sys.executable, "-m", "yt_dlp"] + COMMON_YTDLP_ARGS


def get_video_info(url):
    base = ytdlp_base_cmd()
    auth = ytdlp_auth_args()
    last_err = None
    for strat in YTDLP_PLAYER_CLIENT_STRATEGIES:
        cmd = base + auth + strat + ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '30', url]
        code, out, err, timeout_msg = run_cmd(cmd, timeout=420)
        combined = (err or '') + '\n' + (out or '')
        if code == 0 and (out or '').strip():
            try:
                info = json.loads(out)
            except Exception:
                last_err = _extract_error(err, out, 'Failed to parse video info')
                if is_youtube_bot_check_error(combined) or is_youtube_bot_check_error(last_err):
                    continue
                continue
            if isinstance(info, dict):
                return info
            last_err = 'Unexpected video info response'
            continue
        last_err = _extract_error(err, out, timeout_msg) or 'Failed to fetch video info'
        # try next strategy/client on failures (esp. bot checks)
        continue
    raise RuntimeError(friendly_ytdlp_error(last_err) or 'Failed to fetch video info')


def build_quality_options(info):
    formats = info.get('formats') or []
    duration = info.get('duration') or 0
    heights = set()
    for f in formats:
        if f.get('vcodec') in (None, 'none'):
            continue
        h = f.get('height')
        if h:
            try:
                heights.add(int(h))
            except Exception:
                pass
    options = []
    for h in sorted(heights, reverse=True):
        v_candidates = [f for f in formats if f.get('vcodec') not in (None, 'none') and int(f.get('height') or 0) == h]
        a_candidates = [f for f in formats if f.get('acodec') not in (None, 'none') and f.get('vcodec') in (None, 'none')]

        def best_size(cands):
            best = None
            for f in cands:
                sz = f.get('filesize') or f.get('filesize_approx')
                if sz is None and f.get('tbr') and duration:
                    try:
                        sz = (float(f.get('tbr')) * 1000 / 8) * float(duration)
                    except Exception:
                        sz = None
                if sz is not None:
                    try:
                        sz = float(sz)
                    except Exception:
                        continue
                    if best is None or sz > best:
                        best = sz
            return best

        v_sz = best_size(v_candidates)
        a_sz = best_size(a_candidates)
        total = None
        if v_sz is not None and a_sz is not None:
            total = v_sz + a_sz
        elif v_sz is not None:
            total = v_sz
        prog = [f for f in formats if f.get('acodec') not in (None, 'none') and f.get('vcodec') not in (None, 'none') and int(f.get('height') or 0) == h]
        p_sz = best_size(prog)
        if p_sz and (total is None or (total and abs(p_sz - total) < total * 0.45)):
            total = p_sz
        # Prefer H.264/AAC MP4 for maximum compatibility, fallback to others
        fmt = (
            f"bv*[height={h}][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/"
            f"bv*[height={h}][ext=mp4]+ba[ext=m4a]/"
            f"b[height={h}][ext=mp4]/"
            f"bv*[height={h}][vcodec^=avc1]+ba[acodec^=mp4a]/"
            f"bv*[height={h}]+ba/"
            f"b[height={h}]/"
            f"bv*[height<={h}][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={h}]+ba/"
            f"b[height<={h}]/b"
        )
        # detect fps/ext hints
        fps_vals = [f.get('fps') for f in v_candidates if f.get('fps')]
        max_fps = None
        try:
            if fps_vals:
                max_fps = int(max(float(x) for x in fps_vals if x))
        except Exception:
            max_fps = None
        note_parts = ['MP4']
        if max_fps and max_fps > 30:
            note_parts.append(f'{max_fps}fps')
        options.append({
            'height': h,
            'label': quality_label(h),
            'ext': 'mp4',
            'size': total,
            'size_text': ("~" + fmt_bytes(total)) if fmt_bytes(total) else "Size unavailable",
            'format': fmt,
            'note': ' • '.join(note_parts),
            'source': 'YouTube'
        })
    if not options:
        options = [{
            'height': None,
            'label': 'Best Available',
            'ext': 'mp4',
            'size': None,
            'size_text': 'Size unavailable',
            'format': 'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
            'note': 'MP4',
            'source': 'YouTube'
        }]
    return options


def safe_filename(name):
    name = re.sub(r'[\\/:*?"<>|]+', '', str(name or ''))
    name = re.sub(r'[^\w\-. \(\)\[\]]+', '', name, flags=re.UNICODE).strip()
    name = re.sub(r'\s+', ' ', name).strip()
    return (name[:120] or 'video')


def ffprobe_json(path):
    cmd = [FFPROBE, '-v', 'error', '-show_entries', 'format=duration,size,format_name', '-show_streams', '-of', 'json', str(path)]
    code, out, err, _ = run_cmd(cmd, timeout=30)
    if code != 0:
        return None
    try:
        return json.loads(out or '{}')
    except Exception:
        return None


def media_stream_info(path):
    info = ffprobe_json(path)
    if not info:
        return None
    streams = info.get('streams') or []
    v = None
    a = None
    for s in streams:
        if s.get('codec_type') == 'video' and v is None:
            v = s
        if s.get('codec_type') == 'audio' and a is None:
            a = s
    return {'info': info, 'v': v, 'a': a, 'streams': streams}


def validate_media(path, require_video=True):
    if not path or not os.path.exists(path):
        return False, 'Output file not found'
    try:
        if os.path.getsize(path) < 1024:
            return False, 'Output file is too small'
    except Exception:
        pass
    m = media_stream_info(path)
    if not m or not m.get('streams'):
        return False, 'Could not read media streams'
    has_video = m.get('v') is not None
    has_audio = m.get('a') is not None
    if require_video and not has_video:
        return False, 'No video stream found'
    if not has_video and not has_audio:
        return False, 'No playable streams found'
    return True, m


def ensure_playable_mp4(path, job_id=None, base_progress=90):
    """Ensure output is a broadly playable MP4 (H.264/AAC + faststart). Returns (ok, final_path_or_error)."""
    p = Path(path)
    ok, m = validate_media(p, require_video=True)
    if not ok:
        return False, m
    v = m.get('v') or {}
    a = m.get('a') or {}
    vcodec = (v.get('codec_name') or '').lower()
    acodec = (a.get('codec_name') or '').lower() if a else ''
    is_h264 = vcodec in ('h264', 'avc1')
    is_aac_or_none = (not a) or acodec in ('aac', 'mp3')

    # If already compatible mp4, try faststart remux
    if is_h264 and is_aac_or_none and p.suffix.lower() == '.mp4':
        if job_id:
            update_job(job_id, status='running', phase='finalizing', progress=max(base_progress, 95), message='Optimizing MP4 for playback...')
        tmp = p.with_name(p.stem + '.faststart.tmp.mp4')
        cmd = [FFMPEG, '-y', '-v', 'error', '-i', str(p), '-map', '0', '-c', 'copy', '-movflags', '+faststart', str(tmp)]
        code, _, _, _ = run_cmd(cmd, timeout=1800)
        if code == 0 and tmp.exists() and validate_media(tmp, True)[0]:
            try:
                os.replace(tmp, p)
            except Exception:
                try:
                    shutil.move(str(tmp), str(p))
                except Exception:
                    pass
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        return True, str(p)

    # Transcode to compatible MP4
    if job_id:
        update_job(job_id, status='running', phase='finalizing', progress=max(base_progress, 96), message='Converting to compatible MP4...')
    final_target = p.with_suffix('.mp4') if p.suffix.lower() != '.mp4' else p.with_name(p.stem + '.compatible.mp4')
    if final_target == p:
        final_target = p.with_name(p.stem + '.compatible.mp4')
    cmd = [
        FFMPEG, '-y', '-v', 'error', '-i', str(p),
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart'
    ]
    if a:
        cmd += ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']
    else:
        cmd += ['-an']
    cmd += [str(final_target)]
    code, _, err, _ = run_cmd(cmd, timeout=3600)
    if code == 0 and final_target.exists() and validate_media(final_target, True)[0]:
        dest = p.with_suffix('.mp4')
        try:
            if dest.exists() and dest != final_target:
                dest.unlink()
        except Exception:
            pass
        try:
            if final_target != dest:
                shutil.move(str(final_target), str(dest))
            else:
                dest = final_target
        except Exception:
            dest = final_target
        if p.exists() and p != dest:
            try:
                p.unlink()
            except Exception:
                pass
        try:
            if final_target.exists() and final_target != dest:
                final_target.unlink()
        except Exception:
            pass
        return True, str(dest)
    try:
        if final_target.exists():
            final_target.unlink()
    except Exception:
        pass
    return False, err or 'Failed to create compatible MP4'


def find_produced_file(prefix, out_id):
    candidates = []
    try:
        for p in DOWNLOADS_DIR.iterdir():
            if not p.is_file():
                continue
            if p.name.startswith(prefix) or (out_id and out_id in p.name):
                candidates.append(p)
    except Exception:
        return None
    if not candidates:
        return None
    # prefer mp4 and newest
    candidates.sort(key=lambda p: (p.suffix.lower() == '.mp4', p.stat().st_mtime), reverse=True)
    return candidates[0]


@app.route('/')
def index():
    return render_template('index.html')


@app.get('/api/health')
def api_health():
    return jsonify({
        'ok': True,
        'yt_dlp': YTDLP,
        'yt_dlp_exists': os.path.exists(YTDLP),
        'ffmpeg': FFMPEG,
        'ffmpeg_exists': os.path.exists(FFMPEG),
        'ffprobe': FFPROBE,
        'ffprobe_exists': os.path.exists(FFPROBE),
    })


def assess_copyright_profile(info):
    """Best-effort automated copyright/risk screening from available metadata (no external APIs/AI).
    Returns dict with risk/allow_download/reasons. Not legal advice or a guarantee."""
    reasons = []
    risk = 'low'
    allow = True
    license_str = (info.get('license') or '').strip()
    track = (info.get('track') or '').strip()
    artist = (info.get('artist') or info.get('creator') or info.get('uploader') or '').strip()
    album = (info.get('album') or '').strip()
    categories = info.get('categories') or []
    if isinstance(categories, str):
        categories = [categories]
    categories_l = [str(c).lower() for c in categories]

    # Strong music/copyright signals
    if track:
        reasons.append(f'Detected track metadata: "{track}"')
        risk = 'high'
        allow = False
    if artist and (track or album or 'music' in categories_l):
        if f'Artist/creator metadata present ({artist})' not in reasons:
            reasons.append(f'Artist/creator metadata present ({artist})')
        risk = 'high'
        allow = False
    if album:
        reasons.append(f'Album metadata detected: "{album}"')
        risk = 'high'
        allow = False
    if 'music' in categories_l:
        reasons.append('Category indicates music content')
        risk = 'high'
        allow = False

    # License signals
    if license_str:
        lic_l = license_str.lower()
        if 'creative commons' in lic_l:
            reasons.append(f'License: {license_str}')
            # CC is safer but not a full guarantee (e.g. third-party elements) -> allow only if no music signals
            if allow:
                risk = 'low'
        else:
            reasons.append(f'License: {license_str}')
            if risk == 'low':
                risk = 'medium'
            # be strict for clip downloads to avoid copyright issues
            if not track and 'music' not in categories_l:
                # standard YouTube license / unknown - still potential claims
                risk = 'high'
                allow = False
    else:
        if risk == 'low':
            reasons.append('No explicit reuse license detected')
            risk = 'medium'
            allow = False

    # additional caution for very short/official-looking music uploads keywords
    title = (info.get('title') or '').lower()
    if any(k in title for k in ['official video', 'official audio', 'lyric video', 'music video', 'full album']):
        if 'Title suggests official/music release' not in reasons:
            reasons.append('Title suggests official/music release')
        risk = 'high'
        allow = False

    if allow and risk == 'low' and not reasons:
        reasons.append('No copyright-risk signals detected in available metadata')

    status = 'clear' if allow else 'blocked'
    return {
        'status': status,
        'risk': risk,
        'allow_clip_downloads': allow,
        'reasons': reasons[:6],
        'note': 'Automated pre-check based on available metadata only; not a legal guarantee of copyright clearance.'
    }



# Simple in-memory cache to avoid repeated expensive yt-dlp metadata fetches
_INFO_CACHE = {}
_INFO_CACHE_LOCK = threading.Lock()
_INFO_CACHE_TTL = 600


def get_cached_video_info(url):
    now = time.time()
    key = url.strip()
    with _INFO_CACHE_LOCK:
        item = _INFO_CACHE.get(key)
        if item and now - item.get('ts', 0) < _INFO_CACHE_TTL:
            return item.get('info')
    info = get_video_info(url)
    with _INFO_CACHE_LOCK:
        _INFO_CACHE[key] = {'ts': now, 'info': info}
        # prune
        if len(_INFO_CACHE) > 40:
            old = sorted(_INFO_CACHE.items(), key=lambda kv: kv[1].get('ts', 0))[:10]
            for k, _ in old:
                _INFO_CACHE.pop(k, None)
    return info


@app.post('/api/info')
def api_info():
    cleanup_old_jobs()
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get('url') or '').strip()
    if not url or not YOUTUBE_RE.search(url):
        return jsonify({'error': 'Please provide a valid YouTube URL.'}), 400
    try:
        info = get_cached_video_info(url)
        qualities = build_quality_options(info)
        copyright_profile = assess_copyright_profile(info)
        return jsonify({
            'title': info.get('title') or 'Untitled video',
            'thumbnail': info.get('thumbnail'),
            'duration': info.get('duration'),
            'duration_text': fmt_duration(info.get('duration')),
            'uploader': info.get('uploader') or info.get('channel') or 'Unknown channel',
            'webpage_url': info.get('webpage_url') or url,
            'qualities': qualities,
            'quality_source': 'Fetched from available YouTube formats',
            'copyright': copyright_profile,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.get('/api/job/<job_id>')
def api_job(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify(job)


def _run_download_job(job_id, url, fmt, label, title_in):
    try:
        update_job(job_id, status='running', phase='starting', progress=1, message='Starting download...')
        title = safe_filename(title_in) if title_in else 'video'
        safe_label = safe_filename(label).replace(' ', '-')
        out_id = uuid.uuid4().hex[:10]
        prefix = f"{title}-{safe_label}-{out_id}"
        outtmpl = str(DOWNLOADS_DIR / f"{prefix}.%(ext)s")
        base = ytdlp_base_cmd()
        auth = ytdlp_auth_args()

        # build format fallbacks
        fmt_candidates = []
        for f in [fmt, 'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', 'b[ext=mp4]/b', 'bv*+ba/best', 'best']:
            if f and f not in fmt_candidates:
                fmt_candidates.append(f)

        last_lines = []
        produced = None
        last_ret = 1
        for sidx, strat in enumerate(YTDLP_PLAYER_CLIENT_STRATEGIES):
            if produced:
                break
            if sidx > 0:
                update_job(job_id, status='running', phase='starting', progress=max(2, min(18, 4 + sidx * 3)), message='Retrying with alternate YouTube client...')
            for attempt, use_fmt in enumerate(fmt_candidates, 1):
                if attempt > 1:
                    update_job(job_id, status='running', phase='starting', progress=max(2, min(20, attempt * 5)), message=f'Retrying with alternate format ({attempt}/{len(fmt_candidates)})...')
                cmd = base + auth + strat + [
                    '--ffmpeg-location', str(BIN_DIR),
                    '--newline',
                    '--no-warnings', '--no-playlist',
                    '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30',
                    '-N', '4', '--concurrent-fragments', '4',
                    '-f', use_fmt,
                    '-o', outtmpl,
                    '--merge-output-format', 'mp4',
                    '--no-keep-video',
                    url
                ]
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True)
                last_pct = 1
                if proc.stdout:
                    for line in proc.stdout:
                        line = (line or '').strip()
                        if not line:
                            continue
                        last_lines.append(line)
                        if len(last_lines) > 120:
                            last_lines = last_lines[-120:]
                        m = re.search(r'\[download\]\s+(\d+(?:\.\d+)?)%', line)
                        if m:
                            try:
                                pct = float(m.group(1))
                            except Exception:
                                pct = 0.0
                            mapped = int(2 + pct * 0.86)  # 2..88
                            if mapped < last_pct:
                                mapped = last_pct
                            last_pct = min(88, mapped)
                            msg = f"Downloading... {pct:.1f}%"
                            speed_m = re.search(r'at\s+([^\s]+/s)', line)
                            eta_m = re.search(r'ETA\s+([^\s]+)', line)
                            extras = []
                            if speed_m:
                                extras.append(speed_m.group(1))
                            if eta_m and eta_m.group(1) != 'Unknown':
                                extras.append(f"ETA {eta_m.group(1)}")
                            if extras:
                                msg += ' • ' + ' • '.join(extras)
                            update_job(job_id, status='running', phase='downloading', progress=last_pct, message=msg)
                            continue
                        if '[Merger]' in line or 'Merging formats into' in line:
                            update_job(job_id, status='running', phase='merging', progress=max(last_pct, 90), message='Merging video and audio...')
                            continue
                        if 'Fixup' in line or 'correcting' in line.lower():
                            update_job(job_id, status='running', phase='finalizing', progress=92, message='Finalizing media...')
                            continue
                        if 'Destination:' in line:
                            update_job(job_id, status='running', phase='starting', progress=max(last_pct, 2), message='Preparing download...')
                            continue
                try:
                    last_ret = proc.wait(timeout=3600)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    last_ret = 1

                produced = find_produced_file(prefix, out_id)
                if not produced:
                    # fallback search by out_id
                    cands = [p for p in DOWNLOADS_DIR.iterdir() if p.is_file() and out_id in p.name]
                    if cands:
                        cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        produced = cands[0]
                if produced and produced.exists():
                    ok, _ = validate_media(produced, require_video=True)
                    if ok or os.path.getsize(produced) > 2048:
                        break
                produced = None
                # try next format if likely format/availability error
                tail = '\n'.join(last_lines[-10:]).lower()
                if 'requested format is not available' in tail or 'format is not available' in tail or 'no video formats' in tail or last_ret != 0:
                    continue
                if last_ret == 0:
                    break

        if not produced or not produced.exists():
            tail = '\n'.join(last_lines[-20:])
            raise RuntimeError(friendly_ytdlp_error(_extract_error(tail, '', 'Download completed but output file not found' if last_ret == 0 else None)) or 'Download failed')

        ok, info_or_err = validate_media(produced, require_video=True)
        if not ok:
            update_job(job_id, status='running', phase='finalizing', progress=94, message='Repairing downloaded file...')
            fixed_ok, _ = ensure_playable_mp4(str(produced), job_id=job_id, base_progress=95)
            mp4_candidate = produced.with_suffix('.mp4')
            if mp4_candidate.exists():
                produced = mp4_candidate
            ok, info_or_err = validate_media(produced, require_video=True)
            if not ok or not fixed_ok:
                try:
                    if produced.exists():
                        produced.unlink()
                except Exception:
                    pass
                raise RuntimeError('Downloaded file could not be converted to a playable MP4.')
        else:
            ensure_playable_mp4(str(produced), job_id=job_id, base_progress=93)
            mp4_candidate = produced.with_suffix('.mp4')
            if mp4_candidate.exists():
                produced = mp4_candidate
            elif produced.suffix.lower() != '.mp4':
                newp = produced.with_suffix('.mp4')
                try:
                    if not newp.exists():
                        os.replace(produced, newp)
                        produced = newp
                except Exception:
                    pass

        # final ensure mp4 extension for browser/player friendliness
        if produced.suffix.lower() != '.mp4':
            newp = produced.with_suffix('.mp4')
            try:
                if not newp.exists():
                    shutil.move(str(produced), str(newp))
                    produced = newp
            except Exception:
                pass

        size = produced.stat().st_size
        result = {
            'filename': produced.name,
            'size': size,
            'size_text': fmt_bytes(size),
            'download_url': f"/api/file/{quote(produced.name)}"
        }
        update_job(job_id, status='done', phase='done', progress=100, message='Download ready', result=result)
    except Exception as e:
        update_job(job_id, status='error', phase='error', progress=100, message='Download failed', error=str(e))


@app.post('/api/download/start')
def api_download_start():
    cleanup_old_jobs()
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get('url') or '').strip()
    fmt = (data.get('format') or '').strip() or 'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b'
    label = (data.get('label') or 'video').strip()
    title = (data.get('title') or '').strip()
    if not url or not YOUTUBE_RE.search(url):
        return jsonify({'error': 'Please provide a valid YouTube URL.'}), 400
    job_id = create_job('download')
    t = threading.Thread(target=_run_download_job, args=(job_id, url, fmt, label, title), daemon=True)
    t.start()
    return jsonify({'job_id': job_id})


# --- Clips ---

def probe_duration(path):
    info = ffprobe_json(path)
    try:
        if info:
            d = ((info.get('format') or {}).get('duration'))
            if d is not None:
                return float(d)
    except Exception:
        pass
    return None


def probe_resolution_and_audio(path):
    m = media_stream_info(path) or {}
    v = m.get('v') or {}
    a = m.get('a')
    w = int(v.get('width') or 0)
    h = int(v.get('height') or 0)
    return w, h, bool(a)


def analyze_audio_energy(path, window=1.0):
    cmd = [FFMPEG, '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
    except Exception:
        return [], window
    data = p.stdout or b''
    if not data:
        return [], window
    import array
    samples = array.array('f')
    try:
        samples.frombytes(data)
    except Exception:
        return [], window
    sr = 8000
    win_samples = max(1, int(sr * window))
    energies = []
    for i in range(0, len(samples), win_samples):
        chunk = samples[i:i+win_samples]
        if not chunk:
            break
        ssum = 0.0
        for v in chunk:
            ssum += v * v
        rms = math.sqrt(ssum / len(chunk)) if chunk else 0.0
        energies.append(rms)
    return energies, window


def analyze_scene_changes(path):
    # Downscale for faster scene analysis while keeping timing accurate
    vf = "scale=-2:360,select='gt(scene,0.32)',showinfo"
    cmd = [FFMPEG, '-hide_banner', '-i', str(path), '-an', '-sn', '-dn', '-filter:v', vf, '-f', 'null', '-']
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1800)
    except Exception:
        return []
    times = []
    for line in (p.stderr or '').splitlines():
        if 'showinfo' in line and 'pts_time:' in line:
            m = re.search(r'pts_time:([0-9.]+)', line)
            if m:
                try:
                    times.append(float(m.group(1)))
                except Exception:
                    pass
    return sorted(times)


def choose_segments(source_path, job_id):
    duration = probe_duration(source_path) or 0
    if duration <= 0:
        raise RuntimeError('Could not determine video duration')
    if duration < 20:
        return [(0.0, float(duration))], duration
    window = 1.0
    update_job(job_id, status='running', phase='analyzing_audio', progress=46, message='Analyzing audio energy...')
    energies, w = analyze_audio_energy(source_path, window=window)
    update_job(job_id, status='running', phase='analyzing_scenes', progress=60, message='Detecting scene changes...')
    scenes = analyze_scene_changes(source_path)
    n = len(energies)
    if n == 0:
        n = max(1, int(duration))
        energies = [0.0] * n
    smooth = [0.0] * n
    k = 2
    for i in range(n):
        a = max(0, i - k)
        b = min(n, i + k + 1)
        smooth[i] = sum(energies[a:b]) / (b - a)
    max_e = max(smooth) or 1.0
    scene_density = [0.0] * n
    for t in scenes:
        idx = int(t / w)
        for j in range(max(0, idx - 3), min(n, idx + 4)):
            scene_density[j] += 1.0
    max_s = max(scene_density) or 1.0
    combined = [(smooth[i] / max_e) * 0.7 + (scene_density[i] / max_s) * 0.3 for i in range(n)]
    if duration <= 45:
        clip_len = max(12, min(20, int(duration * 0.6)))
        count = 2
    elif duration <= 120:
        clip_len = max(18, min(30, int(duration * 0.35)))
        count = 3
    elif duration <= 300:
        clip_len = 28
        count = 4
    elif duration <= 600:
        clip_len = 30
        count = 5
    elif duration <= 1200:
        clip_len = 32
        count = 6
    elif duration <= 2400:
        clip_len = 35
        count = 8
    else:
        clip_len = 40
        count = 10
    clip_len = min(clip_len, max(12, int(duration) - 1))
    win_bins = max(5, int(clip_len / w))
    candidates = []
    limit = max(1, n - win_bins + 1)
    stride = 1
    if duration > 1800:
        stride = 2
    if duration > 3600:
        stride = 3
    for i in range(0, limit, stride):
        seg = combined[i:i + win_bins]
        if not seg:
            continue
        score = sum(seg) / len(seg)
        center = (i + win_bins / 2) / max(1, n)
        # slight preference for middle but keep diversity
        score += 0.03 * (1 - abs(center - 0.5) * 2)
        candidates.append((score, i * w, min(duration, (i + win_bins) * w)))
    candidates.sort(reverse=True)
    segments = []
    min_gap = 2.0
    for score, s, e in candidates:
        if len(segments) >= count:
            break
        best_s = float(s)
        for t in scenes:
            if abs(t - s) < 3.0:
                best_s = float(t)
                break
        best_s = max(0.0, best_s)
        best_e = best_s + (e - s)
        if best_e > duration:
            best_e = float(duration)
            best_s = max(0.0, best_e - (e - s))
        ok = True
        for os_, oe_ in segments:
            if not (best_e + min_gap <= os_ or oe_ + min_gap <= best_s):
                ok = False
                break
        if ok and (best_e - best_s) >= 10:
            segments.append((best_s, best_e))
    segments.sort()
    if not segments:
        step = max(15, clip_len)
        t = 0.0
        while t < duration and len(segments) < count:
            e = min(float(duration), t + step)
            if e - t >= 10:
                segments.append((t, e))
            t = e + 1.0
    return segments, duration


def generate_clips_for_video(source_path, job_id):
    segments, duration = choose_segments(source_path, job_id)
    update_job(job_id, status='running', phase='rendering', progress=78, message=f'Rendering {len(segments)} clip(s)...')
    clips = []
    w0, h0, has_audio = probe_resolution_and_audio(source_path)
    qlabel = quality_label(h0) if h0 else 'Source'
    total = max(1, len(segments))
    for idx, (s, e) in enumerate(segments, 1):
        out_name = f"clip-{idx}-{job_id}.mp4"
        out_path = DOWNLOADS_DIR / out_name
        dur = max(1.0, float(e) - float(s))
        pct = 78 + int((idx - 1) / total * 20)
        update_job(job_id, status='running', phase='rendering', progress=pct, message=f'Rendering clip {idx} of {total}...')
        cmd = [
            FFMPEG, '-y', '-v', 'error',
            '-ss', f"{max(0.0, float(s)):.3f}",
            '-i', str(source_path),
            '-t', f"{dur:.3f}",
            '-map', '0:v:0', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
        ]
        if has_audio:
            cmd += ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']
        else:
            cmd += ['-an']
        cmd += [str(out_path)]
        try:
            code, out, err, _ = run_cmd(cmd, timeout=1800)
        except Exception:
            continue
        ok, _ = validate_media(out_path, require_video=True)
        if code != 0 or not out_path.exists() or not ok:
            try:
                if out_path.exists():
                    out_path.unlink()
            except Exception:
                pass
            continue
        size = out_path.stat().st_size
        clips.append({
            'index': idx,
            'start': s,
            'end': e,
            'start_text': fmt_duration(s),
            'end_text': fmt_duration(e),
            'duration': e - s,
            'duration_text': fmt_duration(e - s),
            'quality': qlabel,
            'height': h0,
            'size': size,
            'size_text': fmt_bytes(size),
            'filename': out_name,
            'download_url': f"/api/file/{quote(out_name)}"
        })
    return clips


def _run_clips_job(job_id, url, title_in):
    src_path = None
    try:
        update_job(job_id, status='running', phase='starting', progress=1, message='Starting clip generation...')
        title = safe_filename(title_in) if title_in else 'video'
        src_path = TMP_DIR / f"source-{job_id}.mp4"
        base = ytdlp_base_cmd()
        auth = ytdlp_auth_args()

        fmt_candidates = [
            'bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b',
            'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b',
            'bv*+ba/b/best',
            'best',
        ]
        last_lines = []
        got = False
        for sidx, strat in enumerate(YTDLP_PLAYER_CLIENT_STRATEGIES):
            if got:
                break
            if sidx > 0:
                update_job(job_id, status='running', phase='starting', progress=max(2, min(18, 4 + sidx * 3)), message='Retrying with alternate YouTube client...')
            for attempt, use_fmt in enumerate(fmt_candidates, 1):
                if attempt > 1:
                    update_job(job_id, status='running', phase='starting', progress=max(2, attempt * 4), message=f'Retrying source download ({attempt}/{len(fmt_candidates)})...')
                cmd = base + auth + strat + [
                    '--ffmpeg-location', str(BIN_DIR),
                    '--newline',
                    '--no-warnings', '--no-playlist',
                    '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30',
                    '-N', '4', '--concurrent-fragments', '4',
                    '-f', use_fmt,
                    '-o', str(src_path),
                    '--merge-output-format', 'mp4',
                    '--no-keep-video',
                    url
                ]
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True)
                last_pct = 1
                if proc.stdout:
                    for line in proc.stdout:
                        line = (line or '').strip()
                        if not line:
                            continue
                        last_lines.append(line)
                        if len(last_lines) > 100:
                            last_lines = last_lines[-100:]
                        m = re.search(r'\[download\]\s+(\d+(?:\.\d+)?)%', line)
                        if m:
                            try:
                                pct = float(m.group(1))
                            except Exception:
                                pct = 0.0
                            mapped = int(2 + pct * 0.40)
                            if mapped < last_pct:
                                mapped = last_pct
                            last_pct = min(42, mapped)
                            update_job(job_id, status='running', phase='downloading_source', progress=last_pct, message=f'Downloading source for analysis... {pct:.1f}%')
                            continue
                        if '[Merger]' in line or 'Merging formats into' in line:
                            update_job(job_id, status='running', phase='downloading_source', progress=44, message='Preparing source video...')
                try:
                    ret = proc.wait(timeout=3600)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    ret = 1

                actual = src_path if src_path.exists() else None
                if not actual:
                    candidates = sorted(list(TMP_DIR.glob(f"source-{job_id}.*")), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
                    if candidates:
                        actual = candidates[0]
                        src_path = actual
                if actual and actual.exists():
                    ok, _ = validate_media(actual, require_video=True)
                    if ok or os.path.getsize(actual) > 4096:
                        src_path = actual
                        got = True
                        break
                got = False

        if not got or not src_path or not src_path.exists():
            tail = '\n'.join(last_lines[-15:])
            raise RuntimeError(friendly_ytdlp_error(_extract_error(tail, '', 'Failed to download source video for analysis')) or 'Failed to download source video for analysis')

        ok, info_or_err = validate_media(src_path, require_video=True)
        if not ok:
            fix_ok, _ = ensure_playable_mp4(str(src_path), job_id=job_id, base_progress=44)
            if fix_ok:
                mp4_candidate = Path(src_path).with_suffix('.mp4')
                if mp4_candidate.exists():
                    src_path = mp4_candidate
            ok, _ = validate_media(src_path, require_video=True)
            if not ok:
                raise RuntimeError(f'Source video is not playable: {info_or_err}')

        # We only reach here if pre-check allowed; still mark explicitly
        cp = {}
        try:
            cp = assess_copyright_profile(get_cached_video_info(url))
        except Exception:
            cp = {'allow_clip_downloads': False, 'risk': 'high', 'status': 'blocked', 'reasons': ['Safety verification unavailable'], 'note': 'Automated pre-check unavailable.'}
        clips = generate_clips_for_video(src_path, job_id)
        if not clips:
            raise RuntimeError('Could not generate clips from this video.')
        allow = bool(cp.get('allow_clip_downloads'))
        for c in clips:
            c['download_allowed'] = allow
            c['copyright_status'] = 'cleared' if allow else 'blocked'
            c['copyright_note'] = 'Passed automated pre-download safety check' if allow else 'Blocked by automated copyright safety check'
        result = {'title': title, 'clips': clips, 'count': len(clips), 'copyright': cp}
        msg = f'Generated {len(clips)} clip(s)'
        if not allow:
            msg += ' (downloads blocked by safety check)'
        update_job(job_id, status='done', phase='done', progress=100, message=msg, result=result)
    except Exception as e:
        update_job(job_id, status='error', phase='error', progress=100, message='Clip generation failed', error=str(e))
    finally:
        try:
            if src_path and Path(src_path).exists():
                Path(src_path).unlink()
        except Exception:
            pass
        # cleanup any stray temp files for this job
        try:
            for p in TMP_DIR.glob(f"source-{job_id}*"):
                if p.exists():
                    p.unlink()
        except Exception:
            pass


@app.post('/api/clips/start')
def api_clips_start():
    cleanup_old_jobs()
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get('url') or '').strip()
    title = (data.get('title') or '').strip()
    if not url or not YOUTUBE_RE.search(url):
        return jsonify({'error': 'Please provide a valid YouTube URL.'}), 400
    # Best-effort copyright pre-check (metadata-based, no external APIs). Block clip generation/download flow if risk detected.
    try:
        info = get_cached_video_info(url)
        cp = assess_copyright_profile(info)
        if not cp.get('allow_clip_downloads'):
            return jsonify({'error': 'Copyright safety check blocked clip generation for this video (potential copyrighted content detected).', 'copyright': cp}), 403
    except Exception:
        # If we cannot verify, be strict to avoid potential copyright issues
        return jsonify({'error': 'Copyright safety check could not be completed. Clip generation is blocked to avoid potential copyright issues.'}), 403
    job_id = create_job('clips')
    t = threading.Thread(target=_run_clips_job, args=(job_id, url, title), daemon=True)
    t.start()
    return jsonify({'job_id': job_id})


@app.get('/api/file/<path:filename>')
def api_file(filename):
    safe_name = os.path.basename(filename)
    path = (DOWNLOADS_DIR / safe_name).resolve()
    dl_root = DOWNLOADS_DIR.resolve()
    try:
        path.relative_to(dl_root)
    except Exception:
        abort(404)
    if not path.exists() or not path.is_file():
        abort(404)
    return send_file(path, as_attachment=True, download_name=path.name, conditional=True)


if __name__ == '__main__':
    try:
        import logging
        logging.getLogger('werkzeug').setLevel(logging.ERROR)
    except Exception:
        pass
    host = '127.0.0.1'
    port = int(os.environ.get('PORT', '5050'))
    print(f"\nYouTube Downloader is running at: http://{host}:{port}")
    print("Open the URL above in your browser.")
    print(f"yt-dlp: {YTDLP}")
    print(f"ffmpeg: {FFMPEG}")
    print("Note: the first load/download can take 1-2 minutes while the downloader initializes.\n")
    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)
