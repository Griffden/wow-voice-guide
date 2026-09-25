'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { voices, presetForVoiceId, portraitForVoiceId } = require('../bridge/voice-presets');

test('the three built-in Fish voice IDs have stable names and leave custom IDs alone', () => {
  assert.deepEqual(voices, [
    { id: '06c4b6c98f8a451cad28734427faaa9d', name: 'Warcraft 3 Peon', portrait: 'peon' },
    { id: 'fa4d72bfeee64c029970e09aeb67c43e', name: 'Furbolg (Warcraft 3 ENG)' },
    { id: 'b31185cef9d54e908c58dfe901e9598b', name: 'Warcraft 3 Knight', portrait: 'knight' },
  ]);
  assert.equal(presetForVoiceId(' b31185cef9d54e908c58dfe901e9598b ').name, 'Warcraft 3 Knight');
  assert.equal(presetForVoiceId('a-custom-voice-id'), null);
  assert.equal(presetForVoiceId('fb029f2d4c6c4405bd5b476b536519ae'), null, 'removed Asmongold ID is no longer a preset');
  assert.equal(portraitForVoiceId(voices[0].id), 'peon');
  assert.equal(portraitForVoiceId(voices[2].id), 'knight');
  assert.equal(portraitForVoiceId(voices[1].id), 'guide');
  assert.equal(portraitForVoiceId('a-custom-voice-id'), 'guide');
  const example = require('../bridge/config.example.json');
  assert.equal(example.fish.voiceId, voices[0].id, 'Peon remains the initial choice');
});

test('the Peon and Knight portraits are four-frame game textures', () => {
  for (const kind of ['peon', 'knight']) {
    const image = fs.readFileSync(path.join(__dirname, '..', 'addon', 'WoWClaude', `portrait-${kind}.tga`));
    assert.equal(image[2], 2);
    assert.equal(image.readUInt16LE(12), 512);
    assert.equal(image.readUInt16LE(14), 128);
    assert.equal(image[16], 32);
    for (let frame = 1; frame < 4; frame++) {
      let changed = 0;
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const rest = 18 + (y * 512 + x) * 4;
          const speaking = rest + frame * 128 * 4;
          if (image[rest] !== image[speaking] || image[rest + 1] !== image[speaking + 1] || image[rest + 2] !== image[speaking + 2]) changed++;
        }
      }
      assert.ok(changed > 100, `${kind} frame ${frame} must visibly differ from its resting frame`);
    }
  }
});

test('the companion loads the voice library alongside the editable custom ID', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'companion.html'), 'utf8');
  assert.match(html, /id="fishVoicePreset"/);
  assert.match(html, /id="fishVoice"/);
  assert.match(html, /<script src="voice-presets\.js"><\/script>/);
});
