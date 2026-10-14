const test = require('node:test');
const assert = require('node:assert/strict');
const {loader} = require('./helpers/load-typescript.cjs');

test('Video settings retain old scale/radio keys with new defaults and generation-only policy', () => {
  const saved = new Map();
  class Enum {
    constructor(options) {this.options = options;}
    get() {const o = this.options, value = saved.get(o.storageKey); return o.normalize ? o.normalize(value) ?? o.defaultValue : o.values.includes(value) ? value : o.defaultValue;}
    set(value) {saved.set(this.options.storageKey, value);}
  }
  class Bool {constructor(options) {this.options = options;} get() {return saved.get(this.options.storageKey) ?? this.options.defaultValue;}}
  const load = loader({}, {'../../ui/dashboard-settings': {ConfigSettingEnum: Enum, ConfigSettingBoolean: Bool,
    enumSettingMenuItem: setting => ({label: setting.options.label}), toggleSettingMenuItem: setting => ({label: setting.options.label})}});
  const settings = load('app/apps/video/video-settings.ts');
  assert.deepEqual({...settings.configuredVideoOptions()}, {native: true, dither: false, radio: true});
  saved.set('video.blePhy', '1m'); assert.equal(settings.configuredVideoOptions().radio, false);
  saved.set('video.blePhy', '2m'); assert.equal(settings.configuredVideoOptions().radio, true);
  saved.set('video.blePhy', 'broken'); assert.equal(settings.configuredVideoOptions().radio, true);
  saved.set('video.scale', '2x'); assert.equal(settings.configuredVideoOptions().native, false);
  assert.equal(settings.videoDeblockingSetting.get(), false);
  assert.deepEqual(Array.from(settings.videoSettingsMenuItems(), item => item.label), ['Video size', '2M radio', 'Dithering', 'Deblocking filter']);
});

test('Library de-duplicates paired movies, retains silent streams and keeps one resume key', () => {
  const entries = ['movie.mp4', 'movie.h264', 'silent.264', 'unconverted.mp4', 'movie.g2.json'].map(name => ({name, path: '/Download/G2/' + name, isDirectory: false}));
  const settings = new Map();
  const load = loader({}, {'./file-access': {externalStorageRootPath: () => '', listDirectory: () => entries,
    statPath: path => entries.find(row => row.path === path) ?? null},
    './settings-store': {getStringSetting: (key, fallback) => settings.get(key) ?? fallback, setStringSetting: (key, value) => settings.set(key, value)}});
  const library = load('app/native/g2-video-library.ts');
  assert.deepEqual(Array.from(library.listG2Videos(), entry => entry.name), ['movie.mp4', 'silent.264']);
  assert.deepEqual(Array.from(library.listG2ConversionSources(), entry => entry.name), ['movie.mp4', 'unconverted.mp4']);
  assert.equal(library.resolveG2H264Path('/Download/G2/movie.mp4'), '/Download/G2/movie.h264');
  assert.equal(library.resumePositionFor('first'), 0);
  library.saveVideoResumeState('first', 1234.5); assert.equal(library.resumePositionFor('first'), 1235);
  library.saveVideoResumeState('second', 900); assert.equal(library.resumePositionFor('first'), 0);
  assert.deepEqual([...settings.keys()], ['video.resumeState.v1']);
  settings.set('video.resumeState.v1', 'broken'); assert.equal(library.loadVideoResumeState(), null);
  assert.throws(() => library.saveVideoResumeState('second', NaN));
});
