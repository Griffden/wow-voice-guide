'use strict';
// Faster voice replies: MessagePack, the Fish streaming socket (mocked), sentence
// splitting, speech from a JSON answer still being streamed, fillers, the POST
// fallback, and the streamed Responses API loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const MsgPack = require('../bridge/msgpack');
const Speech = require('../bridge/speech');
const Providers = require('../bridge/providers');
const Audio = require('../bridge/audio-utils');

// A stand-in for the `ws` WebSocket: records what the client sends, and lets
// the test play the server.
function fakeSocketClass({ autoOpen = true } = {}) {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.sent = [];
      sockets.push(this);
      if (autoOpen) setImmediate(() => this.emit('open'));
    }
    send(data) { this.sent.push(MsgPack.decode(data)); }
    close() { this.closed = true; }
    serve(event) { this.emit('message', MsgPack.encode(event)); }
  }
  return { FakeSocket, sockets };
}

const tick = () => new Promise(r => setImmediate(r));
const CFG = { fish: { apiKey: 'fish-key', voiceId: 'voice-1', model: 's2.1-pro-free', latency: 'low' } };

test('MessagePack round-trips the values Fish uses', () => {
  const value = { event: 'audio', audio: Buffer.from([1, 2, 3, 250]), n: -5, big: 70000, f: 1.5, ok: true, none: null, list: [1, 'two', { three: 3 }], long: 'x'.repeat(300) };
  assert.deepEqual(MsgPack.decode(MsgPack.encode(value)), value);
  assert.deepEqual([...MsgPack.encode({ event: 'flush' })], [0x81, 0xa5, ...Buffer.from('event'), 0xa5, ...Buffer.from('flush')]);
});

test('the Fish stream opens with the voice and PCM format, sends text with flushes, and hands over audio', async () => {
  const { FakeSocket, sockets } = fakeSocketClass();
  const audio = [];
  const stream = new Speech.FishStream(CFG, { WebSocketImpl: FakeSocket, onAudio: a => audio.push(a) });
  stream.text('Hello there. ');
  const done = stream.end();
  await tick();
  const socket = sockets[0];
  assert.equal(socket.url, 'wss://api.fish.audio/v1/tts/live');
  assert.equal(socket.opts.headers.Authorization, 'Bearer fish-key');
  assert.equal(socket.opts.headers.model, 's2.1-pro-free');
  assert.deepEqual(socket.sent.map(e => e.event), ['start', 'text', 'flush', 'stop']);
  assert.equal(socket.sent[0].request.reference_id, 'voice-1');
  assert.equal(socket.sent[0].request.format, 'pcm');
  assert.equal(socket.sent[0].request.sample_rate, 44100);
  assert.equal(socket.sent[0].request.latency, 'low');
  assert.equal(socket.sent[1].text, 'Hello there. ');
  socket.serve({ event: 'audio', audio: Buffer.from([1, 0, 2, 0]) });
  socket.serve({ event: 'finish', reason: 'stop' });
  assert.equal(await done, 4);
  assert.deepEqual([...audio[0]], [1, 0, 2, 0]);
  assert.equal(socket.closed, true);
});

test('sentences are cut as the text streams in, without breaking numbers', () => {
  const s = new Speech.SentenceSplitter();
  assert.deepEqual(s.push('Head to Iverron at 54.6, 33'), []);
  assert.deepEqual(s.push('. He is north'), ['Head to Iverron at 54.6, 33.']);
  assert.deepEqual(s.push(' of the tree! Then'), ['He is north of the tree!']);
  assert.deepEqual(s.end(), ['Then']);
  const long = new Speech.SentenceSplitter({ maxChars: 60 });
  assert.equal(long.push('word '.repeat(20)).length, 1, 'a very long sentence is broken at a space');
});

test('speech is read out of a JSON answer while it is still arriving, escapes split across deltas included', () => {
  assert.deepEqual(Speech.speechFields('{"basis":"classic","speech":"Go \\"north'), { json: true, basis: 'classic', basisDone: true, speech: 'Go "north', speechDone: false });
  assert.equal(Speech.speechFields('{"speech":"a\\').speech, 'a', 'an incomplete escape waits for the next delta');
  assert.equal(Speech.speechFields('{"speech":"caf\\u00e9"}').speech, 'café');
  assert.equal(Speech.speechFields('Plain words.').speech, 'Plain words.', 'a reply that is not JSON is all speech');
  const got = [];
  const field = new Speech.SpeechFieldStream(t => got.push(t), { prefixFor: basis => (basis === 'classic' ? 'Classic: ' : '') });
  for (const d of ['{"ba', 'sis":"classic","sp', 'eech":"Go ', 'no\\', 'nrth.","waypoint":null}']) field.push(d);
  assert.deepEqual(got, ['Classic: ', 'Go ', 'no', '\nrth.']);
  assert.equal(field.spoke, true);
});

test('the speaker streams sentences to Fish and relays PCM chunks, then ends the stream', async () => {
  const { FakeSocket, sockets } = fakeSocketClass();
  const sent = [];
  const speaker = new Speech.Speaker(CFG, { send: m => sent.push(m), WebSocketImpl: FakeSocket });
  speaker.push('First sentence here. Second');
  await tick();
  assert.deepEqual(sockets[0].sent.filter(e => e.event === 'text').map(e => e.text), ['First sentence here. '], 'speech starts before the answer is complete');
  sockets[0].serve({ event: 'audio', audio: Buffer.from([0, 1]) });
  const finished = speaker.finish('');
  await tick();
  assert.deepEqual(sockets[0].sent.filter(e => e.event === 'text').map(e => e.text), ['First sentence here. ', 'Second ']);
  sockets[0].serve({ event: 'finish', reason: 'stop' });
  const result = await finished;
  assert.equal(result.mode, 'stream');
  assert.equal(typeof result.firstAudioMs, 'number');
  assert.equal(sent[0].type, 'audio:chunk');
  assert.equal(sent[0].sampleRate, 44100);
  assert.equal(Buffer.from(sent[0].base64, 'base64').length, 2);
  assert.deepEqual(sent[1], { type: 'audio:end', streamId: speaker.streamId });
});

