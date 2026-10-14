const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoPlayback, silentVideoAudio} = require('../.test-build/app/apps/video/video-playback');
const {latencyTransport, replyLatency} = require('./helpers/video-latency-transport.cjs');

test('Reply-size latency fake uses measured costs and advances decoder during awaited traffic', () => {
  assert.deepEqual([6, 16, 36, 72, 96, 128, 192].map(replyLatency), [20, 115, 180, 200, 530, 750, 1300]);
});

test('Default observations cannot starve a primed 70ms decoder with a 16fps timeline', async () => {
  const f = latencyTransport(); let counted = 0;
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, n => counted += n, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 160); assert.equal(counted, 160); assert.equal(f.closed(), true);
  assert.equal(f.primed(), true);
  assert.equal(f.stalls.length, 0, JSON.stringify(f.stalls.slice(0, 5)));
  assert.ok(f.observations.length >= 6, 'Real observations must occur during input, not just at EOF');
  assert.ok(f.observations.every(row => row.free === 0), JSON.stringify(f.observations.filter(row => row.free)));
  const inputPhy = f.calls.filter(row => row.kind === 'phy' && row.accepted > 0 && row.accepted < 163);
  assert.equal(inputPhy.length, 0, 'PHY is lifecycle-only by default');
  assert.ok(f.calls.some(row => row.kind === 'shown-1') && f.calls.some(row => row.kind === 'shown-2'));
});

test('Detailed mode deliberately restores both-lens 500ms full reports for diagnostics', async () => {
  const f = latencyTransport(40);
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true, detailedReports: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 40);
  assert.ok(f.calls.filter(row => row.kind === 'phy' && row.accepted > 0 && row.accepted < 43).length > 2);
  assert.ok(f.copies.some((row, i) => i && row.tick - f.copies[i - 1].tick > 500),
    'Diagnostic reports must expose the old long gaps even before the input can prime');
});

test('Every credited finishing NAL is sent before any later picture metadata request', async () => {
  const f = latencyTransport(80);
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  const sends = f.calls.filter(row => row.kind === 'send');
  assert.ok(sends.every(row => row.records === 1 || row.first === 0));
  assert.ok(f.calls.filter(row => row.kind === 'credit').length < sends.length,
    'Unused reserved credits must not be re-queried per picture');
  assert.equal(f.stalls.length, 0);
});

test('Busy prefetched metadata never permits its finishing NAL to bypass admission', async () => {
  const f = latencyTransport(32), prefetch = f.protocol.sendNalsWithMetadata;
  let refusals = 3;
  f.protocol.sendNalsWithMetadata = async (...args) => {
    if (refusals-- > 0) { await f.protocol.sendNals(args[0], args[1], [args[2]]); return false; }
    return prefetch(...args);
  };
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 32);
  assert.equal(player.view.error, null);
});
