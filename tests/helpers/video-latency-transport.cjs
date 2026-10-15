const assert = require('node:assert/strict');
const {VIDEO} = require('../../.test-build/app/apps/video/video-protocol');

/** Measured PC reply-size costs, not a claim about the phone's BLE controller. */
function replyLatency(bytes) {
  return new Map([[6, 20], [16, 115], [24, 115], [36, 180], [48, 200],
    [72, 200], [96, 530], [128, 750], [192, 1300]]).get(bytes) ?? 20;
}
function put(raw, offset, value) { new DataView(raw.buffer).setUint32(offset, value >>> 0, true); }

/** Decoder consumption continues during every awaited request, not just polling. */
function latencyTransport(frames = 160, decodeMs = 70, pageMs = 0) {
  let now = 100, expected = 0, accepted = 0, active = false, stream = 0, high = 0;
  let work = null, primed = false, paused = false, closed = false, passiveStep = false;
  const queue = [], metadata = [], copies = [], calls = [], stalls = [], observations = [];
  const types = [7, 8, 6, ...Array.from({length: frames}, (_, i) => i % 32 ? 1 : 5)];
  const clip = {duration: Math.round(frames * 62.5), h264: {nals: types.map(type => ({type}))},
    pictures: Array.from({length: frames}, (_, i) => ({pts: Math.round(i * 62.5), nal: i + 3,
      idr: i % 32 === 0, sps: 0, pps: 1}))};
  const occupied = () => queue.length + Number(!!work);
  const status = () => [1, 2].map(lens => ({result: 0, error: 0, state: active ? 2 : 0,
    stream, high, token: active ? 100 + lens : 0, expected, accepted, consumed: expected,
    presented: copies.length, pictures: metadata.length, copyTick: now, credits: 4 - occupied(), capacity: 4}));
  function advance(milliseconds) {
    const end = now + milliseconds;
    while (active && !paused && now < end) {
      if (!work && queue.length) { work = queue.shift(); work.done = now + (work.type === 1 || work.type === 5 ? decodeMs : 2); }
      if (!work) {
        if (primed && accepted < types.length) stalls.push({at: now, milliseconds: end - now});
        break;
      }
      if (work.done > end) break;
      now = work.done; expected++;
      if (work.type === 1 || work.type === 5) {
        const picture = metadata.find(row => row.nal === work.index);
        assert.ok(picture, 'Finishing NAL needs admitted picture metadata');
        copies.push({...picture, tick: now, serial: copies.length + 1});
      }
      work = null;
    }
    now = end;
  }
  async function request(kind, bytes, passive = false, lenses = 2) {
    const pages = Math.ceil(bytes / 6), trips = 1 + lenses * (pages - 1);
    calls.push({kind, bytes, pages: pages * lenses, trips, at: now, occupied: occupied(), active, accepted});
    if ((passive || passiveStep) && active && accepted < types.length) observations.push({kind, free: 4 - occupied(), pages: pages * lenses, trips, at: now});
    advance(pageMs ? trips * pageMs : replyLatency(bytes));
  }
  const protocol = {
    capabilities: async () => request('caps', 16),
    status: async (op = VIDEO.status) => {
      await request('status', op === VIDEO.status ? 192 : 128);
      if (op === VIDEO.stop || op === VIDEO.reset) { active = false; stream = 0; queue.length = 0; work = null; }
      return status();
    },
    radioSelection: async () => request('radio', 24),
    timeline: async () => { await request('timeline', 128); return status(); },
    start: async value => { await request('start', 128); active = true; stream = high = value; return status(); },
    phy: async () => {
      const capturedAt = now;
      await request('phy', 128, copies.length > 0);
      return [1, 2].map(lens => {
        const raw = new Uint8Array(128); raw.set([1, 7, 0, 1]); put(raw, 4, capturedAt); raw.set([1, 32, 3, lens], 8);
        for (let i = 0; i < 3; i++) {
          const p = 12 + i * 32; raw[p] = i + 1;
          if (i) continue;
          raw[p + 1] = active ? 63 : 31; raw[p + 2] = active ? lens === 1 ? 3 : 4 : 8;
          put(raw, p + 4, 40); put(raw, p + 8, now);
          raw.set([1, 1, active && lens === 1 ? 2 : 1, active && lens === 1 ? 2 : 1, 1, 1, active ? 1 : 0, 0], p + 20);
          put(raw, p + 28, active && lens === 1 ? 1 : 0);
        }
        return raw;
      });
    },
    metadata: async (_stream, ordinal, nal, pts) => {
      await request('metadata', 6);
      metadata.push({ordinal, nal, pts}); return true;
    },
    sendNals: async (_stream, first, records) => {
      assert.equal(first, accepted);
      assert.ok(records.length <= 4 - occupied(), 'Do not overdraw either lens');
      for (const record of records) queue.push({index: accepted++, type: record[0] & 31});
      if (occupied() === 4 && copies.length > 0) primed = true;
      calls.push({kind: 'send', at: now, records: records.length, first});
      advance(records.length * (pageMs ? 45 : 20));
    },
    owned: async (op, _stream, tokens, length) => {
      assert.deepEqual(tokens, [101, 102]);
      await request(op === VIDEO.credits ? 'credit' : 'playback', length, op === VIDEO.playback || paused);
      if (op === VIDEO.pause || op === VIDEO.resume) paused = op === VIDEO.pause;
      if (op === VIDEO.credits) return [1, 2].map(() => {
        const raw = new Uint8Array(6); put(raw, 0, expected); raw[4] = 32 | (4 - occupied()); return raw;
      });
      return [1, 2].map(lens => {
        const raw = new Uint8Array(length); raw.set([1, op, 0, lens]);
        [stream, 100 + lens, +paused, +paused, copies.length, copies.at(-1)?.pts ?? 0, clip.duration, 0]
          .forEach((value, i) => put(raw, 4 + i * 4, value));
        return raw;
      });
    },
    shown: async (_stream, token, lens, cursor = 0) => {
      // Frozen replies retain the command-time snapshot across all PAGE fetches.
      const first = Math.max(1, copies.length - 31);
      const row = cursor ? copies[Math.max(first, cursor) - 1] : copies.at(-1);
      const last = copies.length;
      await request('shown-' + lens, 72, true, 1);
      const raw = new Uint8Array(72); raw.set([1, VIDEO.shown, row ? 0 : 3, lens]);
      if (row) [stream, token, row.serial, row.ordinal, row.pts, row.tick, row.tick - 3, row.tick - decodeMs,
        1, first, last, first - 1, 0, 0, 0xffffffff].forEach((value, i) => put(raw, 4 + i * 4, value));
      return raw;
    },
  };
  protocol.sendNalsWithMetadata = async (id, first, nal, next) => {
    // One existing native window: admitted data is enqueued before metadata.
    await protocol.sendNals(id, first, [nal]);
    return protocol.metadata(id, next.ordinal, next.nal, next.pts);
  };
  return {protocol, source: {clip, readNal: async i => Uint8Array.of(types[i] | 0x60, i), close: () => {closed = true;}},
    report: async action => { passiveStep = true; try { return await action(); } finally { passiveStep = false; } },
    clock: () => now, sleep: async ms => advance(ms), copies, calls, stalls, observations,
    primed: () => primed, closed: () => closed};
}
module.exports = {latencyTransport, replyLatency};
