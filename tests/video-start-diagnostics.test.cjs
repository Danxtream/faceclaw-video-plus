const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoPlayback, silentVideoAudio} = require('../.test-build/app/apps/video/video-playback');
const {VIDEO} = require('../.test-build/app/apps/video/video-protocol');

test('Status refusal names each lens, operation and owner fields in the error and console', () => {
  const player = new VideoPlayback({}, {clip: {duration: 1000}}, silentVideoAudio, () => ({}));
  const good = {result: 0, state: 2, error: 0, stream: 50, high: 50, token: 101};
  const bad = {...good, result: 4, state: 0, stream: 0, high: 49, token: 0};
  const original = console.error, logs = [];
  console.error = message => logs.push(message);
  try {
    assert.throws(() => player.validateStatus([good, bad], VIDEO.start, 50), error => {
      assert.match(error.message, /RIGHT operation=START\(1\) result=4 state=0 error=0 stream=0 high=49 token=0/);
      assert.deepEqual(logs, [error.message]); return true;
    });
    logs.length = 0;
    assert.throws(() => player.validateStatus([{...good, error: 8}, good], VIDEO.stop, 50), /LEFT operation=STOP\(2\).*error=8/);
    player.validateStatus([good, good], VIDEO.status, 50);
  } finally { console.error = original; }
});
