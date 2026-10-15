'use strict';
// Polestar (github.com/fitzforge/polestar), the leveling guide add-on, as the
// voice guide sees it. The add-on side (addon/WoWClaude/PolestarLink.lua)
// sends the "polestar" game state section and Polestar moments ("a" records
// of kind pstep, pskip, pdone, proute, ptrain, plevel); this file turns them
// into speech, reads the current step aloud on request, and recognises the
// voice commands that drive Polestar (skip, undo, back, ahead, aim, open a
// guide). Pure: no I/O, no model call.

const GameState = require('./gamestate');

const MOMENTS = Object.freeze(['pstep', 'pskip', 'pdone', 'proute', 'ptrain', 'plevel']);
const ACTIONS = Object.freeze(['skip', 'unskip', 'back', 'ahead', 'current', 'aim', 'guide']);
const NOW_SPOKEN = 3; // goals read out per step; the rest are "and N more"

// Polestar's goal verbs (its describe()): read in lower case mid-sentence.
const VERB = /^(Accept|Turn in|Complete|Kill|Collect|Go to|Talk to|Click|Use|Set your home|Hearth to|Get the flight path|Fly to|Train|Learn|Buy|Explore|Reach|Craft|Loot|Interact with|Interact|Gain|Earn|Discover|Visit|Open|Equip|Escort)\b/;

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// "Kill Mottled Boar 3/8 for Cutting Teeth (optional)" -> "kill Mottled Boar, 3 of 8, for Cutting Teeth, optional"
function goalSpeech(goal) {
  let g = String(goal || '').trim()
    .replace(/ - done$/, '')
    .replace(/ (\d+)\/(\d+)(?= |$)/, ', $1 of $2,')
    .replace(/ \(optional\)$/, ', optional')
    .replace(/,$/, '');
  if (VERB.test(g)) g = g[0].toLowerCase() + g.slice(1);
  return g;
}

function splitList(text) {
  return String(text || '').split(';').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The "polestar" section (P.Section in PolestarLink.lua)
// ---------------------------------------------------------------------------

function sectionText(game) {
  return GameState.sectionText(game, 'polestar');
}

// { guide, step, of, complete, none, title, skipped, viewing, who, person,
// persons, now: [], then, arrow } from the section text, or null without one.
function parseSection(text) {
  const t = String(text || '');
  const head = t.match(/^Polestar guide: (.+?)(?: \((?:step (\d+) of (\d+)[^)]*|(complete))\))?$/m);
  if (!head) return null;
  if (/^installed, no guide open$/.test(head[1])) return { none: true };
  const out = { guide: head[1], now: [] };
  if (head[2]) { out.step = Number(head[2]); out.of = Number(head[3]); }
  if (head[4]) out.complete = true;
  const step = t.match(/^Step (\d+): (.+?)( \(skipped by the player\))?$/m);
  if (step) { out.title = step[2]; out.skipped = !!step[3]; }
  if (/^The player is looking at step \d+; the guide is on step \d+$/m.test(t)) out.viewing = true;
  const who = t.match(/^Now at: (.+?)(?: \(person (\d+) of (\d+)\))?$/m);
  if (who) { out.who = who[1]; if (who[2]) { out.person = Number(who[2]); out.persons = Number(who[3]); } }
  const grab = label => (t.match(new RegExp(`^${label}: (.+)$`, 'm')) || [])[1] || '';
  out.now = splitList(grab('To do now'));
  out.then = grab('Then');
  out.arrow = grab('Arrow');
  return out;
}

