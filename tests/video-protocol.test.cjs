const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoProtocol, VideoReportUnavailable, VIDEO, parseVideoStatus, videoU32 } = require('../.test-build/app/apps/video/video-protocol');

test('Timeline and START carry each supported rate without changing the stream contract',async()=>{
  for(const fps of [10,15,20]) {
    let id=1;const sent=[];
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length)=>{sent.push(raw);return [status().slice(0,length),status().slice(0,length)];}},()=>id++);
    await p.timeline(1,10000,0,fps);await p.start(1,true,false,false,0,false,3,fps);
    assert.equal(sent[0][20],fps);assert.equal(sent[0][22],1);
    assert.equal(videoU32(sent[1],20),Math.ceil(1000/fps));
  }
});

test('New phone refuses the legacy fixed-rate firmware before playback',async()=>{
  let id=1;
  const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length)=>raw[1]===VIDEO.playbackCaps?
    [1,2].map(()=>Uint8Array.from([1,13,0,255,2,16,255,247,0,0,0,0,0,0,0,0])):[status().slice(0,length),status().slice(0,length)]},()=>id++);
  await assert.rejects(p.capabilities(),/10\/15\/20 fps.*update both lenses/);
});

test('Read-only queries get exactly one fresh durable ID after unavailable pages', async () => {
  for (const op of [VIDEO.shown, VIDEO.credits, VIDEO.playback]) {
    let id = 40, fail = 1;
    const requests = [];
    const protocol = new VideoProtocol({epoch: () => 1, exchange: async (raw, length) => {
      requests.push(raw.slice());
      if (fail-- > 0) throw new Error('Video query unavailable: Frozen page refused op=' + op);
      return [new Uint8Array(length), new Uint8Array(length)];
    }}, () => id++);
    await protocol.owned(op, 12, [101, 102], 6);
    assert.deepEqual(requests.map(raw => videoU32(raw, 4)), [40, 41]);
    assert.deepEqual(requests[0].slice(8), requests[1].slice(8));
    fail = 2;
    await assert.rejects(protocol.owned(op, 12, [101, 102], 6), VideoReportUnavailable);
    assert.equal(requests.length, 4);
  }
});

test('Missing reports cannot hide malformed replies, changed epochs or retry controls', async () => {
  for (const op of [VIDEO.start, VIDEO.stop, VIDEO.pause, VIDEO.menu, VIDEO.metadata]) {
    let calls = 0;
    const protocol = new VideoProtocol({epoch: () => 1, exchange: async () => {
      calls++; throw new Error('Video query unavailable: Frozen page refused');
    }}, () => 1);
    await assert.rejects(protocol.owned(op, 12, [101, 102], 6), /unavailable/);
    assert.equal(calls, 1);
  }
  for (const mode of ['epoch', 'malformed', 'owner']) {
    let epoch = 1, calls = 0;
    const protocol = new VideoProtocol({epoch: () => epoch, exchange: async () => {
      calls++;
      if (mode === 'epoch') { epoch++; throw new Error('Video query unavailable: timeout'); }
      if (mode === 'owner') throw new Error('Video owner credit window failed');
      return [];
    }}, () => 1);
    await assert.rejects(protocol.owned(VIDEO.credits, 12, [101, 102], 6), error => !(error instanceof VideoReportUnavailable));
    assert.equal(calls, 1);
  }
});

function status() {
  const raw = new Uint8Array(192);
  raw.set([1, 7, 0, 2]);
  raw.set([0, 16, 0, 0, 246, 15, 0, 0, 64, 1, 192, 0, 1, 2, 1, 1, 4, 6, 4, 4], 32);
  return raw;
}

