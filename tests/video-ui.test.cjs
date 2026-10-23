const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {loader} = require('./helpers/load-typescript.cjs');

function modelFixture(strip = false) {
  const calls = [], values = new Map(); let timer, observer, replace = false;
  const settings = key => ({get: () => values.get(key) ?? (key === 'radio' ? 'video' : key === 'scale' ? 'native' : key === 'rate' ? '15' : key === 'frame' ? '320x176' : key === 'floor' ? '1' : key === 'contrast' ? 'default' : key === 'keyframes' ? 'default' : key === 'bitrate' ? '110' : key === 'audioOffset' ? '0' : false),
    set: value => {values.set(key, value); calls.push([key, value]);}, displayValue: () => values.get(key) === 'off' ? 'Off' : 'Video-only'});
  const player = {view: {active: true, paused: false, position: 1234, duration: 20000},
    pause: async value => calls.push(['pause', value]), seek: async value => calls.push(['seek', value]),
    scale: async value => calls.push(['scale-command', value])};
  const session = {path: '/Download/G2/movie.h264', engine: player, view: player.view, hasAudio: true, stop: () => calls.push(['stop'])};
  const files = [{name: 'movie.mp4', path: '/Download/G2/movie.mp4', isDirectory: false, modifiedMs: 10, sizeBytes: 100}];
  class Observable {constructor() {this.values = new Map();} get(key) {return this.values.get(key);} set(key, value) {this.values.set(key, value);} }
  const load = loader({setInterval: callback => {timer = callback; return 1;}, clearInterval: () => calls.push(['clear-interval']),
    setTimeout: callback => {observer = callback; return 1;}, clearTimeout: () => calls.push(['clear-timeout'])}, {
    '@nativescript/core': {Observable, Dialogs: {confirm: async () => replace}, Frame: {topmost: () => ({goBack() {}})}},
    '../g2/dashboard-controller': {dashboardController: {subscribe: callback => {callback({phase: 'connected'}); return () => calls.push(['unsub']);}, openVideoWindow: async () => calls.push(['window'])}},
    '../native/file-access': {hasAllFilesAccess: () => true, requestAllFilesAccess() {}, statPath: () => null},
    '../native/g2-video-library': {ensureG2VideoDirectory() {}, listG2Videos: () => files, listG2ConversionSources: () => files, listG2Folders: () => [],
      resolveG2H264Path: () => session.path, g2VideoMetadataPath: path => path + '.json'},
    '../native/video-converter': {convertVideo: (...args) => calls.push(['convert', ...args]), cancelVideoConversion() {}, videoConversionState: () => ({running: false, stage: 'idle', progress: 0})},
    '../apps/video': {openPhoneVideo: async path => calls.push(['play', path])},
    '../apps/video/video-session': {activeVideoSession: () => session, observeVideoSession: () => () => calls.push(['unsub-video'])},
    '../apps/video/video-settings': {videoRadioSetting: settings('radio'), videoScaleSetting: settings('scale'), videoDitherSetting: settings('dither'), videoBlackFloorSetting: settings('floor'), videoDeblockingSetting: settings('deblock'), videoConversionRateSetting: settings('rate'),videoConversionFrameSetting: settings('frame'),
      videoConversionContrastSetting: settings('contrast'), videoConversionKeyframesSetting: settings('keyframes'), videoConversionBitrateSetting: settings('bitrate'),
      videoAudioOffsetSetting: settings('audioOffset'), VIDEO_AUDIO_OFFSETS: Array.from({length: 81}, (_, i) => String(i * 25 - 1000))},
  });
  const module = load(strip ? 'app/phone-ui/video-strip.ts' : 'app/phone-ui/video-view-model.ts');
  return {module, calls, values, player, fixture: strip ? new module.VideoStripViewModel() : new module.VideoViewModel(),
    tick: () => timer?.(), seekTick: () => observer?.(), confirmReplace: value => {replace = value;}};
}

test('Time entry handles seconds and clock forms without accepting invalid or overflowing values', () => {
  const {module} = modelFixture();
  for (const [input, output] of [['90', 90000], ['1:30', 90000], ['1:02:03', 3723000]]) assert.equal(module.parseVideoTime(input), output);
  for (const input of ['', '-1', '1:60', '1:2:3:4', '1.5', '99999999999999999']) assert.throws(() => module.parseVideoTime(input));
  assert.equal(module.formatVideoTime(3723000), '1:02:03');
});
test('Converter rate defaults to 15 and only changes the next conversion setting',()=>{
  const f=modelFixture();
  assert.equal(f.fixture.get('conversionRateIndex'),1);
  for(const [index,rate] of [[0,'10'],[1,'15'],[2,'20'],[3,'24']]){
    f.fixture.onConversionRateChange({object:{selectedIndex:index}});
    assert.equal(f.values.get('rate'),rate);
  }
  f.fixture.onConversionRateChange({object:{selectedIndex:4}});
  assert.equal(f.values.get('rate'),'24');
  assert.ok(f.calls.every(row=>row[0]==='rate'));
});

