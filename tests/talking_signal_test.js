'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTalkingSignal } = require('../bridge/talking-signal');

test('the desktop talking signal makes the pre-indexed sound file playable only during speech', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-portrait-'));
  const marker = path.join(root, 'WoWClaude', 'ctl', 'talk.wav');
  try {
    assert.equal(writeTalkingSignal(root, true), false, 'setup must create the file first');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    assert.equal(writeTalkingSignal(root, true), true);
    assert.equal(fs.readFileSync(marker).toString('ascii', 0, 4), 'RIFF');
    assert.equal(writeTalkingSignal(root, false), true);
    assert.equal(fs.statSync(marker).size, 0);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
