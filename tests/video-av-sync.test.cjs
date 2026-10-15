const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoAvSync, VIDEO_AV_DEFAULTS } = require('../.test-build/app/apps/video/video-av-sync');

test('Audio waits for the first shown picture, then starts at it with a seek lead', () => {
  const av = new VideoAvSync(60_000);
  assert.deepEqual(av.decide(1000, 0, false, false), {kind: 'none'});
  assert.equal(av.decide(1000, 0, true, false).kind, 'pause');
  av.anchor(5000, 900);
  const start = av.decide(1000, 0, false, false);
  assert.equal(start.kind, 'play');
  assert.equal(start.seek, true);
  assert.equal(start.position, 5100 + VIDEO_AV_DEFAULTS.seekLeadMs);
  assert.equal(start.speed, 1);
});

test('Audio ahead of the picture holds, then resumes without a seek once the picture leads', () => {
  const av = new VideoAvSync(60_000);
  av.anchor(1000, 0);
  assert.equal(av.decide(0, 0, false, false).position, 1000 + VIDEO_AV_DEFAULTS.seekLeadMs);
  // The decoder starves: its newest picture caps the estimate one frame behind it.
  av.available(1400);
  assert.equal(av.video(500), 1400 - VIDEO_AV_DEFAULTS.frameMs);
  const hold = av.decide(500, 1620, true, false);
  assert.equal(hold.kind, 'pause');
  assert.ok(hold.lag > VIDEO_AV_DEFAULTS.holdMs);
  assert.deepEqual(av.decide(600, 1620, false, false), {kind: 'none'});
  av.available(5000);
  const resume = av.decide(700, 1620, false, false);
  assert.equal(resume.kind, 'play');
  assert.equal(resume.seek, false);
  assert.equal(resume.position, 1620);
});

test('Audio far behind the picture seeks forward; small offsets leave it alone', () => {
  const av = new VideoAvSync(60_000);
  av.anchor(10_000, 0);
  assert.deepEqual(av.decide(0, 10_040, true, false), {kind: 'none'});
  assert.deepEqual(av.decide(0, 9_900, true, false), {kind: 'none'});
  // Behind must persist before a corrective seek.
  assert.deepEqual(av.decide(0, 9_700, true, false), {kind: 'none'});
  const behind = av.decide(300, 10_000, true, false);
  assert.equal(behind.kind, 'play');
  assert.equal(behind.seek, true);
  assert.equal(behind.position, 10_300 + VIDEO_AV_DEFAULTS.seekLeadMs);
});

test('A slow picture rate lowers audio speed within the floor, at most once per interval', () => {
  const av = new VideoAvSync(600_000);
  av.anchor(0, 0);
  av.anchor(3600, 4000);                      // 0.9x over one window
  av.anchor(7200, 8000);
  assert.ok(av.measuredRate < 0.95);
  const first = av.decide(8000, 7200, true, false);
  assert.equal(first.kind, 'play');
  assert.equal(first.seek, false);
  assert.equal(first.speed, VIDEO_AV_DEFAULTS.minSpeed);
  assert.deepEqual(av.decide(8100, 7300, true, false), {kind: 'none'});
});

test('Pause stops audio; restart at the held frame starts it again in sync', () => {
  const av = new VideoAvSync(60_000);
  av.anchor(2000, 0);
  assert.equal(av.decide(100, 2100, true, true).kind, 'pause');
  assert.deepEqual(av.decide(5000, 2100, false, true), {kind: 'none'});
  av.restart(2100, 9000);
  const resume = av.decide(9000, 2100, false, false);
  assert.equal(resume.kind, 'play');
  assert.equal(resume.seek, true);
  assert.equal(resume.position, 2100 + VIDEO_AV_DEFAULTS.seekLeadMs);
});

test('Anchors never move the clock backwards in time and the estimate stops at the end', () => {
  const av = new VideoAvSync(3000);
  av.anchor(1000, 500);
  av.anchor(900, 400);
  assert.equal(av.video(500), 1000);
  assert.equal(av.video(10_000), 3000);
});

test('The seek lead learns from real seeks but stays below the hold threshold', () => {
  const av = new VideoAvSync(60_000);
  av.anchor(1000, 0);
  av.seekTook(300);
  const lead = av.decide(0, 0, false, false).position - 1000;
  assert.ok(lead > VIDEO_AV_DEFAULTS.seekLeadMs && lead <= 400);
  av.seekTook(-5); av.seekTook(Number.NaN);
  assert.equal(av.decide(0, 1000 + lead, true, false).kind, 'none');
});

// A 30 s run: picture at 0.83x with a 200 ms audio start latency and a reader
// that stays stale for 300 ms after every seek (the phone's 198-seek storm).
function simulate({rate = 0.83, startLatency = 200, staleAfterSeek = 300, seconds = 30} = {}) {
  const av = new VideoAvSync(600_000);
  let now = 0, playing = false, base = 0, at = 0, speed = 1, startedAt = 0, staleUntil = -1, staleValue = 0;
  const seeks = [], holds = [];
  const truePos = () => !playing ? base : base + Math.max(0, now - Math.max(at, startedAt)) * speed;
  const reading = () => now < staleUntil ? staleValue : truePos();
  for (; now <= seconds * 1000; now += 100) {
    if (now % 1000 === 0) av.anchor(Math.round(now * rate), now);
    const action = av.decide(now, reading(), playing, false);
    if (action.kind === 'pause') { base = truePos(); playing = false; holds.push(now); }
    else if (action.kind === 'play') {
      const before = truePos();
      if (action.seek) { seeks.push(now); staleValue = before; staleUntil = now + staleAfterSeek; base = action.position; }
      else base = before;
      at = now; startedAt = now + startLatency; speed = action.speed; playing = true;
      av.seekTook(action.seek ? 150 : 0);
    }
  }
  return {seeks, holds, lag: reading() - Math.round(now * rate)};
}

test('No seek storm when the audio reader is stale after seeks and the picture runs slow', () => {
  const run = simulate();
  assert.ok(run.seeks.length <= 3, `seeks ${run.seeks.length}`);
  assert.ok(Math.abs(run.lag) < 400, `final lag ${run.lag}`);
});

test('Real start latency is learned: a steady picture needs a start and at most one correction, no holds', () => {
  const run = simulate({rate: 1, staleAfterSeek: 0, startLatency: 200});
  assert.ok(run.seeks.length <= 2, `seeks ${run.seeks.length}`);
  assert.equal(run.holds.length, 0);
});

test('A steady small lag from start latency is corrected once the latency is learned', () => {
  const run = simulate({rate: 1, staleAfterSeek: 0, startLatency: 200, seconds: 30});
  assert.ok(run.seeks.length <= 3, `seeks ${run.seeks.length}`);
  assert.ok(Math.abs(run.lag) < 100, `final lag ${run.lag}`);
});
