'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const WebSocket = require('ws');
const { redact } = require('./providers');

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const EXAMPLE_FILE = path.join(HERE, 'config.example.json');
let win = null;
let bridge = null;
let flux = null;
let cfg = {};
let speakingStream = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Voice capture is initiated by the in-game hotkey, not a click inside this
// window. Keep Chromium from suspending audio work when the companion is
// minimized or covered by the game.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch {
    try { return JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8')); }
    catch { return {}; }
  }
}

function publicConfig() {
  const c = readConfig();
  return {
    configured: fs.existsSync(CONFIG_FILE),
    deepgram: c.deepgram || {},
    fish: c.fish || {},
    llm: c.llm || {},
    audio: c.audio || {},
    announce: c.announce || {},
    capture: c.capture || {},
  };
}

function writeConfig(update) {
  const current = readConfig();
  current.deepgram = { ...(current.deepgram || {}), ...(update.deepgram || {}) };
  current.fish = { ...(current.fish || {}), ...(update.fish || {}) };
  current.llm = { ...(current.llm || {}), ...(update.llm || {}) };
  current.audio = { ...(current.audio || {}), ...(update.audio || {}) };
  current.announce = { ...(current.announce || {}), ...(update.announce || {}) };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
  cfg = current;
}

function ui(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function log(line) {
  const clean = redact(line).trimEnd();
  if (clean) ui('log', clean);
}

function startBridge() {
  if (bridge) bridge.kill();
  if (!fs.existsSync(CONFIG_FILE)) {
    ui('status', { state: 'setup', text: 'Run npm run setup once, then restart the companion.' });
    return;
  }
  const child = fork(path.join(HERE, 'bridge.js'), [], { silent: true });
  bridge = child;
  child.stdout.on('data', b => log(b.toString()));
  child.stderr.on('data', b => log(b.toString()));
  child.on('message', onBridgeMessage);
  child.on('exit', code => {
    if (bridge !== child) return;
    bridge = null;
    ui('status', { state: 'error', text: `Game bridge stopped (${code}).` });
    if (!app.isQuitting && code !== 2) setTimeout(startBridge, 3000);
  });
}

function deepgramKey() {
  return process.env.DEEPGRAM_API_KEY || (cfg.deepgram && cfg.deepgram.apiKey) || '';
}

function closeFlux(reason, notifyBridge) {
  if (!flux) return;
  const active = flux;
  flux = null;
  clearTimeout(active.timer);
  ui('capture:stop');
  try { active.socket.close(); } catch {}
  if (notifyBridge && bridge && bridge.connected) bridge.send({ type: 'voice:error', requestId: active.requestId, error: reason || 'Listening cancelled.' });
  ui('status', { state: 'idle', text: reason || 'Ready' });
}

function startFlux(message) {
  closeFlux('A new listening session started.', true);
  const key = deepgramKey();
  if (!key) {
    bridge.send({ type: 'voice:error', requestId: message.requestId, error: 'No Deepgram API key is configured.' });
    ui('status', { state: 'error', text: 'Add a Deepgram API key in Settings.' });
    return;
  }
  const dg = cfg.deepgram || {};
  const params = new URLSearchParams({
    model: dg.model || 'flux-general-en',
    encoding: 'linear16',
    sample_rate: '16000',
    eot_threshold: String(dg.eotThreshold || 0.7),
    eot_timeout_ms: String(dg.eotTimeoutMs || 5000),
  });
  for (const term of dg.keyterms || ['World of Warcraft', 'Azeroth', 'Horde', 'Alliance', 'Questie']) params.append('keyterm', term);
  const socket = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, { headers: { Authorization: `Token ${key}` } });
  const active = {
    socket,
    requestId: message.requestId,
    lastTranscript: '',
    timer: null,
    audioBytes: 0,
    audioChunks: 0,
    turnEvents: 0,
  };
  flux = active;
  const captureTimeoutMs = dg.captureTimeoutMs || 30000;
  active.timer = setTimeout(() => {
    const reason = active.audioBytes === 0
      ? 'Microphone produced no audio. Check the selected Windows input device.'
      : 'Deepgram did not detect the end of your turn. Try again and leave a short pause after speaking.';
    log(`Voice capture timed out after ${captureTimeoutMs} ms: ${active.audioChunks} audio chunks (${active.audioBytes} bytes), ${active.turnEvents} Deepgram turn events.`);
    closeFlux(reason, true);
  }, captureTimeoutMs);
  socket.on('open', () => {
    if (flux !== active) return;
    log(`Deepgram connected for voice request ${active.requestId}.`);
    ui('capture:start');
    ui('status', { state: 'listening', text: 'Listening… speak naturally.' });
  });
  socket.on('message', raw => {
    if (flux !== active) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === 'Error' || event.type === 'ConfigureFailure') {
      const detail = event.description || event.code || 'unknown streaming error';
      closeFlux(`Deepgram failed: ${detail}`, true);
      return;
    }
    if (event.type === 'TurnInfo') active.turnEvents += 1;
    if (event.type === 'TurnInfo' && event.transcript) active.lastTranscript = event.transcript.trim();
    if (event.event === 'StartOfTurn') ui('status', { state: 'hearing', text: event.transcript || 'Hearing you…' });
    else if (event.event === 'Update' && event.transcript) ui('status', { state: 'listening', text: event.transcript });
    else if (event.event === 'EndOfTurn') {
      const transcript = String(event.transcript || active.lastTranscript || '').trim();
      flux = null;
      clearTimeout(active.timer);
      ui('capture:stop');
      try { socket.close(); } catch {}
      if (transcript) {
        bridge.send({ type: 'voice:transcript', requestId: active.requestId, transcript });
        ui('status', { state: 'thinking', text: `Heard: ${transcript}` });
      } else {
        bridge.send({ type: 'voice:error', requestId: active.requestId, error: 'I did not hear any speech. Try again.' });
        ui('status', { state: 'idle', text: 'No speech detected.' });
      }
    }
  });
  socket.on('error', err => {
    if (flux !== active) return;
    closeFlux(`Deepgram connection failed: ${err.message}`, true);
  });
  socket.on('close', () => {
    if (flux === active) closeFlux('Deepgram closed before finishing the turn.', true);
  });
}

