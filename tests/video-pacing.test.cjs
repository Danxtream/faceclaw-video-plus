const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoLensClock, VideoAudioClock, videoPaceSpan, videoPacePlan, videoSkipTarget, videoStallBehind } = require('../.test-build/app/apps/video/video-pacing');

// A deterministic generator keeps the jitter repeatable.
function random(seed) { return () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000; }

test('Lens clock fits a 1.4%-fast tick through jittery round trips and keeps the error small', () => {
  const lens = new VideoLensClock(), next = random(7);
  const tickAt = (t) => (4_000_000_000 + Math.round(t * 1.014)) >>> 0; // wraps past 2^32 during the run
  assert.equal(lens.tickAt(0), null);
  for (let t = 0; t <= 60_000; t += 5000) {
    const rtt = 20 + next() * 120, sampled = t + next() * rtt; // read somewhere inside the round trip
    lens.add(t, t + rtt, tickAt(sampled));
    if (t < 8000) assert.equal(lens.rate, 1);
  }
  assert.ok(Math.abs(lens.rate - 1.014) < 0.002, `rate ${lens.rate}`);
  for (const at of [60_000, 61_500, 63_000]) {
    const error = ((lens.tickAt(at) - tickAt(at)) | 0);
    assert.ok(Math.abs(error) <= 50, `error ${error} at ${at}`); // 200 random runs: median 10, p95 28, worst 46
  }
});

test('Lens clock ignores impossible readings and an unreasonable rate', () => {
  const lens = new VideoLensClock();
  lens.add(10, 5, 100); lens.add(NaN, 5, 100); lens.add(0, 5, 1.5);
  assert.equal(lens.ready, false);
  for (let t = 0; t <= 30_000; t += 5000) lens.add(t, t + 10, (t * 2) >>> 0); // a 2x tick is a misread, not a clock
  assert.equal(lens.rate, 1);
});

test('Audio clock uses the median heard offset only after the start settles', () => {
  const audio = new VideoAudioClock();
  audio.reset(1000);
  audio.add(1200, 0); // still settling: the player position stands still after a seek
  for (const [at, position] of [[1600, 5600], [1700, 5700], [1800, 5830], [1900, 5900]]) audio.add(at, position);
  assert.equal(audio.heard(2000), 6000);
  audio.reset(5000);
  assert.equal(audio.heard(5000), null);
  audio.add(6000, null);
  assert.equal(audio.heard(6000), null);
});

test('Pace spacing matches the firmware deadline arithmetic in both directions', () => {
  assert.deepEqual([1, 2, 3, 15, 16].map((d) => videoPaceSpan(15, d)), [66, 133, 200, 1000, 1066]);
  assert.equal(videoPaceSpan(10, -7), -700);
  assert.equal(videoPaceSpan(20, 41), 2050);
});

test('Pace plan targets the first picture due after the lead, on each lens, minus display latency', () => {
  const clocks = [new VideoLensClock(), new VideoLensClock()];
  clocks[0].add(0, 0, 5000); clocks[1].add(0, 0, 90_000);
  const pts = Array.from({ length: 100 }, (_, i) => i * 100);
  // Audio is heard at 2000 ms now; picture 25 (2400 ms) is the first one due 400 ms or more ahead.
  const plan = videoPacePlan({ now: 1000, heard: 2000, offset: 0, pts, first: 18, lead: 400, clocks, latency: 12 });
  assert.equal(plan.ordinal, 25);
  assert.equal(plan.due, 1400);
  assert.deepEqual(plan.ticks, [5000 + 1400 - 12, 90_000 + 1400 - 12]);
  // Sound 300 ms earlier: every picture is due 300 ms later against the audio.
  const early = videoPacePlan({ now: 1000, heard: 2000, offset: 300, pts, first: 18, lead: 400, clocks, latency: 0 });
  assert.equal(early.ordinal, 22); assert.equal(early.due, 1400);
  assert.equal(videoPacePlan({ now: 0, heard: 0, offset: 0, pts, first: 1, lead: 400, clocks: [new VideoLensClock(), clocks[1]], latency: 0 }), null);
  // Audio past the last picture: nothing left to schedule.
  assert.equal(videoPacePlan({ now: 1000, heard: 9800, offset: 0, pts, first: 90, lead: 400, clocks, latency: 0 }), null);
});

test('A stalled picture restarts at the audio, or at the next keyframe when the preroll would be long', () => {
  const clip = { pictures: Array.from({ length: 300 }, (_, i) => ({ pts: i * 100, idr: i % 80 === 0 })) };
  assert.equal(videoSkipTarget(clip, 8_400, 20), 8_400);   // keyframe at 8 s: 4 pictures of preroll
  assert.equal(videoSkipTarget(clip, 12_000, 20), 16_000); // 40 pictures back to its keyframe: next one
  assert.equal(videoSkipTarget(clip, 99_000, 20), 29_900); // past the end and no later keyframe: last picture
});

test('A stall restart needs a fresh lens report to agree', () => {
  // The phone estimate drifted 1.6 s behind while the lenses reported on-time pictures 0.5 s ago.
  const base = {now: 10_000, heard: 50_000, offset: 0, estimate: 48_400};
  assert.equal(videoStallBehind({...base, lens: {pts: 49_400, at: 9_500}}), 100);
  // A stalled lens reports the same old picture: the restart still goes ahead.
  assert.equal(videoStallBehind({...base, lens: {pts: 47_000, at: 9_500}}), 1_600);
  // Without a fresh report the estimate decides, as before.
  assert.equal(videoStallBehind({...base, lens: null}), 1_600);
  assert.equal(videoStallBehind({...base, lens: {pts: 49_400, at: 6_000}}), 1_600);
  assert.equal(videoStallBehind({...base, offset: 200, lens: {pts: 49_400, at: 9_500}}), -100);
});
