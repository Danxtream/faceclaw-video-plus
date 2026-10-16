const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideoClip, videoSeekPoint } = require('../.test-build/app/apps/video/video-clip');

function fixture(count = 5) {
  const hash = 'a'.repeat(64);
  const nals = [7, 8, 6, ...Array.from({length: count}, (_, i) => i % 3 === 0 ? 5 : 1)]
    .map((type, i) => ({offset: 4 + i * 10, bytes: 6, type, sha256: hash}));
  const audit = {bytes: nals.at(-1).offset + 6, sha256: hash, nals};
  const clip = {version: 1, width: 320, height: 192, fps: 15, range: 'full', deblocking: false,
    duration: Math.round(count * 1000 / 15), encoder: 'test', options: ['-profile:v', 'baseline'],
    source: {name: 'test.mp4', bytes: 20, sha256: hash}, h264: structuredClone(audit),
    pictures: Array.from({length: count}, (_, i) => ({pts: Math.round(i * 1000 / 15), nal: i + 3, idr: i % 3 === 0, sps: 0, pps: 1}))};
  return {clip, audit};
}

test('Picture geometry admits all three canvases and odd edges but never silently loses bars', () => {
  for(const g of [{width:320,height:192,picture:{x:0,y:6,width:320,height:180}},
    {width:320,height:176,picture:{x:3,y:0,width:313,height:176}},
    {width:144,height:240,picture:{x:4,y:0,width:135,height:240}}]) {
    const {clip,audit}=fixture();Object.assign(clip,g);
    assert.deepEqual(parseVideoClip(clip,audit).picture,g.picture);
  }
  for(const g of [{width:320,height:176},{width:144,height:240},
    {width:320,height:192,picture:{x:1,y:0,width:320,height:192}},
    {width:320,height:192,picture:{x:0,y:0,width:0,height:192}}]) {
    const {clip,audit}=fixture();Object.assign(clip,g);assert.throws(()=>parseVideoClip(clip,audit),/rectangle/);
  }
  const {clip,audit}=fixture();
  assert.deepEqual(parseVideoClip(clip,audit).picture,{x:0,y:0,width:320,height:192});
});

test('All supported clip rates have exact rounded timestamps and seek boundaries; old rates require reconversion', () => {
  for (const fps of [10,15,20]) {
    const {clip,audit}=fixture(100);
    clip.fps=fps;clip.duration=Math.round(100000/fps);
    clip.pictures.forEach((p,i)=>p.pts=Math.round(i*1000/fps));
    const parsed=parseVideoClip(clip,audit);
    parsed.pictures.forEach((p,i)=>{
      assert.equal(videoSeekPoint(parsed,p.pts).frame,i);
      if(i)assert.equal(videoSeekPoint(parsed,p.pts-1).frame,i-1);
    });
  }
  for(const fps of [undefined,null,0,16,24,30,'15']) {
    const {clip,audit}=fixture();clip.fps=fps;
    assert.throws(()=>parseVideoClip(clip,audit),/Re-convert.*10, 15 or 20 fps/);
  }
});

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

function slicedFixture(types = [7, 8, 6, 5, 5, 5, 1, 1, 1], finishing = [5, 7, 8]) {
  const hash = 'a'.repeat(64);
  const nals = types.map((type, i) => ({offset: 4 + i * 10, bytes: 6, type, sha256: hash}));
  const audit = {bytes: nals.at(-1).offset + 6, sha256: hash, nals};
  const clip = {version: 1, width: 320, height: 192, fps: 15, range: 'full', deblocking: false,
    duration: Math.round(finishing.length * 1000 / 15), encoder: 'test', options: [], keyframes: 'large',
    source: {name: 'test.mp4', bytes: 20, sha256: hash}, h264: structuredClone(audit),
    pictures: finishing.map((nal, i) => ({pts: Math.round(i * 1000 / 15), nal, idr: i === 0, sps: 0, pps: 1}))};
  return {clip, audit};
}

test('Large-keyframe clips may split pictures into consecutive slices and record each first slice', () => {
  const {clip, audit} = slicedFixture();
  const parsed = parseVideoClip(clip, audit);
  assert.deepEqual(parsed.pictures.map(p => [p.first, p.nal]), [[3, 5], [6, 7], [8, 8]]);
  assert.equal(parsed.slices, true);
  const plain = fixture();
  assert.equal(parseVideoClip(plain.clip, plain.audit).slices, false);
  assert.deepEqual(parseVideoClip(plain.clip, plain.audit).pictures.map(p => p.first), [3, 4, 5, 6, 7]);
});

test('Split pictures stay refused without Large keyframes, across parameter sets or mixed slice types', () => {
  const unmarked = slicedFixture(); delete unmarked.clip.keyframes;
  assert.throws(() => parseVideoClip(unmarked.clip, unmarked.audit), /Multiple or unmapped VCL/);
  const parameterSet = slicedFixture([7, 8, 6, 5, 8, 5, 1, 1, 1]);
  assert.throws(() => parseVideoClip(parameterSet.clip, parameterSet.audit), /Multiple or unmapped VCL|active SPS\/PPS/);
  const mixed = slicedFixture([7, 8, 6, 5, 5, 5, 5, 1, 1], [5, 7, 8]);
  assert.throws(() => parseVideoClip(mixed.clip, mixed.audit), /Multiple or unmapped VCL/);
  const unknown = slicedFixture(); unknown.clip.keyframes = 'huge';
  assert.throws(() => parseVideoClip(unknown.clip, unknown.audit), /keyframe size/);
});
