const test = require('node:test');
const assert = require('node:assert/strict');
const {VideoMeasurement} = require('../.test-build/app/apps/video/video-measurement');
const {VideoProtocol} = require('../.test-build/app/apps/video/video-protocol');
const savedError=console.error;
test.before(()=>{console.error=()=>{};});
test.after(()=>{console.error=savedError;});

function packet(side, start, counts, high = start + counts.length - 1, flags = 3) {
  const raw = new Uint8Array(144), view = new DataView(raw.buffer);
  raw.set([1,7,0,6,1,0,side,flags]);
  for (const [at, value] of [[8,50],[12,7],[16,100+side],[20,0xfffffff0],[24,high]]) view.setUint32(at,value,true);
  raw[28] = counts.length; raw[29] = 56;
  counts.forEach((fps,i) => {
    const serial = start+i, values = [serial, (serial-1)*1000, fps, fps < 16 ? 160 : 63,
      fps < 16 ? 300 : 0, 0, 600, 0, 50, fps < 16 ? 300 : 0, 1, serial*16];
    const phases=Array(10).fill(0);for(let j=0;j<fps;j++)phases[j%10]++;
    values.push(phases.slice(0,8).reduce((v,n,j)=>v+(n<<(4*j)),0)>>>0,
      phases[8]+(phases[9]<<4));
    values.forEach((v,j) => view.setUint32(32+i*56+j*4,v,true));
  });
  return raw;
}
test('Paired actual windows expose bursty-average dips, nearest-rank tail and merged lengths', () => {
  const m = new VideoMeasurement(50,[101,102]);
  for (let serial=1;serial<=102;serial+=2) {
    const counts=[serial === 3 ? 14 : 16, serial === 3 ? 18 : 16];
    m.accept([packet(1,serial,counts),packet(2,serial,counts)]);
  }
  const summary=m.summary(true);
  assert.equal(summary.paired.n,101); assert.equal(summary.paired.minimum,14);
  assert.equal(summary.paired.low1,16); assert.equal(summary.badWindows,1);
  assert.equal(summary.longestBadMs,1000); assert.equal(summary.status,'pass');
  assert.equal(summary.sliding100ms.n,1001);
  assert.equal(summary.causeWindows.delivery_suspected,1);
});
test('Missing ring history, absent peer, invalid flags and changing generation never certify stability', () => {
  const m=new VideoMeasurement(50,[101,102]);
  m.accept([packet(1,4,[16,16],10),packet(2,4,[16,16],10)]);
  assert.equal(m.summary(true).status,'inconclusive');
  const fresh=new VideoMeasurement(50,[101,102]);
  fresh.accept([packet(1,1,[16,16]),packet(2,1,[16])]);
  assert.equal(fresh.summary(true).status,'inconclusive');
  const changed=packet(1,3,[16]); new DataView(changed.buffer).setUint32(12,8,true);
  assert.throws(()=>fresh.accept([changed,packet(2,3,[16])]),/generation/);
  const invalid=packet(1,3,[16]); invalid[7]=128;
  assert.throws(()=>fresh.accept([invalid,packet(2,3,[16])]),/schema/);
});
test('Requested pause windows are separately reported; ongoing playback is never a final PASS', () => {
  const m=new VideoMeasurement(50,[101,102]);
  const pair=[packet(1,1,[16,0],2,1),packet(2,1,[16,0],2,1)];
  pair.forEach(raw=>new DataView(raw.buffer).setUint32(32+56+40,16,true));
  m.accept(pair); assert.equal(m.summary().pausedWindows,1);
  assert.equal(m.summary(true).status,'inconclusive');
});
test('Cadence snapshots are capability-gated read-only paired queries with exact independent cursors', async () => {
  let id=1, sends=0, last;
  const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,bytes)=>{
    sends++;last=raw;
    if(raw[1]===0){const r=new Uint8Array(128);r[0]=1;r[1]=7;r[32]=0;r[33]=16;r[36]=246;r[37]=15;r[40]=64;r[41]=1;r[42]=192;r[44]=1;r[45]=2;r[46]=r[47]=1;r[48]=4;r[49]=6;return [r,r];}
    if(raw[1]===13)return [1,2].map(()=>Uint8Array.from([1,13,0,255,2,16,255,119,0,0,0,0,0,0,0,0]));
    return [packet(1,1,[16]),packet(2,1,[16])];
  }},()=>id++);
  assert.equal(await p.rateEvidenceRows(50,[1,1]),null);assert.equal(sends,0);
  await p.capabilities();await p.rateEvidenceRows(50,[4,7]);
  const v=new DataView(last.buffer);assert.equal(last.length,24);assert.equal(last[8],6);
  assert.equal(v.getUint32(12,true),50);assert.equal(v.getUint32(16,true),4);assert.equal(v.getUint32(20,true),7);
});
