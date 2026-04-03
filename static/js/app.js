/* ─────────────────────────────────────────────────────────────────────────────
   app.js  ·  Server-driven UI
   Media transcription, downloads, and file tools all run on the Raspberry Pi.
───────────────────────────────────────────────────────────────────────────── */

const navTranscribe = document.getElementById('nav-transcribe');
const navTools = document.getElementById('nav-tools');
const viewTranscribe = document.getElementById('view-transcribe');
const viewTools = document.getElementById('view-tools');

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
const copyHint = document.getElementById('copy-hint');

const imagesToPdfForm = document.getElementById('images-to-pdf-form');
const imagesToPdfFiles = document.getElementById('images-to-pdf-files');
const imagesToPdfOrderEmpty = document.getElementById('images-to-pdf-order-empty');
const imagesToPdfOrderList = document.getElementById('images-to-pdf-order-list');
const imagesToPdfStatus = document.getElementById('images-to-pdf-status');
const imagesToPdfSubmit = document.getElementById('images-to-pdf-submit');

const imageConvertForm = document.getElementById('image-convert-form');
const imageConvertFiles = document.getElementById('image-convert-files');
const imageConvertFormat = document.getElementById('image-convert-format');
const imageConvertStatus = document.getElementById('image-convert-status');
const imageConvertSubmit = document.getElementById('image-convert-submit');

const pdfToImagesForm = document.getElementById('pdf-to-images-form');
const pdfToImagesFile = document.getElementById('pdf-to-images-file');
const pdfToImagesFormat = document.getElementById('pdf-to-images-format');
const pdfToImagesMode = document.getElementById('pdf-to-images-mode');
const pdfToImagesPageField = document.getElementById('pdf-to-images-page-field');
const pdfToImagesPage = document.getElementById('pdf-to-images-page');
const pdfToImagesStatus = document.getElementById('pdf-to-images-status');
const pdfToImagesSubmit = document.getElementById('pdf-to-images-submit');

const compressPdfForm = document.getElementById('compress-pdf-form');
const compressPdfFile = document.getElementById('compress-pdf-file');
const compressPdfPreset = document.getElementById('compress-pdf-preset');
const compressPdfStatus = document.getElementById('compress-pdf-status');
const compressPdfSubmit = document.getElementById('compress-pdf-submit');

const state = {
  plain: '',
  timestamped: '',
  title: '',
  url: '',
  view: 'timestamped',
  downloadMeta: null,
  activeView: 'transcribe',
  toolFiles: {
    imagesToPdf: [],
  },
};

const platformMeta = {
  youtube: { label: 'YouTube', icon: '▶' },
  instagram: { label: 'Instagram', icon: '📸' },
  tiktok: { label: 'TikTok', icon: '🎵' },
  vsco: { label: 'VSCO', icon: '🖼' },
};

initializeServerMode();
renderToolOrder();
setActiveView('transcribe');
togglePdfPageField();

function initializeServerMode() {
  modelStatusBar.classList.add('ready');
  modelSpinner.classList.add('done');
  modelStatusText.textContent = 'Server-side mode: transcription and file tools run on the Raspberry Pi';
  modelDeviceBadge.textContent = 'PI';
  modelDeviceBadge.className = 'model-device-badge visible server';
  modelProgressFill.style.width = '100%';
  transcribeBtn.disabled = false;
  transcribeBtnText.textContent = 'Transcribe on Raspberry Pi';
}

function setActiveView(view) {
  state.activeView = view;
  const isTranscribe = view === 'transcribe';
  navTranscribe.classList.toggle('active', isTranscribe);
  navTools.classList.toggle('active', !isTranscribe);
  viewTranscribe.hidden = !isTranscribe;
  viewTools.hidden = isTranscribe;
  viewTranscribe.classList.toggle('active', isTranscribe);
  viewTools.classList.toggle('active', !isTranscribe);
}

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
  if (platform === 'vsco') {
    transcribeBtn.disabled = true;
    transcribeBtnText.textContent = 'VSCO is download only';
    return;
  }

  transcribeBtn.disabled = false;
  transcribeBtnText.textContent = 'Transcribe on Raspberry Pi';
}

function showSection(el) {
  [loadingCard, errorCard, resultsCard].forEach(card => { card.hidden = true; });
  if (el) el.hidden = false;
}