test('a slow lookup gets a filler line, a fast answer does not, and fillers can be turned off', async () => {
  const cfg = { fish: { ...CFG.fish, fillerDelayMs: 5, fillers: ['Let me check that.'] } };
  let { FakeSocket, sockets } = fakeSocketClass();
  const slow = new Speech.Speaker(cfg, { WebSocketImpl: FakeSocket });
  slow.lookupStarted();
  await new Promise(r => setTimeout(r, 30));
  await tick();
  assert.deepEqual(sockets[0].sent.filter(e => e.event === 'text').map(e => e.text), ['Let me check that. ']);
  slow.cancel();

  ({ FakeSocket, sockets } = fakeSocketClass());
  const fast = new Speech.Speaker(cfg, { WebSocketImpl: FakeSocket });
  fast.lookupStarted();
  fast.push('Here it is. More');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(sockets[0].sent.filter(e => e.event === 'text').map(e => e.text), ['Here it is. ']);
  fast.cancel();

  ({ FakeSocket, sockets } = fakeSocketClass());
  const off = new Speech.Speaker({ fish: { ...cfg.fish, filler: false } }, { WebSocketImpl: FakeSocket });
  off.lookupStarted();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sockets.length, 0);
});

test('when the socket fails before any audio, the answer is spoken through the one-shot fallback', async () => {
  const { FakeSocket, sockets } = fakeSocketClass();
  const fallback = [];
  const speaker = new Speech.Speaker(CFG, { WebSocketImpl: FakeSocket, fallback: async text => fallback.push(text) });
  const finished = speaker.finish('Go north. Then east.');
  await tick();
  sockets[0].emit('error', new Error('connection refused'));
  const result = await finished;
  assert.equal(result.mode, 'fallback');
  assert.deepEqual(fallback, ['Go north. Then east.']);
  // Streaming off: straight to the fallback, no socket.
  const plain = [];
  const { FakeSocket: Never, sockets: none } = fakeSocketClass();
  const off = new Speech.Speaker({ fish: { ...CFG.fish, stream: false } }, { WebSocketImpl: Never, fallback: async text => plain.push(text) });
  assert.equal((await off.finish('Hello.')).mode, 'file');
  assert.deepEqual(plain, ['Hello.']);
  assert.equal(none.length, 0);
});

test('streamed PCM keeps a split sample for the next chunk', () => {
  const first = Audio.pcm16ToFloat32(new Uint8Array([0x00, 0x40, 0xff]));
  assert.deepEqual([...first.samples], [0.5]);
  assert.deepEqual([...first.carry], [0xff]);
  const second = Audio.pcm16ToFloat32(new Uint8Array([0xff]), first.carry);
  assert.deepEqual([...second.samples], [-1 / 32768]);
  assert.equal(second.carry.length, 0);
});

// Server-sent events for one streamed Responses API reply.
function sse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-event to exercise the parser's buffering.
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  });
}

test('the OpenAI guide streams: a lookup round triggers onLookup, and speech arrives, label first, before the answer completes', async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  const calls = [{ type: 'function_call', name: 'wowhead_search', call_id: 'c1', arguments: '{"query":"Mirror Lake"}' }];
  const answer = JSON.stringify({ basis: 'classic', speech: 'Mirror Lake is southwest of Stormwind. Follow the road.' });
  const rounds = [
    [{ type: 'response.output_item.added', item: calls[0] }, { type: 'response.completed', response: { output: calls } }],
    [
      { type: 'response.output_item.added', item: { type: 'message' } },
      ...answer.match(/.{1,9}/g).map(delta => ({ type: 'response.output_text.delta', delta })),
      { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: answer, annotations: [] }] }] } },
    ],
  ];
  const order = [];
  global.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.openai.com/')) {
      bodies.push(JSON.parse(init.body));
      return new Response(sse(rounds.shift()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  try {
    const speech = [];
    const result = await Providers.requestGuideAnswer({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k' } }, {
      context: '', text: 'Where is Mirror Lake?',
      onSpeech: t => { speech.push(t); order.push('speech'); },
      onLookup: () => order.push('lookup'),
    });
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(order.slice(0, 2), ['lookup', 'speech'], 'the filler hook fires before any answer speech');
    assert.equal(speech[0], 'Based on Classic info, which may differ in Forever: ');
    assert.equal(speech.slice(1).join(''), 'Mirror Lake is southwest of Stormwind. Follow the road.');
    assert.ok(speech.length > 3, 'speech arrives in pieces');
    assert.equal(result.streamed, true);
    assert.equal(result.speech, 'Based on Classic info, which may differ in Forever: Mirror Lake is southwest of Stormwind. Follow the road.');
  } finally { global.fetch = originalFetch; }
});

test('with streaming off the guide makes plain requests', async () => {
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"basis":"game","speech":"Hi."}', annotations: [] }] }] }), { status: 200 });
  };
  try {
    const result = await Providers.requestGuideAnswer({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k' }, playerGuide: { stream: false } },
      { context: '', text: 'hello', onSpeech: () => assert.fail('no streaming') });
    assert.equal(body.stream, undefined);
    assert.equal(result.streamed, false);
    assert.equal(result.speech, 'Hi.');
  } finally { global.fetch = originalFetch; }
});
