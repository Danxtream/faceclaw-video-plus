const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoProtocol, VIDEO} = require('../.test-build/app/apps/video/video-protocol');

function clockRow(side, words = {}) {
  const raw = new Uint8Array(128), view = new DataView(raw.buffer);
  raw.set([1,7,0,5,1,1,side,7]);
  const fields = {8:1, 12:1, 16:100, 20:1000000, 24:100, 28:400, 32:76000000, 36:400,
    40:0xe0000016, 72:1, 76:2, 80:0xe0000016, 84:0xe0000016, ...words};
  for (const [at,value] of Object.entries(fields)) view.setUint32(Number(at),value,true);
  return raw;
}

async function readClocks(rows) {
  let id = 1;
  const output = [], calls = [], original = console.error;
  const protocol = new VideoProtocol({epoch:()=>1, exchange:async(raw,length)=>{
    calls.push(raw.slice());
    if (raw[1] === VIDEO.caps) {
      const status = new Uint8Array(128); status.set([1,7]);
      status.set([0,16,0,0,246,15,0,0,64,1,192,0,1,2,1,1,4,6],32);
      return [status,status];
    }
    if (raw[1] === VIDEO.playbackCaps)
      return [1,2].map(()=>Uint8Array.from([1,13,0,255,2,7,255,55,0,0,0,0,0,0,0,0]));
    assert.equal(raw[1],7); assert.equal(raw[8],5); assert.equal(raw[9],1);
    assert.equal(raw.length,12); assert.equal(length,128);
    return rows;
  }},()=>id++);
  await protocol.capabilities();
  try {
    console.error = line => output.push(line);
    await protocol.clockEvidence(1);
  } finally { console.error = original; }
  assert.equal(calls.length,3); // CAPS, playback CAPS, one paired read; no write or retry.
  return output;
}

test('Clock receiver rejects the logged backwards counter but retains its raw evidence', async () => {
  const raw = clockRow(2,{16:837411,20:23104793,24:837411,28:837684,32:15078018,36:837684});
  const logs = await readClocks([clockRow(1),raw]);
  assert.match(logs[0],/cyclesPerMs=250000 /);
  assert.match(logs[1],/cyclesPerMs=unqualified /);
  assert.match(logs[1],/qualification=counter discontinuity\/implausible delta/);
  assert.ok(logs[1].endsWith('raw='+JSON.stringify(Array.from({length:22},(_,i)=>
    new DataView(raw.buffer).getUint32(8+i*4,true)))));
});

test('Clock receiver accepts genuine cycle and millisecond counter wraps', async () => {
  const firstCycle = 0xffff0000, firstTick = 0xfffffff0;
  const logs = await readClocks([1,2].map(side=>clockRow(side,{
    16:firstTick,20:firstCycle,24:firstTick,28:(firstTick+300)>>>0,
    32:(firstCycle+72900000)>>>0,36:(firstTick+300)>>>0
  })));
  assert.ok(logs.every(line=>line.includes('cyclesPerMs=243000 qualification=qualified')));
});

test('Clock delta bound includes endpoint tick tolerance but rejects zero and over-bound deltas', async () => {
  for (const ticks of [250,1000]) {
    const bound = 250000*(ticks+2);
    const valid = clockRow(1,{28:100+ticks,32:1000000+bound,36:100+ticks});
    const invalid = clockRow(2,{28:100+ticks,32:1000000+bound+1,36:100+ticks});
    const logs = await readClocks([valid,invalid]);
    assert.match(logs[0],/qualification=qualified /);
    assert.match(logs[1],/cyclesPerMs=unqualified /);
  }
  const logs = await readClocks([clockRow(1,{32:1000000}),clockRow(2)]);
  assert.match(logs[0],/qualification=counter discontinuity\/implausible delta/);
});

test('Clock receiver refuses too-short, too-long and zero tick brackets', async () => {
  for (const ticks of [0,249,1001]) {
    const logs = await readClocks([1,2].map(side=>clockRow(side,{
      28:100+ticks,32:1000000+243000*ticks,36:100+ticks
    })));
    assert.ok(logs.every(line=>line.includes('cyclesPerMs=unqualified ')));
  }
});

test('Clock firmware flags cannot qualify disabled, skewed, changed or unknown samples', async () => {
  for (const flags of [0,3,5,7|8,7|16,7|32]) {
    const rows = [1,2].map(side=>{const raw=clockRow(side);raw[7]=flags;return raw;});
    const logs = await readClocks(rows);
    assert.ok(logs.every(line=>line.includes('cyclesPerMs=unqualified ')), 'flags='+flags);
  }
});

test('Clock receiver independently checks captured endpoint skew, performance words and final enable', async () => {
  // The wire schema carries only the final DWT control word, not an initial one.
  for (const words of [{24:101},{36:401},{40:0xe0000015},{80:0xe0000015},
    {84:0xe0000015},{72:0}]) {
    const logs = await readClocks([clockRow(1,words),clockRow(2)]);
    assert.match(logs[0],/cyclesPerMs=unqualified /);
    assert.match(logs[1],/cyclesPerMs=250000 /);
  }
});
