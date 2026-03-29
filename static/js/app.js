/* ─────────────────────────────────────────────────────────────────────────────
   app.js  ·  Main thread orchestrator
   Pi-optimized architecture:
     1. Raspberry Pi handles URL analysis + downloads
     2. Browser on your computer handles Whisper transcription
───────────────────────────────────────────────────────────────────────────── */

const urlInput = document.getElementById('url-input');
const platformBadge = document.getElementById('platform-badge');
const platformIcon = document.getElementById('platform-icon');
const analyzeBtn = document.getElementById('analyze-btn');
const transcribeBtn = document.getElementById('transcribe-btn');
const transcribeBtnText = document.getElementById('transcribe-btn-text');

const modelStatusBar = document.getElementById('model-status-bar');
const modelSpinner = document.getElementById('model-spinner');
const modelStatusText = document.getElementById('model-status-text');
const modelDeviceBadge = document.getElementById('model-device-badge');
const modelProgressFill = document.getElementById('model-progress-fill');

const loadingCard = document.getElementById('loading-card');
const stepDownload = document.getElementById('step-download');
const stepTranscribe = document.getElementById('step-transcribe');
const errorCard = document.getElementById('error-card');
const errorText = document.getElementById('error-text');
const errorRetryBtn = document.getElementById('error-retry-btn');
const resultsCard = document.getElementById('results-card');
const downloadCard = document.getElementById('download-card');

const downloadTitle = document.getElementById('download-title');
const downloadRecommendation = document.getElementById('download-recommendation');
const downloadPlatformBadge = document.getElementById('download-platform-badge');
const downloadKindSelect = document.getElementById('download-kind');
const downloadOptionSelect = document.getElementById('download-option');
const downloadSelectedBtn = document.getElementById('download-selected-btn');
const downloadProgress = document.getElementById('download-progress');
const downloadProgressLabel = document.getElementById('download-progress-label');

const videoTitle = document.getElementById('video-title');
const transcriptText = document.getElementById('transcript-text');
const btnPlain = document.getElementById('btn-plain');
const btnTimestamped = document.getElementById('btn-timestamped');
const dlPlainBtn = document.getElementById('download-plain-btn');
const dlTsBtn = document.getElementById('download-ts-btn');
const copyBtn = document.getElementById('copy-btn');

const state = {
  plain: '',
  timestamped: '',
  title: '',
  url: '',
  view: 'timestamped',
  modelReady: false,
  lowPowerMode: false,
  downloadMeta: null,
};

function shouldUseLowPowerMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('pi') === '1') return true;

  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 0;
  return cores <= 4 || (memory && memory <= 4);
}

state.lowPowerMode = shouldUseLowPowerMode();

const workerUrl = state.lowPowerMode ? '/js/worker.js?pi=1' : '/js/worker.js';
const worker = new Worker(workerUrl, { type: 'module' });

worker.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'status':
      modelStatusText.textContent = data.message;
      break;

    case 'model-progress': {
      const p = data.data;
      if (p.status === 'progress' && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        modelProgressFill.style.width = `${pct}%`;
        modelStatusText.textContent = `Downloading model… ${pct}%`;
      } else if (p.status === 'ready' || p.status === 'done') {
        modelProgressFill.style.width = '100%';
      }
      break;
    }

    case 'model-ready': {
      state.modelReady = true;
      const device = data.device;

      modelStatusBar.classList.add('ready');
      modelSpinner.classList.add('done');
      modelStatusText.textContent = `${data.profile || 'Whisper'} ready`;

      modelDeviceBadge.textContent = device === 'webgpu' ? 'WebGPU' : 'WASM';
      modelDeviceBadge.className = `model-device-badge visible ${device}`;

      updateTranscribeAvailability(detectPlatform(urlInput.value.trim()));
      break;
    }

    case 'result':
      handleTranscriptResult(data.result);
      break;

    case 'error':
      showError(data.message);
      break;
  }
});

worker.postMessage({ type: 'load' });

const platformMeta = {
  youtube: { label: 'YouTube', icon: '▶' },
  instagram: { label: 'Instagram', icon: '📸' },
  tiktok: { label: 'TikTok', icon: '🎵' },
  vsco: { label: 'VSCO', icon: '🖼' },
};

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('vsco.co')) return 'vsco';
  return null;
}

