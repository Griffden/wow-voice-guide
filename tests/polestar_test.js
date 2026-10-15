'use strict';
// bridge/polestar.js: the "polestar" section read aloud, Polestar moments as
// speech, and the voice commands that drive Polestar; plus how they reach
// the announcer, the slot files and the model context.
const test = require('node:test');
const assert = require('node:assert/strict');
const Polestar = require('../bridge/polestar');
const Announce = require('../bridge/announce');
const GameState = require('../bridge/gamestate');
const P = require('../bridge/protocol');

// As PolestarLink.lua sends it (tests/addon_test.js checks the add-on side).
const SECTION = [
  'Polestar guide: Durotar 1-6 (step 1 of 40, 4 of 40 steps done)',
  'Step 1: Valley of Trials',
  'Now at: Gornek (person 1 of 2)',
  'To do now: Accept Cutting Teeth',
  "Then: Foreman Thazz'ril",
  'Arrow: Accept Cutting Teeth, Durotar 42.6, 67.8',
  "Rest of the step: Turn in Your Place In The World at Gornek - done; Accept Lazy Peons from Foreman Thazz'ril; Kill Mottled Boar 3/8 for Cutting Teeth; Loot everything, vendor at the den (optional)",
  'Other Polestar guides open: Mining 1-300 (step 3 of 20)',
].join('\n');

function game(section = SECTION) {
  const store = GameState.newStore();
  if (section) GameState.applySections(store, `polestar${GameState.GS}${section}`);
  return store;
}

test('the section parses into the step, who to see and what to do', () => {
  assert.deepEqual(Polestar.parseSection(SECTION), {
    guide: 'Durotar 1-6', step: 1, of: 40, title: 'Valley of Trials', skipped: false, who: 'Gornek', person: 1, persons: 2,
    now: ['Accept Cutting Teeth'], then: "Foreman Thazz'ril", arrow: 'Accept Cutting Teeth, Durotar 42.6, 67.8',
  });
  assert.deepEqual(Polestar.parseSection('Polestar guide: installed, no guide open'), { none: true });
  const done = Polestar.parseSection('Polestar guide: Elwynn Forest (1-10) (complete)');
  assert.equal(done.guide, 'Elwynn Forest (1-10)', 'a title with parentheses keeps them');
  assert.equal(done.complete, true);
  assert.equal(Polestar.parseSection(''), null);
});

