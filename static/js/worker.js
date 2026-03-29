/* ─────────────────────────────────────────────────────────────────────────────
   Whisper Web Worker  ·  powered by @huggingface/transformers
   Runs in its own thread so the UI never blocks.
   Supports WebGPU (hardware-accelerated) with automatic WASM fallback.
───────────────────────────────────────────────────────────────────────────── */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0/dist/transformers.min.js';

env.allowLocalModels  = false;
env.useBrowserCache   = true;   // Cache model weights after first download

let transcriber = null;
let currentDevice = 'wasm';
let currentProfile = null;

function getRuntimeProfile() {
  const search = new URL(self.location.href).searchParams;
  const explicitPiMode = search.get('pi') === '1';
  const cores = self.navigator.hardwareConcurrency || 2;
  const memory = self.navigator.deviceMemory || 0;
  const likelyLowPower = explicitPiMode || cores <= 4 || (memory && memory <= 4);

  if (likelyLowPower) {
    return {
      label: 'Pi mode',
      model: 'onnx-community/whisper-tiny',
      wasmDtype: 'q8',
      gpuDtype: 'fp16',
      chunkLength: 20,
      strideLength: 3,
    };
  }

  return {
    label: 'Standard mode',
    model: 'onnx-community/whisper-base',
    wasmDtype: 'q8',
    gpuDtype: 'fp32',
    chunkLength: 30,
    strideLength: 5,
  };
}

// ─── Model init ──────────────────────────────────────────────────────────────
async function initModel() {
  currentProfile = getRuntimeProfile();
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
    self.postMessage({ type: 'status', message: `${currentProfile.label}: WASM fallback (${gpuFailReason})`, device: 'wasm' });
  } else {
    self.postMessage({ type: 'status', message: `${currentProfile.label}: loading Whisper model (WebGPU)…`, device: 'webgpu' });
  }

  // Keep the Pi profile on the smallest reasonable model and quantized WASM.
  const dtype = currentDevice === 'webgpu' ? currentProfile.gpuDtype : currentProfile.wasmDtype;

  transcriber = await pipeline(
    'automatic-speech-recognition',
    currentProfile.model,
    {
      device: currentDevice,
      dtype,
      progress_callback: (p) => self.postMessage({ type: 'model-progress', data: p }),
    }
  );

  self.postMessage({
    type: 'model-ready',
    device: currentDevice,
    profile: currentProfile.label,
    model: currentProfile.model,
  });
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
          chunk_length_s:     currentProfile.chunkLength,
          stride_length_s:    currentProfile.strideLength,
          language:           null,   // auto-detect
        });
        self.postMessage({ type: 'result', result });
      } catch (e) {
        self.postMessage({ type: 'error', message: `Transcription failed: ${e.message}` });
      }
      break;
  }
});
