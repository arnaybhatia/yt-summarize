/* ─────────────────────────────────────────────────────────────────────────────
   app.js  ·  Main thread orchestrator
   Flow:
     1. Spawn Web Worker → load Whisper model (WebGPU or WASM)
     2. User pastes URL → POST /api/fetch-audio → receive audio blob
     3. Decode audio to Float32Array @ 16 kHz  (Web Audio API)
     4. Send Float32Array to Worker → get transcript chunks back
     5. Render transcript, enable downloads
───────────────────────────────────────────────────────────────────────────── */

/* ─── Elements ─────────────────────────────────────────────────────────────── */
const urlInput          = document.getElementById('url-input');
const platformBadge     = document.getElementById('platform-badge');
const platformIcon      = document.getElementById('platform-icon');
const transcribeBtn     = document.getElementById('transcribe-btn');
const transcribeBtnText = document.getElementById('transcribe-btn-text');

const modelStatusBar    = document.getElementById('model-status-bar');
const modelSpinner      = document.getElementById('model-spinner');
const modelStatusText   = document.getElementById('model-status-text');
const modelDeviceBadge  = document.getElementById('model-device-badge');
const modelProgressFill = document.getElementById('model-progress-fill');

const loadingCard       = document.getElementById('loading-card');
const stepDownload      = document.getElementById('step-download');
const stepTranscribe    = document.getElementById('step-transcribe');
const errorCard         = document.getElementById('error-card');
const errorText         = document.getElementById('error-text');
const errorRetryBtn     = document.getElementById('error-retry-btn');
const resultsCard       = document.getElementById('results-card');
const videoTitle        = document.getElementById('video-title');
const transcriptText    = document.getElementById('transcript-text');
const btnPlain          = document.getElementById('btn-plain');
const btnTimestamped    = document.getElementById('btn-timestamped');
const dlPlainBtn        = document.getElementById('download-plain-btn');
const dlTsBtn           = document.getElementById('download-ts-btn');
const dlVideoBtn        = document.getElementById('download-video-btn');
const videoProgress     = document.getElementById('video-progress');
const progressLabel     = document.getElementById('progress-label');
const copyBtn           = document.getElementById('copy-btn');

/* ─── State ─────────────────────────────────────────────────────────────────── */
const state = { plain: '', timestamped: '', title: '', url: '', view: 'timestamped', modelReady: false };

/* ─── Web Worker ────────────────────────────────────────────────────────────── */
const worker = new Worker('/js/worker.js', { type: 'module' });

worker.addEventListener('message', ({ data }) => {
  switch (data.type) {

    case 'status':
      modelStatusText.textContent = data.message;
      break;

    case 'model-progress': {
      const p = data.data;
      // p.status can be 'download', 'initiate', 'progress', 'done', 'ready'
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
      const device = data.device;          // 'webgpu' or 'wasm'

      modelStatusBar.classList.add('ready');
      modelSpinner.classList.add('done');
      modelStatusText.textContent = `Whisper ready`;

      modelDeviceBadge.textContent = device === 'webgpu' ? '⚡ WebGPU' : 'WASM';
      modelDeviceBadge.className   = `model-device-badge visible ${device}`;

      transcribeBtn.disabled      = false;
      transcribeBtnText.textContent = 'Transcribe';
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

// Kick off model load immediately
worker.postMessage({ type: 'load' });

/* ─── Platform Detection ────────────────────────────────────────────────────── */
const platformMeta = {
  youtube:   { label: 'YouTube',   icon: '▶' },
  instagram: { label: 'Instagram', icon: '📸' },
  tiktok:    { label: 'TikTok',    icon: '🎵' },
};

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com'))    return 'tiktok';
  return null;
}

urlInput.addEventListener('input', () => {
  state.url = urlInput.value.trim();
  const platform = detectPlatform(state.url);
  platformBadge.className = 'platform-badge';
  if (platform) {
    platformBadge.textContent = platformMeta[platform].label;
    platformBadge.classList.add('visible', platform);
    platformIcon.textContent  = platformMeta[platform].icon;
  } else {
    platformIcon.textContent  = '🔗';
  }
});

/* ─── UI State Helpers ──────────────────────────────────────────────────────── */
function showSection(el) {
  [loadingCard, errorCard, resultsCard].forEach(c => c.hidden = true);
  if (el) el.hidden = false;
}

function showError(msg) {
  errorText.textContent = msg;
  showSection(errorCard);
  transcribeBtn.disabled = false;
}

function setStep(active) {
  // active: 'download' | 'transcribe'
  stepDownload.classList.toggle('active',   active === 'download');
  stepDownload.classList.toggle('done',     active === 'transcribe');
  stepTranscribe.classList.toggle('active', active === 'transcribe');
  stepTranscribe.classList.remove('step-dimmed');
  if (active === 'download') stepTranscribe.classList.add('step-dimmed');
}

/* ─── Audio Decoding ────────────────────────────────────────────────────────── */
async function decodeAudioTo16kHz(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx         = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();

  const targetRate = 16_000;
  if (audioBuffer.sampleRate === targetRate) {
    return audioBuffer.getChannelData(0);
  }

  // Resample to 16 kHz using OfflineAudioContext
  const frames   = Math.ceil(audioBuffer.duration * targetRate);
  const offline  = new OfflineAudioContext(1, frames, targetRate);
  const source   = offline.createBufferSource();
  source.buffer  = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  const resampled = await offline.startRendering();
  return resampled.getChannelData(0);
}

/* ─── Transcribe Flow ───────────────────────────────────────────────────────── */
async function doTranscribe() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    urlInput.style.borderColor = 'var(--error)';
    setTimeout(() => { urlInput.style.borderColor = ''; }, 1200);
    return;
  }
  if (!state.modelReady) return;

  transcribeBtn.disabled = true;
  showSection(loadingCard);
  setStep('download');

  try {
    // Step 1 — fetch audio from server
    const res = await fetch('/api/fetch-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const title      = res.headers.get('X-Video-Title') || 'Transcript';
    const audioBlob  = await res.blob();

    // Step 2 — decode audio in browser
    setStep('transcribe');
    const float32 = await decodeAudioTo16kHz(audioBlob);

    // Step 3 — send to worker (transfer ownership to avoid copy)
    state.title = title;
    state.url   = url;
    worker.postMessage({ type: 'transcribe', audio: float32 }, [float32.buffer]);

  } catch (err) {
    showError(err.message || 'Failed. Please try again.');
    transcribeBtn.disabled = false;
  }
}

transcribeBtn.addEventListener('click', doTranscribe);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doTranscribe(); });
errorRetryBtn.addEventListener('click', () => showSection(null));

