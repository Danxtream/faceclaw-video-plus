const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoPlayback, silentVideoAudio} = require('../.test-build/app/apps/video/video-playback');
const {latencyTransport, replyLatency} = require('./helpers/video-latency-transport.cjs');

test('Reply-size latency fake uses measured costs and advances decoder during awaited traffic', () => {
  assert.deepEqual([6, 16, 36, 72, 96, 128, 192].map(replyLatency), [20, 115, 180, 200, 530, 750, 1300]);
});

test('Link-limited playback still reports and starts audio before EOF', async () => {
  const f = latencyTransport(160, 2), sync = [];
  const player = new VideoPlayback(f.protocol, f.source, {...silentVideoAudio,
    sync: async (...args) => sync.push({args, at: f.clock(), copies: f.copies.length})},
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  assert.ok(f.observations.some(row => row.free > 0 && row.kind.startsWith('shown')));
  assert.ok(sync.some(row => row.args[1] && row.copies < 160), 'Audio must start during playback');
  const input = f.observations;
  assert.ok(input.every((row, i) => !i || row.at - input[i - 1].at < 1900),
    'A report step must run within the staleness cap plus one bounded upload');
});

test('Playback pipeline batches only granted credits and retries busy metadata without skipping a picture', async () => {
  const f = latencyTransport(80), batches = [];
  let busy = 3;
  f.protocol.sendPipeline = async (stream, first, records, following) => {
    batches.push(records.length); let admitted = 0;
    for (let i = 0; i < records.length; i++) {
      await f.protocol.sendNals(stream, first + i, [records[i]]);
      const next = following[i];
      if (!next) continue;
      if (busy-- > 0) return [i + 1, admitted];
      assert.equal(next.nal, first + i + 1);
      await f.protocol.metadata(stream, next.ordinal, next.nal, next.pts); admitted++;
    }
    return [records.length, admitted];
  };
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 80);
  assert.ok(batches.some(count => count > 1));
  assert.ok(batches.every(count => count >= 1 && count <= 4));
  assert.equal(player.view.cleanupFailed, false);
});

test('Default observations keep a primed 70ms decoder fed with bounded staleness', async () => {
  const f = latencyTransport(); let counted = 0;
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, n => counted += n, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 160); assert.equal(counted, 160); assert.equal(f.closed(), true);
  assert.equal(f.primed(), true);
  assert.ok(f.stalls.reduce((sum, row) => sum + row.milliseconds, 0) <= 20,
    'Bounded first-picture reporting may cost at most one 20ms scheduler tick in this fake');
  assert.ok(f.observations.length >= 6, 'Real observations must occur during input, not just at EOF');
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
  assert.ok(f.calls.filter(row => row.kind === 'credit' && row.accepted < 83).length < sends.length,
    'Unused reserved credits must not be re-queried per picture');
  assert.ok(f.stalls.reduce((sum, row) => sum + row.milliseconds, 0) <= 20);
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
