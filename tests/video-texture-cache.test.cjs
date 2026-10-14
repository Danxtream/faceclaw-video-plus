const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

test('Video cache release is ACK-fenced before START and cannot be recreated until resume', () => {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java', 'utf8');
  assert.ok(source.includes('videoTextureCacheGate.prepare'), 'START must release cached textures before admission');
  assert.ok(source.includes('!videoTextureCacheGate.suspended()'), 'Video must disable texture planning');
  assert.match(source, /videoTextureCacheGate\.preparing\(\)\s*\? inFlightMessages\.isEmpty\(\)/);
  assert.ok(source.includes('message.onAck = acknowledged::run'));
  assert.ok(source.includes('message.onTimeout = failed::run'));
  const boundaries = require('../native/kotlin/android-java-boundaries.json');
  assert.ok(boundaries.flatMap(group => group.files).includes('com/faceclaw/app/VideoTextureCacheGate.java'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-video-cache-'));
  try {
    execFileSync('javac', ['-d', folder,
      'App_Resources/Android/src/main/java/com/faceclaw/app/VideoTextureCacheGate.java',
      'tests/java/VideoTextureCacheGateTest.java'], {stdio: 'pipe'});
    execFileSync('java', ['-ea', '-cp', folder, 'com.faceclaw.app.VideoTextureCacheGateTest'], {stdio: 'pipe'});
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, {recursive: true, force: true});
  }
});