function renderPlatformBadge(platform) {
  platformBadge.className = 'platform-badge';
  if (platform && platformMeta[platform]) {
    platformBadge.textContent = platformMeta[platform].label;
    platformBadge.classList.add('visible', platform);
    platformIcon.textContent = platformMeta[platform].icon;
  } else {
    platformIcon.textContent = '🔗';
  }
}

function updateTranscribeAvailability(platform) {
  if (!state.modelReady) {
    transcribeBtn.disabled = true;
    transcribeBtnText.textContent = 'Loading model…';
    return;
  }

  if (platform === 'vsco') {
    transcribeBtn.disabled = true;
    transcribeBtnText.textContent = 'VSCO is download only';
    return;
  }

  transcribeBtn.disabled = false;
  transcribeBtnText.textContent = 'Transcribe on this browser';
}

urlInput.addEventListener('input', () => {
  state.url = urlInput.value.trim();
  state.downloadMeta = null;
  downloadCard.hidden = true;
  const platform = detectPlatform(state.url);
  renderPlatformBadge(platform);
  updateTranscribeAvailability(platform);
});

function showSection(el) {
  [loadingCard, errorCard, resultsCard].forEach(card => { card.hidden = true; });
  if (el) el.hidden = false;
}

function showError(message) {
  errorText.textContent = message;
  showSection(errorCard);
  transcribeBtn.disabled = !state.modelReady;
  analyzeBtn.disabled = false;
  downloadSelectedBtn.disabled = false;
}

function setStep(active) {
  stepDownload.classList.toggle('active', active === 'download');
  stepDownload.classList.toggle('done', active === 'transcribe');
  stepTranscribe.classList.toggle('active', active === 'transcribe');
  stepTranscribe.classList.remove('step-dimmed');
  if (active === 'download') stepTranscribe.classList.add('step-dimmed');
}

async function decodeAudioTo16kHz(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16_000 });
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  await ctx.close();

  const targetRate = 16_000;
  if (audioBuffer.sampleRate === targetRate) {
    return audioBuffer.getChannelData(0).slice();
  }

  const frames = Math.ceil(audioBuffer.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  const resampled = await offline.startRendering();
  return resampled.getChannelData(0).slice();
}

function groupOptionsByKind(options) {
  const grouped = new Map();
  for (const option of options) {
    if (!grouped.has(option.kind)) grouped.set(option.kind, []);
    grouped.get(option.kind).push(option);
  }
  return grouped;
}