test('Frame selector offers the 320-wide canvases and the full-width mid sizes, orientation left to the converter',()=>{
  const f=modelFixture();
  assert.equal(f.fixture.get('conversionFrameIndex'),1);
  const frames=['320x192','320x176','384x216','448x252','480x270','512x288'];
  for(const [i,frame] of frames.entries()) {
    f.fixture.onConversionFrameChange({object:{selectedIndex:i}});
    assert.equal(f.values.get('frame'),frame);
  }
  f.fixture.onConversionFrameChange({object:{selectedIndex:6}});
  assert.equal(f.values.get('frame'),'512x288');
  assert.ok(f.calls.every(row=>row[0]==='frame'));
  const xml=fs.readFileSync('app/phone-ui/video-page.xml','utf8');
  assert.ok(xml.includes('selectedIndexChanged="{{ onConversionFrameChange }}"'));
});

test('Contrast and keyframes default to Default and the chosen levels go to the next conversion',async()=>{
  const f=modelFixture(); f.fixture.attach();
  assert.equal(f.fixture.get('conversionContrastIndex'),0);
  assert.equal(f.fixture.get('conversionKeyframesIndex'),0);
  for(const [i,contrast] of [[0,'default'],[1,'medium'],[2,'high'],[3,'veryhigh']]) {
    f.fixture.onConversionContrastChange({object:{selectedIndex:i}});
    assert.equal(f.values.get('contrast'),contrast);
  }
  f.fixture.onConversionContrastChange({object:{selectedIndex:4}});
  assert.equal(f.values.get('contrast'),'veryhigh');
  for(const [i,keyframes] of [[0,'default'],[1,'large']]) {
    f.fixture.onConversionKeyframesChange({object:{selectedIndex:i}});
    assert.equal(f.values.get('keyframes'),keyframes);
  }
  f.fixture.onConversionKeyframesChange({object:{selectedIndex:2}});
  assert.equal(f.values.get('keyframes'),'large');
  f.confirmReplace(true);
  f.fixture.get('sources')[0].convert(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.find(row=>row[0]==='convert'),['convert','/Download/G2/movie.mp4',false,true,15,'320x176','veryhigh','large','110']);
  const xml=fs.readFileSync('app/phone-ui/video-page.xml','utf8');
  assert.ok(xml.includes('selectedIndexChanged="{{ onConversionContrastChange }}"') && xml.includes('title="Very high"'));
  assert.ok(xml.includes('selectedIndexChanged="{{ onConversionKeyframesChange }}"'));
  f.fixture.dispose();
});

test('Bitrate defaults to 110 and is applied only to the next conversion', async () => {
  const f=modelFixture();
  assert.equal(f.fixture.get('conversionBitrateIndex'),0);
  for(const [index,rate] of ['110','150','200','250','300','400'].entries()) {
    f.fixture.onConversionBitrateChange({object:{selectedIndex:index}});
    assert.equal(f.values.get('bitrate'),rate);
  }
  f.fixture.onConversionBitrateChange({object:{selectedIndex:99}});
  assert.equal(f.values.get('bitrate'),'400');
  assert.ok(f.calls.every(row=>row[0]==='bitrate'));
  f.fixture.onConversionBitrateChange({object:{selectedIndex:6}});
  assert.equal(f.values.get('bitrate'),'auto');
  f.confirmReplace(true);
  f.fixture.get('sources')[0].convert(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.find(row=>row[0]==='convert').at(-1),'auto');
  const xml=fs.readFileSync('app/phone-ui/video-page.xml','utf8');
  assert.ok(xml.includes('selectedIndexChanged="{{ onConversionBitrateChange }}"'));
  const panel=xml.slice(xml.indexOf('<TabViewItem title="Convert">'));
  assert.ok(panel.includes('<ScrollView class="p-8"><StackLayout>'));
  assert.ok(panel.includes('<Repeater items="{{ sources }}">') && panel.includes('tap="{{ action }}"'));
});

test('Audio timing moves 25 ms per tap, stops at both ends and sends no player command', () => {
  const f = modelFixture(); f.fixture.attach();
  assert.equal(f.fixture.get('canAudioEarlier'), true);
  f.fixture.onAudioEarlierTap(); assert.equal(f.values.get('audioOffset'), '25');
  for (let i = 0; i < 50; i++) f.fixture.onAudioLaterTap();
  assert.equal(f.values.get('audioOffset'), '-1000'); assert.equal(f.fixture.get('canAudioLater'), false);
  for (let i = 0; i < 90; i++) f.fixture.onAudioEarlierTap();
  assert.equal(f.values.get('audioOffset'), '1000'); assert.equal(f.fixture.get('canAudioEarlier'), false);
  assert.ok(f.calls.every(row => row[0] === 'audioOffset' || row[0].startsWith('unsub')));
  const xml = fs.readFileSync('app/phone-ui/video-page.xml', 'utf8');
  assert.ok(xml.includes('tap="{{ onAudioEarlierTap }}"') && xml.includes('tap="{{ onAudioLaterTap }}"'));
  f.fixture.dispose();
});

