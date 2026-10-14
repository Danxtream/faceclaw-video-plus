const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideoClip, videoSeekPoint } = require('../.test-build/app/apps/video/video-clip');

function fixture(count = 5) {
  const hash = 'a'.repeat(64);
  const nals = [7, 8, 6, ...Array.from({length: count}, (_, i) => i % 3 === 0 ? 5 : 1)]
    .map((type, i) => ({offset: 4 + i * 10, bytes: 6, type, sha256: hash}));
  const audit = {bytes: nals.at(-1).offset + 6, sha256: hash, nals};
  const clip = {version: 1, width: 320, height: 192, fps: 16, range: 'full', deblocking: false,
    duration: Math.round(count * 1000 / 16), encoder: 'test', options: ['-profile:v', 'baseline'],
    source: {name: 'test.mp4', bytes: 20, sha256: hash}, h264: structuredClone(audit),
    pictures: Array.from({length: count}, (_, i) => ({pts: Math.round(i * 1000 / 16), nal: i + 3, idr: i % 3 === 0, sps: 0, pps: 1}))};
  return {clip, audit};
}

test('Clip preserves non-VCL NALs and seeks from an IDR at all boundaries', () => {
  const {clip, audit} = fixture();
  const parsed = parseVideoClip(clip, audit);
  assert.equal(parsed.pictures[0].nal, 3);
  assert.deepEqual(videoSeekPoint(parsed, 150), {frame: 2, idr: 0, preroll: 2});
  assert.deepEqual(videoSeekPoint(parsed, 1e9), {frame: 4, idr: 3, preroll: 1});
  assert.deepEqual(videoSeekPoint(parsed, -1), {frame: 0, idr: 0, preroll: 0});
  assert.throws(() => videoSeekPoint(parsed, NaN));
});

test('Clip refuses stale identities, malformed picture maps and oversized complete NALs', () => {
  for (const mutate of [c => c.h264.sha256 = 'b'.repeat(64), c => c.h264.nals[0].offset++,
    c => c.h264.nals[0].bytes = 4087, c => c.range = 'tv', c => c.fps = 30,
    c => c.pictures[0].idr = false, c => c.pictures[1].nal = 3, c => c.pictures[1].pts++,
    c => c.pictures[0].pps = 0, c => c.pictures.pop(), c => c.duration++]) {
    const {clip, audit} = fixture(); mutate(clip);
    assert.throws(() => parseVideoClip(clip, audit));
  }
});

test('Every VCL must have a mapped picture, with bounded hidden preroll', () => {
  const {clip, audit} = fixture();
  audit.nals[2].type = clip.h264.nals[2].type = 1;
  assert.throws(() => parseVideoClip(clip, audit), /unmapped/);
  const long = fixture(258);
  long.clip.pictures.forEach((p, i) => { p.idr = i === 0; long.audit.nals[p.nal].type = long.clip.h264.nals[p.nal].type = p.idr ? 5 : 1; });
  assert.throws(() => parseVideoClip(long.clip, long.audit), /preroll/);
});
