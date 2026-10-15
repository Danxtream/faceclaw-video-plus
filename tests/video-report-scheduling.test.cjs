const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoPlayback, silentVideoAudio} = require('../.test-build/app/apps/video/video-playback');
const {latencyTransport, replyLatency} = require('./helpers/video-latency-transport.cjs');

function assertNoUploadStallsOutsidePairedReports(f) {
  const captures = f.calls.filter(row => row.kind.startsWith('shown')).map(row => ({
    start: row.at, end: row.at + replyLatency(row.bytes),
  }));
  const outside = f.stalls.reduce((total, stall) => total + stall.milliseconds - captures.reduce((overlap, capture) =>
    overlap + Math.max(0, Math.min(stall.at + stall.milliseconds, capture.end) - Math.max(stall.at, capture.start)), 0), 0);
  assert.ok(outside <= 20, 'Only the explicit paired capture may stall input, plus one scheduler tick');
}

test('Reply-size latency fake uses measured costs and advances decoder during awaited traffic', () => {
  assert.deepEqual([6, 16, 36, 72, 96, 128, 192].map(replyLatency), [20, 115, 180, 200, 530, 750, 1300]);
});

test('Link-limited playback still reports and starts audio before EOF', async () => {
  const f = latencyTransport(160, 2), sync = [];
  const player = new VideoPlayback(f.protocol, f.source, {...silentVideoAudio,
    sync: async (...args) => sync.push({args, at: f.clock(), copies: f.copies.length})},
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  const report = player.report.bind(player);
  player.report = () => f.report(report);
  await player.run();
  assert.ok(f.observations.some(row => row.free > 0 && row.kind.startsWith('shown')));
  assert.ok(sync.some(row => row.args[1] && row.copies < 160), 'Audio must start during playback');
  const input = f.observations;
  assert.ok(input.every((row, i) => !i || row.at - input[i - 1].at < 1900),
    'A report step must run within the staleness cap plus one bounded upload');
});

test('Paged link-limited playback starts audio with immediate paired SHOWN spaced five seconds apart', async () => {
  const f = latencyTransport(160, 2, 35), sync = [];
  const player = new VideoPlayback(f.protocol, f.source, {...silentVideoAudio,
    sync: async (...args) => sync.push({playing: args[1], copies: f.copies.length})},
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  const begin = player.begin.bind(player);
  player.begin = async (...args) => {
    await begin(...args);
    // This deterministic fake knows the exact instant PHY data was frozen.
    player.generation.anchorAt = f.calls.findLast(row => row.kind === 'phy').at;
    player.generation.anchorUncertainty = 0;
  };
  await player.run();
  assert.ok(sync.some(row => row.playing && row.copies < 160), 'Prepared audio must start before EOF');
  const pairs = f.calls.flatMap((row, i) => {
    if (row.kind !== 'shown-2') return [];
    const left = f.calls[i - 1];
    assert.equal(left.kind, 'shown-1', 'No upload/report/interval may separate the paired queries');
    assert.equal(row.at - left.at, 12 * 35);
    return [left.at];
  });
  assert.ok(pairs.length > 1);
  assert.ok(pairs.every((at, i) => !i || at - pairs[i - 1] >= 5000));
  assert.ok(pairs[0] - f.calls.find(row => row.kind === 'send').at < 2000, 'First pair is attempted promptly, not delayed five seconds');
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

test('Paged passive steps are rate-capped even with blocked credit and paused polls stay compact', async () => {
  for (const decodeMs of [70, 250]) {
    const f = latencyTransport(160, decodeMs, 35); let counted = 0;
    const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
      () => ({native: true, dither: false, radio: true}), () => {}, n => counted += n, f.clock, f.sleep);
    const steps = [], report = player.report.bind(player);
    player.report = async () => {
      const first = f.calls.length, at = f.clock(), blocked = player.reportSafe, feeding = player.generation.index < player.generation.count;
      await report();
      const calls = f.calls.slice(first);
      steps.push({at, blocked, feeding,
        pages: calls.reduce((sum, row) => sum + (row.pages ?? 0), 0),
        trips: calls.reduce((sum, row) => sum + (row.trips ?? 0), 0)});
    };
    await player.run();
    assert.ok(steps.every((row, i) => !i || row.at - steps[i - 1].at >= 1500), 'Blocked credits must not trigger a report burst');
    if (decodeMs === 250) assert.ok(steps.some(row => row.blocked && row.feeding));
    assert.ok(steps.some(row => row.pages === 2 && row.trips === 1), 'Prefer compact credit state to paged playback while feeding');
    assert.equal(counted, 160);
    const sends = f.calls.filter(row => row.kind === 'send');
    const rate = 163e3 / (sends.at(-1).at + sends.at(-1).records * 45 - sends[0].at);
    console.log('Paged fake decode ms:', decodeMs, 'NAL/s:', rate, 'pages/step:', [...new Set(steps.map(row => row.pages))]);
    const before = f.calls.length;
    player.generation = {stream: 1, tokens: [101, 102], reached: true, index: 10, count: 100, detailedReports: false};
    player.view.paused = true;
    f.protocol.owned = async op => {
      assert.equal(op, 10); const raw = new Uint8Array(6); raw[0] = 10; raw[4] = 32;
      return [raw, raw];
    };
    await player.report();
    assert.equal(f.calls.length, before, 'Paused passive report must not fetch SHOWN/playback pages');
  }
});

test('Confirmed pause keeps compact polls alive without uploading until resume', async () => {
  const f = latencyTransport(160, 70, 35);
  let pause, resume, pausedAt = null, polls = 0;
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), view => {
      if (view.paused && pausedAt === null) pausedAt = f.calls.length;
    }, () => {}, f.clock, f.sleep);
  const report = player.report.bind(player);
  player.report = async () => {
    const first = f.calls.length, paused = player.view.paused;
    await report();
    if (!pause && player.generation.reached) pause = player.pause(true);
    if (paused && !resume) {
      assert.deepEqual(f.calls.slice(first).map(row => row.kind), ['credit']);
      assert.ok(f.calls.slice(pausedAt).every(row => row.kind !== 'send'));
      if (++polls === 3) resume = player.pause(false);
    }
  };
  await player.run(); await pause; await resume;
  assert.equal(polls, 3);
  assert.equal(f.copies.length, 160);
  assert.equal(player.view.cleanupFailed, false);
});

test('Primed decoder stalls only within paired reports plus one scheduler tick', async () => {
  const f = latencyTransport(); let counted = 0;
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, n => counted += n, f.clock, f.sleep);
  const report = player.report.bind(player);
  player.report = () => f.report(report);
  await player.run();
  assert.equal(f.copies.length, 160); assert.equal(counted, 160); assert.equal(f.closed(), true);
  assert.equal(f.primed(), true);
  assertNoUploadStallsOutsidePairedReports(f);
  assert.ok(f.observations.length >= 6, 'Real observations must occur during input, not just at EOF');
  const inputPhy = f.calls.filter(row => row.kind === 'phy' && row.accepted > 0 && row.accepted < 163);
  assert.equal(inputPhy.length, 0, 'PHY is lifecycle-only by default');
  assert.ok(f.calls.some(row => row.kind === 'shown-1') && f.calls.some(row => row.kind === 'shown-2'));
});

