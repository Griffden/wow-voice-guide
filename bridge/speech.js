'use strict';
// Low-latency speech: Fish Audio's WebSocket streaming TTS, fed sentence by
// sentence while the guide model is still writing, with audio chunks passed
// on for playback as they arrive.
//
//   FishStream        one wss://api.fish.audio/v1/tts/live session (MessagePack
//                     events start / text / flush / stop in, audio / finish out)
//   SentenceSplitter  text deltas -> whole sentences, so synthesis starts on
//                     the first sentence instead of the whole answer
//   speechFields      the "basis" and "speech" string fields of a JSON answer
//                     that is still being streamed
//   Speaker           one spoken answer: optional filler line while a slow
//                     lookup runs, streamed sentences, and a fallback to the
//                     one-shot POST /v1/tts WAV when the socket fails before
//                     any audio played
//
// Audio leaves as { type: 'audio:chunk', streamId, sampleRate, base64 } (mono
// 16-bit little-endian PCM) and { type: 'audio:end', streamId } messages to the
// desktop process, which forwards them to the renderer.

const MsgPack = require('./msgpack');

const FISH_LIVE_URL = 'wss://api.fish.audio/v1/tts/live';
const PCM_RATE = 44100;
const DEFAULT_FILLERS = Object.freeze(['Let me check that.', 'One moment, let me look that up.', 'Let me look into that.']);

function secret(envName, configured) {
  return process.env[envName] || configured || '';
}

function loadWebSocket() {
  return require('ws');
}

// Text as it should be spoken: no URLs, Markdown or citation markers.
function spokenText(text) {
  return String(text || '')
    .replace(/\s*\(\[[^\]]+\]\(https?:\/\/[^)]+\)\)/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/cite[^]*/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ').trim();
}

// A fallback for game clients whose sound API reports empty files as playable.
// The addon receives this deadline with the text reply and can still animate
// its portrait without a live audio signal.
function estimatedSpeechEnd(text, speaker, now = Date.now()) {
  const words = spokenText(text).split(/\s+/).filter(Boolean).length;
  if (!words) return null;
  const seconds = Math.max(3, Math.min(120, words / 2.5 + (speaker.fillerSaid ? 2 : 0)));
  const startMs = speaker.audioSent && speaker.firstAudioMs != null
    ? speaker.startedAt + speaker.firstAudioMs
    : now + 1500;
  return Math.ceil(startMs / 1000 + seconds);
}

// ---------------------------------------------------------------------------
// Fish streaming session
// ---------------------------------------------------------------------------

class FishStream {
  constructor(cfg, { WebSocketImpl, onAudio = () => {}, log = () => {} } = {}) {
    const fish = cfg.fish || {};
    this.key = secret('FISH_API_KEY', fish.apiKey);
    this.fish = fish;
    this.WebSocketImpl = WebSocketImpl || loadWebSocket();
    this.onAudio = onAudio;
    this.log = log;
    this.queue = [];
    this.socket = null;
    this.open = false;
    this.closed = false;
    this.audioBytes = 0;
    this.error = null;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.done.catch(() => {});
  }

  start() {
    if (this.socket) return;
    if (!this.key) return this.fail(new Error('No Fish Audio API key is configured.'));
    if (!this.fish.voiceId) return this.fail(new Error('No Fish Audio voice model ID is configured.'));
    const socket = new this.WebSocketImpl(FISH_LIVE_URL, { headers: { Authorization: `Bearer ${this.key}`, model: this.fish.model || 's2.1-pro-free' } });
    this.socket = socket;
    this.timer = setTimeout(() => this.fail(new Error('Fish streaming timed out.')), this.fish.timeoutMs || 60000);
    socket.on('open', () => {
      this.open = true;
      this.write({
        event: 'start',
        request: {
          text: '',
          reference_id: this.fish.voiceId,
          format: 'pcm',
          sample_rate: PCM_RATE,
          latency: this.fish.latency || 'balanced',
          normalize: true,
          prosody: { speed: this.fish.speed || 1, volume: this.fish.volume || 0, normalize_loudness: true },
        },
      });
      for (const event of this.queue.splice(0)) this.write(event);
    });
    socket.on('message', raw => {
      let event;
      try { event = MsgPack.decode(raw); }
      catch { try { event = JSON.parse(String(raw)); } catch { return; } }
      if (!event || typeof event !== 'object') return;
      if (event.event === 'audio' && event.audio) {
        const audio = Buffer.from(event.audio);
        if (!audio.length) return;
        this.audioBytes += audio.length;
        this.onAudio(audio);
      } else if (event.event === 'finish') {
        if (event.reason === 'error') this.fail(new Error('Fish streaming finished with an error.'));
        else this.finish();
      } else if (event.event === 'error' || event.error) {
        this.fail(new Error(`Fish streaming failed: ${String(event.message || event.error || 'unknown error').slice(0, 200)}`));
      }
    });
    socket.on('error', err => this.fail(new Error(`Fish streaming connection failed: ${err.message}`)));
    socket.on('close', () => { if (!this.closed) this.fail(new Error('Fish closed the stream before it finished.')); });
    return undefined;
  }

