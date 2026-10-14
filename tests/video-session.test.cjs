const test = require('node:test');
const assert = require('node:assert/strict');
const {loader} = require('./helpers/load-typescript.cjs');

test('Session opens audited media before one supplied transport and counts only shown copies', async () => {
  const events = []; let finish, publish, epoch = 10, ready = true;
  const source = {clip: {source: {name: 'clip.mp4'}}, close: () => events.push('source-close')};
  const audio = {close: async () => events.push('audio-close')};
  const load = loader({com: {faceclaw: {app: {
    FaceclawBleCommunicator: {getActive: () => ({isSessionReady: () => ready, getVideoTransport: () => ({getEpoch: () => epoch}),
      finishVideoDisplay: () => events.push('cache-resume')})},
    FaceclawBleManager: {recordDisplayFrameSent: () => events.push('copy')},
  }}}}, {
    '../../native/file-access': {statPath: () => ({isDirectory: false})},
    '../../native/g2-video-library': {saveVideoResumeState() {}},
    '../../native/video-source': {openVideoSource: async () => {events.push('source'); return source;}},
    '../../native/video-audio': {openVideoAudio: async () => {events.push('audio'); return audio;}},
    '../../native/video-transport': {createVideoProtocol: () => {events.push('protocol'); return {}; }},
    './video-playback': {VideoPlayback: class {
      constructor(protocol, s, a, options, changed, count) { publish = changed; this.count = count; assert.equal(s, source); assert.equal(a, audio); }
      async run() {events.push('run'); publish({active: true, cleanupFailed: false}); this.count(3); await new Promise(resolve => finish = resolve); publish({active: false, cleanupFailed: false});}
      stop() {events.push('stop'); finish();}
    }},
  });
  const {VideoSession, activeVideoSession, observeVideoSession} = load('app/apps/video/video-session.ts');
  let changes = 0;
  const remove = observeVideoSession(() => changes++);
  const session = new VideoSession('clip.h264', () => ({}));
  const running = session.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 4), ['source', 'audio', 'protocol', 'run']);
  assert.equal(events.filter(e => e === 'copy').length, 3);
  assert.equal(session.ownsDisplay, true);
  assert.equal(activeVideoSession(), session);
  await assert.rejects(new VideoSession('other.h264', () => ({})).run(), /owns/);
  await assert.rejects(session.run(), /single use/);
  session.stop(); await running;
  assert.equal(events.at(-1), 'cache-resume');
  assert.equal(session.ownsDisplay, false);
  assert.ok(changes >= 3);
  remove(); epoch++; assert.equal(activeVideoSession(), null);
});

test('Cancellation during source audit does not prepare audio or create transport', async () => {
  let resolve, closed = 0;
  const load = loader({}, {
    '../../native/file-access': {}, '../../native/g2-video-library': {},
    '../../native/video-source': {openVideoSource: () => new Promise(done => resolve = done)},
    '../../native/video-audio': {openVideoAudio: () => {throw new Error('must not prepare');}},
    '../../native/video-transport': {createVideoProtocol: () => {throw new Error('must not send');}},
    './video-playback': {},
  });
  const {VideoSession} = load('app/apps/video/video-session.ts');
  const session = new VideoSession('clip.h264', () => ({})), running = session.run();
  session.stop(); resolve({close: () => closed++}); await running;
  assert.equal(closed, 1); assert.equal(session.opening, false); assert.equal(session.ownsDisplay, false);
});

test('Cancelled native media preparation cleans resources without a session error', async () => {
  let reject;
  const load = loader({}, {
    '../../native/file-access': {}, '../../native/g2-video-library': {},
    '../../native/video-source': {openVideoSource: () => new Promise((_, fail) => reject = fail)},
    '../../native/video-audio': {}, '../../native/video-transport': {}, './video-playback': {},
  });
  const {VideoSession} = load('app/apps/video/video-session.ts');
  const session = new VideoSession('clip.h264', () => ({})), running = session.run();
  session.stop(); reject(new Error('Video source closed')); await running;
  assert.equal(session.error, null); assert.equal(session.opening, false);
  assert.equal(session.ownsDisplay, false);
});

