const test=require('node:test');
const assert=require('node:assert/strict');
const {videoMemoryLines,videoHeapShapeLines}=require('../.test-build/app/apps/video/video-memory');
const {VideoPlayback}=require('../.test-build/app/apps/video/video-playback');
const {VideoProtocol}=require('../.test-build/app/apps/video/video-protocol');
function row(side=1) {
  const raw=new Uint8Array(128),view=new DataView(raw.buffer);
  raw.set([1,7,0,9,1,7,side,0]);
  for(const [at,n] of [[8,50],[12,100+side],[16,7]])view.setUint32(at,n,true);
  for(let i=0;i<3;i++)[400000,50000,40000,200000,130000,20000,45000,20].forEach((n,j)=>view.setUint32(32+i*32+j*4,n,true));
  return raw;
}
test('Memory minima keep both ledgers and explicitly unavailable baselines in bounded lines',()=>{
  const raw=row(),lines=videoMemoryLines(raw,50,101,1);
  assert.equal(lines.length,3);assert.ok(lines[0].includes('totalLedgerAtMin=330000'));
  assert.ok(lines[0].includes('maxOutsideLedger=20000'));assert.ok(lines.every(x=>x.length<700));
  new DataView(raw.buffer).setUint32(52,0xffffffff,true);
  assert.ok(videoMemoryLines(raw,50,101,1)[0].includes('maxOutsideLedger=unavailable'));
  raw[6]=2;assert.throws(()=>videoMemoryLines(raw,50,101,1),/identity/);
});
test('Memory queries are independent and run only once at terminal hooks, not report turns',async()=>{
  let calls=[]; const lines=[],old=console.error;
  const fake={generation:{stream:50,tokens:[101,102]},memoryStreams:new Set(),protocol:{memoryEvidence:async(_,side)=>{
    calls.push(side);if(side===1)throw Error('unsupported');return row(side);
  }}};
  console.error=line=>lines.push(line);
  try {
    await VideoPlayback.prototype.logMemoryEvidence.call(fake);
    await VideoPlayback.prototype.logMemoryEvidence.call(fake);
  } finally {console.error=old;}
  assert.deepEqual(calls,[1,1,2,2]);assert.ok(lines.some(x=>x.includes('side=1 unavailable')));
  assert.ok(lines.some(x=>x.includes('side=2 heap=cached')));
});

test('Queue extension distinguishes legacy absence and unknown fields; shape is identity checked',()=>{
  const raw=row(),v=new DataView(raw.buffer);
  assert.equal(videoMemoryLines(raw,50,101,1).length,3);
  v.setUint16(30,1,true);v.setUint16(20,150,true);v.setUint16(24,65535,true);
  assert.match(videoMemoryLines(raw,50,101,1)[3],/syncWaiting=150.*uartRxBytes=unavailable/);
  raw[3]=10;v.setUint32(32,1,true);v.setUint32(36,200,true);v.setUint32(40,180,true);
  v.setUint32(56,58000,true);
  assert.match(videoHeapShapeLines(raw,50,101,1)[0],/usedBlocks=200.*smallUsedLe512=180.*58000/);
  v.setUint32(32,2,true);assert.match(videoHeapShapeLines(raw,50,101,1)[0],/heap-lock-busy/);
  assert.throws(()=>videoHeapShapeLines(raw,51,101,1),/identity/);
});
test('Retained heap request carries exact stream and lens without adding periodic work',async()=>{
  let seen;
  const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,bytes,side)=>{seen=[raw,bytes,side];return[row(side)];}},()=>42);
  await p.memoryEvidence(50,2);assert.equal(seen[0].length,16);assert.equal(seen[0][8],9);
  assert.equal(new DataView(seen[0].buffer).getUint32(12,true),50);assert.deepEqual(seen.slice(1),[128,2]);
});
