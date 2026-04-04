/* =============================================================================
   app.js — Two-panel UI: left controls + right sticky preview
   All processing runs server-side on the Raspberry Pi.
   ============================================================================= */

// ─── PDF.js (lazy-loaded on first PDF upload) ────────────────────────────────
let pdfjsLib = null;

async function ensurePdfjsLoaded() {
  if (pdfjsLib) return pdfjsLib;
  try {
    const mod = await import(
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs'
    );
    mod.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
    pdfjsLib = mod;
    return pdfjsLib;
  } catch {
    return null;
  }
}

// ─── Caches ───────────────────────────────────────────────────────────────────
const pdfGridCache  = new Map(); // file.name → grid Element (avoids re-rendering)
const pdfNavCache   = new Map(); // file.name → nav Element
const imageUrlCache = new Map(); // File object → object URL string

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  url: '',
  downloadMeta: null,
  modelReady: false,

  uploadedImages: [],
  uploadedPdfs: [],

  imageAction: 'convert',
  imageConvertFormat: 'jpg',

  pdfAction: 'compress',
  pdfCompressPreset: 'small',
  pdfExportFormat: 'png',
  pdfPageModes: {},       // { [filename]: 'all' | 'select' }
  pdfPageSelections: {},  // { [filename]: Set<number> }

  jobs: [],
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const modelStatusBar    = document.getElementById('model-status-bar');
const modelStatusText   = document.getElementById('model-status-text');
const modelDeviceBadge  = document.getElementById('model-device-badge');

const urlInput          = document.getElementById('url-input');
const platformIcon      = document.getElementById('platform-icon');
const platformBadge     = document.getElementById('platform-badge');
const urlAnalyzeSpinner = document.getElementById('url-analyze-spinner');
const urlOptions        = document.getElementById('url-options');
const urlMediaTitle     = document.getElementById('url-media-title');
const dlPlatformBadge   = document.getElementById('download-platform-badge');
const downloadKind      = document.getElementById('download-kind');
const downloadOption    = document.getElementById('download-option');
const downloadBtn       = document.getElementById('download-btn');
const transcribeBtn     = document.getElementById('transcribe-btn');
const transcribeBtnText = document.getElementById('transcribe-btn-text');

const mobileAddFilesBtn = document.getElementById('mobile-add-files-btn');
const fileInput         = document.getElementById('file-input');

const fileActionsSection= document.getElementById('file-actions-section');
const imagesGroup       = document.getElementById('images-group');
const imagesGroupTitle  = document.getElementById('images-group-title');
const imagesFileList    = document.getElementById('images-file-list');
const clearImagesBtn    = document.getElementById('clear-images-btn');
const imgActionConvert  = document.getElementById('img-action-convert');
const imgActionToPdf    = document.getElementById('img-action-topdf');
const imgConvertOpts    = document.getElementById('img-convert-opts');
const imgConvertFormat  = document.getElementById('img-convert-format');
const imagesSubmitBtn   = document.getElementById('images-submit-btn');

const pdfsGroup         = document.getElementById('pdfs-group');
const pdfsGroupTitle    = document.getElementById('pdfs-group-title');
const pdfsFileList      = document.getElementById('pdfs-file-list');
const clearPdfsBtn      = document.getElementById('clear-pdfs-btn');
const pdfActionCompress = document.getElementById('pdf-action-compress');
const pdfActionToImages = document.getElementById('pdf-action-toimages');
const pdfCompressOpts   = document.getElementById('pdf-compress-opts');
const pdfToImagesOpts   = document.getElementById('pdf-to-images-opts');
const pdfCompressPreset = document.getElementById('pdf-compress-preset');
const pdfExportFormat   = document.getElementById('pdf-export-format');
const pdfsSubmitBtn     = document.getElementById('pdfs-submit-btn');

const jobsSection       = document.getElementById('jobs-section');
const jobsList          = document.getElementById('jobs-list');

const previewPanel      = document.getElementById('preview-panel');
const previewEmptyState = document.getElementById('preview-empty-state');
const previewContent    = document.getElementById('preview-content');
const previewCloseBtn   = document.getElementById('preview-close-btn');
const browseBtn         = document.getElementById('browse-btn');
const mobilePreviewFab  = document.getElementById('mobile-preview-fab');

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function looksLikeUrl(s) { return /^https?:\/\/.{6,}/.test(s); }

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractFilename(cd) {
  if (!cd) return 'download';
  const m = cd.match(/filename[^;=\n]*=\s*(?:UTF-8'')?["']?([^"';\n]*)["']?/i);
  return m ? decodeURIComponent(m[1].trim()) : 'download';
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ─── Platform detection ───────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'youtube',   label: 'YouTube',   icon: '▶',  re: /youtube\.com|youtu\.be/ },
  { id: 'instagram', label: 'Instagram', icon: '📸', re: /instagram\.com/ },
  { id: 'tiktok',    label: 'TikTok',    icon: '🎵', re: /tiktok\.com/ },
  { id: 'vsco',      label: 'VSCO',      icon: '🖼', re: /vsco\.co/ },
];