function showError(message) {
  errorText.textContent = message;
  showSection(errorCard);
  updateTranscribeAvailability(detectPlatform(urlInput.value.trim()));
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

  transcribeBtn.disabled = true;
  analyzeBtn.disabled = true;
  showSection(loadingCard);
  setStep('download');

  try {
    const res = await fetch('/api/transcribe-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const payload = await res.json();
    setStep('transcribe');
    state.title = payload.title || 'Transcript';
    state.url = url;
    handleTranscriptResult(payload.result);
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
  copyHint.hidden = true;
  copyHint.textContent = '';
  showSection(resultsCard);
  updateTranscribeAvailability(detectPlatform(urlInput.value.trim()));
}

function setView(view) {
  state.view = view;
  transcriptText.textContent = view === 'plain' ? state.plain : state.timestamped;
  btnPlain.classList.toggle('active', view === 'plain');
  btnTimestamped.classList.toggle('active', view === 'timestamped');
}

function safeFilename(title) {
  return (title || 'transcript').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function selectTranscriptForManualCopy() {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(transcriptText);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

async function copyTranscriptText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }

  if (copied) return true;
  throw new Error('Copy not supported');
}

function flashCopyState(label, className, timeout = 1800) {
  copyBtn.innerHTML = `<span class="copy-icon">${className === 'copied' ? '✓' : '📋'}</span> ${label}`;
  copyBtn.classList.remove('copied', 'manual');
  if (className) copyBtn.classList.add(className);
  window.setTimeout(() => {
    copyBtn.innerHTML = '<span class="copy-icon">📋</span> Copy';
    copyBtn.classList.remove('copied', 'manual');
  }, timeout);
}

function renderToolOrder() {
  const files = state.toolFiles.imagesToPdf;
  imagesToPdfOrderList.innerHTML = '';
  const hasFiles = files.length > 0;
  imagesToPdfOrderList.hidden = !hasFiles;
  imagesToPdfOrderEmpty.hidden = hasFiles;

  files.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'sort-row';

    const label = document.createElement('div');
    label.className = 'sort-label';
    label.textContent = `${index + 1}. ${file.name}`;
    row.appendChild(label);

    const controls = document.createElement('div');
    controls.className = 'sort-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'sort-btn';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveImageOrder(index, index - 1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'sort-btn';
    downBtn.textContent = '↓';
    downBtn.disabled = index === files.length - 1;
    downBtn.addEventListener('click', () => moveImageOrder(index, index + 1));

    controls.append(upBtn, downBtn);
    row.appendChild(controls);
    imagesToPdfOrderList.appendChild(row);
  });
}

function moveImageOrder(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.toolFiles.imagesToPdf.length) return;
  const next = [...state.toolFiles.imagesToPdf];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  state.toolFiles.imagesToPdf = next;
  renderToolOrder();
}

function togglePdfPageField() {
  const isSingle = pdfToImagesMode.value === 'single';
  pdfToImagesPageField.hidden = !isSingle;
  pdfToImagesPage.required = isSingle;
}

function setToolStatus(el, tone, message) {
  el.textContent = message || '';
  el.className = 'tool-status';
  if (!message) return;
  if (tone) el.classList.add(tone);
}

function readFilenameFromDisposition(headers, fallback) {
  const disposition = headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^"]+)"?/i);
  return match ? decodeURIComponent(match[1].replace(/"/g, '')) : fallback;
}

function triggerBlobDownload(blob, filename) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function submitToolRequest({ endpoint, formData, submitBtn, statusEl, startLabel, successLabel }) {
  submitBtn.disabled = true;
  setToolStatus(statusEl, 'pending', startLabel);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    const filename = readFilenameFromDisposition(res.headers, 'download.bin');
    const blob = await res.blob();
    triggerBlobDownload(blob, filename);
    setToolStatus(statusEl, 'success', successLabel || `Downloaded ${filename}`);
  } catch (err) {
    setToolStatus(statusEl, 'error', err.message || 'Tool request failed.');
  } finally {
    submitBtn.disabled = false;
  }
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

    const filename = readFilenameFromDisposition(res.headers, 'download.bin');
    const blob = await res.blob();
    triggerBlobDownload(blob, filename);

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

navTranscribe.addEventListener('click', () => setActiveView('transcribe'));
navTools.addEventListener('click', () => setActiveView('tools'));

urlInput.addEventListener('input', () => {
  state.url = urlInput.value.trim();
  state.downloadMeta = null;
  downloadCard.hidden = true;
  const platform = detectPlatform(state.url);
  renderPlatformBadge(platform);
  updateTranscribeAvailability(platform);
});
urlInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') loadDownloadOptions();
});

analyzeBtn.addEventListener('click', loadDownloadOptions);
downloadKindSelect.addEventListener('change', event => populateDownloadOptionSelect(event.target.value));
downloadSelectedBtn.addEventListener('click', downloadSelectedMedia);
transcribeBtn.addEventListener('click', doTranscribe);
btnPlain.addEventListener('click', () => setView('plain'));
btnTimestamped.addEventListener('click', () => setView('timestamped'));
errorRetryBtn.addEventListener('click', () => showSection(null));

