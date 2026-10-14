const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');

function harness(mode) {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java', 'utf8');
  const start = source.indexOf('    private void enqueueVideoCacheLeaseLocked');
  const end = source.indexOf('    /** Called only', start);
  const method = source.slice(start, end);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-video-lease-'));
  try {
    const file = path.join(folder, 'VideoCacheLeaseHarness.java');
    fs.writeFileSync(file, `package com.faceclaw.app;
import java.util.*;
public class VideoCacheLeaseHarness {
  static class SystemClock { static long elapsedRealtime() { return 0; } }
  static class BleProtocol { static final int FACECLAW_FB_OP_ACQUIRE = 5; }
  static class OutboundMessage {
    String kind,label; int sid,flag,magic,ackTimeoutMs,tileIndex; byte[] message; boolean isLeftArmMessage;
    Runnable onSent,onAck,onTimeout;
    OutboundMessage(String k,String l,int s,int f,int m,byte[] b,int a,int t,boolean left) {
      kind=k;label=l;sid=s;flag=f;magic=m;message=b;ackTimeoutMs=a;tileIndex=t;isLeftArmMessage=left;
    }
  }
  static class MessageBuilder {
    OutboundMessage faceclawFramebufferControl(int op, boolean left) {
      return new OutboundMessage("framebuffer-lease-control","lease",1,1,0,new byte[]{(byte)op},1000,-1,left);
    }
  }
  MessageBuilder messageBuilder = new MessageBuilder();
  ArrayDeque<OutboundMessage> pendingMessages = new ArrayDeque<>();
  long lastFaceclawFramebufferLeaseQueuedAtMs;
${method}
  public static void main(String[] args) {
    VideoCacheLeaseHarness h=new VideoCacheLeaseHarness(); long[] now={0}; int[] ready={0}, failed={0};
    VideoTextureCacheGate gate=new VideoTextureCacheGate(h::enqueueVideoCacheLeaseLocked,()->{},()->now[0]);
    gate.prepare(7,()->ready[0]++,()->failed[0]++);
    if(args[0].equals("drop")) {
      h.pendingMessages.removeIf(m->m.kind.equals("framebuffer-lease-control"));
      assert h.pendingMessages.size()==1 : "Stock clear deleted video preparation";
    }
    if(args[0].equals("timeout")) {
      OutboundMessage late=h.pendingMessages.removeFirst(); now[0]=3001; gate.poll();
      assert failed[0]==1 && !gate.preparing();
      if(late.onSent!=null) late.onSent.run();
      assert ready[0]==0 && h.pendingMessages.isEmpty();
      gate.prepare(7,()->ready[0]++,()->failed[0]++);
    }
    ArrayList<String> writes=new ArrayList<>();
    while(!h.pendingMessages.isEmpty()) {
      OutboundMessage m=h.pendingMessages.removeFirst();
      assert m.magic==0;
      writes.add(m.message[0]+":"+m.isLeftArmMessage);
      // Actual magic-zero write path: successful onSent only, NEVER an ACK.
      if(m.onSent!=null) m.onSent.run();
    }
    assert writes.equals(List.of("6:false","6:true","5:false","5:true"));
    assert ready[0]==1 && !gate.preparing() && gate.suspended();
    gate.prepare(7,()->ready[0]++,()->failed[0]++);
    assert ready[0]==2 && h.pendingMessages.isEmpty() : "Retry released admitted peer lease";
  }
}`, 'utf8');
    execFileSync('javac', ['-d', folder, file,
      'App_Resources/Android/src/main/java/com/faceclaw/app/VideoTextureCacheGate.java'], {stdio: 'pipe'});
    execFileSync('java', ['-ea', '-cp', folder, 'com.faceclaw.app.VideoCacheLeaseHarness', mode], {stdio: 'pipe'});
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, {recursive: true, force: true});
  }
}

test('Real lease enqueue method progresses on writes without any lease ACK', () => {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java', 'utf8');
  assert.ok(source.includes('message.onSent = written::run'));
  harness('written');
});
test('Stock framebuffer-control clearing cannot delete video lease operations', () => {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java', 'utf8');
  assert.ok(source.includes('"video-cache-lease"'));
  harness('drop');
});
test('Whole lease preparation times out, fences late writes and can prepare again', () => harness('timeout'));