function detectPlatform(url) {
  return PLATFORMS.find(p => p.re.test(url)) ?? null;
}

function renderPlatformBadge(platform) {
  if (!platform) {
    platformIcon.textContent = '🔗';
    platformBadge.textContent = '';
    platformBadge.className = 'platform-badge';
    return;
  }
  platformIcon.textContent = platform.icon;
  platformBadge.textContent = platform.label;
  platformBadge.className = `platform-badge visible ${platform.id}`;
}

// ─── Model status ─────────────────────────────────────────────────────────────
async function initializeServerMode() {
  modelStatusBar.hidden = false;
  modelStatusText.textContent = 'Checking transcription model…';
  modelDeviceBadge.textContent = 'PI';

  try {
    const res = await fetch('/api/model-status');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.ready) {
      modelStatusBar.classList.add('ready');
      modelStatusText.textContent = 'Transcription ready';
      modelDeviceBadge.textContent = data.device || 'PI';
      state.modelReady = true;
      transcribeBtn.disabled = !looksLikeUrl(state.url);
      transcribeBtnText.textContent = 'Transcribe';
    } else {
      modelStatusText.textContent = data.status || 'Loading model…';
      setTimeout(initializeServerMode, 3000);
    }
  } catch {
    modelStatusBar.hidden = true;
    state.modelReady = true;
    transcribeBtn.disabled = !looksLikeUrl(state.url);
    transcribeBtnText.textContent = 'Transcribe';
  }
}

// ─── URL auto-analyze ─────────────────────────────────────────────────────────
let analyzeTimer = null;

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  state.url = url;
  state.downloadMeta = null;
  urlOptions.hidden = true;
  downloadBtn.disabled = true;
  transcribeBtn.disabled = true;
  clearTimeout(analyzeTimer);
  renderPlatformBadge(detectPlatform(url));
  if (!looksLikeUrl(url)) { setUrlSpinner(false); return; }
  setUrlSpinner(true);
  analyzeTimer = setTimeout(() => autoAnalyzeUrl(url), 600);
});

function setUrlSpinner(v) { urlAnalyzeSpinner.classList.toggle('visible', v); }

async function autoAnalyzeUrl(url) {
  try {
    const res = await fetch('/api/media-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (urlInput.value.trim() !== url) return;
    setUrlSpinner(false);
    if (!res.ok) return;
    const meta = await res.json();
    if (!meta.options?.length) return;
    renderDownloadMeta(meta, url);
  } catch { setUrlSpinner(false); }
}

function renderDownloadMeta(meta, url) {
  state.downloadMeta = meta;
  urlMediaTitle.textContent = meta.title || url;
  const p = detectPlatform(url || state.url);
  if (p) { dlPlatformBadge.textContent = p.label; dlPlatformBadge.className = `platform-badge visible ${p.id}`; }
  else    { dlPlatformBadge.className = 'platform-badge'; }
  const kinds = [...new Set(meta.options.map(o => o.kind))];
  downloadKind.innerHTML = kinds.map(k =>
    `<option value="${k}">${k==='mp4'?'Video (MP4)':k==='mp3'?'Audio (MP3)':k}</option>`
  ).join('');
  updateQualityOptions();
  downloadKind.addEventListener('change', updateQualityOptions);
  urlOptions.hidden = false;
  downloadBtn.disabled = false;
  if (state.modelReady) transcribeBtn.disabled = false;
}

function updateQualityOptions() {
  if (!state.downloadMeta) return;
  const opts = state.downloadMeta.options.filter(o => o.kind === downloadKind.value);
  downloadOption.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
}

// ─── Network request helper ───────────────────────────────────────────────────
async function sendRequest(endpoint, formData) {
  const res = await fetch(endpoint, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }
  const filename = extractFilename(res.headers.get('Content-Disposition'));
  const blob = await res.blob();
  return { blob, filename };
}

// ─── Job system ───────────────────────────────────────────────────────────────
function addJob(partial) {
  const job = {
    id: uid(), type: 'generic', label: '', status: 'pending',
    step: null, blobUrl: null, filename: null,
    transcript: null, transcriptView: 'timestamped',
    errorMsg: null, retryFn: null,
    ...partial,
  };
  state.jobs.push(job);
  jobsSection.hidden = false;
  renderJobCard(job.id);
  return job.id;
}

function updateJob(id, patch) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  Object.assign(job, patch);
  renderJobCard(id);
}

