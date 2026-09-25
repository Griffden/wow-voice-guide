'use strict';
// The merged live game state the add-on pushes (addon/WoWClaude/GameState.lua),
// and the model context assembled from it per question. Pure: no I/O, so
// tests/gamestate_test.js exercises it directly; bridge.js keeps the store in
// state.json.
//
// A section record (flag "s") carries "key GS value" pairs joined by FS. An
// empty value deletes that section; the key "*" clears them all (context off,
// or the start of a full resend). The older single context string (flag "c",
// reload-mode outbox) is kept as one "legacy" section.

const FS = '\x1C';
const GS = '\x1D';
const SECTION_MAX = 4000;

// Render order, and the base weight used when the budget forces a choice.
const SECTIONS = Object.freeze([
  { key: 'legacy', weight: 100 },
  { key: 'char', weight: 100 },
  { key: 'loc', weight: 95 },
  { key: 'prog', weight: 50 },
  { key: 'target', weight: 70 },
  { key: 'npc', weight: 75 },
  { key: 'quest', weight: 85 },
  { key: 'quests', weight: 80 },
  { key: 'talents', weight: 30 },
  { key: 'prof', weight: 30 },
  { key: 'gear', weight: 35 },
  { key: 'taxi', weight: 25 },
]);

// What a question is about -> the section that should win the budget.
const BOOSTS = Object.freeze({
  npc: /\b(he|she|they|him|her|this (?:npc|guy|person)|npc|said|says|say|saying|talk(?:ing)?|dialog|gossip|offer(?:s|ing)?|quest ?giver)\b/,
  target: /\b(target(?:ed)?|this (?:mob|monster|enemy|creature|thing|boss)|kill|attack|fight|elite|rare|dangerous|tough)\b/,
  talents: /\b(talents?|spec(?:ialization)?|build|points?)\b/,
  prof: /\b(professions?|skills?|craft(?:ing)?|herb(?:alism)?|min(?:e|ing)|skinn(?:ing)?|alchemy|blacksmith(?:ing)?|enchant(?:ing)?|tailor(?:ing)?|leatherworking|engineering|cook(?:ing)?|fish(?:ing)?|first aid)\b/,
  taxi: /\b(fly|flight|flights|taxi|gryphon|wyvern|hippogryph|bat|travel|fastest way|get to)\b/,
  gear: /\b(gear|items?|equip(?:ped|ment)?|weapons?|armou?r|upgrades?|durability|repair|bags?|ilvl|item level|inventory)\b/,
  prog: /\b(money|gold|silver|xp|experience|rested|level(?:ing)?|ding)\b/,
  char: /\b(hearth(?:stone)?|home|bind)\b/,
  quest: /\b(quest|objective|turn in|where (?:do i|should i) go|next|task)\b/,
});

function newStore() {
  return { sections: {}, session: '', updated: 0 };
}

// "key GS value FS key GS value" -> [[key, value]]
function parseSections(payload) {
  const pairs = [];
  for (const part of String(payload || '').split(FS)) {
    if (!part) continue;
    const at = part.indexOf(GS);
    const key = (at < 0 ? part : part.slice(0, at)).trim();
    if (!/^[\w.*-]{1,32}$/.test(key)) continue;
    pairs.push([key, at < 0 ? '' : part.slice(at + 1)]);
  }
  return pairs;
}

function encodeSections(pairs) {
  return pairs.map(([k, v]) => `${k}${GS}${v}`).join(FS);
}

// Apply one record's sections. Returns the keys that changed.
function applySections(store, payload, { now = Date.now(), session = '' } = {}) {
  const changed = [];
  for (const [key, raw] of parseSections(payload)) {
    if (key === '*') {
      changed.push(...Object.keys(store.sections));
      store.sections = {};
      continue;
    }
    const text = String(raw).replace(/\r/g, '').trim().slice(0, SECTION_MAX);
    const prev = store.sections[key];
    if (!text) { if (prev) { delete store.sections[key]; changed.push(key); } continue; }
    if (prev && prev.text === text) { prev.at = now; continue; }
    store.sections[key] = { text, at: now };
    changed.push(key);
  }
  if (session) store.session = session;
  store.updated = now;
  return changed;
}

// The older add-on (or the reload path) sends one context string instead.
function setLegacyContext(store, text, { now = Date.now(), session = '' } = {}) {
  const clean = String(text || '').replace(/\r/g, '').trim().slice(0, 2000);
  store.sections = clean ? { legacy: { text: clean, at: now } } : {};
  if (session) store.session = session;
  store.updated = now;
  return clean;
}

// ---------------------------------------------------------------------------
// Completed quests: runs of ids, base 36, deltas from the previous run's end
// ("a~3" = 4 ids starting 10 after the previous one). See EncodeIds in GameState.lua.
// ---------------------------------------------------------------------------

function decodeIds(text, into = new Set()) {
  let prev = 0;
  for (const token of String(text || '').split(',')) {
    if (!token) continue;
    const [delta, extra] = token.split('~');
    const start = prev + parseInt(delta, 36);
    const count = extra ? parseInt(extra, 36) + 1 : 1;
    if (!Number.isFinite(start) || !Number.isFinite(count) || count > 100000) continue;
    for (let i = 0; i < count; i++) into.add(start + i);
    prev = start + count - 1;
  }
  return into;
}

