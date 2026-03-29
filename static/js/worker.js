/* ─────────────────────────────────────────────────────────────────────────────
   Whisper Web Worker  ·  powered by @huggingface/transformers
   Runs in its own thread so the UI never blocks.
   Supports WebGPU (hardware-accelerated) with automatic WASM fallback.
───────────────────────────────────────────────────────────────────────────── */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0/dist/transformers.min.js';

env.allowLocalModels  = false;
env.useBrowserCache   = true;   // Cache model weights after first download

const MODEL = 'onnx-community/whisper-base';

let transcriber = null;
let currentDevice = 'wasm';

// ─── Model init ──────────────────────────────────────────────────────────────
async function initModel() {
  let gpuFailReason = null;

  if ('gpu' in self.navigator) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        currentDevice = 'webgpu';
      } else {
        gpuFailReason = 'no compatible GPU found';
      }
    } catch (e) {
      gpuFailReason = e.message || 'initialization failed';
    }
  } else {
    gpuFailReason = 'WebGPU not supported by this browser (use Chrome/Edge)';
  }

  if (gpuFailReason) {
    self.postMessage({ type: 'status', message: `WASM Fallback: ${gpuFailReason}`, device: 'wasm' });
  } else {
    self.postMessage({ type: 'status', message: `Loading Whisper model (WebGPU)…`, device: 'webgpu' });
  }

  // WebGPU needs fp32/fp16; WASM works best with q8 (quantised, ~4× smaller)
  const dtype = currentDevice === 'webgpu' ? 'fp32' : 'q8';

  transcriber = await pipeline(
    'automatic-speech-recognition',
    MODEL,
    {
      device: currentDevice,
      dtype,
      progress_callback: (p) => self.postMessage({ type: 'model-progress', data: p }),
    }
  );

  self.postMessage({ type: 'model-ready', device: currentDevice });
}


// ─── Message handler ─────────────────────────────────────────────────────────
self.addEventListener('message', async ({ data }) => {
  switch (data.type) {
    case 'load':
      try {
        await initModel();
      } catch (e) {
        self.postMessage({ type: 'error', message: `Model load failed: ${e.message}` });
      }
      break;

    case 'transcribe':
      if (!transcriber) {
        self.postMessage({ type: 'error', message: 'Model not loaded yet.' });
        return;
      }
      try {
        const result = await transcriber(data.audio, {
          return_timestamps:  true,
          chunk_length_s:     30,
          stride_length_s:    5,
          language:           null,   // auto-detect
        });
        self.postMessage({ type: 'result', result });
      } catch (e) {
        self.postMessage({ type: 'error', message: `Transcription failed: ${e.message}` });
      }
      break;
  }
});
