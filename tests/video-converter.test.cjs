const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {loader} = require('./helpers/load-typescript.cjs');

test('Converter starts independently of glasses and requires explicit overwrite', () => {
  const calls = [], state = {running: false, stage: 'idle', progress: 0};
  const native = {snapshotJson: () => JSON.stringify(state), start: (...args) => calls.push(['start', ...args]), cancel: (...args) => calls.push(['cancel', ...args])};
  const load = loader({global: {isAndroid: true}, com: {faceclaw: {app: {VideoConversionService: native}}}},
    {'@nativescript/core': {Utils: {android: {getApplicationContext: () => 'context'}}}});
  const bridge = load('app/native/video-converter.ts');
  bridge.convertVideo('source.mp4');
  assert.deepEqual(calls[0], ['start', 'context', 'source.mp4', false, false, 15,176,'default']);
  bridge.convertVideo('source.mp4', true, true);
  assert.deepEqual(calls[1], ['start', 'context', 'source.mp4', true, true, 15,176,'default']);
  bridge.convertVideo('source.mp4',false,false,10,192);
  assert.deepEqual(calls.pop(),['start','context','source.mp4',false,false,10,192,'default']);
  for (const contrast of ['medium','high']) {
    bridge.convertVideo('source.mp4',false,false,10,176,contrast);
    assert.deepEqual(calls.pop(),['start','context','source.mp4',false,false,10,176,contrast]);
  }
  assert.throws(()=>bridge.convertVideo('source.mp4',false,false,15,180),/320x192 or 320x176/);
  assert.throws(()=>bridge.convertVideo('source.mp4',false,false,15,176,'extra'),/Default, Medium or High/);
  state.running = true;
  assert.throws(() => bridge.convertVideo('other.mp4'), /running/);
  bridge.cancelVideoConversion(); assert.deepEqual(calls[2], ['cancel', 'context']);
  state.progress = 2; assert.throws(() => bridge.videoConversionState(), /Invalid/);
});

test('Converter service owns only media processing and never Bluetooth or boot startup', () => {
  const manifest = fs.readFileSync('App_Resources/Android/src/main/AndroidManifest.xml', 'utf8');
  const service = manifest.match(/<service\s+android:name="com.faceclaw.app.VideoConversionService"[\s\S]*?\/>/)[0];
  assert.ok(service.includes('android:exported="false"'));
  assert.ok(service.includes('mediaProcessing|dataSync'));
  const job = fs.readFileSync('native/kotlin/shared/src/androidMain/kotlin/com/faceclaw/app/VideoConversion.kt', 'utf8');
  const process = fs.readFileSync('native/kotlin/shared/src/androidMain/kotlin/com/faceclaw/app/VideoConversionService.kt', 'utf8');
  assert.ok(!/Bluetooth|BleCommunicator|BOOT_COMPLETED/.test(job + process));
  assert.ok(process.includes('override fun onTimeout'));
  assert.ok(process.includes('START_NOT_STICKY'));
  assert.ok(job.includes('VideoPictureMap.build'));
  assert.ok(job.includes('input.lastModified() == modified && hash(input) == sourceHash'));
});