test('Failed media preparation closes the source and creates no BLE writer', async () => {
  let closed = 0;
  const load = loader({}, {
    '../../native/file-access': {statPath: () => ({isDirectory: false})}, '../../native/g2-video-library': {},
    '../../native/video-source': {openVideoSource: async () => ({clip: {source: {name: 'clip.mp4'}}, close: () => closed++})},
    '../../native/video-audio': {openVideoAudio: async () => {throw new Error('MP4 mismatch');}},
    '../../native/video-transport': {createVideoProtocol: () => {throw new Error('must not send');}},
    './video-playback': {},
  });
  const {VideoSession} = load('app/apps/video/video-session.ts');
  const session = new VideoSession('clip.h264', () => ({}));
  await assert.rejects(session.run(), /mismatch/);
  assert.equal(closed, 1); assert.equal(session.error, 'Error: MP4 mismatch');
});

test('Forwarded gestures enqueue the real menu vocabulary without drawing a second menu', async () => {
  const calls = [], view = {active: true, paused: false, menuOpen: false};
  const player = {view, pause: async value => calls.push(['pause', value]), menu: async value => calls.push(['menu', value])};
  const load = loader({}, {
    '../../graphics/image': {}, '../../graphics/ui-fonts': {}, '../../graphics/textwrap': {},
    './video-session': {VideoSession: class {constructor() {this.engine = player;} run() {return Promise.resolve();} stop() {calls.push(['stop']);}},
      observeVideoSession: () => () => calls.push(['unsubscribe'])},
  });
  const {VideoPlaybackLayer} = load('app/apps/video/video-playback-layer.ts');
  const layer = new VideoPlaybackLayer('clip.h264', () => {});
  const ctx = {stack: {pop: () => calls.push(['pop'])}, actions: {requestRender() {}}};
  layer.handleInput({type: 'click'}, ctx);
  view.paused = view.menuOpen = true;
  layer.handleInput({type: 'scroll-down'}, ctx); layer.handleInput({type: 'scroll-up'}, ctx); layer.handleInput({type: 'click'}, ctx);
  layer.handleInput({type: 'double-click'}, ctx); layer.onRemoved();
  assert.deepEqual(calls, [['pause', true], ['menu', 'next'], ['menu', 'previous'], ['menu', 'apply'], ['stop'], ['pop'], ['stop'], ['unsubscribe']]);
});

test('In-process render suppression preserves input and resumes ordinary output afterwards', async () => {
  let suppressed = true, painted = 0, submitted = 0, inputs = 0;
  const finishes = [];
  class Stack {async handleInput() {inputs++;} paint() {painted++; return [];} clearToBase() {} }
  const load = loader({}, {
    '../../graphics/image': {}, '../../native/frame-timings': {startFrame: () => 1, finishFrame: (_, why) => finishes.push(why),
      annotateFrame() {}, span: (_, __, fn) => fn(), runWithFrame: (_, fn) => fn(), spanAsync: (_, __, fn) => fn()},
    '../../util/render-freshness': {beginRenderPass() {}, endRenderPass: () => false},
    '../layers': {LayerStack: Stack}, '../window-menu': {}, './chrome-layer': {windowIcon: () => () => null},
    './geometry': {appViewportSize: () => ({width: 576, height: 288})}, './shell': {shell: {isWindowFocused: () => true}},
  });
  const {createInProcessWindow} = load('app/ui/shell/in-process-window.ts');
  const app = createInProcessWindow({appId: 'test', windowId: 'test', title: 'test', closeable: true, actions: {}, baseLayer: {},
    shouldSuppressRender: () => suppressed, keepsScreenOn: () => suppressed,
    submitFrame: async () => submitted++, setSurfaceVisible() {}});
  await app.window.handleInput({type: 'click'}, 1);
  assert.equal(inputs, 1); assert.equal(painted, 0); assert.equal(submitted, 0);
  assert.equal(app.window.keepsScreenOn(), true);
  assert.ok(finishes[0].includes('native video'));
  suppressed = false; await app.window.handleInput({type: 'click'}, 2);
  assert.equal(painted, 1); assert.equal(submitted, 1); assert.equal(inputs, 2);
});
