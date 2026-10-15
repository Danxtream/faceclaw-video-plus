const test=require('node:test');
const assert=require('node:assert/strict');
const {VideoPlayback,silentVideoAudio}=require('../.test-build/app/apps/video/video-playback');
const {latencyTransport}=require('./helpers/video-latency-transport.cjs');

test('Only fenced validated paired credits are handed to the same generation and exact sent index',async()=>{
  let now=100, offered;
  const f=latencyTransport(),p=new VideoPlayback(f.protocol,f.source,silentVideoAudio,
    ()=>({native:true,dither:false,radio:true}),()=>{},()=>{},()=>now,async()=>{});
  const row={index:4,metadata:1,consumed:0,budget:0,blocked:false,running:false,error:''};
  let fenced=false;
  const pump={pause(){fenced=true;},resume(){},close(){},snapshot:()=>row,
    offerCredits(...args){assert.ok(fenced);offered=args;return true;}};
  p.generation={stream:50,tokens:[101,102],index:4,metadata:1,count:100,idr:0,pump};
  f.protocol.owned=async()=>{now+=38;return [1,2].map(()=>Uint8Array.from([4,0,0,0,46,0]));};
  await p.credits();
  assert.equal(p.creditBudget,6);
  assert.deepEqual(offered.slice(0,3),[50,[101,102],4]);assert.equal(offered[4],38);
  assert.equal(offered[3].length,2);
  offered=null;f.protocol.owned=async()=>[Uint8Array.from([4,0,0,0,46,0]),Uint8Array.from([4,0,0,0,46,8])];
  await assert.rejects(p.credits(),/owner credit/);assert.equal(offered,null);
  f.protocol.owned=async()=>[new Uint8Array(5)];
  await assert.rejects(p.credits(),/Missing lens/);assert.equal(offered,null);
});
test('Six-slot progress does not expand fallback batches beyond four or change mixed-lens capacity',async()=>{
  const f=latencyTransport(),p=new VideoPlayback(f.protocol,f.source,silentVideoAudio,
    ()=>({native:true,dither:false,radio:true}));
  p.generation={stream:50,tokens:[101,102],index:0,metadata:0,count:100,idr:0,prefix:[],firstNal:0};
  let batch=0;
  p.creditBudget=6;f.protocol.sendPipeline=async(_stream,_index,records)=>{batch=records.length;return [records.length,0];};
  await p.upload();assert.equal(batch,4);assert.equal(p.creditBudget,2);
  f.protocol.owned=async()=>[Uint8Array.from([4,0,0,0,46,0]),Uint8Array.from([4,0,0,0,36,0])];
  await p.credits();assert.equal(p.creditBudget,4);
});
test('Timed uploads ask for timeline room and accept only a zero result code beside it',async()=>{
  let value, offered;
  const f=latencyTransport(),p=new VideoPlayback(f.protocol,f.source,silentVideoAudio,
    ()=>({native:true,dither:false,radio:true}),()=>{},()=>{},()=>100,async()=>{});
  const row={index:4,metadata:1,consumed:0,budget:0,blocked:false,running:false,error:''};
  const pump={pause(){},resume(){},close(){},snapshot:()=>row,offerCredits(...args){offered=args;return true;}};
  p.generation={stream:50,tokens:[101,102],index:4,metadata:1,count:100,idr:0,pump};
  f.protocol.timedNal=true;
  f.protocol.owned=async(_op,_stream,_tokens,_length,flag)=>{value=flag;return [1,2].map(()=>Uint8Array.from([4,0,0,0,46,3<<5]));};
  await p.credits();
  assert.equal(value,1);assert.equal(p.creditBudget,6);assert.equal(offered[3][0][5],3<<5);
  f.protocol.owned=async()=>[Uint8Array.from([4,0,0,0,46,3<<5]),Uint8Array.from([4,0,0,0,46,(3<<5)|2])];
  await assert.rejects(p.credits(),/owner credit/);
  delete p.generation.pump;f.protocol.owned=async(_op,_stream,_tokens,_length,flag)=>{value=flag;return [1,2].map(()=>Uint8Array.from([4,0,0,0,46,0]));};
  await p.credits();assert.equal(value,undefined);
});