async function runFileJob(jobId, fn) {
  updateJob(jobId, { status: 'processing', step: 'Processing…' });
  try {
    const { blob, filename } = await fn();
    updateJob(jobId, { status: 'done', step: null, blobUrl: URL.createObjectURL(blob), filename });
  } catch (err) {
    updateJob(jobId, { status: 'error', step: null, errorMsg: err.message });
  }
}

const JOB_ICONS = {
  'transcribe': '🎙', 'download-media': '⬇',
  'compress-pdf': '📄', 'pdf-to-images': '📑',
  'convert-image': '🖼', 'images-to-pdf': '📋',
};

function renderJobCard(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;

  let card = jobsList.querySelector(`[data-job-id="${id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'job-card';
    card.dataset.jobId = id;
    jobsList.prepend(card);
  }

  const icon = JOB_ICONS[job.type] || '⚙';

  let iconHtml;
  if (job.status === 'processing' || job.status === 'pending') {
    iconHtml = `<div class="job-icon"><div class="job-icon-spinner"></div></div>`;
  } else if (job.status === 'done') {
    iconHtml = `<div class="job-icon" style="background:var(--success-bg);border-color:var(--success-border)">${icon}</div>`;
  } else if (job.status === 'error') {
    iconHtml = `<div class="job-icon" style="background:var(--error-bg);border-color:var(--error-border)">✕</div>`;
  } else {
    iconHtml = `<div class="job-icon">${icon}</div>`;
  }

  let statusText;
  if (job.status === 'pending') statusText = `<p class="job-status-text">Pending…</p>`;
  else if (job.status === 'processing') statusText = `<p class="job-status-text">${escHtml(job.step||'Processing…')}</p>`;
  else if (job.status === 'done' && job.transcript) statusText = `<p class="job-status-text success">Transcript ready</p>`;
  else if (job.status === 'done') statusText = `<p class="job-status-text success">Done · ${escHtml(job.filename||'file ready')}</p>`;
  else statusText = `<p class="job-status-text error">${escHtml(job.errorMsg||'Error')}</p>`;

  let actionsHtml = '';
  if (job.status === 'done' && job.blobUrl) {
    actionsHtml = `<div class="job-actions"><a class="btn btn-primary btn-sm" href="${job.blobUrl}" download="${escHtml(job.filename||'download')}">⬇</a></div>`;
  } else if (job.status === 'done' && job.transcript) {
    actionsHtml = `<div class="job-actions"><button class="btn btn-secondary btn-sm" data-action="toggle-transcript" data-id="${id}">View</button></div>`;
  } else if (job.status === 'error' && job.retryFn) {
    actionsHtml = `<div class="job-actions"><button class="btn btn-ghost btn-sm" data-action="retry" data-id="${id}">Retry</button></div>`;
  }

  let transcriptHtml = '';
  if (job.transcript) {
    const isOpen = card.classList.contains('transcript-open');
    const text = job.transcriptView === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    transcriptHtml = `
      <div class="job-transcript" ${isOpen ? '' : 'hidden'}>
        <div class="transcript-view-toggle">
          <button class="transcript-toggle-btn ${job.transcriptView==='timestamped'?'active':''}" data-action="set-view" data-id="${id}" data-view="timestamped">Timestamped</button>
          <button class="transcript-toggle-btn ${job.transcriptView==='plain'?'active':''}" data-action="set-view" data-id="${id}" data-view="plain">Plain</button>
        </div>
        <pre class="transcript-pre">${escHtml(text)}</pre>
        <div class="transcript-actions">
          <button class="btn btn-secondary btn-sm" data-action="copy-transcript" data-id="${id}">📋 Copy</button>
          <button class="btn btn-ghost btn-sm" data-action="dl-transcript" data-id="${id}" data-view="plain">⬇ Plain</button>
          <button class="btn btn-ghost btn-sm" data-action="dl-transcript" data-id="${id}" data-view="timestamped">⬇ Timestamped</button>
        </div>
      </div>`;
  }

  card.innerHTML = `<div class="job-card-top">${iconHtml}<div class="job-body"><p class="job-label">${escHtml(job.label)}</p>${statusText}</div>${actionsHtml}</div>${transcriptHtml}`;
}

jobsList.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, view } = btn.dataset;
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;

  if (action === 'toggle-transcript') {
    const card = jobsList.querySelector(`[data-job-id="${id}"]`);
    const isOpen = card.classList.toggle('transcript-open');
    card.querySelector('.job-transcript').hidden = !isOpen;
    btn.textContent = isOpen ? 'Hide' : 'View';
  }
  if (action === 'set-view') updateJob(id, { transcriptView: view });
  if (action === 'copy-transcript') {
    const text = job.transcriptView === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    navigator.clipboard?.writeText(text).catch(() => {});
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  }
  if (action === 'dl-transcript') {
    const t = view === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    triggerBlobDownload(new Blob([t], { type: 'text/plain;charset=utf-8' }), `transcript-${view}.txt`);
  }
  if (action === 'retry' && job.retryFn) job.retryFn();
});

// ─── Download / Transcribe ────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  if (!state.downloadMeta) return;
  const label = state.downloadMeta.title || state.url;
  const jobId = addJob({ type: 'download-media', label, status: 'pending' });
  const doIt = () => runFileJob(jobId, async () => {
    const fd = new FormData();
    fd.append('url', state.url);
    fd.append('kind', downloadKind.value);
    fd.append('value', downloadOption.value);
    return sendRequest('/api/download-media', fd);
  });
  updateJob(jobId, { retryFn: doIt });
  doIt();
});

transcribeBtn.addEventListener('click', () => {
  if (!looksLikeUrl(state.url)) return;
  const label = state.downloadMeta?.title || state.url;
  const jobId = addJob({ type: 'transcribe', label, status: 'pending' });
  const doIt = () => runTranscribeJob(jobId, state.url);
  updateJob(jobId, { retryFn: doIt });
  doIt();
});

async function runTranscribeJob(jobId, url) {
  updateJob(jobId, { status: 'processing', step: 'Fetching audio…' });
  try {
    const fd = new FormData();
    fd.append('url', url);
    const res = await fetch('/api/transcribe-server', { method: 'POST', body: fd });
    updateJob(jobId, { step: 'Transcribing on Pi…' });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||`Server error ${res.status}`); }
    const data = await res.json();
    updateJob(jobId, {
      status: 'done', step: null,
      transcript: { plain: data.plain||'', timestamped: data.timestamped||'' },
      transcriptView: 'timestamped',
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', step: null, errorMsg: err.message });
  }
}

// ─── File input ───────────────────────────────────────────────────────────────
fileInput.addEventListener('change', () => {
  appendFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
mobileAddFilesBtn.addEventListener('click', () => fileInput.click());

function appendFiles(newFiles) {
  const images = newFiles.filter(f => /\.(jpe?g|png|webp)$/i.test(f.name));
  const pdfs   = newFiles.filter(f => /\.pdf$/i.test(f.name));
  const dedup  = (ex, inc) => inc.filter(n => !ex.some(e => e.name===n.name && e.size===n.size));
  state.uploadedImages.push(...dedup(state.uploadedImages, images));
  state.uploadedPdfs.push(...dedup(state.uploadedPdfs, pdfs));
  renderLeftPanel();
  renderPreviewPanel();
}

// ─── Right panel: drop zone ───────────────────────────────────────────────────
previewEmptyState.addEventListener('click', () => fileInput.click());

previewPanel.addEventListener('dragover', e => {
  e.preventDefault();
  previewEmptyState.classList.add('drag-active');
});
previewPanel.addEventListener('dragleave', e => {
  if (!previewPanel.contains(e.relatedTarget)) previewEmptyState.classList.remove('drag-active');
});
previewPanel.addEventListener('drop', e => {
  e.preventDefault();
  previewEmptyState.classList.remove('drag-active');
  appendFiles(Array.from(e.dataTransfer.files));
});

// ─── Mobile overlay ───────────────────────────────────────────────────────────
mobilePreviewFab.addEventListener('click', () => {
  previewPanel.classList.add('open');
  document.body.style.overflow = 'hidden';
});

previewCloseBtn.addEventListener('click', () => {
  previewPanel.classList.remove('open');
  document.body.style.overflow = '';
});

function updateMobileFab() {
  const count = state.uploadedImages.length + state.uploadedPdfs.length;
  mobilePreviewFab.hidden = count === 0;
  if (count > 0) {
    mobilePreviewFab.textContent = `View preview (${count} file${count!==1?'s':''})`;
  }
}

// ─── Left panel rendering ─────────────────────────────────────────────────────
function renderLeftPanel() {
  const hasImages = state.uploadedImages.length > 0;
  const hasPdfs   = state.uploadedPdfs.length > 0;

  fileActionsSection.hidden = !hasImages && !hasPdfs;
  imagesGroup.hidden = !hasImages;
  pdfsGroup.hidden   = !hasPdfs;

  if (hasImages) {
    imagesGroupTitle.textContent = `${state.uploadedImages.length} image${state.uploadedImages.length!==1?'s':''}`;
    renderFileList(imagesFileList, state.uploadedImages, '🖼', removeImage);
  }

  if (hasPdfs) {
    pdfsGroupTitle.textContent = `${state.uploadedPdfs.length} PDF${state.uploadedPdfs.length!==1?'s':''}`;
    renderFileList(pdfsFileList, state.uploadedPdfs, '📄', removePdf);
  }

  updateMobileFab();
}

function renderFileList(container, files, icon, removeFn) {
  container.innerHTML = '';
  files.forEach((file, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="file-row-icon">${icon}</span>
      <span class="file-row-name">${escHtml(file.name)}</span>
      <span class="file-row-size">${formatBytes(file.size)}</span>
      <button class="file-row-remove" type="button" title="Remove">✕</button>
    `;
    row.querySelector('.file-row-remove').addEventListener('click', () => removeFn(i));
    container.appendChild(row);
  });
}

