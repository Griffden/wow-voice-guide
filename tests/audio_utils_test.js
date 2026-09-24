'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { downsampleTo16k } = require('../bridge/audio-utils');

test('downsampleTo16k converts float PCM to signed 16-bit PCM', () => {
  const input = new Float32Array(480);
  input.fill(0.5);
  const output = downsampleTo16k(input, 48000);
  assert.ok(output instanceof Int16Array);
  assert.equal(output.length, 160);
  assert.ok(output.every(v => v === 16384));
});

test('downsampleTo16k clips and rejects unsupported sample rates', () => {
  assert.deepEqual(Array.from(downsampleTo16k(new Float32Array([-2, 2]), 16000)), [-32768, 32767]);
  assert.throws(() => downsampleTo16k(new Float32Array([0]), 8000), /at least 16 kHz/);
});
