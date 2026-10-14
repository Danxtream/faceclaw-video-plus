const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoProtocol, VIDEO, parseVideoStatus, videoU32 } = require('../.test-build/app/apps/video/video-protocol');

function status() {
  const raw = new Uint8Array(192);
  raw.set([1, 7, 0, 2]);
  raw.set([0, 16, 0, 0, 246, 15, 0, 0, 64, 1, 192, 0, 1, 2, 1, 1, 4, 6, 4, 4], 32);
  return raw;
}

test('Video status rejects wrong geometry, slots, credits and incoherent counts', () => {
  assert.equal(parseVideoStatus(status()).capacity, 4);
  for (const offset of [32, 36, 40, 42, 44, 45, 48, 50]) {
    const raw = status(); raw[offset] = 99;
    assert.throws(() => parseVideoStatus(raw));
  }
  const raw = status(); raw[60] = 1;
  assert.throws(() => parseVideoStatus(raw), /counts/);
  assert.throws(() => videoU32(new Uint8Array(3), 0), /Truncated/);
});

test('NAL windows preserve complete NAL identity rather than guessing pictures', async () => {
  let sent;
  const protocol = new VideoProtocol({ epoch: () => 1, sendWindow: async records => {
    sent = records; return records.map(() => 3);
  } }, () => 1);
  const nal = Uint8Array.of(0x67, 1, 2);
  await protocol.sendNals(300, 12, [nal, Uint8Array.of(0x68, 9)]);
  assert.equal(videoU32(sent[0], 2), 300);
  assert.equal(videoU32(sent[0], 6), 12);
  assert.equal(videoU32(sent[1], 6), 13);
  assert.deepEqual(Array.from(sent[0].slice(10)), Array.from(nal));
  await assert.rejects(protocol.sendNals(300, 0, [new Uint8Array(4087)]), /limit/);
  await assert.rejects(protocol.sendNals(300, 0, Array(5).fill(nal)), /window/);
});

test('Paired refusal and connection generation changes never continue references', async () => {
  let epoch = 1;
  const backend = { epoch: () => epoch, sendWindow: async () => [1] };
  const protocol = new VideoProtocol(backend, () => 1);
  await assert.rejects(protocol.sendNals(1, 0, [Uint8Array.of(5)]), /refused/);
  epoch = 2;
  await assert.rejects(protocol.sendNals(1, 0, [Uint8Array.of(1)]), /generation/);
});

test('START keeps fixed cadence, dither generation and bounded preroll', async () => {
  let sent;
  const protocol = new VideoProtocol({ epoch: () => 1, exchange: async raw => {
    sent = raw; return [status().slice(0, 128), status().slice(0, 128)];
  } }, () => 10);
  await protocol.start(4, true, true, false, 9, true);
  assert.equal(sent[18], 1 | 2 | 4 | 8 | 16 | 32);
  assert.equal(sent[19], 9);
  assert.equal(videoU32(sent, 20), 63);
  await assert.rejects(protocol.start(4, false, false, true, 256), /preroll/);
});

test('Queries require both lenses and durable nonwrapping request IDs', async () => {
  const protocol = new VideoProtocol({ epoch: () => 1, exchange: async () => [status()] }, () => 1);
  await assert.rejects(protocol.status(), /Missing lens/);
  const exhausted = new VideoProtocol({ epoch: () => 1 }, () => 0xffffffff);
  await assert.rejects(exhausted.status(VIDEO.caps), /exhausted/);
});

test('A durable reservation finishes before sending and epoch changes during it refuse the query', async () => {
  let release, epoch = 1, sent = 0;
  const protocol = new VideoProtocol({epoch: () => epoch, exchange: async () => {sent++; return [status(), status()];}},
    () => new Promise(resolve => release = resolve));
  const pending = protocol.status();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 0); epoch++; release(100);
  await assert.rejects(pending, /generation/); assert.equal(sent, 0);
});