function removeImage(i) {
  const file = state.uploadedImages[i];
  const url = imageUrlCache.get(file);
  if (url) { URL.revokeObjectURL(url); imageUrlCache.delete(file); }
  state.uploadedImages.splice(i, 1);
  renderLeftPanel();
  renderPreviewPanel();
}

function removePdf(i) {
  const file = state.uploadedPdfs[i];
  pdfGridCache.delete(file.name);
  pdfNavCache.delete(file.name);
  delete state.pdfPageModes[file.name];
  delete state.pdfPageSelections[file.name];
  state.uploadedPdfs.splice(i, 1);
  renderLeftPanel();
  renderPreviewPanel();
}

// ─── Image action choice ──────────────────────────────────────────────────────
imgActionConvert.addEventListener('click', () => setImageAction('convert'));
imgActionToPdf.addEventListener('click',   () => setImageAction('to-pdf'));

function setImageAction(a) {
  state.imageAction = a;
  imgActionConvert.classList.toggle('active', a==='convert');
  imgActionToPdf.classList.toggle('active',   a==='to-pdf');
  imgConvertOpts.hidden = a !== 'convert';
  renderPreviewPanel();
}

imgConvertFormat.addEventListener('change', () => {
  state.imageConvertFormat = imgConvertFormat.value;
  renderPreviewPanel();
});

