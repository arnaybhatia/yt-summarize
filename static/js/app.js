/* =============================================================================
   app.js — Smart front page: URL + file drop routing, parallel jobs
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

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  // URL workflow
  url: '',
  downloadMeta: null,
  modelReady: false,

  // Uploaded file groups
  uploadedImages: [],   // File objects
  uploadedPdfs: [],     // File objects

  // Image action
  imageAction: 'convert',   // 'convert' | 'to-pdf'
  imageConvertFormat: 'jpg',

  // PDF action
  pdfAction: 'compress',    // 'compress' | 'to-images'
  pdfCompressPreset: 'small',
  pdfExportFormat: 'png',
  pdfPageModes: {},          // { [file.name]: 'all' | 'select' }
  pdfPageSelections: {},     // { [file.name]: Set<number> }

  // Jobs
  jobs: [],
};

// ─── DOM references ───────────────────────────────────────────────────────────
const modelStatusBar    = document.getElementById('model-status-bar');
const modelStatusText   = document.getElementById('model-status-text');
const modelDeviceBadge  = document.getElementById('model-device-badge');
const modelProgressFill = document.getElementById('model-progress-fill');

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
const downloadProgress  = document.getElementById('download-progress');
const downloadProgressLabel = document.getElementById('download-progress-label');

const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const browseBtn         = document.getElementById('browse-btn');

const fileActionsSection= document.getElementById('file-actions-section');

const imagesGroup       = document.getElementById('images-group');
const imagesGroupTitle  = document.getElementById('images-group-title');
const imagesFileList    = document.getElementById('images-file-list');
const clearImagesBtn    = document.getElementById('clear-images-btn');
const imgActionConvert  = document.getElementById('img-action-convert');
const imgActionToPdf    = document.getElementById('img-action-topdf');
const imgConvertOpts    = document.getElementById('img-convert-opts');
const imgToPdfOpts      = document.getElementById('img-to-pdf-opts');
const imgConvertFormat  = document.getElementById('img-convert-format');
const imgThumbGrid      = document.getElementById('img-thumb-grid');
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
const perFilePickers    = document.getElementById('per-file-page-pickers');
const pdfsSubmitBtn     = document.getElementById('pdfs-submit-btn');

const jobsSection       = document.getElementById('jobs-section');
const jobsList          = document.getElementById('jobs-list');

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksLikeUrl(str) {
  return /^https?:\/\/.{6,}/.test(str);
}

function extractFilename(contentDisposition) {
  if (!contentDisposition) return 'download';
  const m = contentDisposition.match(/filename[^;=\n]*=\s*(?:UTF-8'')?["']?([^"';\n]*)["']?/i);
  return m ? decodeURIComponent(m[1].trim()) : 'download';
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ─── Platform detection ───────────────────────────────────────────────────────
const PLATFORM_PATTERNS = [
  { id: 'youtube',   label: 'YouTube',   icon: '▶',  re: /youtube\.com|youtu\.be/ },
  { id: 'instagram', label: 'Instagram', icon: '📸', re: /instagram\.com/ },
  { id: 'tiktok',    label: 'TikTok',    icon: '🎵', re: /tiktok\.com/ },
  { id: 'vsco',      label: 'VSCO',      icon: '🖼', re: /vsco\.co/ },
];

function detectPlatform(url) {
  return PLATFORM_PATTERNS.find(p => p.re.test(url)) ?? null;
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
    if (!res.ok) throw new Error('status error');
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
      // Poll until ready
      setTimeout(initializeServerMode, 3000);
    }
  } catch {
    // Server may not have model status endpoint; assume ready
    modelStatusBar.hidden = true;
    state.modelReady = true;
    transcribeBtn.disabled = !looksLikeUrl(state.url);
    transcribeBtnText.textContent = 'Transcribe';
  }
}

// ─── URL auto-analyze ─────────────────────────────────────────────────────────
let analyzeDebounceTimer = null;

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  state.url = url;
  state.downloadMeta = null;

  // Reset options
  urlOptions.hidden = true;
  downloadBtn.disabled = true;
  transcribeBtn.disabled = true;
  clearTimeout(analyzeDebounceTimer);

  const platform = detectPlatform(url);
  renderPlatformBadge(platform);

  if (!looksLikeUrl(url)) {
    setUrlSpinner(false);
    return;
  }

  setUrlSpinner(true);
  analyzeDebounceTimer = setTimeout(() => autoAnalyzeUrl(url), 600);
});

function setUrlSpinner(visible) {
  urlAnalyzeSpinner.classList.toggle('visible', visible);
}

async function autoAnalyzeUrl(url) {
  try {
    const res = await fetch('/api/media-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    // Ignore stale result if URL changed
    if (urlInput.value.trim() !== url) return;
    setUrlSpinner(false);

    if (!res.ok) return; // Silent fail during auto-analyze

    const meta = await res.json();
    if (!meta.options?.length) return;

    renderDownloadMeta(meta, url);
  } catch {
    setUrlSpinner(false);
  }
}

function renderDownloadMeta(meta, url) {
  state.downloadMeta = meta;

  urlMediaTitle.textContent = meta.title || url;

  const platform = detectPlatform(url || state.url);
  if (platform) {
    dlPlatformBadge.textContent = platform.label;
    dlPlatformBadge.className = `platform-badge visible ${platform.id}`;
  } else {
    dlPlatformBadge.className = 'platform-badge';
  }

  // Build kind selector
  const kinds = [...new Set(meta.options.map(o => o.kind))];
  downloadKind.innerHTML = kinds
    .map(k => `<option value="${k}">${k === 'mp4' ? 'Video (MP4)' : k === 'mp3' ? 'Audio (MP3)' : k}</option>`)
    .join('');

  updateQualityOptions();
  downloadKind.addEventListener('change', updateQualityOptions);

  urlOptions.hidden = false;
  downloadBtn.disabled = false;
  if (state.modelReady) transcribeBtn.disabled = false;
}

function updateQualityOptions() {
  if (!state.downloadMeta) return;
  const kind = downloadKind.value;
  const opts = state.downloadMeta.options.filter(o => o.kind === kind);
  downloadOption.innerHTML = opts
    .map(o => `<option value="${o.value}">${o.label}</option>`)
    .join('');
}

// ─── Download media → job ──────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  if (!state.downloadMeta) return;
  const label = state.downloadMeta.title || state.url;
  const jobId = addJob({ type: 'download-media', label, status: 'pending' });

  const doDownload = () => runFileJob(jobId, async () => {
    const fd = new FormData();
    fd.append('url', state.url);
    fd.append('kind', downloadKind.value);
    fd.append('value', downloadOption.value);
    return sendRequest('/api/download-media', fd);
  });

  updateJob(jobId, { retryFn: doDownload });
  doDownload();
});

// ─── Transcribe → job ─────────────────────────────────────────────────────────
transcribeBtn.addEventListener('click', () => {
  if (!looksLikeUrl(state.url)) return;
  const label = state.downloadMeta?.title || state.url;
  const jobId = addJob({ type: 'transcribe', label, status: 'pending' });

  const doTranscribe = () => runTranscribeJob(jobId, state.url);
  updateJob(jobId, { retryFn: doTranscribe });
  doTranscribe();
});

async function runTranscribeJob(jobId, url) {
  updateJob(jobId, { status: 'processing', step: 'Fetching audio…' });
  showJobsSection();

  try {
    const fd = new FormData();
    fd.append('url', url);

    const res = await fetch('/api/transcribe-server', {
      method: 'POST',
      body: fd,
    });

    updateJob(jobId, { step: 'Transcribing on Raspberry Pi…' });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const data = await res.json();
    updateJob(jobId, {
      status: 'done',
      step: null,
      transcript: { plain: data.plain || '', timestamped: data.timestamped || '' },
      transcriptView: 'timestamped',
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', step: null, errorMsg: err.message });
  }
}

// ─── Low-level request helper ──────────────────────────────────────────────────
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

// ─── Job management ───────────────────────────────────────────────────────────
function addJob(partial) {
  const job = {
    id: uid(),
    type: 'generic',
    label: '',
    status: 'pending',
    step: null,
    blobUrl: null,
    filename: null,
    transcript: null,
    transcriptView: 'timestamped',
    errorMsg: null,
    retryFn: null,
    ...partial,
  };
  state.jobs.push(job);
  showJobsSection();
  renderJobCard(job.id);
  return job.id;
}

function updateJob(id, patch) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  Object.assign(job, patch);
  renderJobCard(id);
}

function showJobsSection() {
  jobsSection.hidden = false;
}

async function runFileJob(jobId, fn) {
  updateJob(jobId, { status: 'processing', step: 'Processing…' });
  showJobsSection();
  try {
    const { blob, filename } = await fn();
    const blobUrl = URL.createObjectURL(blob);
    updateJob(jobId, { status: 'done', step: null, blobUrl, filename });
  } catch (err) {
    updateJob(jobId, { status: 'error', step: null, errorMsg: err.message });
  }
}

// ─── Job card rendering ───────────────────────────────────────────────────────
const JOB_ICONS = {
  'transcribe':    '🎙',
  'download-media':'⬇',
  'compress-pdf':  '📄',
  'pdf-to-images': '📑',
  'convert-image': '🖼',
  'images-to-pdf': '📋',
  'generic':       '⚙',
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

  let statusHtml;
  if (job.status === 'pending') {
    statusHtml = `<p class="job-status-text">Pending…</p>`;
  } else if (job.status === 'processing') {
    statusHtml = `<p class="job-status-text">${escHtml(job.step || 'Processing…')}</p>`;
  } else if (job.status === 'done' && job.transcript) {
    statusHtml = `<p class="job-status-text success">Transcript ready</p>`;
  } else if (job.status === 'done') {
    statusHtml = `<p class="job-status-text success">Done — ${escHtml(job.filename || 'file ready')}</p>`;
  } else if (job.status === 'error') {
    statusHtml = `<p class="job-status-text error">${escHtml(job.errorMsg || 'Error')}</p>`;
  }

  let actionsHtml = '';
  if (job.status === 'done' && job.blobUrl) {
    actionsHtml = `<div class="job-actions">
      <a class="btn btn-primary btn-sm" href="${job.blobUrl}" download="${escHtml(job.filename || 'download')}">⬇ Download</a>
    </div>`;
  } else if (job.status === 'done' && job.transcript) {
    actionsHtml = `<div class="job-actions">
      <button class="btn btn-secondary btn-sm" data-action="toggle-transcript" data-id="${id}">View transcript</button>
    </div>`;
  } else if (job.status === 'error' && job.retryFn) {
    actionsHtml = `<div class="job-actions">
      <button class="btn btn-ghost btn-sm" data-action="retry" data-id="${id}">Retry</button>
    </div>`;
  }

  // Transcript section
  let transcriptHtml = '';
  if (job.transcript) {
    const text = job.transcriptView === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    const isHidden = !card.classList.contains('transcript-open');
    transcriptHtml = `
      <div class="job-transcript" ${isHidden ? 'hidden' : ''}>
        <div class="transcript-view-toggle">
          <button class="transcript-toggle-btn ${job.transcriptView === 'timestamped' ? 'active' : ''}"
            data-action="set-view" data-id="${id}" data-view="timestamped">Timestamped</button>
          <button class="transcript-toggle-btn ${job.transcriptView === 'plain' ? 'active' : ''}"
            data-action="set-view" data-id="${id}" data-view="plain">Plain</button>
        </div>
        <pre class="transcript-pre">${escHtml(text)}</pre>
        <div class="transcript-actions">
          <button class="btn btn-secondary btn-sm" data-action="copy-transcript" data-id="${id}">📋 Copy</button>
          <button class="btn btn-ghost btn-sm" data-action="dl-transcript" data-id="${id}" data-view="plain">⬇ Plain .txt</button>
          <button class="btn btn-ghost btn-sm" data-action="dl-transcript" data-id="${id}" data-view="timestamped">⬇ Timestamped .txt</button>
        </div>
      </div>`;
  }

  card.innerHTML = `
    <div class="job-card-top">
      ${iconHtml}
      <div class="job-body">
        <p class="job-label">${escHtml(job.label)}</p>
        ${statusHtml}
      </div>
      ${actionsHtml}
    </div>
    ${transcriptHtml}
  `;
}

// Delegate job card interactions
jobsList.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;

  if (action === 'toggle-transcript') {
    const card = jobsList.querySelector(`[data-job-id="${id}"]`);
    const isOpen = card.classList.toggle('transcript-open');
    const section = card.querySelector('.job-transcript');
    if (section) section.hidden = !isOpen;
    btn.textContent = isOpen ? 'Hide transcript' : 'View transcript';
  }

  if (action === 'set-view') {
    updateJob(id, { transcriptView: btn.dataset.view });
  }

  if (action === 'copy-transcript') {
    const text = job.transcriptView === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    navigator.clipboard?.writeText(text).catch(() => {
      // Fallback: select the pre
      const pre = jobsList.querySelector(`[data-job-id="${id}"] .transcript-pre`);
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  }

  if (action === 'dl-transcript') {
    const view = btn.dataset.view;
    const text = view === 'plain' ? job.transcript.plain : job.transcript.timestamped;
    const suffix = view === 'plain' ? 'plain' : 'timestamped';
    const filename = `transcript-${suffix}.txt`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(blob, filename);
  }

  if (action === 'retry' && job.retryFn) {
    job.retryFn();
  }
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Drop zone ────────────────────────────────────────────────────────────────
browseBtn.addEventListener('click', e => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-active');
});

dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-active');
});

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-active');
  appendFiles(Array.from(e.dataTransfer.files));
});

fileInput.addEventListener('change', () => {
  appendFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

function appendFiles(newFiles) {
  const images = newFiles.filter(f => /\.(jpe?g|png|webp)$/i.test(f.name));
  const pdfs   = newFiles.filter(f => /\.pdf$/i.test(f.name));

  const dedup = (existing, incoming) =>
    incoming.filter(n => !existing.some(e => e.name === n.name && e.size === n.size));

  state.uploadedImages.push(...dedup(state.uploadedImages, images));
  state.uploadedPdfs.push(...dedup(state.uploadedPdfs, pdfs));

  renderFileGroups();
}

// After files added, compact the drop zone
function compactDropZone() {
  const total = state.uploadedImages.length + state.uploadedPdfs.length;
  if (total > 0) {
    dropZone.classList.add('compact');
    const prompt = document.getElementById('drop-prompt');
    prompt.querySelector('.drop-text').textContent =
      `${total} file${total !== 1 ? 's' : ''} added`;

    let addMore = dropZone.querySelector('.compact-add-more');
    if (!addMore) {
      addMore = document.createElement('button');
      addMore.type = 'button';
      addMore.className = 'compact-add-more';
      addMore.textContent = '+ Add more';
      addMore.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
      dropZone.appendChild(addMore);
    } else {
      addMore.style.display = '';
    }
  } else {
    dropZone.classList.remove('compact');
    const prompt = document.getElementById('drop-prompt');
    prompt.querySelector('.drop-text').textContent = 'Drop images or PDFs here';
    const addMore = dropZone.querySelector('.compact-add-more');
    if (addMore) addMore.style.display = 'none';
  }
}

// ─── File groups rendering ────────────────────────────────────────────────────
function renderFileGroups() {
  compactDropZone();

  const hasImages = state.uploadedImages.length > 0;
  const hasPdfs   = state.uploadedPdfs.length > 0;

  fileActionsSection.hidden = !hasImages && !hasPdfs;
  imagesGroup.hidden = !hasImages;
  pdfsGroup.hidden   = !hasPdfs;

  if (hasImages) {
    imagesGroupTitle.textContent =
      `${state.uploadedImages.length} image${state.uploadedImages.length !== 1 ? 's' : ''}`;
    renderFileList(imagesFileList, state.uploadedImages, '🖼', removeImage);
    if (state.imageAction === 'to-pdf') renderImageThumbnails();
  }

  if (hasPdfs) {
    pdfsGroupTitle.textContent =
      `${state.uploadedPdfs.length} PDF${state.uploadedPdfs.length !== 1 ? 's' : ''}`;
    renderFileList(pdfsFileList, state.uploadedPdfs, '📄', removePdf);
    if (state.pdfAction === 'to-images') renderPerFilePickers();
  }
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
      <button class="file-row-remove" data-index="${i}" type="button" title="Remove">✕</button>
    `;
    row.querySelector('.file-row-remove').addEventListener('click', () => removeFn(i));
    container.appendChild(row);
  });
}

function removeImage(index) {
  state.uploadedImages.splice(index, 1);
  renderFileGroups();
  renderImageThumbnails();
}

function removePdf(index) {
  const removed = state.uploadedPdfs[index];
  state.uploadedPdfs.splice(index, 1);
  delete state.pdfPageModes[removed.name];
  delete state.pdfPageSelections[removed.name];
  renderFileGroups();
}

// ─── Image action choice ──────────────────────────────────────────────────────
imgActionConvert.addEventListener('click', () => setImageAction('convert'));
imgActionToPdf.addEventListener('click',   () => setImageAction('to-pdf'));

function setImageAction(action) {
  state.imageAction = action;
  imgActionConvert.classList.toggle('active', action === 'convert');
  imgActionToPdf.classList.toggle('active',   action === 'to-pdf');
  imgConvertOpts.hidden = action !== 'convert';
  imgToPdfOpts.hidden   = action !== 'to-pdf';
  if (action === 'to-pdf') renderImageThumbnails();
}

imgConvertFormat.addEventListener('change', () => {
  state.imageConvertFormat = imgConvertFormat.value;
});

// ─── Image thumbnails (drag-to-reorder) ───────────────────────────────────────
let dragSrcIndex = null;

function renderImageThumbnails() {
  imgThumbGrid.innerHTML = '';

  if (!state.uploadedImages.length) {
    const msg = document.createElement('p');
    msg.className = 'thumb-empty-msg';
    msg.textContent = 'Upload images to preview and reorder pages.';
    imgThumbGrid.appendChild(msg);
    return;
  }

  state.uploadedImages.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.draggable = true;
    item.dataset.index = index;

    const img = document.createElement('img');
    const objUrl = URL.createObjectURL(file);
    img.src = objUrl;
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(objUrl);

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = `Page ${index + 1}`;

    // Mobile arrows
    const arrows = document.createElement('div');
    arrows.className = 'thumb-arrows';
    const upBtn = document.createElement('button');
    upBtn.className = 'thumb-arrow-btn';
    upBtn.textContent = '▲';
    upBtn.type = 'button';
    upBtn.addEventListener('click', e => { e.stopPropagation(); moveImage(index, index - 1); });
    const dnBtn = document.createElement('button');
    dnBtn.className = 'thumb-arrow-btn';
    dnBtn.textContent = '▼';
    dnBtn.type = 'button';
    dnBtn.addEventListener('click', e => { e.stopPropagation(); moveImage(index, index + 1); });
    arrows.appendChild(upBtn);
    arrows.appendChild(dnBtn);

    item.appendChild(img);
    item.appendChild(label);
    item.appendChild(arrows);

    item.addEventListener('dragstart', e => {
      dragSrcIndex = index;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrcIndex === null || dragSrcIndex === index) return;
      moveImage(dragSrcIndex, index);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragSrcIndex = null;
      imgThumbGrid.querySelectorAll('.thumb-item').forEach(el => el.classList.remove('drag-over'));
    });

    imgThumbGrid.appendChild(item);
  });
}

function moveImage(from, to) {
  if (to < 0 || to >= state.uploadedImages.length) return;
  const arr = [...state.uploadedImages];
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  state.uploadedImages = arr;
  renderImageThumbnails();
}

// ─── PDF action choice ────────────────────────────────────────────────────────
pdfActionCompress.addEventListener('click', () => setPdfAction('compress'));
pdfActionToImages.addEventListener('click', () => setPdfAction('to-images'));

function setPdfAction(action) {
  state.pdfAction = action;
  pdfActionCompress.classList.toggle('active', action === 'compress');
  pdfActionToImages.classList.toggle('active', action === 'to-images');
  pdfCompressOpts.hidden  = action !== 'compress';
  pdfToImagesOpts.hidden  = action !== 'to-images';
  if (action === 'to-images') renderPerFilePickers();
}

pdfCompressPreset.addEventListener('change', () => {
  state.pdfCompressPreset = pdfCompressPreset.value;
});

pdfExportFormat.addEventListener('change', () => {
  state.pdfExportFormat = pdfExportFormat.value;
});

// ─── Per-file PDF page pickers (PDF.js) ───────────────────────────────────────
function renderPerFilePickers() {
  perFilePickers.innerHTML = '';

  state.uploadedPdfs.forEach(file => {
    if (!state.pdfPageModes[file.name]) {
      state.pdfPageModes[file.name] = 'all';
      state.pdfPageSelections[file.name] = new Set();
    }

    const picker = document.createElement('div');
    picker.className = 'pdf-file-picker';
    picker.dataset.filename = file.name;

    const mode = state.pdfPageModes[file.name];
    const sel  = state.pdfPageSelections[file.name];
    const selCount = sel.size;
    const summary  = mode === 'all' ? 'All pages' : `${selCount} page${selCount !== 1 ? 's' : ''} selected`;

    picker.innerHTML = `
      <div class="pdf-picker-header">
        <span class="pdf-picker-filename">${escHtml(file.name)}</span>
        <span class="pdf-picker-summary">${summary}</span>
        <span class="pdf-picker-chevron">▶</span>
      </div>
      <div class="pdf-picker-body">
        <div class="page-mode-toggle">
          <button type="button" class="page-mode-btn ${mode === 'all' ? 'active' : ''}" data-mode="all">All pages</button>
          <button type="button" class="page-mode-btn ${mode === 'select' ? 'active' : ''}" data-mode="select">Select pages</button>
        </div>
        <div class="page-grid ${mode === 'select' ? '' : 'hidden-grid'}" id="grid-${CSS.escape(file.name)}"></div>
        <p class="page-loading-msg" id="loading-${CSS.escape(file.name)}" style="display:none">Loading pages…</p>
      </div>
    `;

    // Toggle open/close
    picker.querySelector('.pdf-picker-header').addEventListener('click', () => {
      picker.classList.toggle('open');
      if (picker.classList.contains('open')) {
        loadPdfPageGrid(picker, file);
      }
    });

    // Mode buttons
    picker.querySelectorAll('.page-mode-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const newMode = btn.dataset.mode;
        state.pdfPageModes[file.name] = newMode;

        picker.querySelectorAll('.page-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const grid = picker.querySelector('.page-grid');
        if (newMode === 'select') {
          grid.classList.remove('hidden-grid');
          grid.hidden = false;
          loadPdfPageGrid(picker, file);
        } else {
          grid.classList.add('hidden-grid');
          grid.hidden = true;
          // Clear selections
          state.pdfPageSelections[file.name].clear();
          grid.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
        }
        updatePickerSummary(picker, file.name);
      });
    });

    perFilePickers.appendChild(picker);
  });
}

async function loadPdfPageGrid(picker, file) {
  const gridId   = `grid-${CSS.escape(file.name)}`;
  const loadId   = `loading-${CSS.escape(file.name)}`;
  const grid     = picker.querySelector('.page-grid');
  const loadMsg  = picker.querySelector('.page-loading-msg');

  if (grid.dataset.loaded === 'true') return;

  loadMsg.style.display = 'block';
  grid.hidden = state.pdfPageModes[file.name] !== 'select';

  const lib = await ensurePdfjsLoaded();
  if (!lib) {
    loadMsg.textContent = 'PDF preview unavailable (CDN unreachable).';
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const pdf = await lib.getDocument({ data: buffer }).promise;
    loadMsg.style.display = 'none';
    grid.dataset.loaded = 'true';

    const sel = state.pdfPageSelections[file.name];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 0.3 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      const thumb = document.createElement('div');
      thumb.className = `page-thumb${sel.has(i) ? ' selected' : ''}`;
      thumb.dataset.page = i;

      const check = document.createElement('span');
      check.className = 'page-thumb-check';
      check.textContent = '✓';

      const lbl = document.createElement('div');
      lbl.className = 'page-thumb-label';
      lbl.textContent = `p${i}`;

      thumb.appendChild(canvas);
      thumb.appendChild(check);
      thumb.appendChild(lbl);

      thumb.addEventListener('click', () => {
        if (state.pdfPageModes[file.name] !== 'select') return;
        if (sel.has(i)) { sel.delete(i); thumb.classList.remove('selected'); }
        else            { sel.add(i);    thumb.classList.add('selected'); }
        updatePickerSummary(picker, file.name);
      });

      grid.appendChild(thumb);
    }
  } catch (err) {
    loadMsg.style.display = 'block';
    loadMsg.textContent = `Could not load PDF preview: ${err.message}`;
  }
}

function updatePickerSummary(picker, filename) {
  const mode = state.pdfPageModes[filename];
  const sel  = state.pdfPageSelections[filename];
  const summary = mode === 'all'
    ? 'All pages'
    : `${sel.size} page${sel.size !== 1 ? 's' : ''} selected`;
  picker.querySelector('.pdf-picker-summary').textContent = summary;
}

// hidden-grid helper (display:none without the hidden attribute fighting the grid)
const gridStyle = document.createElement('style');
gridStyle.textContent = '.hidden-grid { display: none !important; }';
document.head.appendChild(gridStyle);

// ─── Clear buttons ────────────────────────────────────────────────────────────
clearImagesBtn.addEventListener('click', () => {
  state.uploadedImages = [];
  renderFileGroups();
});

clearPdfsBtn.addEventListener('click', () => {
  state.uploadedPdfs = [];
  state.pdfPageModes = {};
  state.pdfPageSelections = {};
  renderFileGroups();
});

// ─── Process images ───────────────────────────────────────────────────────────
imagesSubmitBtn.addEventListener('click', () => {
  if (!state.uploadedImages.length) return;

  if (state.imageAction === 'convert') {
    processConvertImages();
  } else {
    processImagesToPdf();
  }
});

async function processConvertImages() {
  const files  = [...state.uploadedImages];
  const format = imgConvertFormat.value;

  const jobIds = files.map(f =>
    addJob({
      type:  'convert-image',
      label: `${f.name} → ${format.toUpperCase()}`,
      status: 'pending',
    })
  );

  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData();
      fd.append('files', file, file.name);
      fd.append('target_format', format);
      return sendRequest('/api/tools/image-convert', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt });
    return doIt();
  }));
}

async function processImagesToPdf() {
  const files = [...state.uploadedImages];
  const jobId = addJob({
    type:  'images-to-pdf',
    label: `${files.length} image${files.length !== 1 ? 's' : ''} → PDF`,
    status: 'pending',
  });

  const doIt = () => runFileJob(jobId, async () => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f, f.name));
    return sendRequest('/api/tools/images-to-pdf', fd);
  });

  updateJob(jobId, { retryFn: doIt });
  doIt();
}

// ─── Process PDFs ─────────────────────────────────────────────────────────────
pdfsSubmitBtn.addEventListener('click', () => {
  if (!state.uploadedPdfs.length) return;

  if (state.pdfAction === 'compress') {
    processCompressPdfs();
  } else {
    processPdfsToImages();
  }
});

async function processCompressPdfs() {
  const files  = [...state.uploadedPdfs];
  const preset = pdfCompressPreset.value;

  const jobIds = files.map(f =>
    addJob({ type: 'compress-pdf', label: f.name, status: 'pending' })
  );

  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('preset', preset);
      return sendRequest('/api/tools/compress-pdf', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt });
    return doIt();
  }));
}

async function processPdfsToImages() {
  const files  = [...state.uploadedPdfs];
  const format = pdfExportFormat.value;

  // Validate page selections before starting
  for (const file of files) {
    const mode = state.pdfPageModes[file.name] || 'all';
    if (mode === 'select' && state.pdfPageSelections[file.name]?.size === 0) {
      alert(`No pages selected for "${file.name}". Switch to "All pages" or select at least one page.`);
      return;
    }
  }

  const jobIds = files.map(f =>
    addJob({ type: 'pdf-to-images', label: f.name, status: 'pending' })
  );

  await Promise.all(files.map((file, i) => {
    const doIt = () => runFileJob(jobIds[i], async () => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('target_format', format);

      const mode = state.pdfPageModes[file.name] || 'all';
      if (mode === 'all') {
        fd.append('mode', 'all');
      } else {
        const pages = [...state.pdfPageSelections[file.name]].sort((a, b) => a - b);
        fd.append('mode', 'pages');
        fd.append('page', pages.join(','));
      }

      return sendRequest('/api/tools/pdf-to-images', fd);
    });
    updateJob(jobIds[i], { retryFn: doIt });
    return doIt();
  }));
}

// ─── Cleanup blob URLs on unload ──────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  state.jobs.forEach(job => {
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
initializeServerMode();