/* ─── Handle Transcript Result ──────────────────────────────────────────────── */
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
    const ts = `[${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}]`;
    return `${ts} ${chunk.text.trim()}`;
  }).join('\n');
}

function handleTranscriptResult(result) {
  state.plain       = formatPlain(result);
  state.timestamped = formatTimestamped(result);

  videoTitle.textContent     = state.title;
  transcriptText.textContent = state.plain;
  setView('timestamped');
  showSection(resultsCard);
  transcribeBtn.disabled = false;
}

/* ─── Toggle Plain / Timestamped ───────────────────────────────────────────── */
function setView(view) {
  state.view = view;
  transcriptText.textContent = view === 'plain' ? state.plain : state.timestamped;
  btnPlain.classList.toggle('active', view === 'plain');
  btnTimestamped.classList.toggle('active', view === 'timestamped');
}
btnPlain.addEventListener('click',       () => setView('plain'));
btnTimestamped.addEventListener('click', () => setView('timestamped'));

/* ─── Copy to Clipboard ────────────────────────────────────────────────────── */
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
    setTimeout(() => { copyBtn.innerHTML = '<span class="copy-icon">📋</span> Copy'; }, 1500);
  }
});

/* ─── Download Transcript ───────────────────────────────────────────────────── */
function safeFilename(title) {
  return (title || 'transcript').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
}
function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}
dlPlainBtn.addEventListener('click', () => downloadText(state.plain,       `${safeFilename(state.title)}_plain.txt`));
dlTsBtn.addEventListener('click',   () => downloadText(state.timestamped,  `${safeFilename(state.title)}_timestamped.txt`));

/* ─── Download Video ────────────────────────────────────────────────────────── */
dlVideoBtn.addEventListener('click', async () => {
  if (!state.url) return;
  dlVideoBtn.disabled     = true;
  videoProgress.hidden    = false;
  progressLabel.textContent = 'Downloading highest quality video…';

  try {
    const res = await fetch('/api/download-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: state.url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const match       = disposition.match(/filename="?([^"]+)"?/);
    const filename    = match ? match[1] : 'video.mp4';

    const blob = await res.blob();
    const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
    a.click();
    URL.revokeObjectURL(a.href);

    progressLabel.textContent = '✓ Video downloaded!';
    setTimeout(() => { videoProgress.hidden = true; }, 2500);
  } catch (err) {
    progressLabel.textContent = `Error: ${err.message}`;
    setTimeout(() => { videoProgress.hidden = true; }, 3500);
  } finally {
    dlVideoBtn.disabled = false;
  }
});