test('"read me the step" speaks the section', () => {
  assert.equal(Polestar.readStep(game()), "Step 1 of 40, Valley of Trials. At Gornek: accept Cutting Teeth. Then Foreman Thazz'ril.");
  assert.equal(Polestar.readStep(game('Polestar guide: installed, no guide open')), 'Polestar has no guide open.');
  assert.equal(Polestar.readStep(game('Polestar guide: Durotar 1-6 (complete)')), 'Your Polestar guide, Durotar 1-6, is complete.');
  assert.match(Polestar.readStep(game(SECTION.replace('\nStep 1:', '\nThe player is looking at step 1; the guide is on step 2\nStep 1:'))), /^You're looking at a different step in Polestar\. Step 1/);
  assert.equal(Polestar.readStep(game('')), '');
});

test('steps and goals read naturally: verbs in lower case, counters as "3 of 8", long lists cut short', () => {
  assert.equal(Polestar.goalSpeech('Kill Mottled Boar 3/8 for Cutting Teeth'), 'kill Mottled Boar, 3 of 8, for Cutting Teeth');
  assert.equal(Polestar.goalSpeech('Kill Mottled Boar 3/8'), 'kill Mottled Boar, 3 of 8');
  assert.equal(Polestar.goalSpeech('Loot everything (optional)'), 'loot everything, optional');
  assert.equal(Polestar.goalSpeech("Foreman Thazz'ril"), "Foreman Thazz'ril", 'a name keeps its capital');
  assert.equal(Polestar.stepSpeech({ who: "Foreman Thazz'ril", now: 'Accept Lazy Peons', then: 'Kill Mottled Boar 3/8 for Cutting Teeth' }, { same: true }),
    "Next, Foreman Thazz'ril: accept Lazy Peons. Then kill Mottled Boar, 3 of 8, for Cutting Teeth.");
  assert.equal(Polestar.stepSpeech({ step: 3, of: 40, title: 'Burning Blade Coven', now: ['Kill Vile Familiar 2/12', 'Collect Felstalker Hoof 0/4'] }),
    'Step 3 of 40, Burning Blade Coven. Kill Vile Familiar, 2 of 12 and collect Felstalker Hoof, 0 of 4.');
  assert.equal(Polestar.stepSpeech({ step: 9, who: 'Gornek', now: 'Accept A; Accept B; Accept C; Accept D; Accept E' }),
    'Step 9. At Gornek: accept A, accept B, accept C and 2 more.');
});

test('Polestar moments speak when the "polestar" announcement is on, and only the latest step waits in the queue', () => {
  const field = (kind, pairs) => [['kind', kind], ...pairs].map(([k, v]) => `${k}${GameState.GS}${v}`).join(GameState.FS);
  const compose = (kind, pairs) => Announce.compose(Announce.fieldsOf(field(kind, pairs)));
  assert.equal(compose('pstep', [['step', 2], ['of', 40], ['title', 'Razor Hill'], ['who', "Gar'Thok"], ['now', 'Accept Vanquish the Betrayers'], ['same', '']]),
    "Step 2 of 40, Razor Hill. At Gar'Thok: accept Vanquish the Betrayers.");
  assert.equal(compose('pskip', [['quests', 'Sarkoth (No longer offered: you took Sarkoth, part 2)']]), 'Polestar moved past Sarkoth: No longer offered: you took Sarkoth, part 2.');
  assert.equal(compose('pdone', [['guide', 'Durotar 1-6']]), 'You finished Durotar 1-6.');
  assert.equal(compose('proute', [['guide', 'Durotar 1-6'], ['options', 'The Barrens 12-20 (recommended); Silverpine Forest 10-20']]),
    'Durotar 1-6 is done. Pick your next zone in Polestar: The Barrens 12-20, recommended, or Silverpine Forest 10-20.');
  assert.equal(compose('proute', [['guide', ''], ['options', 'Silverpine Forest; The Barrens (recommended)']]),
    'Pick your next zone in Polestar: Silverpine Forest or The Barrens, recommended.');
  assert.equal(compose('ptrain', [['level', 6], ['npc', 'Frang'], ['where', 'Durotar']]), 'Time to visit your class trainer: Frang in Durotar.');
  assert.equal(compose('plevel', [['guide', 'Durotar 1-6'], ['next', 'The Barrens 12-20']]),
    'You\'ve out-leveled Durotar 1-6. Polestar suggests The Barrens 12-20. Say "switch to the Barrens 12-20 guide" to change.');

  for (const kind of Polestar.MOMENTS) assert.equal(Announce.toggleFor(kind), 'polestar');
  const cfg = { announce: { polestar: false } };
  const spoken = [];
  let busy = true;
  const a = new Announce.Announcer({ cfg, speak: text => { spoken.push(text); }, busy: () => busy, retryMs: 5 });
  const step = n => field('pstep', [['step', n], ['who', 'Gornek'], ['now', 'Accept Cutting Teeth']]);
  assert.equal(a.handle(step(1)), 'off');
  cfg.announce.polestar = true;
  assert.equal(a.handle(step(1)), 'queued');
  assert.equal(a.handle(step(2)), 'queued', 'steps are never rate limited');
  assert.equal(a.handle(field('pdone', [['guide', 'Durotar 1-6']])), 'queued');
  assert.deepEqual(a.queue.map(q => q.say), ['Step 2. At Gornek: accept Cutting Teeth.', 'You finished Durotar 1-6.'], 'an older step still waiting is dropped');
  a.stop();
  busy = false;
});

test('voice commands are recognised only as commands, never inside a question', () => {
  const g = game();
  const cases = {
    'Skip this step.': ['skip', ''],
    'Hey guide, can you skip this step please?': ['skip', ''],
    'skip the current step': ['skip', ''],
    'Undo that skip': ['unskip', ''],
    'unskip': ['unskip', ''],
    'Bring that step back.': ['unskip', ''],
    'Go back a step': ['back', ''],
    'show me the previous step': ['back', ''],
    'Look ahead': ['ahead', ''],
    'show me the next step': ['ahead', ''],
    'Back to the current step': ['current', ''],
    'go back to my current step': ['current', ''],
    'Point me at the second goal': ['aim', 'second'],
    'aim the arrow at the third one': ['aim', 'third'],
    "Point me at Thazz'ril": ['aim', "thazz'ril"],
    'Switch to the mining guide': ['guide', 'mining'],
    'open the barrens guide': ['guide', 'barrens'],
  };
  for (const [said, [action, arg]] of Object.entries(cases)) {
    assert.deepEqual(Polestar.command(said, g) && [Polestar.command(said, g).action, Polestar.command(said, g).arg], [action, arg], said);
  }
  for (const said of ['Read me the step', "What's my current step?", 'What does Polestar say?']) {
    assert.deepEqual(Polestar.command(said, g), { read: true }, said);
  }
  for (const said of ['Should I skip this step?', 'Why did Polestar skip Sarkoth?', "What's the next step?", 'Point me to the inn',
    'Go to the next guide', 'Where do I go next?', 'Read me this quest', 'next step', 'skip', '']) {
    assert.equal(Polestar.command(said, g), null, said);
  }
});

test('a command answer carries the action for the add-on; without Polestar it says so', () => {
  const g = game();
  assert.deepEqual(Polestar.answer('Skip this step', g), {
    display: 'Skipping this step.', speech: 'Skipping this step.', streamed: false, waypoint: null, sources: [],
    lookup: { basis: 'game', questNotes: 0, toolCalls: 0, webSearches: 0, citations: 0 }, polestar: { action: 'skip', arg: '' },
  });
  assert.equal(Polestar.answer('point me at the second one', g).speech, "Pointing Polestar's arrow at the second goal.");
  assert.equal(Polestar.answer('switch to the mining guide', g).speech, 'Switching Polestar to the mining guide.');
  const read = Polestar.answer('read me the step', g);
  assert.equal(read.speech, "Step 1 of 40, Valley of Trials. At Gornek: accept Cutting Teeth. Then Foreman Thazz'ril.");
  assert.equal(read.polestar, undefined, 'reading changes nothing');
  const none = game('');
  assert.equal(Polestar.answer('skip this step', none).speech, "I don't see Polestar. Is it installed, with a guide open?");
  assert.equal(Polestar.answer('skip this step', none).polestar, undefined);
  assert.equal(Polestar.answer("point me at Thazz'ril", none), null, 'without Polestar, aiming at a name is a question for the guide');
  assert.equal(Polestar.answer('where is the inn?', g), null);
});

test('the slot file carries a Polestar command, the in-game switch is understood, and "what next?" questions get the section', () => {
  const lua = P.luaTable('WoWClaude_SlotData', [
    { chat: 'c1', id: 7, status: 'done', text: 'Pointing.', polestar: { action: 'aim', arg: 'thazz"ril' } },
    { chat: 'c2', id: 8, status: 'done', text: 'Hm.', polestar: { action: 'delete', arg: '' } },
  ], { now: 1000 });
  assert.match(lua, /\n\t\t\tpolestar = \{ action = "aim", arg = "thazz\\"ril" \},\n/);
  assert.equal((lua.match(/polestar =/g) || []).length, 1, 'an unknown action never reaches the game');
  assert.deepEqual(P.parseFlags('ann=polestar:1,route:0').announceSet, { polestar: true, route: false });

  const store = game();
  GameState.applySections(store, `quest${GameState.GS}${'Selected quest: Cutting Teeth (id 788)\n'.padEnd(600, 'x')}`);
  const context = GameState.assembleContext(store, "what's next?", { maxChars: 1300 });
  assert.ok(context.startsWith('Polestar guide: Durotar 1-6'), 'the Polestar step wins the budget for a "next" question');
});
