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
  const behind = av.decide(0, 9_800, true, false);
  assert.equal(behind.kind, 'play');
  assert.equal(behind.seek, true);
  assert.equal(behind.position, 10_000 + VIDEO_AV_DEFAULTS.seekLeadMs);
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
  assert.ok(lead > VIDEO_AV_DEFAULTS.seekLeadMs && lead < VIDEO_AV_DEFAULTS.holdMs);
  av.seekTook(-5); av.seekTook(Number.NaN);
  assert.equal(av.decide(0, 1000 + lead, true, false).kind, 'none');
});
