(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const hero = document.querySelector('.ytx-hero');
  const form = $('video-url-form');
  const input = $('video-url');
  const submitBtn = $('submit-url');
  const pasteBtn = $('ytx-paste-btn');
  const clearBtn = $('ytx-clear-btn');
  const errorBox = $('error-message');
  const waitBox = $('ytx-wait');
  const themeBtn = $('ytx-theme-toggle');

  const results = $('results');
  const thumb = $('v-thumb');
  const durationEl = $('v-duration');
  const titleEl = $('v-title');
  const uploaderEl = $('v-uploader');
  const qualitySourceEl = $('v-quality-source');
  const openLink = $('v-open');
  const copyrightBox = $('copyright-box');
  const copyrightTitle = $('copyright-title');
  const copyrightDetail = $('copyright-detail');
  const qualityList = $('quality-list');
  const qualityCount = $('quality-count');
  const clipsList = $('clips-list');
  const clipsCount = $('clips-count');
  const generateClipsBtn = $('generate-clips-btn');
  const clipsGate = $('clips-gate');
  const clipsProgress = $('clips-progress');
  const clipsProgressMsg = $('clips-progress-msg');
  const clipsProgressPct = $('clips-progress-pct');
  const clipsProgressFill = $('clips-progress-fill');
  const clipsError = $('clips-error');
  const clipsNote = $('clips-note');

  const state = {
    url: '',
    info: null,
    copyright: null,
    clipsAllowed: false,
  };

  const ERR = {
    empty: 'Please paste a YouTube link first.',
    bad: 'Please paste a valid YouTube video or Shorts link.',
    network: 'Network error. Please check your connection and try again.',
    generic: 'Something went wrong. Please try again.',
    clip: 'Clipboard access is unavailable. Please paste the YouTube link manually.',
    clipEmpty: 'Your clipboard is empty. Copy a YouTube link first.',
  };
  const WAIT_MSG = 'Still working… first request can take 1–2 minutes while the downloader initializes.';

  function isYouTubeUrl(raw) {
    if (typeof raw !== 'string') return false;
    let s = raw.trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      const host = (u.hostname || '').toLowerCase();
      if (host === 'youtu.be' && u.pathname.length > 1) return true;
      if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host)) {
        const p = u.pathname || '';
        if (p === '/watch' && u.searchParams && u.searchParams.get('v')) return true;
        if (/^\/(shorts|embed|live|v)\/[^/]+/.test(p)) return true;
      }
    } catch (_) { return false; }
    return false;
  }

  function showError(msg) {
    errorBox.textContent = msg || ERR.generic;
    errorBox.hidden = false;
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.hidden = true;
  }
  function showClipsError(msg) {
    clipsError.textContent = msg || '';
    clipsError.classList.toggle('hidden', !msg);
  }
  function syncClearBtn() {
    if (!clearBtn) return;
    if ((input.value || '').trim().length > 0) clearBtn.removeAttribute('hidden');
    else clearBtn.setAttribute('hidden', '');
  }

  let waitTimer = null;
  function setBusy(busy) {
    submitBtn.disabled = !!busy;
    submitBtn.setAttribute('data-state', busy ? 'loading' : 'idle');
    submitBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    if (waitBox) {
      waitBox.hidden = true; waitBox.textContent = '';
      if (busy) waitTimer = setTimeout(() => { waitBox.textContent = WAIT_MSG; waitBox.hidden = false; }, 6000);
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.data = data; err.status = res.status;
      throw err;
    }
    return data;
  }

  async function pollJob(jobId, onUpdate, interval = 1000) {
    while (true) {
      const job = await api(`/api/job/${encodeURIComponent(jobId)}`);
      if (onUpdate) onUpdate(job);
      if (job.status === 'done') return job;
      if (job.status === 'error') throw new Error(job.error || 'Job failed');
      await new Promise(r => setTimeout(r, interval));
    }
  }

  function fmtSec(s) {
    if (s == null || isNaN(s)) return '--:--';
    s = Math.max(0, Math.round(Number(s)));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  function setCopyright(cp) {
    state.copyright = cp || null;
    const allowed = !!(cp && cp.allow_clip_downloads);
    state.clipsAllowed = allowed;
    copyrightBox.classList.remove('safe', 'danger', 'neutral');
    if (!cp) {
      copyrightBox.classList.add('neutral');
      copyrightTitle.textContent = 'Copyright safety check';
      copyrightDetail.textContent = 'Automated metadata pre-check (no external APIs). Not a legal guarantee.';
      generateClipsBtn.disabled = true;
      clipsGate.classList.add('hidden');
      return;
    }
    const reasons = (cp.reasons || []).filter(Boolean);
    const reasonText = reasons.length ? reasons.join(' • ') : 'Automated metadata pre-check completed.';
    const note = cp.note ? ` ${cp.note}` : '';
    if (allowed) {
      copyrightBox.classList.add('safe');
      copyrightTitle.textContent = 'Automated pre-check: clip downloads allowed';
      copyrightDetail.textContent = `${reasonText}.${note}`;
      generateClipsBtn.disabled = false;
      clipsGate.classList.add('hidden');
      clipsGate.textContent = '';
    } else {
      copyrightBox.classList.add('danger');
      copyrightTitle.textContent = 'Potential copyright detected — clip downloads blocked';
      copyrightDetail.textContent = `${reasonText}.${note}`;
      generateClipsBtn.disabled = true;
      clipsGate.textContent = 'Clip generation/download is blocked for this video because automated safety checks detected potential copyright signals. Full video download may still be available if you have rights to use it.';
      clipsGate.classList.remove('hidden');
    }
  }

  function renderQualities(qualities) {
    qualityList.innerHTML = '';
    qualityCount.textContent = `${(qualities || []).length} options`;
    if (!qualities || !qualities.length) {
      qualityList.innerHTML = '<div class="clips-note">No downloadable formats detected for this video.</div>';
      return;
    }
    qualities.forEach((q) => {
      const card = document.createElement('div');
      card.className = 'ytx-format-card';
      card.innerHTML = `
        <div class="ytx-fmt-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>
        </div>
        <div class="ytx-fmt-body">
          <p class="ytx-fmt-title">${q.label || 'Unknown'}</p>
          <div class="ytx-fmt-tags">
            <span class="ytx-tag ytx-tag--blue">${q.ext || 'mp4'}</span>
            <span class="ytx-tag">${q.note || 'MP4'}</span>
            <span class="ytx-tag ytx-tag--green">${q.size_text || 'Size unavailable'}</span>
          </div>
          <div class="q-progress hidden">
            <div class="q-progress-bar"><div class="q-progress-fill"></div></div>
            <div class="q-progress-text">0%</div>
          </div>
        </div>
        <div class="ytx-fmt-actions">
          <button class="ytx-btn ytx-btn--primary q-dl" type="button"><span class="ytx-btn-text">Download</span><span class="ytx-btn-loading"><span class="ytx-spinner"></span></span></button>
        </div>`;
      const btn = card.querySelector('.q-dl');
      const prog = card.querySelector('.q-progress');
      const fill = card.querySelector('.q-progress-fill');
      const ptxt = card.querySelector('.q-progress-text');
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        clearError();
        btn.disabled = true; btn.classList.add('loading');
        prog.classList.remove('hidden'); fill.style.width = '2%'; ptxt.textContent = 'Starting...';
        try {
          const start = await api('/api/download/start', { method: 'POST', body: JSON.stringify({ url: state.url, format: q.format, label: q.label || 'video', title: state.info?.title || '' }) });
          const job = await pollJob(start.job_id, (j) => {
            const p = Math.max(0, Math.min(100, Number(j.progress || 0)));
            fill.style.width = `${p}%`; ptxt.textContent = j.message || `${Math.round(p)}%`;
          });
          const result = job.result || {};
          fill.style.width = '100%'; ptxt.textContent = `Ready • ${result.size_text || ''}`.trim();
          btn.classList.remove('loading'); btn.disabled = false;
          btn.querySelector('.ytx-btn-text').textContent = 'Save File';
          btn.onclick = () => { if (result.download_url) window.location.href = result.download_url; };
          if (result.download_url) window.location.href = result.download_url;
        } catch (e) {
          btn.classList.remove('loading'); btn.disabled = false;
          btn.querySelector('.ytx-btn-text').textContent = 'Retry';
          ptxt.textContent = e.message || 'Failed'; fill.style.width = '0%';
          showError(e.message || 'Download failed');
        }
      });
      qualityList.appendChild(card);
    });
  }

  function renderClips(clips, copyright) {
    clipsList.innerHTML = '';
    const allowed = !!(copyright ? copyright.allow_clip_downloads : state.clipsAllowed);
    const list = clips || [];
    clipsCount.textContent = `${list.length} clips`;
    if (!list.length) {
      clipsList.innerHTML = '<div class="clips-note">No clips generated yet.</div>';
      return;
    }
    list.forEach((c) => {
      const dlAllowed = allowed && c.download_allowed !== false;
      const item = document.createElement('div');
      item.className = 'clip-item';
      item.innerHTML = `
        <div class="clip-media"><video controls preload="metadata" playsinline src="${c.download_url || ''}#t=0.1"></video></div>
        <div class="clip-info">
          <div class="clip-head">
            <div>
              <div class="clip-name">Clip ${c.index} • ${c.start_text || ''}–${c.end_text || ''}</div>
              <div class="clip-sub">${c.duration_text || ''} • ${c.quality || 'Source'} • ${c.size_text || ''}</div>
            </div>
            <span class="clip-badge ${dlAllowed ? 'safe' : 'blocked'}">${dlAllowed ? 'Cleared' : 'Blocked'}</span>
          </div>
          <div class="clip-safe-note">${dlAllowed ? 'Passed automated pre-download safety check. Verify rights before sharing.' : 'Blocked by automated copyright safety check.'}</div>
          <div class="clip-actions">
            ${dlAllowed ? `<a class="ytx-btn ytx-btn--ghost" href="${c.download_url}" download>Download Clip</a>` : `<button class="ytx-btn ytx-btn--ghost" type="button" disabled>Download Unavailable</button>`}
          </div>
        </div>`;
      clipsList.appendChild(item);
    });
  }

  async function loadInfo(url) {
    clearError(); showClipsError('');
    setBusy(true);
    try {
      const info = await api('/api/info', { method: 'POST', body: JSON.stringify({ url }) });
      state.url = info.webpage_url || url;
      state.info = info;
      thumb.src = info.thumbnail || '';
      thumb.alt = info.title ? `Thumbnail for ${info.title}` : 'Video thumbnail';
      durationEl.textContent = info.duration_text || fmtSec(info.duration);
      titleEl.textContent = info.title || 'Untitled video';
      uploaderEl.textContent = info.uploader || 'Unknown channel';
      qualitySourceEl.textContent = info.quality_source || 'All available YouTube qualities detected';
      if (info.webpage_url) { openLink.href = info.webpage_url; openLink.classList.remove('hidden'); } else { openLink.classList.add('hidden'); }
      setCopyright(info.copyright);
      renderQualities(info.qualities || []);
      clipsList.innerHTML = ''; clipsCount.textContent = '0 clips';
      clipsProgress.classList.add('hidden');
      results.classList.remove('hidden');
      // scroll to results
      setTimeout(() => results.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (e) {
      showError(e.message || 'Failed to load video info');
      results.classList.add('hidden');
    } finally {
      setBusy(false);
    }
  }

  async function generateClips() {
    if (!state.url) return;
    if (!state.clipsAllowed) {
      showClipsError('Clip generation is blocked by the copyright safety check for this video.');
      return;
    }
    showClipsError('');
    clipsList.innerHTML = ''; clipsCount.textContent = '0 clips';
    clipsProgress.classList.remove('hidden');
    clipsProgressFill.style.width = '1%'; clipsProgressPct.textContent = '1%'; clipsProgressMsg.textContent = 'Starting clip generation...';
    generateClipsBtn.disabled = true; generateClipsBtn.classList.add('loading');
    try {
      const start = await api('/api/clips/start', { method: 'POST', body: JSON.stringify({ url: state.url, title: state.info?.title || '' }) });
      const job = await pollJob(start.job_id, (j) => {
        const p = Math.max(0, Math.min(100, Number(j.progress || 0)));
        clipsProgressFill.style.width = `${p}%`;
        clipsProgressPct.textContent = `${Math.round(p)}%`;
        clipsProgressMsg.textContent = j.message || 'Processing...';
      }, 1200);
      clipsProgressFill.style.width = '100%'; clipsProgressPct.textContent = '100%';
      clipsProgressMsg.textContent = job.message || 'Done';
      const result = job.result || {};
      if (result.copyright) setCopyright(result.copyright);
      renderClips(result.clips || [], result.copyright || state.copyright);
    } catch (e) {
      if (e.data && e.data.copyright) setCopyright(e.data.copyright);
      showClipsError(e.message || 'Failed to generate clips');
      clipsProgress.classList.add('hidden');
    } finally {
      generateClipsBtn.classList.remove('loading');
      generateClipsBtn.disabled = !state.clipsAllowed;
    }
  }

  // Tabs
  document.querySelectorAll('.wtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.wtab;
      document.querySelectorAll('.wtab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.wtab-panel').forEach(p => p.classList.toggle('active', p.id === `wtab-${tab}`));
    });
  });

  // Theme toggle
  const THEME_KEY = 'vidgrab_theme';
  function applyTheme(t) {
    if (!hero) return;
    hero.setAttribute('data-theme', t);
    if (themeBtn) {
      const dark = t === 'dark';
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      themeBtn.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
  }
  if (themeBtn) themeBtn.addEventListener('click', () => applyTheme(hero.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  try { const saved = localStorage.getItem(THEME_KEY); if (saved === 'dark' || saved === 'light') applyTheme(saved); } catch (_) {}

  // Paste/clear/input
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      clearError();
      if (!navigator.clipboard || !navigator.clipboard.readText) { showError(ERR.clip); input.focus(); return; }
      try {
        const txt = (await navigator.clipboard.readText() || '').trim();
        if (!txt) { showError(ERR.clipEmpty); return; }
        input.value = txt; syncClearBtn(); input.focus();
        if (isYouTubeUrl(txt) && !submitBtn.disabled) form.requestSubmit ? form.requestSubmit() : submitBtn.click();
      } catch (_) { showError(ERR.clip); input.focus(); }
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; clearError(); syncClearBtn(); input.focus(); });
  input.addEventListener('input', () => { clearError(); syncClearBtn(); });
  input.addEventListener('paste', () => setTimeout(() => { syncClearBtn(); if (isYouTubeUrl(input.value)) form.requestSubmit ? form.requestSubmit() : submitBtn.click(); }, 0));
  syncClearBtn();

  // Submit
  let inflight = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (inflight) return;
    clearError();
    const raw = (input.value || '').trim();
    if (!raw) { showError(ERR.empty); input.focus(); return; }
    if (!isYouTubeUrl(raw)) { showError(ERR.bad); input.focus(); input.select(); return; }
    inflight = true;
    try { await loadInfo(raw); }
    finally { inflight = false; }
  });

  generateClipsBtn.addEventListener('click', generateClips);
  setCopyright(null);
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) { setBusy(false); inflight = false; } });
})();
