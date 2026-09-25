'use strict';

const fs = require('fs');
const path = require('path');
const { SILENT_WAV } = require('./protocol');

// The game checks whether this pre-indexed file is playable. A silent WAV means
// the companion is playing speech; an empty file means the portrait rests.
function writeTalkingSignal(addonDir, active) {
  if (!addonDir) return false;
  const marker = path.join(addonDir, 'WoWClaude', 'ctl', 'talk.wav');
  if (!fs.existsSync(marker)) return false;
  const tmp = marker + '.tmp';
  try {
    fs.writeFileSync(tmp, active ? SILENT_WAV : Buffer.alloc(0));
    fs.renameSync(tmp, marker);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return true;
}

module.exports = { writeTalkingSignal };