test('Detailed mode retains both-lens full reports within the passive rate cap', async () => {
  const f = latencyTransport(40);
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true, detailedReports: true}), () => {}, () => {}, f.clock, f.sleep);
  await player.run();
  assert.equal(f.copies.length, 40);
  assert.ok(f.calls.filter(row => row.kind === 'phy' && row.accepted > 0 && row.accepted < 43).length >= 2);
  assert.ok(f.copies.some((row, i) => i && row.tick - f.copies[i - 1].tick > 500),
    'Diagnostic reports must expose the old long gaps even before the input can prime');
});

test('Every credited finishing NAL is sent before any later picture metadata request', async () => {
  const f = latencyTransport(80);
  const player = new VideoPlayback(f.protocol, f.source, silentVideoAudio,
    () => ({native: true, dither: false, radio: true}), () => {}, () => {}, f.clock, f.sleep);
  const upload = player.upload.bind(player), report = player.report.bind(player);
  player.report = () => f.report(report);
  player.upload = async () => {
    const credited = player.creditBudget > 0 && player.generation.index < player.generation.count, first = f.calls.length;
    const result = await upload();
    if (credited) assert.notEqual(f.calls[first]?.kind, 'credit', 'Upload must use its unused reserved credits');
    return result;
  };
  await player.run();
  const sends = f.calls.filter(row => row.kind === 'send');
  assert.ok(sends.every(row => row.records === 1 || row.first === 0));
  assertNoUploadStallsOutsidePairedReports(f);
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