function onBridgeMessage(message) {
  if (!message || !message.type) return;
  if (message.type === 'voice:start') startFlux(message);
  else if (message.type === 'voice:cancel') closeFlux('Listening cancelled.', true);
  else if (message.type === 'config:announce') {
    // Switched in game (/wow-claude announce ...): keep it and show it in Settings.
    writeConfig({ announce: message.announce || {} });
    ui('config:announce', cfg.announce);
  }
  else if (message.type === 'voice:volume') {
    const volumePercent = Math.max(0, Math.min(200, Math.round(Number(message.volumePercent) || 0)));
    writeConfig({ audio: { volumePercent } });
    ui('audio:volume', { volumePercent });
    log(`Voice playback volume set to ${volumePercent}%.`);
  }
  else if (message.type === 'audio:play') {
    try {
      const bytes = fs.readFileSync(message.file);
      try { fs.unlinkSync(message.file); } catch {}
      ui('audio:play', {
        base64: bytes.toString('base64'),
        mime: 'audio/wav',
        volumePercent: ((cfg.audio || {}).volumePercent ?? 125),
      });
      ui('status', { state: 'speaking', text: 'Speaking…' });
    } catch (e) { log(`audio playback file failed: ${e.message}`); }
  } else if (message.type === 'audio:chunk') {
    // Streamed speech: PCM chunks straight to the renderer's Web Audio queue.
    if (message.streamId !== speakingStream) {
      speakingStream = message.streamId;
      ui('status', { state: 'speaking', text: 'Speaking…' });
    }
    ui('audio:stream', {
      streamId: message.streamId,
      sampleRate: message.sampleRate,
      base64: message.base64,
      volumePercent: ((cfg.audio || {}).volumePercent ?? 125),
    });
  } else if (message.type === 'audio:end') {
    ui('audio:stream-end', { streamId: message.streamId, cancelled: !!message.cancelled });
  } else if (message.type === 'status') ui('status', message.status);
  else if (message.type === 'guide:sources') ui('guide:sources', { sources: message.sources });
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 620,
    minHeight: 580,
    title: 'WoW Voice Guide',
    backgroundColor: '#090b10',
    webPreferences: {
      preload: path.join(HERE, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(HERE, 'companion.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.handle('config:get', () => publicConfig());
ipcMain.handle('config:save', (_event, update) => {
  writeConfig(update || {});
  startBridge();
  return publicConfig();
});
ipcMain.on('capture:audio', (_event, arrayBuffer) => {
  if (flux && flux.socket.readyState === WebSocket.OPEN) {
    const audio = Buffer.from(arrayBuffer);
    flux.audioChunks += 1;
    flux.audioBytes += audio.length;
    flux.socket.send(audio);
  }
});
ipcMain.on('capture:force-end', () => {
  if (flux && flux.socket.readyState === WebSocket.OPEN) flux.socket.send(JSON.stringify({ type: 'ForceEndTurn' }));
});
ipcMain.on('capture:cancel', () => closeFlux('Listening cancelled.', true));
ipcMain.on('audio:ended', () => ui('status', { state: 'idle', text: 'Ready' }));
ipcMain.on('guide:open-source', (_event, value) => {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && !url.username && !url.password) shell.openExternal(url.href);
  } catch {}
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    cfg = readConfig();
    createWindow();
    startBridge();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    closeFlux('', false);
    if (bridge) bridge.kill();
  });
  app.on('window-all-closed', () => app.quit());
}
