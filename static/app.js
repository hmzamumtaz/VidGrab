const $ = (s) => document.querySelector(s);

const urlForm = $('#url-form');
const urlInput = $('#url-input');
const loadBtn = $('#load-btn');
const formError = $('#form-error');

const videoSection = $('#video-section');
const videoThumb = $('#video-thumb');
const thumbFallback = $('#thumb-fallback');
const videoTitle = $('#video-title');
const videoUploader = $('#video-uploader');
const videoDuration = $('#video-duration');
const videoLink = $('#video-link');

const tabFull = $('#tab-full');
const tabClips = $('#tab-clips');
const fullSection = $('#full-section');
const clipsSection = $('#clips-section');

const qualityList = $('#quality-list');

const generateClipsBtn = $('#generate-clips-btn');
const clipsIdle = $('#clips-idle');
const clipsProgress = $('#clips-progress');
const clipsProgressTitle = $('#clips-progress-title');
const clipsProgressSub = $('#clips-progress-sub');
const clipsProgressPct = $('#clips-progress-pct');
const clipsProgressBar = $('#clips-progress-bar');
const clipsError = $('#clips-error');
const clipsList = $('#clips-list');

const toast = $('#toast');

let current = { url: '', info: null };

function show(el) { el && el.classList.remove('hidden'); }
function hide(el) { el && el.classList.add('hidden'); }

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  show(toast);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => hide(toast), 4200);
}

function setFormError(msg) {
  if (!msg) { hide(formError); formError.textContent = ''; return; }
  formError.textContent = msg;
  show(formError);
}

function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  btn.classList.toggle('loading', !!loading);
  btn.disabled = !!loading;
  const lbl = btn.querySelector('.btn-label');
  if (lbl && label) lbl.textContent = label;
}