test('Paired capability gates refusal evidence and raw read-only clock logging', async () => {
  for (const flags of [23, 55, 119, 247, 150]) {
    let id = 100, configured = null, clocks = 0;
    const output = [], original = console.error;
    const protocol = new VideoProtocol({epoch: () => 1, configureEvidence: value => configured = value,
      exchange: async (raw, length) => {
        if (raw[1] === VIDEO.caps) return [status().slice(0, 128), status().slice(0, 128)];
        if (raw[1] === VIDEO.playbackCaps) return [1, 2].map(() => Uint8Array.from([1,13,0,255,2,7,255,flags,0,0,0,0,0,0,0,0]));
        assert.equal(raw[1], 7); assert.equal(raw[8], 5); assert.equal(raw[9], 1); clocks++;
        return [1, 2].map(side => {
          const row = new Uint8Array(length); row.set([1,7,0,5,1,1,side,7]);
          const view = new DataView(row.buffer);
          view.setUint32(16, 100, true); view.setUint32(20, 0xff000000, true);
          view.setUint32(28, 400, true); view.setUint32(32, (0xff000000 + 75000000) >>> 0, true);
          view.setUint32(24, 100, true); view.setUint32(36, 400, true);
          view.setUint32(72, 1, true);
          return row;
        });
      }}, () => id++);
    if (flags === 150) { await assert.rejects(protocol.capabilities(), /10\/15\/20 fps/); continue; }
    try {
      console.error = line => output.push(line);
      await protocol.capabilities(); await protocol.clockEvidence(1);
    } finally { console.error = original; }
    assert.equal(configured, !!(flags & 32)); assert.equal(clocks, flags & 32 ? 1 : 0);
    assert.equal(protocol.timedNal, !!(flags & 128));
    if (flags & 32) assert.ok(output.length === 2 && output.every(line => line.includes('cyclesPerMs=250000')));
  }
});

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
  assert.equal(videoU32(sent, 20), 67);
  await assert.rejects(protocol.start(4, false, false, true, 256), /preroll/);
});

test('START retry targets only the refused lens with a fresh request ID', async () => {
  const requests = []; let id = 10;
  const protocol = new VideoProtocol({epoch: () => 1, exchange: async (raw, bytes, targets) => {
    requests.push({raw, targets});
    return Array.from({length: targets === 3 ? 2 : 1}, () => status().slice(0, bytes));
  }}, () => id++);
  for (const targets of [3, 2, 1]) await protocol.start(4, true, true, false, 9, true, targets);
  assert.deepEqual(requests.map(row => row.targets), [3, 2, 1]);
  assert.deepEqual(requests.map(row => videoU32(row.raw, 4)), [10, 11, 12]);
  assert.ok(requests.every(row => Buffer.from(row.raw.slice(8)).equals(Buffer.from(requests[0].raw.slice(8)))));
  await assert.rejects(protocol.start(4, false, false, true, 0, false, 0), /lens mask/);
});

test('Pipeline keeps each NAL identity, gates following metadata and rejects impossible completions', async () => {
  let records, commands, result = [2, 1], epoch = 1, id = 90;
  const backend = {epoch: () => epoch, sendPipeline: async (nals, following) => {
    records = nals; commands = following; return result;
  }};
  const protocol = new VideoProtocol(backend, () => id++);
  const nals = [Uint8Array.of(0x65), Uint8Array.of(0x61)];
  const next = [{ordinal: 2, nal: 4, pts: 63}, null];
  assert.deepEqual(await protocol.sendPipeline(50, 3, nals, next), [2, 1]);
  assert.deepEqual(records.map(row => videoU32(row, 6)), [3, 4]);
  assert.equal(videoU32(commands[0], 4), 90); assert.equal(commands[1], null);
  result = [1, 0]; assert.deepEqual(await protocol.sendPipeline(50, 3, nals, next), result);
  for (const invalid of [[0, 0], [3, 1], [1, 1], [2, 0], [2, 2], [2, 1, 0]]) {
    result = invalid; await assert.rejects(protocol.sendPipeline(50, 3, nals, next), /completion/);
  }
  backend.sendPipeline = async () => { epoch++; return [2, 1]; };
  await assert.rejects(protocol.sendPipeline(50, 3, nals, next), /generation/);
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

test('Admitted data and future metadata share a bounded window without inventing acceptance', async () => {
  let pair, epoch = 1, busy = false;
  const protocol = new VideoProtocol({epoch: () => epoch, sendPicture: async (data, metadata) => {
    pair = [data, metadata];
    return [1, 2].map(() => {
      const raw = new Uint8Array(6); raw[0] = 2; raw[4] = 2; raw[5] = busy ? 3 : 0; return raw;
    });
  }}, () => 88);
  const next = {ordinal: 2, nal: 4, pts: 63};
  assert.equal(await protocol.sendNalsWithMetadata(50, 3, Uint8Array.of(0x65), next), true);
  assert.equal(videoU32(pair[0], 6), 3); assert.equal(pair[1][1], VIDEO.metadata);
  assert.equal(videoU32(pair[1], 4), 88); assert.equal(videoU32(pair[1], 16), 4);
  busy = true;
  assert.equal(await protocol.sendNalsWithMetadata(50, 3, Uint8Array.of(0x65), next), false);
  epoch++;
  await assert.rejects(protocol.sendNalsWithMetadata(50, 3, Uint8Array.of(0x65), next), /generation/);
});
