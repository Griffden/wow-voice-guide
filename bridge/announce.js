'use strict';
// Opt-in spoken announcements: the add-on reports a moment (an "a" record:
// quest objectives done, level up, new zone, bags nearly full, gear about to
// break, quest accepted) and, when the player switched that kind on, the
// companion says one or two sentences about it in the selected Fish voice.
//
// The sentences are built here from the moment, the game state and the
// offline quest database, without a model call, so they are instant and
// free. Every kind is off by default, each kind is rate limited, and
// announcements wait while the guide is answering. The add-on never sends
// moments during combat. Informational only: nothing acts for the player.

const GameState = require('./gamestate');
const QuestDB = require('./questdb');

const KINDS = Object.freeze(['quest', 'level', 'zone', 'bags', 'narrate']);
// Minimum time between two announcements of the same moment kind.
const MIN_INTERVAL_MS = Object.freeze({ quest: 10000, level: 0, zone: 90000, bags: 300000, repair: 300000, accept: 0 });
const STALE_MS = 60000;
const QUEUE_MAX = 4;

function settings(cfg) {
  const a = (cfg && cfg.announce) || {};
  const out = {};
  for (const kind of KINDS) out[kind] = a[kind] === true;
  return out;
}

function toggleFor(kind) {
  if (kind === 'accept') return 'narrate';
  if (kind === 'repair') return 'bags';
  return kind;
}

function fieldsOf(text) {
  const out = {};
  for (const [key, value] of GameState.parseSections(text)) out[key] = value;
  return out;
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function sentence(text) {
  const t = String(text || '').trim();
  return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`;
}

// The quest database scope from the game state.
function scope(game) {
  if (!game) return { player: {}, completed: new Set(), active: new Set() };
  return { player: GameState.playerInfo(game), completed: GameState.completedQuestIds(game), active: GameState.questLogIds(game) };
}

// What to say about one moment, or '' when there is nothing useful to say.
function compose(fields, { game } = {}) {
  const kind = fields.kind;
  if (kind === 'quest') {
    const title = fields.title || 'A quest';
    let where = sentence(fields.next);
    if (!where && fields.id && QuestDB.available()) {
      const info = QuestDB.questInfo(fields.id, scope(game)).results;
      const giver = info && info[0] && info[0].givers.find(g => g.npc && typeof g.x === 'number');
      if (giver) where = `The quest giver was ${giver.npc}, at ${Math.round(giver.x)}, ${Math.round(giver.y)} in ${giver.zone}.`;
    }
    return `${title} is ready to turn in.${where ? ` ${where}` : ''}`;
  }
  if (kind === 'level') {
    const spells = String(fields.spells || '').split(';').map(s => s.trim()).filter(Boolean);
    return `Level ${fields.level || 'up'}!${spells.length ? ` New at your class trainer: ${listNames(spells)}.` : ''}`;
  }
  if (kind === 'zone') {
    const zone = fields.zone || 'a new zone';
    let brief = '';
    if (QuestDB.available()) {
      const s = scope(game);
      const mapId = Number(fields.map) || QuestDB.mapIdByName(zone) || s.player.mapId;
      // The position is only useful once it is on the new map.
      const sameMap = s.player.mapId === mapId;
      if (mapId) brief = QuestDB.zoneSummary({ ...s, player: sameMap ? s.player : { ...s.player, mapId, x: undefined, y: undefined } });
    }
    return `Welcome to ${zone}.${brief ? ` ${brief}` : ''}`;
  }
  if (kind === 'bags') {
    const free = Number(fields.free);
    return Number.isFinite(free) ? `Your bags are almost full: ${free === 0 ? 'no free slots left' : `${free} free slot${free === 1 ? '' : 's'} left`}.` : '';
  }
  if (kind === 'repair') {
    return `Your gear needs repair: ${String(fields.slot || 'an item').toLowerCase()} is at ${fields.percent}% durability.`;
  }
  if (kind === 'accept') {
    const parts = [sentence(fields.title), fields.text, fields.objectives ? sentence(fields.objectives) : ''].filter(Boolean);
    return parts.join(' ');
  }
  return '';
}

class Announcer {
  // speak(text) -> Promise; busy() -> true while the guide is answering or speaking.
  constructor({ cfg, speak, log = () => {}, busy = () => false, now = () => Date.now(), retryMs = 1000 }) {
    this.cfg = cfg;
    this.speak = speak;
    this.log = log;
    this.busy = busy;
    this.now = now;
    this.retryMs = retryMs;
    this.queue = [];
    this.last = {};
    this.speaking = false;
    this.timer = null;
  }

  // Returns what happened, for logs and tests.
  handle(text, context = {}) {
    const fields = fieldsOf(text);
    const kind = fields.kind;
    if (!kind) return 'ignored';
    if (!settings(this.cfg)[toggleFor(kind)]) return 'off';
    const at = this.now();
    if (at - (this.last[kind] || -Infinity) < (MIN_INTERVAL_MS[kind] ?? 30000)) return 'rate-limited';
    const say = compose(fields, context);
    if (!say) return 'nothing to say';
    this.last[kind] = at;
    this.queue.push({ kind, say, at });
    while (this.queue.length > QUEUE_MAX) this.queue.shift();
    this.pump();
    return 'queued';
  }

  pump() {
    if (this.speaking || this.timer || !this.queue.length) return;
    if (this.busy()) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.retryMs);
      return;
    }
    const item = this.queue.shift();
    if (this.now() - item.at > STALE_MS) { this.pump(); return; }
    this.speaking = true;
    this.log(`announce ${item.kind}: ${item.say}`);
    Promise.resolve()
      .then(() => this.speak(item.say, item.kind))
      .catch(e => this.log(`announcement failed: ${e.message}`))
      .finally(() => { this.speaking = false; this.pump(); });
  }

  stop() { clearTimeout(this.timer); this.timer = null; this.queue = []; }
}

// "Read me this quest": the focused quest's story from the game state.
function asksToReadQuest(question) {
  return /\b(read|narrate)\b[^.?!]{0,30}\bquests?\b/i.test(String(question || ''));
}

function questStory(game) {
  const text = GameState.sectionText(game, 'quest');
  const title = text.match(/^(?:Selected|Tracked|Only|Quest) quest: (.+?) \(id \d+\)$/m);
  if (!title) return '';
  const grab = label => (text.match(new RegExp(`^${label}: (.+)$`, 'm')) || [])[1] || '';
  return [sentence(title[1]), grab('Quest description'), sentence(grab('Quest instructions'))].filter(Boolean).join(' ');
}

module.exports = { KINDS, MIN_INTERVAL_MS, settings, toggleFor, fieldsOf, compose, Announcer, asksToReadQuest, questStory };