// ─── PDF action choice ────────────────────────────────────────────────────────
pdfActionCompress.addEventListener('click', () => setPdfAction('compress'));
pdfActionToImages.addEventListener('click', () => setPdfAction('to-images'));

function setPdfAction(a) {
  state.pdfAction = a;
  pdfActionCompress.classList.toggle('active', a==='compress');
  pdfActionToImages.classList.toggle('active', a==='to-images');
  pdfCompressOpts.hidden   = a !== 'compress';
  pdfToImagesOpts.hidden   = a !== 'to-images';
  renderPreviewPanel();
}

pdfCompressPreset.addEventListener('change', () => { state.pdfCompressPreset = pdfCompressPreset.value; });
pdfExportFormat.addEventListener('change',   () => { state.pdfExportFormat   = pdfExportFormat.value; renderPreviewPanel(); });

// ─── Clear buttons ────────────────────────────────────────────────────────────
clearImagesBtn.addEventListener('click', () => {
  state.uploadedImages.forEach(f => {
    const url = imageUrlCache.get(f);
    if (url) { URL.revokeObjectURL(url); imageUrlCache.delete(f); }
  });
  state.uploadedImages = [];
  renderLeftPanel(); renderPreviewPanel();
});

clearPdfsBtn.addEventListener('click', () => {
  state.uploadedPdfs.forEach(f => { pdfGridCache.delete(f.name); pdfNavCache.delete(f.name); });
  state.uploadedPdfs = [];
  state.pdfPageModes = {};
  state.pdfPageSelections = {};
  renderLeftPanel(); renderPreviewPanel();
});