  write(event) {
    if (this.closed) return;
    if (!this.open) { this.queue.push(event); return; }
    try { this.socket.send(MsgPack.encode(event)); }
    catch (e) { this.fail(e); }
  }

  text(text) {
    this.start();
    this.write({ event: 'text', text });
    this.write({ event: 'flush' });
  }

  // No more text: resolves once Fish has sent the last audio.
  end() {
    this.start();
    this.write({ event: 'stop' });
    return this.done;
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch {}
    this.resolve(this.audioBytes);
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    clearTimeout(this.timer);
    try { if (this.socket) this.socket.close(); } catch {}
    this.reject(err);
  }

  abort() { this.fail(new Error('Speech cancelled.')); }
}

// ---------------------------------------------------------------------------
// Sentences out of a stream of text
// ---------------------------------------------------------------------------

class SentenceSplitter {
  constructor({ maxChars = 220 } = {}) {
    this.buffer = '';
    this.maxChars = maxChars;
  }

  // Returns the sentences completed by this delta.
  push(delta) {
    this.buffer += String(delta || '');
    const out = [];
    for (;;) {
      const m = this.buffer.match(/^([\s\S]*?[.!?…]["')\]]?)(\s+)(?=\S)|^([\s\S]*?)\n+/);
      if (m) {
        const sentence = (m[1] || m[3] || '').trim();
        this.buffer = this.buffer.slice(m[0].length);
        if (sentence) out.push(sentence);
        continue;
      }
      if (this.buffer.length > this.maxChars) {
        // A very long sentence: break at the last comma or space.
        const cut = Math.max(this.buffer.lastIndexOf(', ', this.maxChars), this.buffer.lastIndexOf(' ', this.maxChars));
        if (cut > 40) { out.push(this.buffer.slice(0, cut + 1).trim()); this.buffer = this.buffer.slice(cut + 1); continue; }
      }
      break;
    }
    return out;
  }

  end() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

// ---------------------------------------------------------------------------
// The fields of a JSON answer that is still arriving
// ---------------------------------------------------------------------------

// Decode a JSON string body starting at `i` (just after the opening quote).
// Returns { text, done }; stops early at an incomplete escape.
function partialString(raw, i) {
  let text = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return { text, done: true };
    if (c === '\\') {
      const e = raw[i + 1];
      if (e === undefined) break;
      if (e === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        text += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      text += { n: '\n', t: '\t', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' }[e] ?? e;
      i += 2;
      continue;
    }
    text += c;
    i++;
  }
  return { text, done: false };
}

// { basis, basisDone, speech, speechDone, json } from a partial model answer.
// A reply that is not JSON at all is all speech.
function speechFields(raw) {
  const clean = String(raw || '').replace(/^\s*```(?:json)?\s*/i, '');
  if (clean.trim() && !clean.trim().startsWith('{')) return { json: false, speech: clean, speechDone: false };
  const out = { json: true };
  for (const field of ['basis', 'speech']) {
    const m = clean.match(new RegExp(`"${field}"\\s*:\\s*"`));
    if (!m) continue;
    const s = partialString(clean, m.index + m[0].length);
    out[field] = s.text;
    out[`${field}Done`] = s.done;
  }
  return out;
}

// Feeds deltas of a JSON answer and calls onText with each new piece of the
// "speech" field (prefixed once with prefixFor(basis), when there is one).
class SpeechFieldStream {
  constructor(onText, { prefixFor = () => '' } = {}) {
    this.raw = '';
    this.sent = 0;
    this.started = false;
    this.onText = onText;
    this.prefixFor = prefixFor;
  }

  push(delta) {
    this.raw += delta;
    const f = speechFields(this.raw);
    if (f.speech === undefined) return;
    // The answer schema puts basis first, so its label can be spoken first.
    if (!this.started) {
      this.started = true;
      const prefix = this.prefixFor(f.basisDone ? f.basis : null);
      if (prefix) this.onText(prefix);
    }
    if (f.speech.length > this.sent) {
      this.onText(f.speech.slice(this.sent));
      this.sent = f.speech.length;
    }
  }

  get spoke() { return this.started && this.sent > 0; }
}

// ---------------------------------------------------------------------------
// One spoken answer
// ---------------------------------------------------------------------------

let streamCounter = 0;

class Speaker {
  // send: message to the desktop process; fallback(text): the POST/WAV path.
  constructor(cfg, { send = () => {}, log = () => {}, fallback, WebSocketImpl } = {}) {
    const fish = cfg.fish || {};
    this.cfg = cfg;
    this.streaming = fish.stream !== false;
    this.fillerOn = fish.filler !== false;
    this.fillers = Array.isArray(fish.fillers) && fish.fillers.length ? fish.fillers : DEFAULT_FILLERS;
    this.fillerDelayMs = fish.fillerDelayMs ?? 1200;
    this.send = send;
    this.log = log;
    this.fallback = fallback;
    this.WebSocketImpl = WebSocketImpl;
    this.streamId = `s${process.pid}-${++streamCounter}`;
    this.splitter = new SentenceSplitter();
    this.said = [];
    this.stream = null;
    this.audioSent = false;
    this.answerStarted = false;
    this.fillerTimer = null;
    this.startedAt = Date.now();
    this.firstAudioMs = null;
  }

  ensureStream() {
    if (this.stream) return this.stream;
    this.stream = new FishStream(this.cfg, {
      WebSocketImpl: this.WebSocketImpl,
      log: this.log,
      onAudio: audio => {
        if (!this.audioSent) this.firstAudioMs = Date.now() - this.startedAt;
        this.audioSent = true;
        this.send({ type: 'audio:chunk', streamId: this.streamId, sampleRate: PCM_RATE, base64: audio.toString('base64') });
      },
    });
    this.stream.start();
    return this.stream;
  }

  say(sentence) {
    const text = spokenText(sentence);
    if (!text) return;
    this.said.push(text);
    if (this.streaming) this.ensureStream().text(`${text} `);
  }

  // A lookup began: if the answer hasn't started talking within
  // fillerDelayMs, say a short filler so the player knows it's working.
  lookupStarted() {
    if (!this.fillerOn || !this.streaming || this.fillerTimer || this.answerStarted || this.fillerSaid) return;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (this.answerStarted || this.fillerSaid || this.cancelled) return;
      this.fillerSaid = this.fillers[Math.floor(Math.random() * this.fillers.length)];
      this.log(`speaking filler: ${this.fillerSaid}`);
      this.ensureStream().text(`${this.fillerSaid} `);
    }, this.fillerDelayMs);
  }

  // A piece of the answer as the model writes it.
  push(delta) {
    this.answerStarted = true;
    clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
    for (const sentence of this.splitter.push(delta)) this.say(sentence);
  }

  // The answer is complete. `text` is what still has to be spoken (the whole
  // answer when nothing was streamed). Resolves once the audio has been sent.
  async finish(text) {
    this.answerStarted = true;
    clearTimeout(this.fillerTimer);
    for (const sentence of this.splitter.end()) this.say(sentence);
    if (text) {
      const split = new SentenceSplitter();
      for (const sentence of [...split.push(text), ...split.end()]) this.say(sentence);
    }
    const full = this.said.join(' ');
    if (!this.streaming) {
      if (full && this.fallback) await this.fallback(full);
      return { mode: 'file' };
    }
    if (!this.stream) return { mode: 'none' };
    try {
      await this.stream.end();
      this.send({ type: 'audio:end', streamId: this.streamId });
      return { mode: 'stream', firstAudioMs: this.firstAudioMs };
    } catch (e) {
      if (this.cancelled) return { mode: 'cancelled' };
      if (this.audioSent) {
        this.send({ type: 'audio:end', streamId: this.streamId });
        throw e;
      }
      this.log(`Fish streaming failed (${e.message}); falling back to one-shot synthesis.`);
      const spoken = this.said.filter(s => s !== this.fillerSaid).join(' ');
      if (spoken && this.fallback) await this.fallback(spoken);
      return { mode: 'fallback', error: e.message };
    }
  }

  cancel() {
    this.cancelled = true;
    clearTimeout(this.fillerTimer);
    if (this.stream) this.stream.abort();
    if (this.audioSent) this.send({ type: 'audio:end', streamId: this.streamId, cancelled: true });
  }
}

module.exports = {
  FISH_LIVE_URL, PCM_RATE, DEFAULT_FILLERS,
  spokenText, estimatedSpeechEnd, FishStream, SentenceSplitter, partialString, speechFields, SpeechFieldStream, Speaker,
};
