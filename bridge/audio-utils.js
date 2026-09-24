'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WowVoiceAudio = api;
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
  function downsampleTo16k(float32, inputRate) {
    if (!(float32 instanceof Float32Array)) float32 = new Float32Array(float32);
    if (!inputRate || inputRate < 16000) throw new Error('Microphone sample rate must be at least 16 kHz.');
    const ratio = inputRate / 16000;
    const length = Math.max(1, Math.floor(float32.length / ratio));
    const out = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(float32.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += float32[j];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      out[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    return out;
  }

  return { downsampleTo16k };
});
