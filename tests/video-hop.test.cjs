const test = require('node:test');
const assert = require('node:assert/strict');
const {parseVideoHop} = require('../.test-build/app/apps/video/video-hop');
const {VideoProtocol, VIDEO, videoU32} = require('../.test-build/app/apps/video/video-protocol');

function row(side=1) {
  const r=new Uint8Array(172), v=new DataView(r.buffer);
  r.set([1,7,0,8,0,1,side,1]);v.setUint32(8,7,true);v.setUint32(12,100+side,true);
  r[16]=1;r[17]=3;v.setUint32(20,1000,true);v.setUint32(24,10,true);
  v.setUint32(32,2,true);v.setUint32(36,16,true);v.setUint32(40,8,true);v.setUint16(46,2,true);
  return r;
}
test('Frozen hop body validates lens stream token version bins and all seven same-clock spans',()=>{
  const p=parseVideoHop(row(),7,101,1);
  assert.deepEqual(p.stages[0],{stage:'receiveToForward',count:2,sumTicks:16,meanTicks:8,maxTicks:8,bins:[0,2,0,0],p95UpperTicks:8});
  assert.equal(p.maxPending,3);
  assert.equal(parseVideoHop(row(2),7,102,2).stages.length,7);
  for (const args of [[8,101,1],[7,102,1],[7,101,2]])
    assert.throws(()=>parseVideoHop(row(),...args),/identity/);
  const bad=row();bad[46]=1;assert.throws(()=>parseVideoHop(bad,7,101,1),/counters/);
});
test('Developer legacy override disables opt-in START, wide credits and continuous native pump together',async()=>{
  let id=1, plan;const sent=[];
  const backend={epoch:()=>1,createUploadPump:(_,p)=>{plan=p;return {};},exchange:async(raw,n)=>{
    sent.push(raw.slice());
    if(raw[1]===7) return [1,2].map(side=> {if(n===172)return row(side);const r=new Uint8Array(n);r.set([1,7,0,8,0,1]);r[8]=172;return r;});
    if(raw[1]===VIDEO.playbackCaps)return [1,2].map(()=>Uint8Array.from([1,13,0,255,194,7,255,255,0,64,0,0,0,32,0,0]));
    if(raw[1]===VIDEO.credits)return [new Uint8Array(n),new Uint8Array(n)];
    const status=()=>{const r=new Uint8Array(n),v=new DataView(r.buffer);r.set([1,7]);v.setUint32(32,4096,true);v.setUint32(36,4086,true);
      r.set([64,1,192,0,1,2,1,1,4,6,4,4],40);r[71]=64;return r;};return [status(),status()];
  }};
  const p=new VideoProtocol(backend,()=>id++);await p.capabilities();
  for(const enabled of [false,true,false]) {
    p.continuousDelivery(enabled);await p.start(7,false,false,false);
    assert.equal(!!(sent.at(-1)[18]&64),enabled);
    p.createUploadPump({},{});assert.equal(plan.flow,enabled);
    const r=await p.owned(VIDEO.credits,7,[101,102],6,1);
    assert.equal(videoU32(sent.at(-1),20),enabled?3:1);assert.equal(r[0].length,enabled?16:6);
  }
  assert.equal((await p.hopEvidence(7))[0].length,172);assert.equal(sent.at(-1)[8],8);assert.equal(sent.at(-1)[9],0);assert.equal(videoU32(sent.at(-1),12),7);
});
test('Old or mixed firmware disables hop queries after one bounded discovery without changing playback',async()=>{
  for(const mixed of [false,true]) {
    let calls=0;
    const p=new VideoProtocol({epoch:()=>1,exchange:async(raw,n)=>{calls++;assert.equal(n,128);
      return [1,2].map(side=>{const r=new Uint8Array(n);r.set([1,7,0,mixed&&side===1?8:0,0,1]);r[8]=172;return r;});}},()=>1);
    assert.equal(await p.hopEvidence(7),null);assert.equal(await p.hopEvidence(7),null);assert.equal(calls,1);
  }
});