// What to say about a step. f: { step, of, title, who, now: [] | "a; b",
// then }. same: the step is the same, only the person changed.
function stepSpeech(f, { same = false } = {}) {
  const now = (Array.isArray(f.now) ? f.now : splitList(f.now)).map(goalSpeech);
  const spoken = now.slice(0, NOW_SPOKEN);
  if (now.length > NOW_SPOKEN) spoken.push(`${now.length - NOW_SPOKEN} more`);
  const parts = [];
  if (!same && f.step) parts.push(`Step ${f.step}${f.of ? ` of ${f.of}` : ''}${f.title ? `, ${f.title}` : ''}.`);
  if (f.who) {
    const lead = same ? `Next, ${f.who}` : `At ${f.who}`;
    parts.push(spoken.length ? `${lead}: ${listNames(spoken)}.` : `${lead}.`);
  } else if (spoken.length) {
    parts.push(`${same ? 'Next, ' : ''}${same ? listNames(spoken) : capitalize(listNames(spoken))}.`);
  }
  if (f.then) parts.push(`Then ${goalSpeech(f.then)}.`);
  return parts.join(' ');
}

// "Read me the step": the section, spoken. '' when there is nothing to read.
function readStep(game) {
  const f = parseSection(sectionText(game));
  if (!f) return '';
  if (f.none) return 'Polestar has no guide open.';
  if (f.complete || !f.step) return `Your Polestar guide, ${f.guide}, is complete.`;
  const say = stepSpeech(f);
  return f.viewing ? `You're looking at a different step in Polestar. ${say}` : say;
}

// ---------------------------------------------------------------------------
// Moments (announce kind "polestar")
// ---------------------------------------------------------------------------

// "Title (reason)" -> "Title: reason"
function skippedSpeech(item) {
  return item.replace(/ \((.+)\)$/, ': $1');
}

function optionSpeech(item) {
  return item.replace(/ \(recommended\)$/, ', recommended,');
}

function orNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function compose(fields) {
  switch (fields.kind) {
    case 'pstep': return stepSpeech(fields, { same: fields.same === '1' });
    case 'pskip': {
      const quests = splitList(fields.quests).map(skippedSpeech);
      return quests.length ? `Polestar moved past ${listNames(quests)}.` : '';
    }
    case 'pdone': return `You finished ${fields.guide || 'your Polestar guide'}.`;
    case 'proute': {
      const options = splitList(fields.options).map(optionSpeech);
      if (!options.length) return '';
      return `${fields.guide ? `${fields.guide} is done. ` : ''}Pick your next zone in Polestar: ${orNames(options).replace(/,$/, '')}.`.replace(/,\./, '.');
    }
    case 'ptrain': {
      if (!fields.npc) return `Time to visit your class trainer${fields.level ? ` for level ${fields.level}` : ''}.`;
      return `Time to visit your class trainer: ${fields.npc}${fields.where ? ` in ${fields.where}` : ''}.`;
    }
    case 'plevel': {
      if (!fields.guide) return '';
      if (!fields.next) return `You've out-leveled ${fields.guide}.`;
      return `You've out-leveled ${fields.guide}. Polestar suggests ${fields.next}. Say "switch to the ${fields.next.replace(/^the /i, '')} guide" to change.`;
    }
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Voice commands
// ---------------------------------------------------------------------------

const LEAD = /^(?:hey|ok|okay|alright|all right|um|uh|so|voice guide|guide|polestar|please|can you|could you|would you|will you|go ahead and|just)\s+/;
const TAIL = /\s+(?:please|for me|now|thanks|thank you)$/;

function normalize(text) {
  let t = String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/[.!?,;:"]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let before = ''; before !== t;) { before = t; t = t.replace(LEAD, '').replace(TAIL, ''); }
  return t;
}

const ORDINAL = /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|last|1st|2nd|3rd|[4-8]th|[1-8]|one|two|three|four|five|six|seven|eight)$/;
const STEP = '(?:(?:this|that|the|my|current|polestar|polestar\'s|guide) )*step';

const PATTERNS = [
  { read: true, re: new RegExp(`^(?:read|say|tell)(?: me)?(?: out)? ${STEP}(?: again| aloud| out loud)?$`) },
  { read: true, re: new RegExp(`^what(?:'s| is) ${STEP}$`) },
  { read: true, re: /^what(?:'s| is| does) (?:polestar|the guide|my guide)(?: say(?:ing)?| want me to do| telling me(?: to do)?)$/ },
  { action: 'skip', re: new RegExp(`^skip ${STEP}$|^skip (?:this|that) one$`) },
  { action: 'unskip', re: /^(?:undo|reverse)(?: (?:that|the|my|last))? skip$|^unskip(?: (?:that|it|the step|this step|that step))?$|^bring (?:that|the|it|the skipped) (?:step )?back$/ },
  { action: 'back', re: new RegExp(`^(?:go |step )?back (?:a|one) step$|^(?:go to |show(?: me)? )?(?:the )?previous step$`) },
  { action: 'ahead', re: /^(?:show(?: me)?|look at|peek at) (?:the )?next step$|^(?:look|peek) ahead(?: a step)?$|^(?:go |step )?forward (?:a|one) step$/ },
  { action: 'current', re: new RegExp(`^(?:(?:go|jump|return) )?(?:back )?to (?:the |my )?(?:current|live) step$`) },
  { action: 'aim', re: /^(?:point|aim)(?: me| the arrow| polestar's arrow| the polestar arrow)? (?:at|to|toward|towards) (?:the )?(.+?)$|^(?:put |set |move )?(?:the )?arrow (?:on|at|to) (?:the )?(.+?)$/ },
  { action: 'guide', re: /^(?:switch|change|swap|go)(?: over)? to (?:the |my )?(.+?) guide$|^open (?:the |my )?(.+?) guide$/ },
];

// The command a question is, or null. With `game`, commands that need
// Polestar answer that it is missing, and an arrow aimed by name must name
// something in the current step (else it is an ordinary question).
// -> { read } | { action, arg, speech } | { missing, speech }
function command(question, game) {
  const t = normalize(question);
  if (!t) return null;
  const section = sectionText(game);
  for (const p of PATTERNS) {
    const m = t.match(p.re);
    if (!m) continue;
    let arg = (m[1] || m[2] || '').trim();
    if (p.read) return section ? { read: true } : { missing: true, speech: "I don't see Polestar. Is it installed, with a guide open?" };
    if (p.action === 'aim') {
      arg = arg.replace(/\s+(?:one|goal|objective|row|line)$/, '').trim();
      const ordinal = ORDINAL.test(arg);
      // "point me to the inn" is a question for the guide, not a Polestar row.
      if (!ordinal && !(section && arg.length >= 3 && section.toLowerCase().includes(arg))) return null;
      if (!section) return null;
      return { action: 'aim', arg, speech: ordinal ? `Pointing Polestar's arrow at the ${arg === 'last' ? 'last' : arg} goal.` : `Pointing Polestar's arrow at ${arg}.` };
    }
    if (p.action === 'guide' && (!arg || /^(?:next|previous|other|polestar|current|this|that)$/.test(arg))) return null;
    if (!section) return { missing: true, speech: "I don't see Polestar. Is it installed, with a guide open?" };
    const speech = {
      skip: 'Skipping this step.',
      unskip: 'Bringing the skipped step back.',
      back: 'Going back a step.',
      ahead: 'Looking ahead a step.',
      current: 'Back to your current step.',
      guide: `Switching Polestar to the ${arg} guide.`,
    }[p.action];
    return { action: p.action, arg, speech };
  }
  return null;
}

// A guide answer for a Polestar command, or null when the question is not one.
function answer(question, game) {
  const c = command(question, game);
  if (!c) return null;
  const say = c.read ? readStep(game) : c.speech;
  if (!say) return null;
  const out = { display: say, speech: say, streamed: false, waypoint: null, sources: [], lookup: { basis: 'game', questNotes: 0, toolCalls: 0, webSearches: 0, citations: 0 } };
  if (c.action) out.polestar = { action: c.action, arg: c.arg || '' };
  return out;
}

module.exports = { MOMENTS, ACTIONS, goalSpeech, parseSection, stepSpeech, readStep, compose, normalize, command, answer };