async function postJSON(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollJob(jobId, onUpdate, interval = 1000) {
  while (true) {
    const job = await getJSON(`/api/job/${jobId}`);
    if (onUpdate) onUpdate(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error || job.message || 'Job failed');
    await sleep(interval);
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderVideo(info) {
  if (info.thumbnail) {
    videoThumb.src = info.thumbnail;
    videoThumb.onload = () => { show(videoThumb); hide(thumbFallback); };
    videoThumb.onerror = () => { hide(videoThumb); show(thumbFallback); };
    show(videoThumb);
    hide(thumbFallback);
  } else {
    videoThumb.removeAttribute('src');
    hide(videoThumb);
    show(thumbFallback);
  }
  videoTitle.textContent = info.title || 'Untitled video';
  videoUploader.textContent = info.uploader || 'Unknown channel';
  videoDuration.textContent = info.duration_text || '';
  videoLink.href = info.webpage_url || current.url;
  show(videoSection);
  setActiveTab('full');
}

function setActiveTab(mode) {
  const isFull = mode === 'full';
  tabFull.classList.toggle('active', isFull);
  tabClips.classList.toggle('active', !isFull);
  if (isFull) {
    show(fullSection);
    hide(clipsSection);
  } else {
    hide(fullSection);
    show(clipsSection);
  }
}

function qualityCard(q) {
  const card = document.createElement('div');
  card.className = 'q-card';

  const top = document.createElement('div');
  top.className = 'q-top';
  top.innerHTML = `
    <div>
      <div class="q-badge">${q.label || 'Best'}</div>
      <div class="q-sub">${q.size_text || 'Size unknown'}</div>
    </div>
    <span class="chip">MP4</span>
  `;

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.innerHTML = `<span class="btn-label">Download</span>`;

  const progressWrap = document.createElement('div');
  progressWrap.className = 'progress-wrap hidden';
  progressWrap.innerHTML = `
    <div class="progress-meta"><span class="status-text">Preparing...</span><span class="pct">0%</span></div>
    <div class="bar"><div class="bar-fill" style="width:0%"></div></div>
  `;

  const statusLine = document.createElement('div');
  statusLine.className = 'status-line hidden';

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    show(progressWrap);
    hide(statusLine);
    statusLine.className = 'status-line hidden';
    const statusText = progressWrap.querySelector('.status-text');
    const pctText = progressWrap.querySelector('.pct');
    const bar = progressWrap.querySelector('.bar-fill');
    const setProgress = (p, msg) => {
      const pct = Math.max(0, Math.min(100, Math.round(p || 0)));
      pctText.textContent = pct + '%';
      bar.style.width = pct + '%';
      if (msg) statusText.textContent = msg;
    };
    setProgress(1, 'Starting...');
    try {
      const start = await postJSON('/api/download/start', {
        url: current.url,
        format: q.format,
        label: (q.height || 'best') + 'p',
        title: current.info ? current.info.title : ''
      });
      const job = await pollJob(start.job_id, (j) => {
        setProgress(j.progress || 0, j.message || 'Working...');
      }, 900);
      const res = job.result || {};
      setProgress(100, 'Ready');
      statusLine.innerHTML = `Download ready (${res.size_text || 'file'}). <a href="${res.download_url}" class="link-btn" download>Save again</a>`;
      statusLine.className = 'status-line ok';
      show(statusLine);
      if (res.download_url) triggerDownload(res.download_url, res.filename);
      showToast('Download ready');
    } catch (e) {
      statusText.textContent = 'Failed';
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg,#ff6b7a,#ff9b6b)';
      statusLine.textContent = e.message || 'Download failed';
      statusLine.className = 'status-line err';
      show(statusLine);
      showToast(e.message || 'Download failed', true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });

  actions.appendChild(btn);
  actions.appendChild(progressWrap);
  actions.appendChild(statusLine);

  card.appendChild(top);
  card.appendChild(actions);
  return card;
}

function renderQualities(qualities) {
  qualityList.innerHTML = '';
  if (!qualities || qualities.length === 0) {
    qualityList.innerHTML = '<div class="empty-state"><div class="empty-title">No formats found</div><div class="empty-sub">This video may not have downloadable formats available.</div></div>';
    return;
  }
  qualities.forEach(q => qualityList.appendChild(qualityCard(q)));
}

function resetClipsUI() {
  hide(clipsProgress);
  hide(clipsError);
  clipsError.textContent = '';
  clipsList.innerHTML = '';
  show(clipsIdle);
  clipsProgressBar.style.width = '0%';
  clipsProgressPct.textContent = '0%';
  clipsProgressTitle.textContent = 'Preparing...';
  clipsProgressSub.textContent = 'This can take a few minutes depending on video length.';
  setBtnLoading(generateClipsBtn, false, 'Generate Clips');
}

function renderClips(clips) {
  clipsList.innerHTML = '';
  if (!clips || clips.length === 0) {
    clipsList.innerHTML = '<div class="empty-state"><div class="empty-title">No clips generated</div><div class="empty-sub">Try a longer video with more visual or audio variation.</div></div>';
    return;
  }
  clips.forEach(c => {
    const card = document.createElement('div');
    card.className = 'clip-card';
    const safeUrl = c.download_url || '#';
    card.innerHTML = `
      <div class="clip-preview">
        <video controls preload="metadata" playsinline src="${safeUrl}"></video>
      </div>
      <div class="clip-body">
        <div class="clip-title"><span class="chip">Clip ${c.index}</span> ${c.start_text} – ${c.end_text}</div>
        <div class="clip-meta">Duration: <strong>${c.duration_text}</strong><br>Quality: ${c.quality || 'Source'} • Size: ${c.size_text || 'Unknown'}</div>
        <div class="clip-actions">
          <a class="btn btn-primary" href="${safeUrl}" download="${c.filename || ''}"><span class="btn-label">Download Clip</span></a>
        </div>
      </div>
    `;
    clipsList.appendChild(card);
  });
}

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  setFormError('');
  if (!url) return;
  hide(videoSection);
  hide(fullSection);
  hide(clipsSection);
  resetClipsUI();
  setBtnLoading(loadBtn, true, 'Loading...');
  try {
    const info = await postJSON('/api/info', { url });
    current.url = info.webpage_url || url;
    current.info = info;
    renderVideo(info);
    renderQualities(info.qualities || []);
    resetClipsUI();
  } catch (err) {
    setFormError(err.message || 'Failed to load video. Please check the URL and try again.');
  } finally {
    setBtnLoading(loadBtn, false, 'Load Video');
  }
});

tabFull.addEventListener('click', () => setActiveTab('full'));
tabClips.addEventListener('click', () => setActiveTab('clips'));

generateClipsBtn.addEventListener('click', async () => {
  if (!current.url) return;
  hide(clipsIdle);
  hide(clipsError);
  clipsList.innerHTML = '';
  show(clipsProgress);
  setBtnLoading(generateClipsBtn, true, 'Generating...');
  const setProgress = (p, title, sub) => {
    const pct = Math.max(0, Math.min(100, Math.round(p || 0)));
    clipsProgressBar.style.width = pct + '%';
    clipsProgressPct.textContent = pct + '%';
    if (title) clipsProgressTitle.textContent = title;
    if (sub) clipsProgressSub.textContent = sub;
  };
  setProgress(1, 'Starting clip generation...', 'Preparing to download source video for analysis.');
  try {
    const start = await postJSON('/api/clips/start', { url: current.url, title: current.info ? current.info.title : '' });
    const job = await pollJob(start.job_id, (j) => {
      setProgress(j.progress || 0, j.message || 'Working...', 'This can take a few minutes depending on video length.');
    }, 1000);
    const res = job.result || {};
    hide(clipsProgress);
    renderClips(res.clips || []);
    showToast(`Generated ${(res.clips || []).length} clip(s)`);
  } catch (err) {
    hide(clipsProgress);
    clipsError.textContent = err.message || 'Failed to generate clips.';
    show(clipsError);
    show(clipsIdle);
    showToast(err.message || 'Failed to generate clips', true);
  } finally {
    setBtnLoading(generateClipsBtn, false, 'Generate Clips');
  }
});

// allow Enter in input naturally via form submit
