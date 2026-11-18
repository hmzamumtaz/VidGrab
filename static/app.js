(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    form: $('load-form'),
    url: $('url-input'),
    loadBtn: $('load-btn'),
    error: $('error'),
    notice: $('notice'),
    skeleton: $('skeleton'),
    panel: $('video-panel'),
    thumb: $('thumb'),
    duration: $('duration-badge'),
    title: $('video-title'),
    channel: $('video-channel'),
    qualitySource: $('quality-source'),
    linkWrap: $('video-link-wrap'),
    link: $('video-link'),
    copyrightBanner: $('copyright-banner'),
    copyrightTitle: $('copyright-title'),
    copyrightDetail: $('copyright-detail'),
    qualityGrid: $('quality-grid'),
    generateBtn: $('generate-clips-btn'),
    clipsBlocked: $('clips-blocked'),
    clipsProgress: $('clips-progress'),
    clipsProgressText: $('clips-progress-text'),
    clipsProgressPct: $('clips-progress-pct'),
    clipsProgressFill: $('clips-progress-fill'),
    clipsEmpty: $('clips-empty'),
    clipsList: $('clips-list'),
  };

  const state = {
    url: '',
    info: null,
    copyright: null,
    clipsAllowed: false,
    activeDownloadButtons: new Set(),
  };

  function show(el, on = true) {
    if (!el) return;
    el.classList.toggle('hidden', !on);
  }

  function setLoading(btn, loading, labelWhenDone) {
    if (!btn) return;
    btn.disabled = !!loading;
    btn.classList.toggle('loading', !!loading);
    const label = btn.querySelector('.btn-label');
    if (label && labelWhenDone) label.textContent = loading ? label.dataset.loading || 'Working...' : labelWhenDone;
  }

  function setError(msg) {
    if (!msg) {
      els.error.textContent = '';
      show(els.error, false);
      return;
    }
    els.error.textContent = msg;
    show(els.error, true);
  }

  function setNotice(msg) {
    if (!msg) {
      els.notice.textContent = '';
      show(els.notice, false);
      return;
    }
    els.notice.textContent = msg;
    show(els.notice, true);
  }

  function fmtSec(s) {
    if (s == null || isNaN(s)) return '--:--';
    s = Math.max(0, Math.round(Number(s)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
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
      err.data = data;
      err.status = res.status;
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

  function setCopyrightUI(cp) {
    state.copyright = cp || null;
    const allowed = !!(cp && cp.allow_clip_downloads);
    state.clipsAllowed = allowed;
    els.copyrightBanner.classList.remove('safe', 'warn', 'danger', 'neutral');
    if (!cp) {
      els.copyrightBanner.classList.add('neutral');
      els.copyrightTitle.textContent = 'Copyright safety check';
      els.copyrightDetail.textContent = 'Load a video to run automated pre-checks.';
      show(els.clipsBlocked, false);
      els.generateBtn.disabled = true;
      return;
    }
    const reasons = (cp.reasons || []).filter(Boolean);
    const reasonText = reasons.length ? reasons.join(' • ') : 'Automated metadata pre-check completed.';
    const note = cp.note ? ` ${cp.note}` : '';
    if (allowed) {
      els.copyrightBanner.classList.add('safe');
      els.copyrightTitle.textContent = 'Clip downloads cleared by automated pre-check';
      els.copyrightDetail.textContent = `${reasonText}.${note}`;
      show(els.clipsBlocked, false);
      els.generateBtn.disabled = false;
    } else {
      els.copyrightBanner.classList.add('danger');
      els.copyrightTitle.textContent = 'Potential copyright detected — clip downloads blocked';
      els.copyrightDetail.textContent = `${reasonText}.${note}`;
      els.clipsBlocked.textContent = 'Clips cannot be generated/downloaded for this video because the automated safety check detected potential copyright signals. Full video download may still be available if you have rights to use it.';
      show(els.clipsBlocked, true);
      els.generateBtn.disabled = true;
    }
  }

  function renderQualities(qualities) {
    els.qualityGrid.innerHTML = '';
    if (!qualities || !qualities.length) {
      els.qualityGrid.innerHTML = '<div class="empty-inline">No downloadable formats detected for this video.</div>';
      return;
    }
    qualities.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'quality-card';
      const label = q.label || 'Unknown';
      const note = q.note || 'MP4';
      const size = q.size_text || 'Size unavailable';
      card.innerHTML = `
        <div class="quality-main">
          <div class="quality-label">${label}</div>
          <div class="quality-sub">${note}</div>
        </div>
        <div class="quality-side">
          <div class="quality-size">${size}</div>
          <button class="btn btn-secondary btn-sm q-dl-btn" type="button">Download</button>
          <div class="q-progress hidden"><div class="q-progress-bar"><div class="q-progress-fill"></div></div><div class="q-progress-text">0%</div></div>
        </div>`;
      const btn = card.querySelector('.q-dl-btn');
      const progWrap = card.querySelector('.q-progress');
      const progFill = card.querySelector('.q-progress-fill');
      const progText = card.querySelector('.q-progress-text');

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        setError('');
        btn.disabled = true;
        btn.textContent = 'Starting...';
        show(progWrap, true);
        progFill.style.width = '2%';
        progText.textContent = 'Starting...';
        try {
          const start = await api('/api/download/start', {
            method: 'POST',
            body: JSON.stringify({ url: state.url, format: q.format, label: label, title: state.info?.title || '' })
          });
          const job = await pollJob(start.job_id, (j) => {
            const p = Math.max(0, Math.min(100, Number(j.progress || 0)));
            progFill.style.width = `${p}%`;
            progText.textContent = j.message || `${p}%`;
          });
          const result = job.result || {};
          progFill.style.width = '100%';
          progText.textContent = `Ready • ${result.size_text || ''}`.trim();
          btn.textContent = 'Save File';
          btn.disabled = false;
          btn.onclick = () => { window.location.href = result.download_url; };
          // trigger once automatically
          if (result.download_url) window.location.href = result.download_url;
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Retry';
          progText.textContent = e.message || 'Failed';
          progFill.style.width = '0%';
          setError(e.message || 'Download failed');
        }
      });

      els.qualityGrid.appendChild(card);
    });
  }

  function renderClips(clips, copyright) {
    els.clipsList.innerHTML = '';
    const allowed = !!(copyright ? copyright.allow_clip_downloads : state.clipsAllowed);
    if (!clips || !clips.length) {
      show(els.clipsEmpty, true);
      return;
    }
    show(els.clipsEmpty, false);
    clips.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'clip-card';
      const dlAllowed = allowed && c.download_allowed !== false;
      const safeBadge = dlAllowed
        ? '<span class="chip chip-safe">Safety check passed</span>'
        : '<span class="chip chip-danger">Download blocked</span>';
      const previewUrl = c.download_url || '';
      card.innerHTML = `
        <div class="clip-preview">
          <video preload="metadata" controls playsinline src="${previewUrl}#t=0.1"></video>
        </div>
        <div class="clip-body">
          <div class="clip-top">
            <div>
              <div class="clip-title">Clip ${c.index} • ${c.start_text || ''}–${c.end_text || ''}</div>
              <div class="clip-meta">${c.duration_text || ''} • ${c.quality || 'Source'} • ${c.size_text || ''}</div>
            </div>
            ${safeBadge}
          </div>
          <div class="clip-note">${dlAllowed ? 'Pre-download safety check passed. Review content rights before sharing.' : 'Potential copyright risk detected. Download disabled by safety gate.'}</div>
          <div class="clip-actions">
            ${dlAllowed ? `<a class="btn btn-secondary btn-sm" href="${c.download_url}" download>Download Clip</a>` : `<button class="btn btn-secondary btn-sm" disabled>Download Unavailable</button>`}
          </div>
        </div>`;
      els.clipsList.appendChild(card);
    });
  }

  function setClipsProgress(pct, text) {
    const p = Math.max(0, Math.min(100, Number(pct || 0)));
    els.clipsProgressFill.style.width = `${p}%`;
    els.clipsProgressPct.textContent = `${Math.round(p)}%`;
    els.clipsProgressText.textContent = text || 'Working...';
  }

  async function loadInfo(url) {
    setError('');
    setNotice('Fetching video info and all available qualities. First request can take 1–2 minutes while the downloader initializes...');
    show(els.skeleton, true);
    show(els.panel, false);
    els.qualityGrid.innerHTML = '';
    els.clipsList.innerHTML = '';
    show(els.clipsEmpty, false);
    show(els.clipsProgress, false);
    setLoading(els.loadBtn, true, 'Load Video');
    els.loadBtn.querySelector('.btn-label').dataset.loading = 'Loading...';

    try {
      const info = await api('/api/info', { method: 'POST', body: JSON.stringify({ url }) });
      state.url = info.webpage_url || url;
      state.info = info;
      els.thumb.src = info.thumbnail || '';
      els.thumb.alt = info.title ? `Thumbnail for ${info.title}` : 'Video thumbnail';
      els.duration.textContent = info.duration_text || fmtSec(info.duration);
      els.title.textContent = info.title || 'Untitled video';
      els.channel.textContent = info.uploader || 'Unknown channel';
      els.qualitySource.textContent = info.quality_source || 'Fetched from available YouTube formats';
      if (info.webpage_url) {
        els.link.href = info.webpage_url;
        show(els.linkWrap, true);
      } else {
        show(els.linkWrap, false);
      }
      setCopyrightUI(info.copyright);
      renderQualities(info.qualities || []);
      setNotice('');
      show(els.panel, true);
      if (state.clipsAllowed) {
        show(els.clipsEmpty, true);
      }
    } catch (e) {
      setNotice('');
      setError(e.message || 'Failed to load video info');
      show(els.panel, false);
    } finally {
      show(els.skeleton, false);
      setLoading(els.loadBtn, false, 'Load Video');
    }
  }

  async function generateClips() {
    if (!state.url) return;
    if (!state.clipsAllowed) {
      setError('Clip generation is blocked by the copyright safety check for this video.');
      return;
    }
    setError('');
    els.clipsList.innerHTML = '';
    show(els.clipsEmpty, false);
    show(els.clipsProgress, true);
    setClipsProgress(1, 'Starting clip generation...');
    setLoading(els.generateBtn, true, 'Generate Viral Clips');
    els.generateBtn.querySelector('.btn-label').dataset.loading = 'Generating...';

    try {
      const start = await api('/api/clips/start', { method: 'POST', body: JSON.stringify({ url: state.url, title: state.info?.title || '' }) });
      const job = await pollJob(start.job_id, (j) => {
        setClipsProgress(j.progress || 0, j.message || 'Processing...');
      }, 1200);
      setClipsProgress(100, job.message || 'Done');
      const result = job.result || {};
      renderClips(result.clips || [], result.copyright || state.copyright);
      if (!result.clips || !result.clips.length) show(els.clipsEmpty, true);
    } catch (e) {
      const cp = e.data && e.data.copyright;
      if (cp) setCopyrightUI(cp);
      setError(e.message || 'Failed to generate clips');
      show(els.clipsProgress, false);
      show(els.clipsEmpty, true);
    } finally {
      setLoading(els.generateBtn, false, 'Generate Viral Clips');
    }
  }

  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    });
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = (els.url.value || '').trim();
    if (!url) return;
    loadInfo(url);
  });

  els.generateBtn.addEventListener('click', generateClips);

  // initial state
  setCopyrightUI(null);
})();
