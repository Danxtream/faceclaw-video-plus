const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {loader} = require('./helpers/load-typescript.cjs');

function modelFixture(strip = false) {
  const calls = [], values = new Map(); let timer, observer;
  const settings = key => ({get: () => values.get(key) ?? (key === 'radio' ? 'video' : key === 'scale' ? 'native' : key === 'rate' ? '15' : key === 'height' ? '176' : key === 'floor' ? '1' : false),
    set: value => {values.set(key, value); calls.push([key, value]);}, displayValue: () => values.get(key) === 'off' ? 'Off' : 'Video-only'});
  const player = {view: {active: true, paused: false, position: 1234, duration: 20000},
    pause: async value => calls.push(['pause', value]), seek: async value => calls.push(['seek', value]),
    scale: async value => calls.push(['scale-command', value])};
  const session = {path: '/Download/G2/movie.h264', engine: player, view: player.view, hasAudio: true, stop: () => calls.push(['stop'])};
  const files = [{name: 'movie.mp4', path: '/Download/G2/movie.mp4', isDirectory: false, modifiedMs: 10, sizeBytes: 100}];
  class Observable {constructor() {this.values = new Map();} get(key) {return this.values.get(key);} set(key, value) {this.values.set(key, value);} }
  const load = loader({setInterval: callback => {timer = callback; return 1;}, clearInterval: () => calls.push(['clear-interval']),
    setTimeout: callback => {observer = callback; return 1;}, clearTimeout: () => calls.push(['clear-timeout'])}, {
    '@nativescript/core': {Observable, Dialogs: {confirm: async () => false}, Frame: {topmost: () => ({goBack() {}})}},
    '../g2/dashboard-controller': {dashboardController: {subscribe: callback => {callback({phase: 'connected'}); return () => calls.push(['unsub']);}, openVideoWindow: async () => calls.push(['window'])}},
    '../native/file-access': {hasAllFilesAccess: () => true, requestAllFilesAccess() {}, statPath: () => null},
    '../native/g2-video-library': {ensureG2VideoDirectory() {}, listG2Videos: () => files, listG2ConversionSources: () => files,
      resolveG2H264Path: () => session.path, g2VideoMetadataPath: path => path + '.json'},
    '../native/video-converter': {convertVideo: (...args) => calls.push(['convert', ...args]), cancelVideoConversion() {}, videoConversionState: () => ({running: false, stage: 'idle', progress: 0})},
    '../apps/video': {openPhoneVideo: async path => calls.push(['play', path])},
    '../apps/video/video-session': {activeVideoSession: () => session, observeVideoSession: () => () => calls.push(['unsub-video'])},
    '../apps/video/video-settings': {videoRadioSetting: settings('radio'), videoScaleSetting: settings('scale'), videoDitherSetting: settings('dither'), videoBlackFloorSetting: settings('floor'), videoDeblockingSetting: settings('deblock'), videoConversionRateSetting: settings('rate'),videoConversionHeightSetting: settings('height')},
  });
  const module = load(strip ? 'app/phone-ui/video-strip.ts' : 'app/phone-ui/video-view-model.ts');
  return {module, calls, values, player, fixture: strip ? new module.VideoStripViewModel() : new module.VideoViewModel(),
    tick: () => timer?.(), seekTick: () => observer?.()};
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
  for(const [index,rate] of [[0,'10'],[1,'15'],[2,'20']]){
    f.fixture.onConversionRateChange({object:{selectedIndex:index}});
    assert.equal(f.values.get('rate'),rate);
  }
  f.fixture.onConversionRateChange({object:{selectedIndex:3}});
  assert.equal(f.values.get('rate'),'20');
  assert.ok(f.calls.every(row=>row[0]==='rate'));
});

test('Canvas selector has only 192 and 176 with automatic orientation left to the converter',()=>{
  const f=modelFixture();
  assert.equal(f.fixture.get('conversionHeightIndex'),1);
  for(const [i,height] of [[0,'192'],[1,'176']]) {
    f.fixture.onConversionHeightChange({object:{selectedIndex:i}});
    assert.equal(f.values.get('height'),height);
  }
  f.fixture.onConversionHeightChange({object:{selectedIndex:2}});
  assert.equal(f.values.get('height'),'176');
  assert.ok(f.calls.every(row=>row[0]==='height'));
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
