const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {videoDeliveryMeasureLines} = require('../.test-build/app/apps/video/video-delivery-measure');
const {VideoProtocol} = require('../.test-build/app/apps/video/video-protocol');
const {VideoPlayback} = require('../.test-build/app/apps/video/video-playback');

function row(mode = 0, side = 1) {
  const r = new Uint8Array(mode ? 128 : 172), v = new DataView(r.buffer);
  r.set([1, 7, 0, 8, mode, 2, side, 1]); v.setUint32(8, 7, true); v.setUint32(12, 100 + side, true);
  if (mode) {v.setUint32(96, 1, true); v.setUint32(100, 2, true);}
  return r;
}
test('Passive delivery rows validate identity, buckets and counters in bounded log lines', () => {
  for (const side of [1, 2]) for (const mode of [0, 1]) {
    const raw = row(mode, side), lines = videoDeliveryMeasureLines(raw, 7, 100 + side, side);
    assert.ok(lines.every(line => line.startsWith('Video measure ') && line.length < 700));
    assert.throws(() => videoDeliveryMeasureLines(raw, 8, 100 + side, side), /identity/);
    assert.throws(() => videoDeliveryMeasureLines(raw, 7, 999, side), /identity/);
  }
  const bad = row(); bad[32] = 1; assert.throws(() => videoDeliveryMeasureLines(bad, 7, 101, 1), /counters/);
  const overlap = row(1); overlap[96] = 3; assert.throws(() => videoDeliveryMeasureLines(overlap, 7, 101, 1), /overlap/);
});
test('Discover each lens independently; old firmware disables only its optional measurement', async () => {
  let id = 1; const calls = [];
  const protocol = new VideoProtocol({epoch: () => 1, exchange: async (raw, n, side) => {
    calls.push([raw.slice(), n, side]);
    if (raw.length === 12) { const r = new Uint8Array(128); r.set([1, 7, 0, 8, 0, side === 1 ? 2 : 1]); r[8] = 172; r[9] = 128; return [r]; }
    return [row(raw[9], side)];
  }}, () => id++);
  assert.equal((await protocol.deliveryMeasure(7, 1, 0)).length, 172);
  assert.equal((await protocol.deliveryMeasure(7, 1, 1)).length, 128);
  assert.equal(await protocol.deliveryMeasure(7, 2, 0), null);
  assert.equal(await protocol.deliveryMeasure(7, 2, 0), null);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => c[2]), [1, 1, 1, 2]);
});
test('Retirement/failure capture is once per stream and a bad lens never suppresses the other', async () => {
  const calls = [], player = Object.create(VideoPlayback.prototype), old = console.error;
  player.generation = {stream: 7, tokens: [101, 102]}; player.deliveryStreams = new Set();
  player.clock = () => 100; player.readMeasurement = () => null;
  player.protocol = {deliveryMeasure: async (_, side, mode) => {
    calls.push([side, mode]); if (side === 1) throw new Error('unavailable'); return row(mode, side);
  }};
  console.error = () => {};
  try { await player.logDeliveryMeasure('failure'); await player.logDeliveryMeasure('end'); }
  finally { console.error = old; }
  assert.deepEqual(calls, [[1, 0], [1, 1], [2, 0], [2, 1]]);
  const source = fs.readFileSync('app/apps/video/video-playback.ts', 'utf8');
  const report = source.slice(source.indexOf('private async reportStep'), source.indexOf('private async preview'));
  assert.doesNotMatch(report, /deliveryMeasure|logDeliveryMeasure/);
  assert.equal(source.match(/this\.logDeliveryMeasure\(/g).length, 2);
  assert.equal(source.match(/this\.logDeliveryRadio\(/g).length, 1);
});
test('MTU sampling reads the existing cache and never changes a link', () => {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java', 'utf8');
  const method = source.slice(source.indexOf('public int[] getVideoLinkMtus()'), source.indexOf('private void enqueueVideoCacheLeaseLocked'));
  assert.match(method, /getNegotiatedMtu\(leftAddress\)/); assert.match(method, /getNegotiatedMtu\(rightAddress\)/);
  assert.doesNotMatch(method, /requestMtu|readPhy|writeFrames|pendingMessages/);
});
