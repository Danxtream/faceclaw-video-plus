const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoAvSync, VIDEO_AV_DEFAULTS } = require('../.test-build/app/apps/video/video-av-sync');
const {videoAvOptions}=require('../.test-build/app/apps/video/video-av-sync');

test('Only frame-derived audio limits follow clip cadence, with the existing policy unchanged',()=>{
  for(const fps of [10,15,20]){
    const options=videoAvOptions(fps);
    assert.equal(options.frameMs,1000/fps);assert.equal(options.holdMs,Math.max(80,1500/fps));
    assert.equal(options.resumeMs,Math.max(50,500/fps));
    for(const key of Object.keys(VIDEO_AV_DEFAULTS).filter(k=>!['frameMs','holdMs','resumeMs'].includes(k)))
      assert.equal(options[key],VIDEO_AV_DEFAULTS[key]);
  }
});

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
  assert.deepEqual(av.decide(500, 1620, true, false), {kind: 'none'});
  const hold = av.decide(800, 1920, true, false);
  assert.equal(hold.kind, 'pause');
  assert.ok(hold.lag > VIDEO_AV_DEFAULTS.holdMs);
  assert.deepEqual(av.decide(900, 1920, false, false), {kind: 'none'});
  av.available(5000);
  const resume = av.decide(1100, 1920, false, false);
  assert.equal(resume.kind, 'play');
  assert.equal(resume.seek, false);
  assert.equal(resume.position, 1920);
});

test('Audio far behind the picture seeks forward; small offsets leave it alone', () => {
  const av = new VideoAvSync(60_000);
  av.anchor(10_000, 0);
  assert.deepEqual(av.decide(0, 10_040, true, false), {kind: 'none'});
  assert.deepEqual(av.decide(0, 9_900, true, false), {kind: 'none'});
  // Behind must persist before a corrective seek.
  assert.deepEqual(av.decide(0, 9_300, true, false), {kind: 'none'});
  const behind = av.decide(300, 9_600, true, false);
  assert.equal(behind.kind, 'play');
  assert.equal(behind.seek, true);
  assert.equal(behind.position, 10_300 + VIDEO_AV_DEFAULTS.seekLeadMs);
});

