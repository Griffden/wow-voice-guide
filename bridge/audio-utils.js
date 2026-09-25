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

  // Streamed speech arrives as mono signed 16-bit little-endian PCM in chunks
  // that may split a sample; the odd byte is carried to the next chunk.
  function pcm16ToFloat32(bytes, carry) {
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (carry && carry.length) {
      const joined = new Uint8Array(carry.length + data.length);
      joined.set(carry, 0);
      joined.set(data, carry.length);
      data = joined;
    }
    const count = Math.floor(data.length / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let v = data[2 * i] | (data[2 * i + 1] << 8);
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return { samples: out, carry: data.slice(count * 2) };
  }

  return { downsampleTo16k, pcm16ToFloat32 };
});