dlPlainBtn.addEventListener('click', () => {
  if (!state.plain) return;
  downloadText(state.plain, `${safeFilename(state.title)}_plain.txt`);
});

dlTsBtn.addEventListener('click', () => {
  if (!state.timestamped) return;
  downloadText(state.timestamped, `${safeFilename(state.title)}_timestamped.txt`);
});

copyBtn.addEventListener('click', async () => {
  const text = state.view === 'plain' ? state.plain : state.timestamped;
  if (!text) return;

  copyHint.hidden = true;
  copyHint.textContent = '';

  try {
    await copyTranscriptText(text);
    flashCopyState('Copied!', 'copied');
  } catch {
    const selected = selectTranscriptForManualCopy();
    if (selected) {
      copyHint.hidden = false;
      copyHint.textContent = 'Copy fallback: the transcript is selected. Use your phone’s copy action.';
      flashCopyState('Select + Copy', 'manual', 2400);
    } else {
      copyHint.hidden = false;
      copyHint.textContent = 'Copy failed on this device.';
      flashCopyState('Failed', '', 1800);
    }
  }
});

imagesToPdfFiles.addEventListener('change', () => {
  state.toolFiles.imagesToPdf = Array.from(imagesToPdfFiles.files || []);
  renderToolOrder();
  setToolStatus(imagesToPdfStatus, '', '');
});

imageConvertFiles.addEventListener('change', () => setToolStatus(imageConvertStatus, '', ''));
pdfToImagesFile.addEventListener('change', () => setToolStatus(pdfToImagesStatus, '', ''));
compressPdfFile.addEventListener('change', () => setToolStatus(compressPdfStatus, '', ''));
pdfToImagesMode.addEventListener('change', togglePdfPageField);

imagesToPdfForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.toolFiles.imagesToPdf.length) {
    setToolStatus(imagesToPdfStatus, 'error', 'Upload at least one image.');
    return;
  }
  const formData = new FormData();
  state.toolFiles.imagesToPdf.forEach(file => formData.append('files', file, file.name));
  formData.append('order', state.toolFiles.imagesToPdf.map(file => file.name).join(','));
  await submitToolRequest({
    endpoint: '/api/tools/images-to-pdf',
    formData,
    submitBtn: imagesToPdfSubmit,
    statusEl: imagesToPdfStatus,
    startLabel: 'Building PDF…',
    successLabel: 'PDF ready.',
  });
});

imageConvertForm.addEventListener('submit', async event => {
  event.preventDefault();
  const files = Array.from(imageConvertFiles.files || []);
  if (!files.length) {
    setToolStatus(imageConvertStatus, 'error', 'Upload at least one image.');
    return;
  }
  const formData = new FormData();
  files.forEach(file => formData.append('files', file, file.name));
  formData.append('target_format', imageConvertFormat.value);
  await submitToolRequest({
    endpoint: '/api/tools/image-convert',
    formData,
    submitBtn: imageConvertSubmit,
    statusEl: imageConvertStatus,
    startLabel: 'Converting images…',
    successLabel: 'Converted files ready.',
  });
});

pdfToImagesForm.addEventListener('submit', async event => {
  event.preventDefault();
  const file = pdfToImagesFile.files?.[0];
  if (!file) {
    setToolStatus(pdfToImagesStatus, 'error', 'Upload a PDF first.');
    return;
  }
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('target_format', pdfToImagesFormat.value);
  formData.append('mode', pdfToImagesMode.value);
  if (pdfToImagesMode.value === 'single') {
    formData.append('page', pdfToImagesPage.value.trim());
  }
  await submitToolRequest({
    endpoint: '/api/tools/pdf-to-images',
    formData,
    submitBtn: pdfToImagesSubmit,
    statusEl: pdfToImagesStatus,
    startLabel: 'Exporting page images…',
    successLabel: 'Image export ready.',
  });
});

compressPdfForm.addEventListener('submit', async event => {
  event.preventDefault();
  const file = compressPdfFile.files?.[0];
  if (!file) {
    setToolStatus(compressPdfStatus, 'error', 'Upload a PDF first.');
    return;
  }
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('preset', compressPdfPreset.value);
  await submitToolRequest({
    endpoint: '/api/tools/compress-pdf',
    formData,
    submitBtn: compressPdfSubmit,
    statusEl: compressPdfStatus,
    startLabel: 'Compressing PDF…',
    successLabel: 'Compressed PDF ready.',
  });
});
