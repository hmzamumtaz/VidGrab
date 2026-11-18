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
  const clipsNoteDot = document.querySelector('.clips-note-dot');
  const clipsGateTitle = $('clips-gate-title');
  const clipsGateDetail = $('clips-gate-detail');
  const clipsGateFooter = $('clips-gate-footer');

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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function shortResolution(q) {
    const label = String(q?.label || '');
    if (/4k|2160/i.test(label)) return '4K';
    if (/1440/i.test(label)) return '1440';
    const match = label.match(/(\d{3,4})p/i);
    if (match) return match[1];
    return 'HD';
  }

  function qualityHeight(q) {
    const value = Number(q?.display_height ?? q?.height);
    return Number.isFinite(value) ? value : 0;
  }

  function recommendedQualityIndex(qualities) {
    if (!qualities || qualities.length < 2) return -1;
    const scored = qualities.map((q, index) => ({ index, height: qualityHeight(q) })).filter((x) => x.height > 0);
    if (!scored.length) return -1;
    const balanced = scored.filter((x) => x.height <= 1080).sort((a, b) => b.height - a.height)[0];
    const best = scored.sort((a, b) => b.height - a.height)[0];
    return balanced ? balanced.index : best.index;
  }

  function formatTags(q) {
    const ext = String(q?.ext || 'mp4').toUpperCase();
    const note = String(q?.note || '').split('•').map((x) => x.trim()).filter(Boolean);
    return Array.from(new Set([ext, ...note]));
  }

  function emptyState(title, detail, icon) {
    const box = el('div', 'empty-state');
    const mark = el('span', 'empty-state-icon', '');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = icon;
    const copy = el('div', '');
    copy.appendChild(el('strong', '', title));
    copy.appendChild(el('span', '', detail));
    box.appendChild(mark);
    box.appendChild(copy);
    return box;
  }

  const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"/></svg>';
  const CLIPS_EMPTY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.7 7.6L20 18M8.7 16.4L20 6"/></svg>';
  const QUALITY_EMPTY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>';

  function setCopyright(cp) {
    state.copyright = cp || null;
    const allowed = !!(cp && cp.allow_clip_downloads);
    state.clipsAllowed = allowed;
    if (copyrightBox) copyrightBox.classList.remove('safe', 'danger', 'neutral');
    if (clipsNoteDot) clipsNoteDot.classList.remove('ready');
    if (!cp) {
      if (copyrightBox) copyrightBox.classList.add('neutral');
      setText(copyrightTitle, 'Copyright safety check');
      setText(copyrightDetail, 'Automated metadata pre-check (no external APIs). Not a legal guarantee.');
      if (generateClipsBtn) generateClipsBtn.disabled = true;
      if (clipsGate) clipsGate.classList.add('hidden');
      setText(clipsNote, 'Load a video to check clip eligibility.');
      return;
    }
    const reasons = (cp.reasons || []).filter(Boolean);
    const reasonText = reasons.length ? reasons.join(' • ') : 'Automated metadata pre-check completed.';
    const note = cp.note ? ` ${cp.note}` : '';
    if (allowed) {
      if (copyrightBox) copyrightBox.classList.add('safe');
      setText(copyrightTitle, 'Automated pre-check: clip downloads allowed');
      setText(copyrightDetail, `${reasonText}.${note}`);
      if (generateClipsBtn) generateClipsBtn.disabled = false;
      if (clipsGate) {
        setText(clipsGateTitle, '');
        setText(clipsGateDetail, '');
        setText(clipsGateFooter, '');
        clipsGate.classList.add('hidden');
      }
      setText(clipsNote, 'Ready to scan locally. Clip downloads stay subject to the automated safety check.');
      if (clipsNoteDot) clipsNoteDot.classList.add('ready');
    } else {
      if (copyrightBox) copyrightBox.classList.add('danger');
      setText(copyrightTitle, 'Potential copyright detected — clip downloads blocked');
      setText(copyrightDetail, `${reasonText}.${note}`);
      if (generateClipsBtn) generateClipsBtn.disabled = true;
      const gateTitle = 'Clip downloads are blocked for this video';
      const gateDetail = `Automated pre-check found: ${reasonText}.${note}`;
      const gateFooter = 'Full video download is still available if you have rights to use it.';
      if (clipsGateTitle) {
        setText(clipsGateTitle, gateTitle);
        setText(clipsGateDetail, gateDetail);
        setText(clipsGateFooter, gateFooter);
      } else {
        setText(clipsGate, gateTitle);
      }
      if (clipsGate) clipsGate.classList.remove('hidden');
      setText(clipsNote, 'Clip downloads require passing the automated copyright safety pre-check.');
    }
  }

  function renderQualities(qualities) {
    qualityList.innerHTML = '';
    qualityCount.textContent = `${(qualities || []).length} options`;
    if (!qualities || !qualities.length) {
      qualityList.appendChild(emptyState('No downloadable formats found', 'Try another public YouTube video or refresh the page.', QUALITY_EMPTY_ICON));
      return;
    }
    const recommended = recommendedQualityIndex(qualities);
    qualities.forEach((q, index) => {
      const card = el('article', `ytx-format-card${index === recommended ? ' is-recommended' : ''}`);
      card.setAttribute('aria-label', `${q.label || 'Quality'} download`);
      const top = el('div', 'ytx-format-top');
      const icon = el('div', 'ytx-fmt-icon', shortResolution(q));
      icon.setAttribute('aria-hidden', 'true');
      const body = el('div', 'ytx-fmt-body');
      const titleRow = el('div', 'ytx-fmt-title-row');
      titleRow.appendChild(el('p', 'ytx-fmt-title', q.label || 'Unknown'));
      if (index === recommended) titleRow.appendChild(el('span', 'ytx-rec-badge', 'Recommended'));
      body.appendChild(titleRow);
      body.appendChild(el('p', 'ytx-fmt-caption', `${q.source || 'YouTube'} format • direct MP4 download`));
      const tags = el('div', 'ytx-fmt-tags');
      formatTags(q).forEach((tag, tagIndex) => tags.appendChild(el('span', tagIndex === 0 ? 'ytx-tag ytx-tag--blue' : 'ytx-tag', tag)));
      body.appendChild(tags);
      const sizeBox = el('div', 'ytx-fmt-size');
      const rawSize = String(q.size_text || 'Size unavailable');
      sizeBox.appendChild(el('strong', '', rawSize));
      sizeBox.appendChild(el('span', '', rawSize.startsWith('~') ? 'estimated size' : 'size unknown'));
      top.appendChild(icon);
      top.appendChild(body);
      top.appendChild(sizeBox);

      const actions = el('div', 'ytx-fmt-actions');
      const btn = el('button', 'ytx-btn ytx-btn--primary q-dl');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Download ${q.label || 'video'}`);
      btn.innerHTML = `<span class="ytx-btn-icon" aria-hidden="true">${DOWNLOAD_ICON}</span><span class="ytx-btn-text">Download</span><span class="ytx-btn-loading" aria-hidden="true"><span class="ytx-spinner"></span></span>`;
      actions.appendChild(btn);

      const prog = el('div', 'q-progress hidden');
      const bar = el('div', 'q-progress-bar');
      const fill = el('div', 'q-progress-fill');
      bar.appendChild(fill);
      const ptxt = el('div', 'q-progress-text', '0%');
      prog.appendChild(bar);
      prog.appendChild(ptxt);

      card.appendChild(top);
      card.appendChild(actions);
      card.appendChild(prog);

      let downloadedUrl = '';
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        if (downloadedUrl) { window.location.href = downloadedUrl; return; }
        clearError();
        btn.disabled = true; btn.classList.add('loading');
        prog.classList.remove('hidden'); fill.style.width = '2%'; ptxt.textContent = 'Starting...';
        try {
          const payload = {
            url: state.url,
            format: q.format,
            format_id: q.format_id || '',
            height: q.height || null,
            client_args: state.info?.client_args || [],
            label: q.label || 'video',
            title: state.info?.title || ''
          };
          const start = await api('/api/download/start', { method: 'POST', body: JSON.stringify(payload) });
          const job = await pollJob(start.job_id, (j) => {
            const p = Math.max(0, Math.min(100, Number(j.progress || 0)));
            fill.style.width = `${p}%`; ptxt.textContent = j.message || `${Math.round(p)}%`;
          });
          const result = job.result || {};
          downloadedUrl = result.download_url || '';
          fill.style.width = '100%'; ptxt.textContent = `Ready • ${result.size_text || ''}`.trim();
          btn.classList.remove('loading'); btn.disabled = false;
          btn.querySelector('.ytx-btn-text').textContent = 'Save File';
          if (downloadedUrl) window.location.href = downloadedUrl;
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
      clipsList.appendChild(emptyState('No clips generated yet', 'Generate clips to see preview cards and download options here.', CLIPS_EMPTY_ICON));
      return;
    }
    list.forEach((c) => {
      const dlAllowed = allowed && c.download_allowed !== false;
      const item = el('article', 'clip-item');
      const media = el('div', 'clip-media');
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      if (c.download_url) video.src = `${c.download_url}#t=0.1`;
      media.appendChild(video);

      const info = el('div', 'clip-info');
      const head = el('div', 'clip-head');
      const copy = el('div', '');
      const range = c.start_text && c.end_text ? ` • ${c.start_text}–${c.end_text}` : '';
      copy.appendChild(el('div', 'clip-name', c.index ? `Clip ${c.index}${range}` : `${c.start_text || 'Clip'}${c.end_text ? `–${c.end_text}` : ''}`));
      copy.appendChild(el('div', 'clip-sub', [c.duration_text, c.quality || 'Source', c.size_text].filter(Boolean).join(' • ')));
      head.appendChild(copy);
      head.appendChild(el('span', `clip-badge ${dlAllowed ? 'safe' : 'blocked'}`, dlAllowed ? 'Cleared' : 'Blocked'));
      info.appendChild(head);
      info.appendChild(el('div', 'clip-safe-note', dlAllowed ? 'Passed automated pre-download safety check. Verify rights before sharing.' : 'Blocked by automated copyright safety check.'));
      const actions = el('div', 'clip-actions');
      if (dlAllowed && c.download_url) {
        const link = el('a', 'ytx-btn ytx-btn--primary', 'Download Clip');
        link.href = c.download_url;
        link.setAttribute('download', '');
        actions.appendChild(link);
      } else {
        const btn = el('button', 'ytx-btn ytx-btn--ghost', 'Download Unavailable');
        btn.type = 'button';
        btn.disabled = true;
        actions.appendChild(btn);
      }
      info.appendChild(actions);
      item.appendChild(media);
      item.appendChild(info);
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
      renderClips([], info.copyright);
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
    renderClips([], state.copyright);
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

  const wtabs = Array.from(document.querySelectorAll('.wtab'));
  const wtabPanels = Array.from(document.querySelectorAll('.wtab-panel'));
  function activateTab(btn) {
    const tab = btn.dataset.wtab;
    wtabs.forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
    wtabPanels.forEach((p) => {
      const active = p.id === `wtab-${tab}`;
      p.classList.toggle('active', active);
      p.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
  }
  wtabs.forEach((btn, index) => {
    btn.addEventListener('click', () => activateTab(btn));
    btn.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % wtabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + wtabs.length) % wtabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = wtabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(wtabs[next]);
      wtabs[next].focus();
    });
  });
  activateTab(wtabs.find((b) => b.classList.contains('active')) || wtabs[0]);

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
