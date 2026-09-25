'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WowData = require('../bridge/wowdata');

const LOG = 'Selected quest: Mirror Lake (id 1861)\nObjective: Mirror Lake Water Sample: 0/1\nQuest log (3): Mirror Lake (#1861); For Love Eternal (#963); The Fall of Ameth\'Aran (#953)';

test('questLog reads the add-on quest list and the focused quest', () => {
  assert.deepEqual(WowData.questLog(LOG), [
    { title: 'Mirror Lake', id: 1861 }, { title: 'For Love Eternal', id: 963 }, { title: 'The Fall of Ameth\'Aran', id: 953 },
  ]);
  assert.deepEqual(WowData.questLog('Tracked quest: Solo (id 5)'), [{ title: 'Solo', id: 5 }]);
  assert.deepEqual(WowData.questLog(''), []);
});

test('mentionedQuests matches spoken titles loosely and the focused quest on "where do I go"', () => {
  const ids = q => WowData.mentionedQuests(q, LOG).map(quest => quest.id);
  assert.deepEqual(ids('What do I have to do for the uh Quest for Love Eternal here in Darkshore?'), [963]);
  assert.deepEqual(ids('fall of ametharan help'), [953]);
  assert.deepEqual(ids('Where do I go?'), [1861]);
  assert.deepEqual(ids('How do I finish this quest?'), [1861]);
  assert.deepEqual(ids('What level am I?'), []);
  assert.deepEqual(ids('Tell me about lakes'), []);
});

test('htmlToText flattens tooltip markup', () => {
  assert.equal(WowData.htmlToText('<table><tr><td><b>Name</b></td></tr></table><br />Kill &amp; loot<!--x--> 5 &lt;boars&gt;'), 'Name\nKill & loot 5 <boars>');
});

test('lookup maps NPC coordinates to the in-game map and rejects bad input', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => new Response(JSON.stringify(/npc\/2439$/.test(url)
    ? { name: 'Major Samuelson', tooltip: '<b>Major Samuelson</b>', map: { zone: 1519, coords: { 0: [[72.4, 16], [72.6, 16]] } } }
    : { error: 'Entity not found' }), { status: 200 });
  try {
    const npc = await WowData.lookup('npc', 2439);
    assert.deepEqual(npc.location, { zone: 'Stormwind City', uiMapId: 1453, coords: [[72.4, 16], [72.6, 16]] });
    assert.equal(npc.url, 'https://www.wowhead.com/forever/npc=2439');
    await assert.rejects(() => WowData.lookup('quest', 1), /no Forever entry for quest 1/);
    await assert.rejects(() => WowData.lookup('guild', 1), /Unknown Wowhead type/);
    await assert.rejects(() => WowData.lookup('npc', -3), /Invalid npc id/);
  } finally { global.fetch = originalFetch; WowData._cache.clear(); }
});

test('zone names resolve to Forever uiMapIDs, including new zones', () => {
  assert.equal(WowData.zoneByName('Darkshore').uiMapId, 1439);
  assert.equal(WowData.zoneByName('mount hyjal').uiMapId, 2482);
  assert.equal(WowData.zoneByName('Nowhere'), null);
});
