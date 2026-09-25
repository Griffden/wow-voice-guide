'use strict';
// WoW: Forever game data from Wowhead's public tooltip and search endpoints.
// Wowhead has no official API; these are the JSON endpoints behind its own
// tooltips and search box, so lookups are cached and kept small.
//
//   search(query)      name -> quests/NPCs/items/spells with ids and quest text
//   lookup(type, id)   one entity's tooltip: objectives, spell/item text, NPC map
//   questNotes(q, ctx) quests from the player's log that a question refers to,
//                      looked up before the model runs
//
// zones.json maps Wowhead's zone (AreaTable) ids to in-game uiMapIDs. It was
// generated from the Forever 1.60.1.70009 UiMap/UiMapAssignment tables on
// wago.tools.

const ZONES = require('./zones.json');

const SITE = 'https://www.wowhead.com/forever';
const TOOLTIP = 'https://nether.wowhead.com/forever/tooltip';
const TYPES = Object.freeze(['quest', 'npc', 'item', 'spell', 'zone', 'object']);
const TYPE_NAMES = Object.freeze({ Quest: 'quest', NPC: 'npc', Item: 'item', Spell: 'spell', Zone: 'zone', Object: 'object' });
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function entityUrl(type, id) {
  return `${SITE}/${type}=${id}`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>|<\/(?:tr|div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function getJson(url, { timeoutMs = 6000, signal } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Wowhead returned ${response.status}`);
    const value = await response.json();
    cache.set(url, { at: Date.now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

async function search(query, { limit = 6, ...opts } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const json = await getJson(`${SITE}/search/suggestions-template?q=${encodeURIComponent(q)}`, opts);
  return (Array.isArray(json && json.results) ? json.results : []).slice(0, limit).map(result => {
    const type = TYPE_NAMES[result.typeName] || String(result.typeName || '').toLowerCase();
    const level = String(result.pinFooterText || '').match(/Level:?\s*(\d+)/i);
    return {
      type,
      id: result.id,
      name: String(result.name || ''),
      ...(level ? { level: Number(level[1]) } : {}),
      ...(Array.isArray(result.pinBreadcrumb) && result.pinBreadcrumb.length ? { category: result.pinBreadcrumb.join(' > ') } : {}),
      ...(result.side === 1 ? { side: 'Alliance' } : result.side === 2 ? { side: 'Horde' } : {}),
      text: htmlToText(result.pinDescription).slice(0, 700),
      url: entityUrl(type, result.id),
    };
  });
}

// Wowhead coordinates are 0-100 on the zone map; keep a few spawn points.
function mapLocation(map) {
  if (!map || typeof map !== 'object') return null;
  const zone = ZONES[String(map.zone)];
  const floors = map.coords && typeof map.coords === 'object' ? Object.values(map.coords) : [];
  const points = floors.flat().filter(p => Array.isArray(p) && p.length >= 2).slice(0, 5);
  if (!points.length) return null;
  return { zone: zone ? zone.name : `zone ${map.zone}`, ...(zone ? { uiMapId: zone.uiMapId } : {}), coords: points.map(([x, y]) => [x, y]) };
}

async function lookup(type, id, opts = {}) {
  const kind = String(type || '').toLowerCase();
  const num = Number(id);
  if (!TYPES.includes(kind)) throw new Error(`Unknown Wowhead type "${type}".`);
  if (!Number.isInteger(num) || num <= 0) throw new Error(`Invalid ${kind} id "${id}".`);
  const json = await getJson(`${TOOLTIP}/${kind}/${num}`, opts);
  if (!json || json.error || !json.name) throw new Error(`Wowhead has no Forever entry for ${kind} ${num}.`);
  const location = mapLocation(json.map);
  return {
    type: kind,
    id: num,
    name: String(json.name),
    text: htmlToText(json.tooltip).slice(0, 1500),
    ...(location ? { location } : {}),
    url: entityUrl(kind, num),
  };
}

// ---------------------------------------------------------------------------
// The player's quest log, as the add-on sends it in the game context
// ---------------------------------------------------------------------------

function focusedQuest(context) {
  const match = String(context || '').match(/^(?:Selected|Tracked|Only) quest: (.+?) \(id (\d+)\)$/m);
  return match ? { title: match[1], id: Number(match[2]) } : null;
}

function questLog(context) {
  const quests = [];
  const line = String(context || '').match(/^Quest log \(\d+\): (.+)$/m);
  if (line) {
    for (const entry of line[1].split('; ')) {
      // "Title (#id)", optionally followed by "[objective progress / ready to turn in]".
      const match = entry.match(/^(.+?) \(#(\d+)\)(?: \[[^\]]*\])?$/);
      if (match) quests.push({ title: match[1], id: Number(match[2]) });
    }
  }
  const focused = focusedQuest(context);
  if (focused && !quests.some(q => q.id === focused.id)) quests.unshift(focused);
  return quests;
}

const TITLE_STOPWORDS = new Set('a an and the of to in on for from with at by'.split(' '));

function words(text) {
  return String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Quests the question names (whole title, or every significant title word for
// titles of two or more such words, since speech transcripts rarely match a
// title exactly), then the selected/tracked quest when the question points at it.
function mentionedQuests(question, context, max = 3) {
  const q = ` ${words(question)} `;
  const found = [];
  for (const quest of questLog(context)) {
    const title = words(quest.title);
    if (!title) continue;
    const significant = title.split(' ').filter(w => w.length >= 3 && !TITLE_STOPWORDS.has(w));
    if (q.includes(` ${title} `) || (significant.length >= 2 && significant.every(w => q.includes(` ${w} `)))) found.push(quest);
  }
  const focused = focusedQuest(context);
  if (focused && !found.some(quest => quest.id === focused.id) &&
    /\b(this|my|current|tracked|selected) quest\b|\bwhere do i go\b|\bwhat do i do\b|\bnext step\b|\bobjective\b|\b(finish|complete|turn in) (this|it)\b/.test(q)) {
    found.push(focused);
  }
  return found.slice(0, max);
}

// Tooltip (objectives, turn-in) plus the quest text from search for each quest
// the question refers to. Failures are skipped: the model can still search.
async function questNotes(question, context, { timeoutMs = 4000 } = {}) {
  const quests = mentionedQuests(question, context);
  if (!quests.length) return { quests: [], text: '', sources: [] };
  const opts = { timeoutMs };
  const notes = await Promise.all(quests.map(async quest => {
    const [tip, found] = await Promise.allSettled([
      lookup('quest', quest.id, opts),
      search(quest.title, { ...opts, limit: 10 }),
    ]);
    const tooltip = tip.status === 'fulfilled' ? tip.value : null;
    const match = found.status === 'fulfilled' ? found.value.find(r => r.type === 'quest' && r.id === quest.id) : null;
    if (!tooltip && !match) return null;
    const lines = [`Quest ${quest.id} "${quest.title}"${match && match.level ? `, level ${match.level}` : ''}${match && match.category ? `, ${match.category}` : ''}:`];
    if (tooltip) lines.push(`Objectives: ${tooltip.text.replace(/^.*\n/, '').replace(/\n/g, ' ')}`);
    if (match && match.text) lines.push(`Quest text: ${match.text.replace(/\n/g, ' ')}`);
    return { quest, text: lines.join('\n'), source: { title: `${quest.title} - Wowhead Forever`, url: entityUrl('quest', quest.id) } };
  }));
  const ok = notes.filter(Boolean);
  return {
    quests: ok.map(n => n.quest),
    text: ok.map(n => n.text).join('\n\n'),
    sources: ok.map(n => n.source),
  };
}

function zoneByName(name) {
  const wanted = String(name || '').toLowerCase().trim();
  return Object.values(ZONES).find(zone => zone.name.toLowerCase() === wanted) || null;
}

module.exports = {
  TYPES,
  htmlToText,
  search,
  lookup,
  focusedQuest,
  questLog,
  mentionedQuests,
  questNotes,
  zoneByName,
  entityUrl,
  _cache: cache,
};