function completedQuestIds(store) {
  const ids = new Set();
  const sections = (store && store.sections) || {};
  const summary = sections.done && sections.done.text.match(/in (\d+) chunks/);
  const chunks = summary ? Number(summary[1]) : Infinity;
  for (const [key, value] of Object.entries(sections)) {
    const m = key.match(/^done\.(\d+)$/);
    if (m && Number(m[1]) <= chunks) decodeIds(value.text, ids);
  }
  if (sections['done.new']) decodeIds(sections['done.new'].text, ids);
  return ids;
}

// ---------------------------------------------------------------------------
// The player, as the sections describe them (for the quest database filters)
// ---------------------------------------------------------------------------

const RACES = ['Night Elf', 'Blood Elf', 'Void Elf', 'Lightforged Draenei', 'Dark Iron Dwarf', 'Highmountain Tauren', "Mag'har Orc", 'Kul Tiran', 'Zandalari Troll',
  'Human', 'Dwarf', 'Gnome', 'Draenei', 'Worgen', 'Orc', 'Undead', 'Tauren', 'Troll', 'Goblin', 'Pandaren', 'Nightborne', 'Vulpera', 'Mechagnome', 'Dracthyr', 'Earthen'];
const CLASSES = ['Death Knight', 'Demon Hunter', 'Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Monk', 'Druid', 'Evoker'];

function sectionText(store, key) {
  const s = store && store.sections && store.sections[key];
  return s ? s.text : '';
}

function allText(store) {
  return Object.values((store && store.sections) || {}).map(s => s.text).join('\n');
}

// { name, level, race, class, faction, zone, mapId, x, y } from whatever is known.
function playerInfo(store) {
  const text = allText(store);
  const out = {};
  const who = text.match(/^Character: ([^,\n]+?)(?: on [^,\n]+)?, (.+)$/m);
  if (who) {
    out.name = who[1];
    const rest = who[2];
    const level = rest.match(/level (\d+)/);
    if (level) out.level = Number(level[1]);
    out.race = RACES.find(r => rest.includes(r)) || '';
    out.class = CLASSES.find(c => new RegExp(`\\b${c}\\b`).test(rest)) || '';
    const faction = rest.match(/\((Alliance|Horde)\)/);
    if (faction) out.faction = faction[1];
  }
  const loc = text.match(/^Location: ([^\n]+?)(?: - [^\n]+)?$/m);
  if (loc) out.zone = loc[1].trim();
  const pos = text.match(/^Position: ([\d.]+), ([\d.]+)(?: on (.+?))? \(map (\d+)\)$/m);
  if (pos) { out.x = Number(pos[1]); out.y = Number(pos[2]); out.mapId = Number(pos[4]); if (pos[3]) out.mapName = pos[3]; }
  return out;
}

// Quest ids in the log, from the "Quest log (N): T (#id) [..]; ..." line.
function questLogIds(store) {
  const line = allText(store).match(/^Quest log \(\d+\): (.+)$/m);
  const ids = new Set();
  if (line) for (const m of line[1].matchAll(/\(#(\d+)\)/g)) ids.add(Number(m[1]));
  const focus = allText(store).match(/^(?:Selected|Tracked|Only) quest: .+ \(id (\d+)\)$/m);
  if (focus) ids.add(Number(focus[1]));
  return ids;
}

// ---------------------------------------------------------------------------
// The model's game context: every section that fits, the ones the question is
// about first, rendered in a fixed order.
// ---------------------------------------------------------------------------

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function renderSection(key, section, now) {
  const age = now - (section.at || now);
  if (key === 'npc') {
    if (age > 30 * 60 * 1000) return '';
    return `Last NPC dialog (opened ${ago(age)}):\n${section.text}`;
  }
  if (key === 'target' && age > 60 * 60 * 1000) return '';
  return section.text;
}

function assembleContext(store, question = '', { maxChars = 3500, now = Date.now() } = {}) {
  const sections = (store && store.sections) || {};
  const q = ` ${String(question || '').toLowerCase()} `;
  const candidates = [];
  SECTIONS.forEach(({ key, weight }, order) => {
    const section = sections[key];
    if (!section) return;
    const text = renderSection(key, section, now);
    if (!text) return;
    let w = weight;
    if (BOOSTS[key] && BOOSTS[key].test(q)) w += 100;
    if (key === 'npc' && now - section.at < 3 * 60 * 1000) w += 20;
    candidates.push({ key, text, weight: w, order });
  });
  const completed = completedQuestIds(store);
  if (completed.size) candidates.push({ key: 'done', text: `Completed quests: ${completed.size} (the guide's quest database knows which)`, weight: 20, order: 99 });
  const chosen = [];
  let room = maxChars;
  for (const c of [...candidates].sort((a, b) => b.weight - a.weight || a.order - b.order)) {
    const cost = c.text.length + 1;
    if (cost <= room) { chosen.push(c); room -= cost; }
    else if (room > 200) {
      const cut = c.text.slice(0, room - 5).replace(/\n[^\n]*$/, '');
      if (cut.length > 100) { chosen.push({ ...c, text: `${cut}\n...` }); room -= cut.length + 5; }
    }
  }
  return chosen.sort((a, b) => a.order - b.order).map(c => c.text).join('\n');
}

// One line for logs and the banner.
function summary(store) {
  const char = sectionText(store, 'char') || sectionText(store, 'legacy');
  return (char.split('\n').find(l => /^Character:/.test(l)) || char.split('\n')[0] || '').slice(0, 100);
}

module.exports = {
  FS, GS, SECTIONS,
  newStore, parseSections, encodeSections, applySections, setLegacyContext,
  decodeIds, completedQuestIds, playerInfo, questLogIds, sectionText,
  assembleContext, summary,
};