function populateDownloadSelectors(meta) {
  const grouped = groupOptionsByKind(meta.options || []);
  downloadKindSelect.innerHTML = '';

  for (const [kind, options] of grouped.entries()) {
    const el = document.createElement('option');
    el.value = kind;
    el.textContent = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} (${options.length})`;
    downloadKindSelect.appendChild(el);
  }

  if (!downloadKindSelect.value) {
    const preferred = grouped.has('video') ? 'video' : grouped.keys().next().value;
    downloadKindSelect.value = preferred || '';
  }

  populateDownloadOptionSelect(downloadKindSelect.value);
}

function populateDownloadOptionSelect(kind) {
  const options = (state.downloadMeta?.options || []).filter(option => option.kind === kind);
  downloadOptionSelect.innerHTML = '';

  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    downloadOptionSelect.appendChild(el);
  }
}

function renderDownloadMeta(meta) {
  state.downloadMeta = meta;
  downloadTitle.textContent = meta.title;
  downloadRecommendation.textContent = meta.transcription_recommendation;

  downloadPlatformBadge.className = 'platform-badge visible';
  downloadPlatformBadge.textContent = platformMeta[meta.platform]?.label || meta.platform;
  if (meta.platform) downloadPlatformBadge.classList.add(meta.platform);

  populateDownloadSelectors(meta);
  downloadCard.hidden = false;
}

async function loadDownloadOptions() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }

  analyzeBtn.disabled = true;
  try {
    const res = await fetch('/api/media-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const meta = await res.json();
    if (!meta.options?.length) {
      throw new Error('No download options were found for this URL.');
    }

    renderDownloadMeta(meta);
  } catch (err) {
    showError(err.message || 'Failed to load download options.');
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function doTranscribe() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }
  if (!state.modelReady) return;

  transcribeBtn.disabled = true;
  analyzeBtn.disabled = true;
  showSection(loadingCard);
  setStep('download');

  try {
    const res = await fetch('/api/fetch-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const title = res.headers.get('X-Video-Title') || 'Transcript';
    const audioBlob = await res.blob();

    setStep('transcribe');
    const float32 = await decodeAudioTo16kHz(audioBlob);

    state.title = title;
    state.url = url;
    worker.postMessage({ type: 'transcribe', audio: float32 }, [float32.buffer]);
  } catch (err) {
    showError(err.message || 'Transcription failed.');
    transcribeBtn.disabled = false;
  } finally {
    analyzeBtn.disabled = false;
  }
}

function formatPlain(result) {
  return (result.text || '').trim();
}

function formatTimestamped(result) {
  return (result.chunks || []).map(chunk => {
    const [start] = chunk.timestamp || [0];
    const s = Math.floor(start);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const ts = `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}]`;
    return `${ts} ${chunk.text.trim()}`;
  }).join('\n');
}

function handleTranscriptResult(result) {
  state.plain = formatPlain(result);
  state.timestamped = formatTimestamped(result);

  videoTitle.textContent = state.title;
  transcriptText.textContent = state.timestamped;
  setView('timestamped');
  showSection(resultsCard);
  transcribeBtn.disabled = false;
}

function setView(view) {
  state.view = view;
  transcriptText.textContent = view === 'plain' ? state.plain : state.timestamped;
  btnPlain.classList.toggle('active', view === 'plain');
  btnTimestamped.classList.toggle('active', view === 'timestamped');
}

copyBtn.addEventListener('click', async () => {
  const text = state.view === 'plain' ? state.plain : state.timestamped;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    copyBtn.innerHTML = '<span class="copy-icon">✓</span> Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.innerHTML = '<span class="copy-icon">📋</span> Copy';
      copyBtn.classList.remove('copied');
    }, 1800);
  } catch {
    copyBtn.textContent = 'Failed';
    setTimeout(() => {
      copyBtn.innerHTML = '<span class="copy-icon">📋</span> Copy';
    }, 1500);
  }
});

function safeFilename(title) {
  return (title || 'transcript').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadSelectedMedia() {
  if (!state.downloadMeta) return;

  const selectedOption = state.downloadMeta.options.find(option => option.id === downloadOptionSelect.value);
  if (!selectedOption) return;

  downloadSelectedBtn.disabled = true;
  downloadProgress.hidden = false;
  downloadProgressLabel.textContent = `Preparing ${selectedOption.label}…`;

  try {
    const res = await fetch('/api/download-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        title: state.downloadMeta.title,
        option: selectedOption,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^"]+)"?/i);
    const filename = match ? decodeURIComponent(match[1].replace(/"/g, '')) : 'download.bin';

    const blob = await res.blob();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: filename,
    });
    a.click();
    URL.revokeObjectURL(a.href);

    downloadProgressLabel.textContent = `Downloaded ${selectedOption.label}`;
    setTimeout(() => {
      downloadProgress.hidden = true;
    }, 1800);
  } catch (err) {
    downloadProgressLabel.textContent = `Error: ${err.message}`;
    setTimeout(() => {
      downloadProgress.hidden = true;
    }, 3500);
  } finally {
    downloadSelectedBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', loadDownloadOptions);
downloadKindSelect.addEventListener('change', event => populateDownloadOptionSelect(event.target.value));
downloadSelectedBtn.addEventListener('click', downloadSelectedMedia);
transcribeBtn.addEventListener('click', doTranscribe);
urlInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') loadDownloadOptions();
});
errorRetryBtn.addEventListener('click', () => showSection(null));
btnPlain.addEventListener('click', () => setView('plain'));
btnTimestamped.addEventListener('click', () => setView('timestamped'));
dlPlainBtn.addEventListener('click', () => downloadText(state.plain, `${safeFilename(state.title)}_plain.txt`));
dlTsBtn.addEventListener('click', () => downloadText(state.timestamped, `${safeFilename(state.title)}_timestamped.txt`));
