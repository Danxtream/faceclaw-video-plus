const test = require('node:test');
const assert = require('node:assert/strict');
const {loader} = require('./helpers/load-typescript.cjs');

test('Audio cancel during polling and repeated pause/close never call a closed native player', async () => {
  let cancel = false, pending = false, closed = false, closes = 0, syncs = 0;
  class Player {
    beginPrepare() {} poll() { if (pending) cancel = true; return pending ? 0 : 1; }
    takeResult() { assert.equal(closed, false); }
    beginSync() { assert.equal(closed, false); syncs++; pending = true; }
    beginPause() { assert.equal(closed, false); }
    close() { closed = true; closes++; }
  }
  const load = loader({global: {isAndroid: true}, com: {faceclaw: {app: {VideoAudioPlayer: Player}}}}, {});
  const {openVideoAudio} = load('app/native/video-audio.ts');
  const audio = await openVideoAudio('/video/clip.h264', {source: {name: 'clip.mp4', bytes: 4, sha256: 'a'}}, () => cancel);
  await audio.sync(0, true, 1, 100);
  await audio.pause(); await audio.pause(); await audio.close(); await audio.close();
  await audio.sync(0, true, 1, 100);
  assert.equal(closes, 1); assert.equal(syncs, 1);
});
