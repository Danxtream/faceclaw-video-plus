const test = require('node:test');
const assert = require('node:assert/strict');
const {videoMeasurementLogs} = require('../.test-build/app/apps/video/video-measurement-log');

function collect(lines) {
  const groups = new Map();
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line,'utf8') <= 700);
    const row = JSON.parse(line.slice('Video measurement '.length));
    const key = JSON.stringify([row.stream,row.tokens,row.sample,row.phase,row.kind]);
    if (!groups.has(key)) groups.set(key, {row,parts:[]});
    const group=groups.get(key);
    assert.equal(group.parts[row.part],undefined);
    group.parts[row.part]=row.data;
  }
  return [...groups.values()].map(({row,parts}) => {
    assert.equal(parts.length,row.parts);
    return {...row,value:JSON.parse(parts.join(''))};
  });
}
test('Aggregate logs stay within UTF8 budget and losslessly reconstruct independent owners and largest counters',()=>{
  const groups={pump:{queueToWrite:0}, transport:{queueToWrite:Number.MAX_VALUE,
    writeToAck:Number.MAX_SAFE_INTEGER}, shown:{text:'é水😀"\\'.repeat(300), reportSpans:Array(128).fill({duration:Number.MAX_VALUE})}};
  const rows=collect(videoMeasurementLogs({stream:0xfffffffe,tokens:[0xffffffff,0xffffffff]},Number.MAX_SAFE_INTEGER,'final',groups));
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.kind,r.value])),groups);
  assert.ok(rows.every(r=>r.stream===0xfffffffe && r.phase==='final'));
});
test('Rate, EOF and cancel aggregates retain generation and sample identity without per-packet logs',()=>{
  const {VideoPlayback,silentVideoAudio}=require('../.test-build/app/apps/video/video-playback');
  const {latencyTransport}=require('./helpers/video-latency-transport.cjs');
  const f=latencyTransport(), p=new VideoPlayback(f.protocol,f.source,silentVideoAudio,
    ()=>({native:true,dither:false,radio:true}));
  const logs=[],save=console.error; console.error=line=>logs.push(line);
  try {
    p.generation={stream:50,tokens:[101,102]};
    p.logMeasurement('rate',{pump:{count:0},transport:{count:9}});
    p.logMeasurement('final',{shown:{status:'inconclusive'}});
    p.generation={stream:51,tokens:[103,104]};
    p.logMeasurement('final',{shown:{cancelled:true}});
  } finally {console.error=save;}
  const rows=collect(logs);
  assert.deepEqual(rows.map(r=>[r.stream,r.sample,r.kind]),[[50,0,'pump'],[50,0,'transport'],[50,1,'shown'],[51,2,'shown']]);
});
