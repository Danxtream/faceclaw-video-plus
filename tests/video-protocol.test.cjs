const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoProtocol, VideoReportUnavailable, VIDEO, parseVideoStatus, videoU32 } = require('../.test-build/app/apps/video/video-protocol');

test('Confirmation room requires both base capabilities and adds only the queue-size query', async () => {
  for (const [sides, deep] of [[[0,0],true],[[128,0],true],[[128,128],true],[[128,128],false]]) {
    let calls=0, plan;
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length)=>{
      calls++;
      if (raw[1]===7) {
        // Firmware with a deeper queue echoes subtype 11; older firmware sends its generic status.
        assert.equal(raw[8],11); assert.equal(length,128);
        return [1,2].map(side=>{const row=deep ? new Uint8Array(128) : status().slice(0,128);
          if (deep) row.set([1,7,0,11,4,side===1 ? 12 : 13,12,side]); return row;});
      }
      return raw[1]===13 ? [1,2].map(()=>Uint8Array.from([1,13,0,255,194,7,255,255,...Array(8).fill(0)])) :
        sides.map(bit=>{const row=status().slice(0,length);row[71]=bit;return row;});
    },createUploadPump:(_,value)=>{plan=value;}},()=>calls+1);
    await p.capabilities(); p.createUploadPump({},{});
    const room=sides.every(x=>x===128);
    assert.equal(calls,room ? 3 : 2); assert.equal(plan.confirmationRoom,room);
    assert.equal(plan.queueCapacity,room && deep ? 12 : 6); assert.equal(p.queueCapacity,plan.queueCapacity);
  }
});

test('Independent metadata room accepts six but never seven on either send path', async () => {
  let room = 6;
  const rows = () => [1, 2].map(() => Uint8Array.from([2, 0, 0, 0, room, 0]));
  const protocol = new VideoProtocol({epoch: () => 1, exchange: async () => rows(), sendPicture: async () => rows()}, () => 10);
  for (room of [0, 4, 5, 6]) {
    assert.equal(await protocol.metadata(1, 2, 3, 67), true);
    assert.equal(await protocol.sendNalsWithMetadata(1, 2, Uint8Array.of(0x65), {ordinal: 2, nal: 3, pts: 67}), true);
  }
  room = 7;
  await assert.rejects(protocol.metadata(1, 2, 3, 67), /metadata refused/);
  await assert.rejects(protocol.sendNalsWithMetadata(1, 2, Uint8Array.of(0x65), {ordinal: 2, nal: 3, pts: 67}), /metadata refused/);
});

test('Timeline and START carry each supported rate without changing the stream contract',async()=>{
  for(const fps of [10,15,20]) {
    let id=1;const sent=[];
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length)=>{sent.push(raw);return [status().slice(0,length),status().slice(0,length)];}},()=>id++);
    await p.timeline(1,10000,0,fps);await p.start(1,true,false,false,0,false,3,fps);
    assert.equal(sent[0][20],fps);assert.equal(sent[0][22],1);
    assert.equal(videoU32(sent[1],20),Math.ceil(1000/fps));
  }
});

test('Geometry START requires paired capability and carries exact odd picture edges on every lens mask',async()=>{
  for(const depths of [[2,2],[130,2],[130,130]]) {
    let id=1;const sent=[];
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length,targets)=>{
      sent.push(raw.slice());return raw[1]===VIDEO.playbackCaps?
        depths.map(depth=>Uint8Array.from([1,13,0,255,depth,7,255,247,0,0,0,0,0,0,0,0])):
        [status().slice(0,length),status().slice(0,length)].slice(0,targets===3?2:1);
    }},()=>id++);
    await p.capabilities();
    const g={width:320,height:176,picture:{x:3,y:0,width:313,height:176}};
    if(depths.includes(2)) {await assert.rejects(p.start(1,false,false,false,0,false,3,15,g),/Update both lenses/);continue;}
    for (const mask of [1,2,3]) await p.start(1,false,false,false,2,true,mask,15,g);
    const raw=sent.at(-1),v=new DataView(raw.buffer);
    assert.equal(raw.length,32);
    assert.deepEqual([12,14,24,26,28,30].map(i=>v.getUint16(i,true)),[320,176,3,0,313,176]);
    assert.equal(raw[19],2);
    await p.start(2,false,false,false);
    assert.equal(sent.at(-1).length,24);
  }
});