test('A slow picture rate lowers audio speed within the floor, at most once per interval', () => {
  const av = new VideoAvSync(600_000);
  av.anchor(0, 0);
  av.anchor(7200, 8000);                      // 0.9x over one window
  av.anchor(14_400, 16_000);
  assert.ok(av.measuredRate < 0.95);
  const first = av.decide(16_000, 14_400, true, false);
  assert.equal(first.kind, 'play');
  assert.equal(first.seek, false);
  assert.equal(first.speed, VIDEO_AV_DEFAULTS.minSpeed);
  assert.deepEqual(av.decide(16_100, 14_500, true, false), {kind: 'none'});
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
      // A speed change on playing audio (setPlaybackParams) keeps it running; only a start or seek waits.
      if (action.seek || !playing) startedAt = now + startLatency;
      at = now; speed = action.speed; playing = true;
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

test('A picture paced 2-3% fast by the lens tick is matched by audio speed instead of repeated seeks', () => {
  // Measured on pair 1: the lens tick runs about 2% fast against the phone clock.
  for (const rate of [1.017, 1.02, 1.023, 1.03]) {
    // Before: speed stayed at 1 and audio needed a seek every 6-8 s (about 40 in 5 minutes).
    const run = simulate({rate, staleAfterSeek: 0, startLatency: 200, seconds: 300});
    const settled = run.seeks.filter(at => at > 120_000);
    assert.ok(run.seeks.length <= 9 && settled.length === 0, `rate ${rate}: seeks at ${run.seeks.join(',')}`);
    assert.equal(run.holds.length, 0, `rate ${rate}`);
    assert.ok(Math.abs(run.lag) < 150, `rate ${rate}: final lag ${run.lag}`);
  }
});

test('After a resume the rate is measured from the first moving anchor, not the resume command', () => {
  const av = new VideoAvSync(600_000);
  for (let t = 0; t <= 16_000; t += 1000) av.anchor(t, t);
  av.restart(16_000, 30_000);
  // The lenses refill for 400 ms before the held frame moves again.
  // One rate window after the picture moves again; measuring from the command would read 0.95.
  for (let t = 30_400; t <= 38_400; t += 1000) av.anchor(16_000 + t - 30_400, t);
  assert.ok(av.measuredRate > 0.99, `rate ${av.measuredRate}`);
});

test('A steady small lag from start latency is corrected once the latency is learned', () => {
  const run = simulate({rate: 1, staleAfterSeek: 0, startLatency: 200, seconds: 30});
  assert.ok(run.seeks.length <= 3, `seeks ${run.seeks.length}`);
  assert.ok(Math.abs(run.lag) < 100, `final lag ${run.lag}`);
});

test('A brief ahead-to-behind reversal does not cut playing audio', () => {
  const av = new VideoAvSync(60_000, videoAvOptions(10));
  av.anchor(0, 0);
  av.available(933);
  // A stale availability cap makes audio appear 167 ms ahead at this turn.
  assert.deepEqual(av.decide(1000, 1000, true, false), {kind: 'none'});
  av.available(5000);
  av.anchor(1353, 1122);
  // The next report reverses the sign, as in the 122 ms phone sequence.
  assert.deepEqual(av.decide(1122, 1122, true, false), {kind: 'none'});
  av.anchor(1250, 1250);
  assert.deepEqual(av.decide(1250, 1250, true, false), {kind: 'none'});
});

test('A far-behind sample while audio is held must persist before seeking', () => {
  const av = new VideoAvSync(60_000, videoAvOptions(10));
  av.anchor(0, 0);
  av.decide(0, 0, false, false);
  av.available(1000);
  av.decide(2000, 1167, true, false);
  assert.equal(av.decide(2300, 1467, true, false).kind, 'pause');
  av.available(5000);
  av.anchor(1698, 2422);
  assert.deepEqual(av.decide(2422, 1467, false, false), {kind: 'none'});
  const correction = av.decide(2722, 1467, false, false);
  assert.equal(correction.kind, 'play');
  assert.equal(correction.seek, true);
});

test('Recovery and a user pause reset pending ahead confirmation at every clip rate', () => {
  for (const fps of [10, 15, 20]) {
    const av = new VideoAvSync(60_000, videoAvOptions(fps));
    av.anchor(0, 0); av.available(1000);
    assert.equal(av.decide(2000, 2200, true, false).kind, 'none');
    av.available(5000);
    assert.equal(av.decide(2200, 2200, true, false).kind, 'none');
    av.available(1000);
    assert.equal(av.decide(2300, 2500, true, false).kind, 'none');
    av.decide(2400, 2600, true, true);
    assert.equal(av.decide(2500, 2700, true, false).kind, 'none');
    assert.equal(av.decide(2799, 2999, true, false).kind, 'none');
    assert.equal(av.decide(2800, 3000, true, false).kind, 'pause');
    av.restart(1000, 4000);
    assert.equal(av.decide(4000, 1200, true, false).kind, 'none');
  }
});

test('Held audio resumes without seeking when a transient behind estimate recovers', () => {
  const av = new VideoAvSync(60_000, videoAvOptions(10));
  av.anchor(0, 0); av.decide(0, 0, false, false); av.available(1000);
  av.decide(2000, 1167, true, false);
  assert.equal(av.decide(2300, 1467, true, false).kind, 'pause');
  av.available(5000); av.anchor(1698, 2422);
  assert.equal(av.decide(2422, 1467, false, false).kind, 'none');
  av.anchor(1467, 2522);
  const resumed = av.decide(2522, 1467, false, false);
  assert.equal(resumed.kind, 'play');
  assert.equal(resumed.seek, false);
});

test('A persistent 230 ms offset recovers without skipping audio, at every clip rate', () => {
  for (const fps of [10, 15, 20]) {
    const av = new VideoAvSync(60_000, videoAvOptions(fps));
    let audio = 0, speed = 1, previous = 1000;
    const changes = [];
    for (let now = 1000; now <= 31_000; now += 100) {
      audio += (now - previous) * speed; previous = now;
      av.anchor(now - 770, now);
      const action = av.decide(now, audio, true, false);
      assert.notEqual(action.kind, 'pause');
      if (action.kind === 'play') {
        assert.equal(action.seek, false, 'small lag must never skip speech');
        speed = action.speed; changes.push(speed);
      }
    }
    assert.ok(changes.some(value => value > 1));
    assert.ok(changes.every(value => value >= 0.95 && value <= 1.05));
    assert.ok(Math.abs(audio - (31_000 - 770)) < 100);
  }
});