// ─── PREVIEW PANEL RENDERING ─────────────────────────────────────────────────
function renderPreviewPanel() {
  const hasImages = state.uploadedImages.length > 0;
  const hasPdfs   = state.uploadedPdfs.length > 0;
  const isEmpty   = !hasImages && !hasPdfs;

  previewEmptyState.hidden = !isEmpty;
  previewContent.hidden    = isEmpty;

  if (isEmpty) return;

  // Clear and rebuild (cached grid elements survive this via pdfGridCache)
  previewContent.innerHTML = '';

  if (hasImages) {
    if (state.imageAction === 'to-pdf') {
      previewContent.appendChild(buildImageThumbSection());
    } else {
      previewContent.appendChild(buildFileSummarySection(
        state.uploadedImages, '🖼',
        `${state.uploadedImages.length} image${state.uploadedImages.length!==1?'s':''} — converting to ${state.imageConvertFormat.toUpperCase()}`
      ));
    }
  }

  if (hasPdfs) {
    if (state.pdfAction === 'to-images') {
      previewContent.appendChild(buildPdfPagesSection());
    } else {
      previewContent.appendChild(buildFileSummarySection(
        state.uploadedPdfs, '📄',
        `${state.uploadedPdfs.length} PDF${state.uploadedPdfs.length!==1?'s':''} — compressing`
      ));
    }
  }
}

// ── Image thumbnails (drag-to-reorder) ──────────────────────────────────────
let previewDragSrcIdx = null;

function buildImageThumbSection() {
  const section = document.createElement('div');
  section.className = 'preview-section';

  const hdr = document.createElement('div');
  hdr.className = 'preview-section-header';
  hdr.innerHTML = `<p class="preview-section-title">Page order</p><p style="font-size:.72rem;color:var(--text-muted)">Drag to rearrange</p>`;

  const grid = document.createElement('div');
  grid.className = 'preview-thumb-grid';

  state.uploadedImages.forEach((file, index) => {
    let url = imageUrlCache.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      imageUrlCache.set(file, url);
    }

    const item = document.createElement('div');
    item.className = 'preview-thumb-item';
    item.draggable = true;
    item.dataset.index = index;

    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;

    const lbl = document.createElement('div');
    lbl.className = 'preview-thumb-label';
    lbl.textContent = `p${index + 1} · ${file.name}`;

    // Mobile arrows
    const arrows = document.createElement('div');
    arrows.className = 'preview-thumb-arrows';
    const up = document.createElement('button');
    up.className = 'preview-thumb-arrow'; up.textContent = '▲'; up.type = 'button';
    up.addEventListener('click', e => { e.stopPropagation(); moveImage(index, index - 1); });
    const dn = document.createElement('button');
    dn.className = 'preview-thumb-arrow'; dn.textContent = '▼'; dn.type = 'button';
    dn.addEventListener('click', e => { e.stopPropagation(); moveImage(index, index + 1); });
    arrows.appendChild(up); arrows.appendChild(dn);

    item.appendChild(img); item.appendChild(lbl); item.appendChild(arrows);

    item.addEventListener('dragstart', e => {
      previewDragSrcIdx = index;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-over');
      if (previewDragSrcIdx !== null && previewDragSrcIdx !== index) moveImage(previewDragSrcIdx, index);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging'); previewDragSrcIdx = null;
      grid.querySelectorAll('.preview-thumb-item').forEach(el => el.classList.remove('drag-over'));
    });

    grid.appendChild(item);
  });

  section.appendChild(hdr); section.appendChild(grid);
  return section;
}

function moveImage(from, to) {
  if (to < 0 || to >= state.uploadedImages.length) return;
  const arr = [...state.uploadedImages];
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  state.uploadedImages = arr;
  renderPreviewPanel();
}