test('Four black floors keep Off and default unchanged and require both lenses for tuned START',async()=>{
  for(const depths of [[130,130],[194,130],[194,194]]) {
    let id=1;const sent=[];
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length,targets)=>{
      sent.push(raw.slice());return raw[1]===VIDEO.playbackCaps?
        depths.map(depth=>Uint8Array.from([1,13,0,255,depth,7,255,247,0,0,0,0,0,0,0,0])):
        [status().slice(0,length),status().slice(0,length)].slice(0,targets===3?2:1);
    }},()=>id++);
    await p.capabilities();
    for (const floor of [1,0,0.25,0.5]) {
      await p.start(1,false,false,false,0,false,3,15,undefined,floor);
      assert.equal(sent.at(-1).length,24);
      if(floor!==1 && depths.includes(130)) {
        await assert.rejects(p.start(1,false,true,false,0,false,3,15,undefined,floor),/Update both lenses.*black floor/);
      } else {
        for(const mask of [1,2,3]) {
          await p.start(1,false,true,false,0,true,mask,15,undefined,floor);
          const raw=sent.at(-1);
          assert.equal(raw.length,floor===1?24:36);
          if(floor!==1) {
            assert.equal(raw[32],[1,0,0.25,0.5].indexOf(floor));
            assert.deepEqual([...raw.slice(24,32)],[0,0,0,0,64,1,192,0]);
            assert.deepEqual([...raw.slice(33)],[0,0,0]);
          }
        }
      }
    }
  }
});

test('New phone refuses the legacy fixed-rate firmware before playback',async()=>{
  let id=1;
  const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,length)=>raw[1]===VIDEO.playbackCaps?
    [1,2].map(()=>Uint8Array.from([1,13,0,255,2,16,255,247,0,0,0,0,0,0,0,0])):[status().slice(0,length),status().slice(0,length)]},()=>id++);
  await assert.rejects(p.capabilities(),/10\/15\/20 fps.*update both lenses/);
});

test('Refused capabilities name each lens with its result, error and state', async () => {
  const left = status(), right = status();
  right[2] = 3; right[3] = 0; left[24] = 16;
  const p = new VideoProtocol({epoch: () => 1, exchange: async (raw, length) => [left.slice(0, length), right.slice(0, length)]}, () => 1);
  await assert.rejects(p.capabilities(), error =>
    /LEFT result=0 error=16 state=2 .*RIGHT result=3 error=0 state=0/.test(error.message));
});

test('An idle lens keeps its last stream error, which no longer blocks the next playback', async () => {
  const idle = status(); idle[3] = 0; idle[24] = 16; // POWER after the app closed mid-stream
  const p = new VideoProtocol({epoch: () => 1, exchange: async (raw, length) => raw[1] === VIDEO.playbackCaps ?
    [1, 2].map(() => Uint8Array.from([1, 13, 0, 255, 2, 7, 255, 247, 0, 0, 0, 0, 0, 0, 0, 0])) :
    [idle.slice(0, length), idle.slice(0, length)]}, () => 1);
  await p.capabilities();
  const live = status(); live[24] = 16;                // the same error on a live owner still refuses
  const q = new VideoProtocol({epoch: () => 1, exchange: async (raw, length) => [live.slice(0, length), live.slice(0, length)]}, () => 1);
  await assert.rejects(q.capabilities(), /refused \(LEFT result=0 error=16 state=2/);
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
  for (const flags of [23, 55, 119, 247, 255, 150]) {
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
    assert.equal(protocol.slices, !!(flags & 8));
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

test('PACE carries stream, both owner tokens, the picture and each lens tick, and needs both tokens', async () => {
  let id = 40; const sent = [];
  const protocol = new VideoProtocol({epoch: () => 1, exchange: async (raw, length, targets) => {
    sent.push({raw, length, targets});
    return [1, 2].map(() => { const row = new Uint8Array(length); row.set([1, VIDEO.pace, 0]); return row; });
  }}, () => id++);
  const rows = await protocol.pace(9, [101, 102], 25, [7, 0xffffffff]);
  assert.equal(rows.length, 2);
  const {raw, length, targets} = sent[0];
  assert.equal(raw.length, 32); assert.equal(raw[1], 25); assert.equal(length, 36); assert.equal(targets, 3);
  assert.deepEqual([8, 12, 16, 20, 24, 28].map((offset) => videoU32(raw, offset)), [9, 101, 102, 25, 7, 0xffffffff]);
  await assert.rejects(protocol.pace(9, [101, 0], 25, [7, 8]), /token/);
  await assert.rejects(protocol.pace(9, [101, 102], 25, [7]), /token/);
});
