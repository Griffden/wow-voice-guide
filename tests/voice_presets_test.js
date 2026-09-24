'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { voices, presetForVoiceId } = require('../bridge/voice-presets');

test('the four built-in Fish voice IDs have stable names and leave custom IDs alone', () => {
  assert.deepEqual(voices, [
    { id: '06c4b6c98f8a451cad28734427faaa9d', name: 'Warcraft 3 Peon' },
    { id: 'fa4d72bfeee64c029970e09aeb67c43e', name: 'Furbolg (Warcraft 3 ENG)' },
    { id: 'b31185cef9d54e908c58dfe901e9598b', name: 'Warcraft 3 Knight' },
    { id: 'fb029f2d4c6c4405bd5b476b536519ae', name: 'Asmongold' },
  ]);
  assert.equal(presetForVoiceId(' b31185cef9d54e908c58dfe901e9598b ').name, 'Warcraft 3 Knight');
  assert.equal(presetForVoiceId('a-custom-voice-id'), null);
  const example = require('../bridge/config.example.json');
  assert.equal(example.fish.voiceId, voices[0].id, 'Peon remains the initial choice');
});

test('the companion loads the voice library alongside the editable custom ID', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'companion.html'), 'utf8');
  assert.match(html, /id="fishVoicePreset"/);
  assert.match(html, /id="fishVoice"/);
  assert.match(html, /<script src="voice-presets\.js"><\/script>/);
});
