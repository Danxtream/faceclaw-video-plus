const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {loader} = require('./helpers/load-typescript.cjs');

test('Chosen bitrate crosses the native boundary and unsupported values never start a job', () => {
  const calls = [];
  const native = {snapshotJson: () => JSON.stringify({running:false,stage:'idle',progress:0}), start: (...args) => calls.push(args)};
  const load = loader({global:{isAndroid:true},com:{faceclaw:{app:{VideoConversionService:native}}}},
    {'@nativescript/core':{Utils:{android:{getApplicationContext:()=> 'context'}}}});
  const {convertVideo} = load('app/native/video-converter.ts');
  for (const bitrate of ['110','150','200','250','auto']) {
    convertVideo('source.mp4',true,false,20,176,'veryhigh','large',bitrate);
    assert.equal(calls.at(-1).at(-1),bitrate);
  }
  for (const bitrate of ['0','130','300','',110])
    assert.throws(()=>convertVideo('source.mp4',true,false,20,176,'veryhigh','large',bitrate), /bitrate/i);
  assert.equal(calls.length,5);
});

test('Persisted bitrate setting keeps the approved 110 default and fixed choices', () => {
  class Setting { constructor(options) { Object.assign(this,options); } }
  const load=loader({}, {'../../ui/dashboard-settings':{ConfigSettingEnum:Setting,ConfigSettingBoolean:Setting}});
  const setting=load('app/apps/video/video-settings.ts').videoConversionBitrateSetting;
  assert.equal(setting.defaultValue,'110');
  assert.deepEqual(Array.from(setting.values),['110','150','200','250','auto']);
  assert.equal(setting.formatValue('250'),'250 kbps');
  assert.equal(setting.formatValue('auto'),'Auto');
});

test('Converter starts independently of glasses and requires explicit overwrite', () => {
  const calls = [], state = {running: false, stage: 'idle', progress: 0};
  const native = {snapshotJson: () => JSON.stringify(state), start: (...args) => calls.push(['start', ...args]), cancel: (...args) => calls.push(['cancel', ...args])};
  const load = loader({global: {isAndroid: true}, com: {faceclaw: {app: {VideoConversionService: native}}}},
    {'@nativescript/core': {Utils: {android: {getApplicationContext: () => 'context'}}}});
  const bridge = load('app/native/video-converter.ts');
  bridge.convertVideo('source.mp4');
  assert.deepEqual(calls[0], ['start', 'context', 'source.mp4', false, false, 15,176,'default','default','110']);
  bridge.convertVideo('source.mp4', true, true);
  assert.deepEqual(calls[1], ['start', 'context', 'source.mp4', true, true, 15,176,'default','default','110']);
  bridge.convertVideo('source.mp4',false,false,10,192);
  assert.deepEqual(calls.pop(),['start','context','source.mp4',false,false,10,192,'default','default','110']);
  for (const contrast of ['medium','high','veryhigh']) {
    bridge.convertVideo('source.mp4',false,false,10,176,contrast);
    assert.deepEqual(calls.pop(),['start','context','source.mp4',false,false,10,176,contrast,'default','110']);
  }
  bridge.convertVideo('source.mp4',false,false,10,176,'high','large');
  assert.deepEqual(calls.pop(),['start','context','source.mp4',false,false,10,176,'high','large','110']);
  assert.throws(()=>bridge.convertVideo('source.mp4',false,false,15,176,'high','huge'),/Default or Large keyframes/);
  assert.throws(()=>bridge.convertVideo('source.mp4',false,false,15,180),/320x192 or 320x176/);
  assert.throws(()=>bridge.convertVideo('source.mp4',false,false,15,176,'extra'),/Default, Medium, High or Very high/);
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
  assert.ok(job.includes('.put("bitrate", bitrate.kbps(fps)).put("bitrateSelection", bitrate.id)'));
});

test('Header report runs on a new thread each conversion, never a pooled FFmpeg thread', () => {
  // FFmpeg keeps one report file per thread and never closes it, so a reused thread skips the new report.
  const job = fs.readFileSync('native/kotlin/shared/src/androidMain/kotlin/com/faceclaw/app/VideoConversion.kt', 'utf8');
  const audit = job.slice(job.indexOf('val reportThread'), job.indexOf('val headerAudit'));
  assert.ok(audit.includes('Executors.newSingleThreadExecutor'));
  assert.ok(audit.includes('"trace_headers"') && audit.includes('executor = reportThread'));
  assert.ok(audit.includes('finally { reportThread.shutdown() }'));
});
