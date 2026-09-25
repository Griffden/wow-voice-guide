'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('researched answer logs lookup and completes without a reference error', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
  const start = source.indexOf('async function runAssistantJob(');
  const end = source.indexOf('\nif (process.send) {', start);
  assert.ok(start >= 0 && end > start, 'runAssistantJob source is available');
  const finished = [];
  const logged = [];
  const runAssistantJob = vm.runInNewContext(`${source.slice(start, end)}\nrunAssistantJob`, {
    chatKey: () => 'test-chat',
    transcripts: { chats: {} },
    noteMessage: () => {},
    beat: () => {},
    publish: () => {},
    gameContext: () => 'Game: World of Warcraft: Forever',
    cfg: { playerGuide: true, fish: { speakTyped: false } },
    Providers: {
      requestGuideAnswer: async (_cfg, input) => {
        assert.equal(typeof input.onProgress, 'function');
        return { display: 'Follow the river.', speech: 'Follow the river.', sources: [], lookup: { basis: 'forever', questNotes: 1, toolCalls: 0, webSearches: 0, citations: 0 } };
      },
      redact: value => value,
    },
    log: value => logged.push(value),
    finish: (_job, status, text) => finished.push({ status, text }),
    process: { send: null },
  });
  await runAssistantJob({ id: 26, session: 'test-session', chat: 'test-chat', voice: false, cwd: '' }, 'Where is the quest?');
  assert.deepEqual(finished, [{ status: 'done', text: 'Follow the river.' }]);
  assert.match(logged[0], /^#26@test-session guide: basis=forever, questNotes=1/);
});
