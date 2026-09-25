'use strict';

const $ = id => document.getElementById(id);
let media = null;
let player = null;
let playbackContext = null;
let playbackSource = null;
let playbackGain = null;
let voiceVolumePercent = 125;
let streamGain = null;
let speech = null; // streamed reply: { id, nextTime, sources, carry, ended }

const presets = {
  luna: { provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-6-luna', reasoningEffort: 'none' },
  gpt41mini: { provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', reasoningEffort: '' },
  gemma26: { provider: 'gemini', endpoint: '', model: 'gemma-4-26b-a4b-it', thinkingLevel: 'minimal' },
  gemma31: { provider: 'gemini', endpoint: '', model: 'gemma-4-31b-it', thinkingLevel: 'minimal' },
  local: { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: '', reasoningEffort: '' },
};

const fishVoicePresets = window.WowVoicePresets;
for (const voice of fishVoicePresets.voices) {
  const option = document.createElement('option');
  option.value = voice.id;
  option.textContent = voice.name;
  $('fishVoicePreset').append(option);
}
const customVoiceOption = document.createElement('option');
customVoiceOption.value = 'custom';
customVoiceOption.textContent = 'Custom model ID';
$('fishVoicePreset').append(customVoiceOption);

function syncFishVoicePreset() {
  const matched = fishVoicePresets.presetForVoiceId($('fishVoice').value);
  $('fishVoicePreset').value = matched ? matched.id : 'custom';
}

$('fishVoicePreset').addEventListener('change', event => {
  if (event.target.value === 'custom') {
    $('fishVoice').focus();
    $('fishVoice').select();
  }
  else $('fishVoice').value = event.target.value;
});
$('fishVoice').addEventListener('input', syncFishVoicePreset);

function setStatus(value) {
  const status = value || { state: 'idle', text: 'Ready' };
  $('state').dataset.state = status.state || 'idle';
  $('state').querySelector('strong').textContent = status.state || 'idle';
  $('statusText').textContent = status.text || 'Ready';
  const listening = ['listening', 'hearing'].includes(status.state);
  $('forceEnd').disabled = !listening;
  $('cancel').disabled = !listening;
}

function setVoiceVolume(value) {
  const n = Number(value);
  voiceVolumePercent = Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : 125;
  for (const gain of [playbackGain, streamGain]) {
    if (gain && playbackContext) gain.gain.setTargetAtTime(voiceVolumePercent / 100, playbackContext.currentTime, 0.015);
  }
}

// Gain followed by a limiter, so volumes above 100% don't clip harshly.
function outputChain(context) {
  const gain = context.createGain();
  const limiter = context.createDynamicsCompressor();
  gain.gain.value = voiceVolumePercent / 100;
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  gain.connect(limiter).connect(context.destination);
  return gain;
}

// ---------------------------------------------------------------------------
// Streamed speech: PCM chunks scheduled back to back on one Web Audio clock,
// so playback starts with the first sentence Fish synthesizes.
// ---------------------------------------------------------------------------

function stopStream() {
  if (!speech) return;
  const old = speech;
  speech = null;
  for (const source of old.sources) { source.onended = null; try { source.stop(); } catch {} }
}

function stopElement() {
  if (player) {
    player.pause();
    player.onended = null;
  }
}

function streamDone() {
  if (speech && speech.ended && speech.sources.size === 0) {
    speech = null;
    window.wowVoice.audioEnded();
  }
}

async function playStreamChunk(value) {
  playbackContext = playbackContext || new AudioContext();
  if (playbackContext.state === 'suspended') await playbackContext.resume();
  if (!streamGain) streamGain = outputChain(playbackContext);
  if (!speech || speech.id !== value.streamId) {
    stopElement();
    stopStream();
    setVoiceVolume(value.volumePercent ?? voiceVolumePercent);
    speech = { id: value.streamId, nextTime: 0, sources: new Set(), carry: null, ended: false };
  }
  const bytes = Uint8Array.from(atob(value.base64), c => c.charCodeAt(0));
  const { samples, carry } = window.WowVoiceAudio.pcm16ToFloat32(bytes, speech.carry);
  speech.carry = carry;
  if (!samples.length) return;
  const buffer = playbackContext.createBuffer(1, samples.length, value.sampleRate || 44100);
  buffer.copyToChannel(samples, 0);
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(streamGain);
  // A small lead on the first chunk absorbs network jitter between chunks.
  const at = Math.max(playbackContext.currentTime + (speech.sources.size ? 0.01 : 0.08), speech.nextTime);
  source.start(at);
  speech.nextTime = at + buffer.duration;
  speech.sources.add(source);
  const current = speech;
  source.onended = () => {
    current.sources.delete(source);
    if (speech === current) streamDone();
  };
}

window.wowVoice.on('audio:stream', value => {
  playStreamChunk(value).catch(error => setStatus({ state: 'error', text: `Audio playback failed: ${error.message}` }));
});
window.wowVoice.on('audio:stream-end', value => {
  if (!speech || speech.id !== value.streamId) return;
  if (value.cancelled) { stopStream(); window.wowVoice.audioEnded(); return; }
  speech.ended = true;
  streamDone();
});

async function startCapture() {
  await stopCapture();
  let stream = null;
  let context = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    context = new AudioContext();
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') throw new Error(`audio engine is ${context.state}`);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = window.WowVoiceAudio.downsampleTo16k(input, context.sampleRate);
      window.wowVoice.sendAudio(pcm.buffer);
    };
    source.connect(processor);
    processor.connect(context.destination);
    media = { stream, context, source, processor };
  } catch (error) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    setStatus({ state: 'error', text: `Microphone failed: ${error.message}` });
    window.wowVoice.cancel();
  }
}