// ── PDF pages section ────────────────────────────────────────────────────────
function buildPdfPagesSection() {
  const section = document.createElement('div');
  section.className = 'preview-section';

  const hdr = document.createElement('div');
  hdr.className = 'preview-section-header';
  hdr.innerHTML = `<p class="preview-section-title">${state.uploadedPdfs.length} PDF${state.uploadedPdfs.length!==1?'s':''}</p>`;
  section.appendChild(hdr);

  state.uploadedPdfs.forEach(file => {
    if (!state.pdfPageModes[file.name]) {
      state.pdfPageModes[file.name] = 'all';
      state.pdfPageSelections[file.name] = new Set();
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:24px';

    // Per-file header: filename + All/Select toggle
    const fileHdr = document.createElement('div');
    fileHdr.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap';

    const fname = document.createElement('p');
    fname.style.cssText = 'font-size:.82rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    fname.textContent = file.name;

    const toggle = document.createElement('div');
    toggle.className = 'page-mode-toggle';
    const mode = state.pdfPageModes[file.name];

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `page-mode-btn ${mode==='all'?'active':''}`;
    allBtn.textContent = 'All pages';

    const selBtn = document.createElement('button');
    selBtn.type = 'button';
    selBtn.className = `page-mode-btn ${mode==='select'?'active':''}`;
    selBtn.textContent = 'Select pages';

    allBtn.addEventListener('click', () => {
      state.pdfPageModes[file.name] = 'all';
      state.pdfPageSelections[file.name].clear();
      allBtn.classList.add('active');
      selBtn.classList.remove('active');
      wrap.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
      wrap.querySelectorAll('.pdf-page-nav-btn').forEach(t => t.classList.remove('selected'));
    });

    selBtn.addEventListener('click', () => {
      state.pdfPageModes[file.name] = 'select';
      selBtn.classList.add('active');
      allBtn.classList.remove('active');
    });

    toggle.appendChild(allBtn); toggle.appendChild(selBtn);
    fileHdr.appendChild(fname); fileHdr.appendChild(toggle);
    wrap.appendChild(fileHdr);

    // Page grid + nav — use cache so we don't re-render PDF.js on every state change
    let grid = pdfGridCache.get(file.name);
    let nav  = pdfNavCache.get(file.name);
    if (!grid) {
      nav  = document.createElement('div');
      nav.className = 'pdf-page-nav';
      grid = document.createElement('div');
      grid.className = 'preview-page-grid';
      pdfGridCache.set(file.name, grid);
      pdfNavCache.set(file.name, nav);
      loadPdfPagesIntoGrid(file, grid, nav);
    }

    wrap.appendChild(nav);
    wrap.appendChild(grid);
    section.appendChild(wrap);
  });

  return section;
}

async function loadPdfPagesIntoGrid(file, grid, nav) {
  const loading = document.createElement('p');
  loading.className = 'page-loading-msg';
  loading.textContent = 'Loading pages…';
  grid.appendChild(loading);

  const lib = await ensurePdfjsLoaded();
  if (!lib) { loading.textContent = 'PDF preview unavailable (CDN unreachable).'; return; }

  try {
    const buffer = await file.arrayBuffer();
    const pdf    = await lib.getDocument({ data: buffer }).promise;
    loading.remove();

    const sel = state.pdfPageSelections[file.name];
    const panel = document.getElementById('preview-panel');
    const navBtns = [];

    const syncSelectedState = (pageNumber, isSelected) => {
      const thumb = grid.querySelector(`.page-thumb[data-page="${pageNumber}"]`);
      const btn = navBtns[pageNumber - 1];
      thumb?.classList.toggle('selected', isSelected);
      btn?.classList.toggle('selected', isSelected);
    };

    const togglePageSelection = pageNumber => {
      if (state.pdfPageModes[file.name] !== 'select') return;
      const isSelected = sel.has(pageNumber);
      if (isSelected) sel.delete(pageNumber);
      else sel.add(pageNumber);
      syncSelectedState(pageNumber, !isSelected);
    };

    // Counter label "p X / Y" — appended after buttons so margin-left:auto pins it right
    const counter = document.createElement('span');
    counter.className = 'pdf-page-counter';
    counter.textContent = `1 / ${pdf.numPages}`;

    // IntersectionObserver: highlight nav btn for whichever page is most visible
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const idx = parseInt(entry.target.dataset.page, 10) - 1;
        navBtns.forEach((b, j) => b.classList.toggle('active', j === idx));
        counter.textContent = `${idx + 1} / ${pdf.numPages}`;
        // scroll the active nav button into view within the strip
        const activeBtn = navBtns[idx];
        if (activeBtn) {
          const stripOffset = activeBtn.offsetLeft - nav.offsetWidth / 2 + activeBtn.offsetWidth / 2;
          nav.scrollTo({ left: stripOffset, behavior: 'smooth' });
        }
      });
    }, { root: panel, threshold: 0.4 });

    for (let i = 1; i <= pdf.numPages; i++) {
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      const thumb = document.createElement('div');
      thumb.className = `page-thumb${sel?.has(i) ? ' selected' : ''}`;
      thumb.dataset.page = i;

      const check = document.createElement('span');
      check.className = 'page-thumb-check';
      check.textContent = '✓';

      const lbl = document.createElement('div');
      lbl.className = 'page-thumb-label';
      lbl.textContent = `p${i}`;

      thumb.appendChild(canvas); thumb.appendChild(check); thumb.appendChild(lbl);

      thumb.addEventListener('click', () => togglePageSelection(i));

      grid.appendChild(thumb);
      observer.observe(thumb);

      // Nav button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pdf-page-nav-btn${i === 1 ? ' active' : ''}${sel?.has(i) ? ' selected' : ''}`;
      btn.textContent = i;
      btn.addEventListener('click', () => {
        const panel = document.getElementById('preview-panel');
        const offset = thumb.getBoundingClientRect().top
                     - panel.getBoundingClientRect().top
                     + panel.scrollTop;
        panel.scrollTo({ top: offset - 8, behavior: 'smooth' });
        if (state.pdfPageModes[file.name] === 'select') togglePageSelection(i);
      });
      nav.appendChild(btn);
      navBtns.push(btn);
    }
    nav.appendChild(counter); // must be last so margin-left:auto pins it to the right
  } catch (err) {
    loading.textContent = `Could not load: ${err.message}`;
    loading.style.display = 'block';
  }
}