test('Dither remains On/Off with an independent four-choice default-one floor for next START',()=>{
  const f=modelFixture();
  assert.equal(f.fixture.get('blackFloorIndex'),3);
  for (const [i,value] of ['0','0.25','0.5','1'].entries()) {
    f.fixture.onBlackFloorChange({object:{selectedIndex:i}});
    assert.equal(f.values.get('floor'),value);
  }
  f.fixture.onBlackFloorChange({object:{selectedIndex:4}});
  f.fixture.onDitherChange({object:{checked:true}});
  assert.ok(f.calls.every(row=>['floor','dither'].includes(row[0])));
  const xml=fs.readFileSync('app/phone-ui/video-page.xml','utf8');
  assert.ok(xml.includes('checkedChange="{{ onDitherChange }}"'));
  assert.ok(xml.includes('onBlackFloorChange') && !xml.includes('Half-step'));
});

test('Radio/dither settings issue no current-generation command and remote controls use one engine', async () => {
  const f = modelFixture(); f.fixture.attach();
  f.fixture.onRadioChange({object: {selectedIndex: 0}}); f.fixture.onDitherChange({object: {checked: true}});
  assert.deepEqual(f.calls.filter(row => !row[0].startsWith('unsub')), [['radio', 'off'], ['dither', true]]);
  f.fixture.onToggleTap(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(row => row[0] === 'pause' && row[1] === true));
  f.fixture.onStopTap(); assert.ok(f.calls.some(row => row[0] === 'stop'));
  f.fixture.dispose(); assert.ok(f.calls.some(row => row[0] === 'clear-interval'));
});

test('Programmatic slider updates do not seek and library refresh does not recreate unchanged rows', async () => {
  const f = modelFixture(); f.fixture.attach();
  const rows = f.fixture.get('videos'); f.tick(); assert.equal(f.fixture.get('videos'), rows);
  f.fixture.onSeekChange({value: 1234}); f.seekTick(); assert.ok(!f.calls.some(row => row[0] === 'seek'));
  f.fixture.set('position', 5000); // NativeScript may update a two-way binding before valueChange.
  f.fixture.onSeekChange({value: 5000}); f.seekTick(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(row => row[0] === 'seek' && row[1] === 5000));
  f.fixture.dispose();
});

test('Remote and strip retain drag target/label across refresh, debounce release and restore playback tracking', async () => {
  for (const strip of [false, true]) {
    const f = modelFixture(strip); f.fixture.attach();
    f.fixture.onSeekTouch({action: 'down'});
    f.fixture.onSeekChange({value: 5000});
    f.player.view.position = 2000; f.tick();
    assert.equal(f.fixture.get('position'), 5000);
    assert.equal(f.fixture.get('timeLabel'), '0:05 / 0:20');
    f.seekTick(); assert.ok(!f.calls.some(row => row[0] === 'seek'));
    f.fixture.onSeekChange({value: 6000}); f.fixture.onSeekTouch({action: 'up'});
    f.tick(); assert.equal(f.fixture.get('position'), 6000);
    assert.equal(f.fixture.get('timeLabel'), '0:06 / 0:20');
    f.seekTick(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.filter(row => row[0] === 'seek'), [['seek', 6000]]);
    f.player.view.position = 6200; f.tick(); assert.equal(f.fixture.get('position'), 6200);
    f.fixture.onSeekTouch({action: 'down'}); f.fixture.onSeekChange({value: 9000});
    f.fixture.onSeekTouch({action: 'cancel'}); f.tick();
    assert.equal(f.fixture.get('position'), 6200);
    f.fixture.dispose();
  }
});

test('Programmatic selected settings do not resubmit controls or settings writes', () => {
  const f = modelFixture();
  f.fixture.onScaleChange({object: {selectedIndex: 0}});
  f.fixture.onRadioChange({object: {selectedIndex: 1}});
  f.fixture.onDitherChange({object: {checked: false}});
  assert.equal(f.calls.length, 0);
});

test('Files retains its own player while the separate Video routes keep required controls', () => {
  const xml = fs.readFileSync('app/phone-ui/video-page.xml', 'utf8');
  for (const action of ['onToggleTap', 'onStopTap', 'onBack30Tap', 'onBack10Tap', 'onForward10Tap', 'onForward30Tap', 'onTimeTap', 'onScaleChange']) assert.ok(xml.includes(action));
  assert.ok(xml.includes('title="Library"') && xml.includes('title="Remote"') && xml.includes('title="Convert"'));
  const app = fs.readFileSync('app/apps/video/index.ts', 'utf8');
  assert.ok(app.includes('rootPath: g2VideoDirectoryPath()'));
  assert.ok(!app.includes('../files/video-window'));
  assert.ok(fs.readFileSync('app/apps/files/index.ts', 'utf8').includes('createFilesAppWindow'));
});