async function stopCapture() {
  if (!media) return;
  const old = media;
  media = null;
  old.processor.disconnect();
  old.source.disconnect();
  old.stream.getTracks().forEach(track => track.stop());
  await old.context.close();
}

function applyConfig(config) {
  const dg = config.deepgram || {}, fish = config.fish || {}, llm = config.llm || {};
  setVoiceVolume((config.audio || {}).volumePercent ?? 125);
  $('deepgramKey').value = dg.apiKey || '';
  $('deepgramModel').value = dg.model || 'flux-general-en';
  $('eotThreshold').value = dg.eotThreshold || 0.7;
  $('fishKey').value = fish.apiKey || '';
  $('fishVoice').value = fish.voiceId || '';
  syncFishVoicePreset();
  $('fishModel').value = fish.model || 's2.1-pro-free';
  $('fishLatency').value = fish.latency || 'balanced';
  $('fishStream').checked = fish.stream !== false;
  $('fishFiller').checked = fish.filler !== false;
  $('llmKey').value = llm.apiKey || '';
  $('llmEndpoint').value = llm.endpoint || '';
  $('llmModel').value = llm.model || '';
  const match = Object.entries(presets).find(([, p]) => p.provider === llm.provider && p.model === llm.model);
  $('llmPreset').value = match ? match[0] : 'local';
}

$('llmPreset').addEventListener('change', event => {
  const p = presets[event.target.value];
  $('llmEndpoint').value = p.endpoint;
  $('llmModel').value = p.model;
});

$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const p = presets[$('llmPreset').value];
  const updated = await window.wowVoice.saveConfig({
    deepgram: { apiKey: $('deepgramKey').value.trim(), model: $('deepgramModel').value.trim(), eotThreshold: Number($('eotThreshold').value) },
    fish: { apiKey: $('fishKey').value.trim(), voiceId: $('fishVoice').value.trim(), model: $('fishModel').value, latency: $('fishLatency').value, stream: $('fishStream').checked, filler: $('fishFiller').checked },
    llm: { ...p, apiKey: $('llmKey').value.trim(), endpoint: $('llmEndpoint').value.trim(), model: $('llmModel').value.trim() },
  });
  applyConfig(updated);
  $('saved').textContent = 'Saved';
  setTimeout(() => { $('saved').textContent = ''; }, 1800);
});

$('forceEnd').addEventListener('click', () => window.wowVoice.forceEnd());
$('cancel').addEventListener('click', () => window.wowVoice.cancel());

window.wowVoice.on('capture:start', startCapture);
window.wowVoice.on('capture:stop', stopCapture);
window.wowVoice.on('status', setStatus);
window.wowVoice.on('guide:sources', value => {
  const box = $('sourceLinks');
  box.replaceChildren();
  for (const source of (value.sources || []).slice(0, 3)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-link';
    button.textContent = `${source.title} — ${source.url}`;
    button.addEventListener('click', () => window.wowVoice.openGuideSource(source.url));
    box.append(button);
  }
  $('guideSources').hidden = box.childElementCount === 0;
});
window.wowVoice.on('audio:volume', value => setVoiceVolume(value && value.volumePercent));
window.wowVoice.on('log', line => {
  const log = $('log');
  log.textContent = (log.textContent + line + '\n').slice(-20000);
  log.scrollTop = log.scrollHeight;
});
window.wowVoice.on('audio:play', async value => {
  setVoiceVolume(value.volumePercent ?? voiceVolumePercent);
  stopElement();
  stopStream();
  if (playbackSource) playbackSource.disconnect();
  player = new Audio(`data:${value.mime};base64,${value.base64}`);
  playbackContext = playbackContext || new AudioContext();
  if (playbackContext.state === 'suspended') await playbackContext.resume();
  playbackSource = playbackContext.createMediaElementSource(player);
  if (playbackGain) playbackGain.disconnect();
  playbackGain = outputChain(playbackContext);
  playbackSource.connect(playbackGain);
  player.addEventListener('ended', () => window.wowVoice.audioEnded(), { once: true });
  player.play().catch(error => setStatus({ state: 'error', text: `Audio playback failed: ${error.message}` }));
});

window.wowVoice.getConfig().then(applyConfig);