// ── File summary cards (compress / convert — no visual preview) ──────────────
function buildFileSummarySection(files, icon, title) {
  const section = document.createElement('div');
  section.className = 'preview-section';

  const hdr = document.createElement('div');
  hdr.className = 'preview-section-header';
  hdr.innerHTML = `<p class="preview-section-title">${escHtml(title)}</p>`;

  const cards = document.createElement('div');
  cards.className = 'preview-file-cards';

  files.forEach(file => {
    const card = document.createElement('div');
    card.className = 'preview-file-card';
    card.innerHTML = `
      <span class="preview-file-card-icon">${icon}</span>
      <div style="min-width:0">
        <p class="preview-file-card-name">${escHtml(file.name)}</p>
        <p class="preview-file-card-size">${formatBytes(file.size)}</p>
      </div>`;
    cards.appendChild(card);
  });

  section.appendChild(hdr); section.appendChild(cards);
  return section;
}

// ─── Process images ───────────────────────────────────────────────────────────
imagesSubmitBtn.addEventListener('click', () => {
  if (!state.uploadedImages.length) return;
  state.imageAction === 'convert' ? processConvertImages() : processImagesToPdf();
});

async function processConvertImages() {
  const files  = [...state.uploadedImages];
  const format = imgConvertFormat.value;
  const jobIds = files.map(f => addJob({ type: 'convert-image', label: `${f.name} → ${format.toUpperCase()}`, status: 'pending' }));
  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData(); fd.append('files', file, file.name); fd.append('target_format', format);
      return sendRequest('/api/tools/image-convert', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt }); return doIt();
  }));
}

async function processImagesToPdf() {
  const files = [...state.uploadedImages];
  const jobId = addJob({ type: 'images-to-pdf', label: `${files.length} images → PDF`, status: 'pending' });
  const doIt  = () => runFileJob(jobId, async () => {
    const fd = new FormData(); files.forEach(f => fd.append('files', f, f.name));
    return sendRequest('/api/tools/images-to-pdf', fd);
  });
  updateJob(jobId, { retryFn: doIt }); doIt();
}

// ─── Process PDFs ─────────────────────────────────────────────────────────────
pdfsSubmitBtn.addEventListener('click', () => {
  if (!state.uploadedPdfs.length) return;
  state.pdfAction === 'compress' ? processCompressPdfs() : processPdfsToImages();
});

async function processCompressPdfs() {
  const files  = [...state.uploadedPdfs];
  const preset = pdfCompressPreset.value;
  const jobIds = files.map(f => addJob({ type: 'compress-pdf', label: f.name, status: 'pending' }));
  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData(); fd.append('file', file, file.name); fd.append('preset', preset);
      return sendRequest('/api/tools/compress-pdf', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt }); return doIt();
  }));
}

async function processPdfsToImages() {
  const files  = [...state.uploadedPdfs];
  const format = pdfExportFormat.value;

  for (const file of files) {
    const mode = state.pdfPageModes[file.name] || 'all';
    if (mode === 'select' && !state.pdfPageSelections[file.name]?.size) {
      alert(`No pages selected for "${file.name}". Use "All pages" or click pages to select.`);
      return;
    }
  }

  const jobIds = files.map(f => addJob({ type: 'pdf-to-images', label: f.name, status: 'pending' }));
  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData(); fd.append('file', file, file.name); fd.append('target_format', format);
      const mode = state.pdfPageModes[file.name] || 'all';
      if (mode === 'all') {
        fd.append('mode', 'all');
      } else {
        const pages = [...state.pdfPageSelections[file.name]].sort((a,b)=>a-b);
        fd.append('mode', 'pages'); fd.append('page', pages.join(','));
      }
      return sendRequest('/api/tools/pdf-to-images', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt }); return doIt();
  }));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  state.jobs.forEach(j => { if (j.blobUrl) URL.revokeObjectURL(j.blobUrl); });
  imageUrlCache.forEach(url => URL.revokeObjectURL(url));
});

// ─── Init ─────────────────────────────────────────────────────────────────────
initializeServerMode();
