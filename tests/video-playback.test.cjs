const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoPlayback, silentVideoAudio } = require('../.test-build/app/apps/video/video-playback');
const { VIDEO } = require('../.test-build/app/apps/video/video-protocol');
const { parseVideoPhy, videoRestored, videoLive, parsePlayback, parseShown, videoTickSpan, videoCopyRate } = require('../.test-build/app/apps/video/video-observations');

function put(raw, offset, value) { new DataView(raw.buffer).setUint32(offset, value, true); }

test('Flagged report credits retain six-picture room and reject impossible seven', async () => {
  const f = fixture(); let room = 6; let offered = 0;
  f.player.generation = {stream: 1, tokens: [101, 102], index: 0,
    pump: {offerCredits: () => offered++}};
  f.player.suspendUpload = async () => {};
  f.protocol.timedNal = true;
  f.protocol.owned = async () => [1, 2].map(() => Uint8Array.from([0, 0, 0, 0, 46, room << 5]));
  await f.player.credits(); assert.equal(f.player.creditBudget, 6); assert.equal(offered, 1);
  room = 7;
  await assert.rejects(f.player.credits(), /owner credit window failed/);
  assert.equal(offered, 1);
});
function phy(lens, owned = false, tick = 100) {
  const raw = new Uint8Array(128);
  raw.set([1, 7, 0, 1]); put(raw, 4, tick); raw.set([1, 32, 3, lens], 8);
  for (let i = 0; i < 3; i++) {
    const base = 12 + i * 32;
    raw[base] = i + 1;
    if (i) continue;
    raw[base + 1] = owned ? 63 : 31;
    raw[base + 2] = owned ? lens === 1 ? 3 : 4 : 8;
    put(raw, base + 4, 40);
    put(raw, base + 8, tick);
    raw.set([1, 1, owned && lens === 1 ? 2 : 1, owned && lens === 1 ? 2 : 1, 1, 1, owned ? 1 : 0, 0], base + 20);
    put(raw, base + 28, owned && lens === 1 ? 1 : 0);
  }
  return raw;
}
function playback(op, lens, stream, token, paused = false, shown = 0, position = 0, duration = 1000, menu = false) {
  const raw = new Uint8Array(op === VIDEO.menu || op === VIDEO.scale ? 48 : 36);
  raw.set([1, op, 0, lens]);
  [stream, token, +paused, +paused, shown, position, duration, 0].forEach((v, i) => put(raw, 4 + i * 4, v));
  if (raw.length === 48) put(raw, 36, +menu);
  return raw;
}
function shown(lens, stream, token, ordinal, pts, tick, replyTick = 0) {
  const raw = new Uint8Array(72);
  raw.set([1, VIDEO.shown, ordinal ? 0 : 3, lens]);
  if (ordinal) [stream, token, ordinal, ordinal, pts, tick, (tick - 3) >>> 0, (tick - 10) >>> 0,
    0, 1, ordinal, 0, 0, replyTick, 0xffffffff].forEach((v, i) => put(raw, 4 + i * 4, v));
  return raw;
}
function fixture(frames = 20, step = 67) {
  let now = 100;
  const calls = [], audio = [], view = [];
  const nals = [7, 8, 6, ...Array.from({length: frames}, (_, i) => i % 5 === 0 ? 5 : 1)]
    .map((type, index) => ({type, bytes: 2, offset: index * 6 + 4, sha256: 'a'.repeat(64)}));
  const clip = {fps: 15, duration: Math.round(frames * 1000 / 15), h264: {nals},
    pictures: Array.from({length: frames}, (_, i) => ({pts: Math.round(i * 1000 / 15), nal: i + 3, idr: i % 5 === 0, sps: 0, pps: 1}))};
  const state = {active: false, stream: 0, high: 0, expected: 0, metadata: [], decoded: [],
    paused: false, preview: false, shown: [], native: false, selection: 0, menu: false, serial: 0, target: 0,
    busyMetadata: 0, refusal: false, wrongRestore: false, failedSample: false, concurrent: 0};
  // An idle lens keeps the error that ended its last stream until a START clears it (state.staleError).
  const status = () => [1, 2].map((lens) => ({result: 0, error: state.staleError ?? 0, state: state.active ? 2 : 0, stream: state.stream,
    high: state.high, token: state.active ? 100 + lens : 0, expected: state.expected, accepted: state.expected,
    consumed: state.expected, presented: state.shown.length, pictures: state.metadata.length, copyTick: now, credits: 4, capacity: 4}));
  // Lens ticks may run at their own rate against the phone clock (state.tickScale).
  const lensTick = () => Math.round(now * (state.tickScale ?? 1));
  function advance() {
    if (state.paused || !state.decoded.length) return;
    const row = state.decoded.shift();
    now += step; state.shown.push({...row, tick: lensTick(), at: now});
    if (state.preview) { state.paused = true; state.preview = false; state.menu = true; }
  }
  const protocol = {
    capabilities: async () => calls.push('caps'),
    status: async (op = VIDEO.status, stream) => {
      calls.push(['status', op, stream]);
      if (op === VIDEO.reset || op === VIDEO.stop) { state.active = false; state.stream = 0; }
      return status();
    },
    phy: async () => {
      calls.push('phy');
      now++;
      if (state.failedSample) { state.failedSample = false; throw new Error('diagnostics unavailable'); }
      const rows = [1, 2].map(lens => phy(lens, state.active, lensTick()));
      if (state.wrongRestore && !state.active) rows[1][36] = 2;
      return rows;
    },
    radioSelection: async value => calls.push(['radio', value]),
    timeline: async (stream, duration, pts) => { calls.push(['timeline', stream, pts]); return status(); },
    start: async (stream, native, dither, radio, preroll, paused) => {
      calls.push(['start', stream, native, dither, radio, preroll, paused]);
      state.active = true; state.stream = state.high = stream; state.expected = 0; state.metadata = []; state.staleError = 0;
      state.decoded = []; state.shown = []; state.preview = paused; state.paused = false; state.preroll = preroll;
      state.native = native; state.menu = false; state.serial = 0; state.selection = 0;
      return status();
    },
    metadata: async (stream, ordinal, nal, pts) => {
      calls.push(['metadata', ordinal, nal, pts]);
      if (state.busyMetadata > 0) { state.busyMetadata--; return false; }
      state.metadata.push({ordinal, nal, pts}); return true;
    },
    sendNals: async (stream, first, records) => {
      calls.push(['send', stream, first, records.map(row => [...row])]);
      if (state.refusal) throw new Error('paired input refused');
      assert.equal(first, state.expected);
      state.expected += records.length;
      for (const row of state.metadata) if (row.nal >= first && row.nal < state.expected && row.ordinal > state.preroll)
        state.decoded.push(row);
    },
    owned: async (op, stream, tokens, length, value) => {
      calls.push(['owned', op, value]);
      assert.equal(stream, state.stream); assert.deepEqual(tokens, [101, 102]);
      if (op === VIDEO.credits) {
        advance();
        return [1, 2].map(() => { const raw = new Uint8Array(6); put(raw, 0, state.expected); raw[4] = 36; return raw; });
      }
      if (op === VIDEO.pause || op === VIDEO.resume) { state.paused = op === VIDEO.pause; state.menu = state.paused; }
      if (op === VIDEO.scale) { assert.ok(value === 1 || value === 2); state.native = value === 1; }
      if (op === VIDEO.menu) {
        if (value === 0) { state.menu = state.paused = true; state.selection = 0; }
        if (value === 1) state.menu = false;
        if (value === 2) state.selection = (state.selection + 1) % 5;
        if (value === 3) state.selection = (state.selection + 4) % 5;
        if (value === 4) {
          if (!state.selection) state.menu = state.paused = false;
          else { state.target = Math.min(clip.duration, Math.max(0, (state.shown.at(-1)?.pts ?? 0) + [-0, -10000, 10000, -30000, 30000][state.selection])); state.serial++; }
        }
      }
      const last = state.shown.at(-1);
      return [1, 2].map(lens => {
        const raw = playback(op, lens, stream, 100 + lens, state.paused, state.shown.length, last?.pts ?? 0, clip.duration, state.menu);
        if (raw.length === 48) { put(raw, 36, (+state.menu | state.selection << 1) | +state.native << 4 | +state.native << 5); put(raw, 40, state.serial); put(raw, 44, state.target); }
        return raw;
      });
    },
    shown: async (stream, token, lens, cursor = 0) => {
      // The firmware's 32-row ring (patches/video/shown.c) answers cursor 0 with its oldest retained row.
      const row = cursor ? state.shown.find(r => r.ordinal === cursor) :
        state.oldestShown ? state.shown[Math.max(0, state.shown.length - 32)] : state.shown.at(-1);
      return shown(lens, stream, token, row?.ordinal ?? 0, row?.pts ?? 0, row?.tick ?? 0, state.replyTicks ? lensTick() : 0);
    },
  };
  let closed = false, copied = 0;
  const source = {clip, readNal: async index => { assert.ok(index >= 0 && index < nals.length); return Uint8Array.of(nals[index].type | 0x60, index); }, close: () => { closed = true; calls.push('close'); }};
  const player = new VideoPlayback(protocol, source, {sync: async (...args) => audio.push(['sync', ...args]),
    pause: async () => audio.push(['pause']), close: async () => audio.push(['close'])},
    () => ({native: state.native, dither: false, radio: true, detailedReports: !!state.detailedReports, audioOffsetMs: state.audioOffsetMs}), v => { view.push(v); f.onView?.(v); },
    count => copied += count, () => now, async ms => { now += ms; });
  const f = {player, state, calls, audio, view, clip, protocol, onView: null,
    closed: () => closed, copied: () => copied};
  return f;
}

test('Observation parsers preserve zero ticks, wraps and source/owner failures', () => {
  assert.equal(videoTickSpan(0, 0xffffffff), 1);
  assert.throws(() => videoTickSpan(0xffffffff, 0), /bounded/);
  assert.equal(videoCopyRate({ordinal: 1, copyTick: 0xffffffc0}, {ordinal: 2, copyTick: 0}).fps, 15.625);
  const raw = shown(1, 22, 11, 1, 0, 0);
  assert.equal(parseShown(raw, 1, 22, 11).copyTick, 0);
  assert.throws(() => parseShown(raw, 2, 22, 11));
  assert.throws(() => parsePlayback(playback(VIDEO.pause, 1, 22, 11), 1, 23, 11));
  const busy = playback(VIDEO.menu, 1, 22, 11); busy[2] = 3;
  assert.equal(parsePlayback(busy, 1, 22, 11).result, 3);
});

test('Wire-fed peer fallback is safe, but its uncertain epoch or wrong restoration is not', () => {
  const before = [1, 2].map(lens => parseVideoPhy(phy(lens, true), lens));
  const after = [1, 2].map(lens => parseVideoPhy(phy(lens), lens));
  assert.equal(before[1].links[0].phase, 4);
  assert.equal(videoRestored(before, after), true);
  const bad = structuredClone(after); bad[1].links[0].current = 514;
  assert.throws(() => videoRestored(before, bad), /restored/);
  bad[1].links[0] = {...after[1].links[0], epoch: 41};
  assert.throws(() => videoRestored(before, bad), /changed/);
  bad[1].links[0] = {...after[1].links[0], permission: 1};
  assert.equal(videoRestored(before, bad), false);
});

test('START waits for delayed READ on RIGHT slot three before timeline or admission', async () => {
  const f = fixture(5), sample = f.protocol.phy;
  let queries = 0;
  f.protocol.phy = async () => {
    const rows = await sample();
    if (!f.state.active) {
      queries++;
      const right = rows[1]; right.set(right.slice(12, 44), 76); right[76] = 3;
      right.fill(0, 12, 44); right[12] = 1;
      if (queries < 3) {
        right[77] &= ~4; put(right, 84, 0);
        if (queries === 2) { right[77] |= 64; right[103] = 1; }
      }
    }
    return rows;
  };
  // Inspect pre-admission only; subsequent active/retirement fixture uses slot1.
  const rows = await f.player.cleanStartPhy();
  assert.equal(queries, 3); assert.equal(rows[1].links[2].valid, true);
  assert.equal(rows[1].links[2].pending, false);
  assert.equal(f.calls.some(row => Array.isArray(row) && ['timeline', 'start', 'radio'].includes(row[0])), false);
  const h = fixture(5), read = h.protocol.phy, timeline = h.protocol.timeline;
  let idleQueries = 0;
  h.protocol.phy = async () => {
    const result = await read();
    if (!h.state.active && ++idleQueries < 3) result[1][13] &= ~4;
    return result;
  };
  h.protocol.timeline = async (...args) => { assert.equal(idleQueries, 3); return timeline(...args); };
  await h.player.run();
  assert.equal(h.copied(), 5);
});

test('START refuses every unsafe field with identical console and error evidence', async () => {
  const cases = {
    bound: raw => { raw[13] &= ~2; },
    connected: raw => { raw[13] &= ~1; },
    owners: raw => { raw[13] |= 32; raw[38] = 1; },
    permission: raw => put(raw, 40, 9),
    uncertain: raw => { raw[13] |= 128; },
    status: raw => { raw[15] = 12; },
    pending: raw => { raw[13] |= 64; raw[39] = 1; },
  };
  const log = console.error;
  try {
    for (const [field, mutate] of Object.entries(cases)) {
      const f = fixture(5), sample = f.protocol.phy, logs = [];
      console.error = message => logs.push(message);
      f.protocol.phy = async () => { const rows = await sample(); mutate(rows[1]); return rows; };
      await assert.rejects(f.player.run(), error => {
        assert.match(error.message, /RIGHT link=1/);
        for (const name of ['bound', 'connected', 'valid', 'pending', 'owners', 'permission', 'uncertain', 'status', 'epoch', 'tx', 'rx'])
          assert.ok(error.message.includes(`${name}=`), `${field}: ${name}`);
        assert.ok(error.message.includes(`${field}=`));
        assert.deepEqual(logs, [error.message]); return true;
      });
      assert.equal(f.calls.some(row => Array.isArray(row) && row[0] === 'start'), false);
      assert.equal(f.closed(), true);
    }
  } finally { console.error = log; }
});

test('START rejects stale valid samples, missing valid samples and in-flight SET', async () => {
  const log = console.error;
  try {
    for (const mode of ['stale', 'invalid', 'set']) {
      const f = fixture(5), sample = f.protocol.phy, logs = [];
      let queries = 0;
      console.error = message => logs.push(message);
      f.protocol.phy = async () => {
        const rows = await sample(); queries++;
        if (mode === 'stale') put(rows[1], 20, 0);
        if (mode === 'invalid') rows[1][13] &= ~4;
        if (mode === 'set' && queries > 1) { rows[1][13] |= 64; rows[1][39] = 2; }
        return rows;
      };
      await assert.rejects(f.player.run(), error => {
        assert.match(error.message, /RIGHT link=1/);
        assert.match(error.message, mode === 'set' ? /failed=pending/ : /PHY read timed out/);
        assert.match(error.message, mode === 'invalid' ? /valid=false/ : mode === 'set' ? /operation=2/ : /fresh PHY sample/);
        assert.deepEqual(logs, [error.message]); return true;
      });
      assert.ok(queries <= 80); assert.equal(f.calls.some(row => Array.isArray(row) && row[0] === 'start'), false);
    }
  } finally { console.error = log; }
});

test('START freshness accepts event-timer wrap but rejects epoch changes and disconnects', async () => {
  const f = fixture(5), sample = f.protocol.phy;
  let queries = 0;
  f.protocol.phy = async () => { const rows = await sample(); queries++;
    put(rows[1], 20, queries === 1 ? 0xffffffff : 0); return rows; };
  assert.equal((await f.player.cleanStartPhy())[1].links[0].sampleTick, 0);
  const log = console.error;
  try {
    for (const mode of ['epoch', 'disconnect', 'transport', 'cancel']) {
      const h = fixture(5), read = h.protocol.phy; let count = 0;
      console.error = () => {};
      h.protocol.phy = async () => {
        const rows = await read(); count++;
        if (mode === 'cancel') h.player.stop();
        if (count > 1) {
          if (mode === 'epoch') put(rows[1], 16, 41);
          if (mode === 'disconnect') rows[1][13] = 0;
          if (mode === 'transport') throw new Error('link request timed out');
        }
        return rows;
      };
      if (mode === 'cancel') { await h.player.run(); assert.equal(h.player.view.error, null); }
      else await assert.rejects(h.player.run(), mode === 'epoch' ? /failed=epoch.*epoch=41/ :
        mode === 'disconnect' ? /failed=bound/ : /request timed out.*RIGHT link=1/);
      assert.equal(h.calls.some(row => Array.isArray(row) && row[0] === 'start'), false);
    }
  } finally { console.error = log; }
});

test('Single writer finishes paired copies, uses metadata identity and cleans all resources', async () => {
  const f = fixture();
  await f.player.run();
  assert.equal(f.copied(), 20);
  assert.equal(f.closed(), true);
  assert.equal(f.player.view.error, null);
  assert.equal(f.player.view.active, false);
  assert.ok(f.audio.some(row => row[0] === 'sync'));
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'metadata' && row[1] === 1 && row[2] === 3));
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
  await assert.rejects(f.player.run(), /single use/);
});

test('Native upload progress fences every JS report/control and recreates only after seek retirement', async () => {
  const f = fixture(12), source = f.player.source, sleep = f.player.sleep;
  source.uploadHandle = 'audited-reader'; source.readNal = async () => { throw new Error('JS must not read native-pumped NALs'); };
  const pumps = []; let pump, native = false, flow;
  for (const [name, method] of Object.entries(f.protocol)) {
    f.protocol[name] = async (...args) => {
      assert.ok(native || !pump?.row.running, `JS ${name} overlapped upload`);
      return method(...args);
    };
  }
  f.protocol.createUploadPump = (reader, plan) => {
    assert.equal(reader, 'audited-reader'); assert.ok(!pump || pump.closed);
    const p = {row: {index: 0, metadata: 0, consumed: -1, budget: 0, blocked: false, running: false, error: ''},
      requested: false, closed: false, plan,
      resume() {assert.equal(this.closed, false); this.requested = true; this.row.running = this.row.index < plan.count;},
      pause() {this.requested = false;}, snapshot() {return {...this.row};},
      close() {assert.equal(this.row.running, false); this.closed = true;}};
    pumps.push(p); pump = p; return p;
  };
  f.player.sleep = async ms => {
    await sleep(ms);
    if (!pump?.row.running) return;
    const {row, plan} = pump;
    native = true;
    try {
      const index = row.index < plan.prefix.length ? plan.prefix[row.index] : plan.firstNal + row.index - plan.prefix.length;
      const next = plan.pictures[row.metadata];
      if (next?.nal === index) {
        assert.equal(await f.protocol.metadata(plan.stream, row.metadata + 1, row.index, next.pts), true); row.metadata++;
      }
      await f.protocol.sendNals(plan.stream, row.index, [Uint8Array.of(f.clip.h264.nals[index].type | 0x60, index)]);
      row.index++; row.consumed = row.index; row.budget = 3;
      await f.protocol.owned(VIDEO.credits, plan.stream, plan.tokens, 6);
      row.running = pump.requested && row.index < plan.count;
    } finally { native = false; }
  };
  f.onView = view => {
    if (view.position > 0 && !flow) flow = (async () => {
      await f.player.pause(true); await f.player.seek(750); await f.player.pause(false);
    })();
  };
  await f.player.run(); await flow;
  assert.equal(pumps.length, 2); assert.ok(pumps.every(p => p.closed));
  assert.equal(f.player.view.cleanupFailed, false); assert.equal(f.closed(), true);
});

test('Native pump failure still fences and attempts STOP and original PHY restoration', async () => {
  const f = fixture(5); let closed = false;
  f.protocol.createUploadPump = () => ({resume() {}, pause() {}, close() {closed = true;},
    snapshot: () => ({index: 0, metadata: 0, consumed: -1, budget: 0, blocked: false, running: false, error: 'paired native input refused'})});
  await assert.rejects(f.player.run(), /paired native input refused/);
  assert.equal(closed, true); assert.equal(f.closed(), true);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
  assert.equal(f.player.view.cleanupFailed, false);
});

test('LEASE refusal retries the same stream only on the unadmitted lens', async () => {
  const f = fixture(5), start = f.protocol.start, calls = [];
  f.protocol.start = async (...args) => {
    calls.push(args);
    if (calls.length === 1) {
      const rows = await start(...args);
      rows[1] = {...rows[1], result: 4, state: 0, stream: 0, high: 0, token: 0};
      return rows;
    }
    assert.equal(args[6], 2);
    return (await start(...args)).slice(1);
  };
  await f.player.run();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].slice(0, 6), calls[1].slice(0, 6));
  assert.equal(f.copied(), 5);
});

test('Persistent LEASE refusal stops after three same-stream retries and cleans up', async () => {
  const f = fixture(5), status = f.protocol.status, attempts = [];
  f.protocol.start = async (...args) => {
    attempts.push(args);
    return (await status()).map(row => ({...row, result: 4}));
  };
  await assert.rejects(f.player.run(), /result=4/);
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(args => args[0] === attempts[0][0]));
  assert.ok(attempts.slice(1).every(args => args[6] === 3));
  assert.equal(f.copied(), 0);
  assert.equal(f.player.view.cleanupFailed, false);
});

test('Unadmitted idle STALE STOP cleans up, but admitted or foreign owners do not', async () => {
  for (const mode of ['unadmitted', 'admitted', 'foreign', 'error']) {
    const f = fixture(5), status = f.protocol.status;
    f.protocol.start = async () => { throw new Error('START record timed out'); };
    f.protocol.status = async (...args) => {
      const rows = await status(...args);
      if (args[0] === VIDEO.stop) for (const row of rows) {
        row.result = 2;
        if (mode === 'admitted') row.high = 1;
        if (mode === 'foreign') { row.state = 2; row.stream = 99; }
        if (mode === 'error') row.error = 8;
      }
      return rows;
    };
    await assert.rejects(f.player.run(), /START record timed out/);
    assert.equal(f.player.view.cleanupFailed, mode !== 'unadmitted');
    assert.equal(f.closed(), true);
  }
});

test('Idle retired stream IDs permit LEASE retries and STALE cleanup, but never this attempted stream', async () => {
  const f = fixture(5), start = f.protocol.start;
  f.state.high = f.state.stream = 6;
  let attempts = 0;
  f.protocol.start = async (...args) => {
    const rows = await start(...args);
    if (++attempts === 1) { rows[0] = {...rows[0], result: 4, state: 0, stream: 6, high: 6}; return rows; }
    assert.equal(args[0], 7); assert.equal(args[6], 1); return rows.slice(0, 1);
  };
  await f.player.run(); assert.equal(attempts, 2);
  for (const mode of ['retired', 'attempted', 'admitted', 'error']) {
    const h = fixture(5), status = h.protocol.status;
    h.state.high = h.state.stream = 6;
    h.protocol.start = async () => { throw new Error('START not admitted'); };
    h.protocol.status = async (...args) => {
      const rows = await status(...args);
      if (args[0] === VIDEO.stop) for (const row of rows) {
        row.result = 2; row.stream = mode === 'attempted' ? 7 : 6;
        if (mode === 'admitted') row.high = 7;
        if (mode === 'error') row.error = 8;
      }
      return rows;
    };
    await assert.rejects(h.player.run(), /START not admitted/);
    assert.equal(h.player.view.cleanupFailed, mode !== 'retired');
  }
});

test('A busy metadata queue retries without relabelling NALs or skipping pictures', async () => {
  const f = fixture(5); f.state.busyMetadata = 3;
  await f.player.run();
  assert.equal(f.copied(), 5);
  const first = f.calls.filter(row => Array.isArray(row) && row[0] === 'metadata' && row[1] === 1);
  assert.ok(first.length >= 4);
  assert.ok(first.every(row => row[2] === 3));
});

test('Pause waits actual state; paused seek resets, restores and displays a fresh-IDR preview', async () => {
  const f = fixture(20); let flow;
  f.onView = v => {
    if (v.position > 0 && !flow) flow = (async () => {
      await f.player.pause(true);
      assert.equal(f.player.view.paused, true);
      await f.player.seek(750);
      assert.equal(f.player.view.paused, true);
      assert.equal(f.player.view.position, 733);
      await f.player.pause(false);
    })();
  };
  await f.player.run(); await flow;
  const starts = f.calls.filter(row => Array.isArray(row) && row[0] === 'start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1][1], starts[0][1] + 1);
  assert.equal(starts[1][5], 1); assert.equal(starts[1][6], true);
  const reset = f.calls.findIndex(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.reset);
  const start = f.calls.findIndex(row => Array.isArray(row) && row[0] === 'start' && row[1] === starts[1][1]);
  assert.ok(reset < start);
  const send = f.calls.find(row => Array.isArray(row) && row[0] === 'send' && row[1] === starts[1][1]);
  assert.equal(send[3][0][0] & 31, 7); assert.equal(send[3][1][0] & 31, 8); assert.equal(send[3][2][0] & 31, 5);
});

// Large keyframes: picture 10's IDR is two slices (NALs 13 and 14); `nal` names the last one.
function slicedFixture() {
  const f = fixture(20);
  f.clip.h264.nals.splice(13, 0, {...f.clip.h264.nals[13]});
  for (const picture of f.clip.pictures.slice(10)) picture.nal++;
  f.clip.pictures[10].first = 13;
  f.clip.slices = true;
  return f;
}

test('Large-keyframe clips are refused before START unless both lenses decode split pictures', async () => {
  const f = slicedFixture();
  await assert.rejects(f.player.run(), /Update both lenses to play this video's large keyframes/);
  assert.ok(!f.calls.some(row => Array.isArray(row) && row[0] === 'start'));
});

test('A seek into a split keyframe sends every slice from its first one', async () => {
  const f = slicedFixture(); let flow;
  f.protocol.slices = true;
  f.onView = v => {
    if (v.position > 0 && !flow) flow = f.player.seek(750);
  };
  await f.player.run(); await flow;
  const starts = f.calls.filter(row => Array.isArray(row) && row[0] === 'start');
  assert.equal(starts.length, 2);
  const sent = f.calls.filter(row => Array.isArray(row) && row[0] === 'send' && row[1] === starts[1][1]).flatMap(row => row[3]);
  assert.deepEqual(sent.slice(0, 4).map(row => row[1]), [0, 1, 13, 14]);
  // After SPS and PPS, the keyframe's picture completes at its second slice.
  const after = f.calls.slice(f.calls.indexOf(starts[1]));
  assert.deepEqual(after.find(row => Array.isArray(row) && row[0] === 'metadata').slice(1), [1, 3, f.clip.pictures[10].pts]);
  assert.equal(f.state.shown.at(-1).pts, f.clip.pictures[19].pts);
});

test('An idle POWER error left by an interrupted stream does not block the next playback', async () => {
  const f = fixture(20);
  f.state.staleError = 16;
  await f.player.run();
  assert.equal(f.player.view.error, null);
  assert.equal(f.state.shown.length, 20);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'start'));
});

test('A pause longer than the copy-progress limit resumes without a stall error', async () => {
  const f = fixture(20); let flow;
  f.onView = v => {
    if (v.position > 0 && !flow) flow = (async () => {
      await f.player.pause(true);
      await f.player.sleep(31_000);
      await f.player.pause(false);
    })();
  };
  await f.player.run(); await flow;
  assert.equal(f.player.view.error, null);
  assert.equal(f.state.shown.length, 20);
});

test('Firmware menu apply hands seek to the same writer and scale uses values 1/2', async () => {
  const f = fixture(20); let flow;
  f.onView = v => {
    if (v.position > 0 && !flow) flow = (async () => {
      await f.player.menu('open'); await f.player.menu('next'); await f.player.menu('next');
      await f.player.menu('apply');
      assert.equal(f.player.view.position, 1267);
      await f.player.scale(true); await f.player.scale(false);
      await f.player.pause(false);
    })();
  };
  await f.player.run(); await flow;
  assert.equal(f.calls.filter(row => Array.isArray(row) && row[0] === 'start').length, 2);
  assert.deepEqual(f.calls.filter(row => Array.isArray(row) && row[0] === 'owned' && row[1] === VIDEO.scale).map(row => row[2]), [1, 2]);
});

test('Paired NAL failure still STOPs; evidence failure never prevents a STOP attempt', async () => {
  const f = fixture(); f.state.refusal = true;
  await assert.rejects(f.player.run(), /refused/);
  assert.equal(f.closed(), true);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
  const h = fixture();
  h.protocol.sendNals = async () => { h.state.failedSample = true; throw new Error('send failed'); };
  await assert.rejects(h.player.run(), /cleanup failed/);
  assert.ok(h.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
  assert.equal(h.player.view.cleanupFailed, false);
});

test('Cleared ownership cannot erase the original-pair restoration obligation', async () => {
  const f = fixture(5), sample = f.protocol.phy, send = f.protocol.sendNals;
  let clear = false;
  f.protocol.sendNals = async (...args) => { await send(...args); clear = true; };
  f.protocol.phy = async () => {
    const rows = await sample();
    if (clear) for (const row of rows) {
      row[13] &= ~32; row[38] = 0; put(row, 40, 0);
      row[34] = row[36] = 2;
    }
    return rows;
  };
  await assert.rejects(f.player.run(), /restored/);
  assert.equal(f.player.view.cleanupFailed, true);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
});

test('Every bound peer remains checked even when it carries no video or SHOWN is busy', async () => {
  const baseline = [1, 2].map(lens => parseVideoPhy(phy(lens, true), lens));
  videoLive(baseline, baseline);
  for (const change of [{epoch: 41}, {valid: false}, {pending: true}, {uncertain: true},
      {status: 1}, {bound: false}, {phase: 9}]) {
    const current = structuredClone(baseline);
    Object.assign(current[1].links[0], change);
    assert.throws(() => videoLive(baseline, current), /health/);
  }
  const f = fixture(5), sample = f.protocol.phy, send = f.protocol.sendNals;
  let unsafe = false;
  f.state.detailedReports = true;
  f.protocol.sendNals = async (...args) => { await send(...args); unsafe = true; };
  f.protocol.shown = async (_stream, _token, lens) => shown(lens, 0, 0, 0, 0, 0);
  f.protocol.phy = async () => {
    const rows = await sample();
    if (unsafe && f.state.active) rows[1][15] = 1;
    return rows;
  };
  await assert.rejects(f.player.run(), /health/);
  assert.equal(f.player.view.cleanupFailed, false);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
});

test('An audio pause error cannot prevent STOP and an unsafe restore remains explicit', async () => {
  const f = fixture(5);
  f.player.audio.pause = async () => {throw new Error('audio pause failed');};
  await assert.rejects(f.player.run(), /audio pause/);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
  assert.equal(f.player.view.cleanupFailed, false);
  const h = fixture(5); const send = h.protocol.sendNals;
  h.protocol.sendNals = async (...args) => {await send(...args); h.state.wrongRestore = true;};
  await assert.rejects(h.player.run(), /restored/);
  assert.equal(h.player.view.cleanupFailed, true);
});

test('Bounded control queue refuses overflow and explicit STOP rejects outstanding intents', async () => {
  const f = fixture(); const requests = [];
  f.onView = v => {
    if (v.active && !requests.length) {
      for (let i = 0; i < 17; i++) requests.push(f.player.pause(true).catch(error => String(error)));
      f.player.stop();
    }
  };
  await f.player.run();
  const results = await Promise.all(requests);
  assert.ok(results[16].includes('queue full'));
  assert.ok(results.slice(0, 16).every(result => result.includes('ended')));
  assert.equal(f.closed(), true);
  assert.ok(!f.calls.some(row => Array.isArray(row) && row[0] === 'start'));
});

test('Paused seek previews report even when input credits remain available', async () => {
  const f = fixture(20), shown = f.protocol.shown;
  let intent = false;
  f.onView = view => {
    if (view.position === 667 && view.active) f.player.stop();
    else if (view.active && !intent) { intent = true; f.player.pause(true).catch(() => {}); }
  };
  f.protocol.shown = async (...args) => {
    const generation = f.player.generation;
    assert.ok(generation.index > 0 && generation.index < generation.count,
      'Preview must not wait for every input NAL before reporting');
    return shown(...args);
  };
  await f.player.run(700, true).catch(error => {
    f.player.stop(); throw error;
  });
  assert.equal(f.player.view.position, 667);
  assert.equal(f.closed(), true);
});

test('Cancel during START PHY refresh is a clean cancel, not dirty host links', async () => {
  const f = fixture(20), phy = f.protocol.phy;
  f.protocol.phy = async () => {
    const rows = await phy();
    for (const row of rows) row[13] &= ~4;
    f.player.stop();
    return rows;
  };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  assert.equal(f.player.view.cleanupFailed, false);
  assert.ok(!f.calls.some(row => Array.isArray(row) && row[0] === 'start'));
});

test('Cancel during a NAL read still retires owners without reporting a source failure', async () => {
  const f = fixture(20);
  f.player.source.readNal = async () => { f.player.stop(); throw new Error('Video source closed'); };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  assert.equal(f.player.view.cleanupFailed, false);
  assert.ok(f.calls.some(row => Array.isArray(row) && row[0] === 'status' && row[1] === VIDEO.stop));
});

test('Audio sync anchors on the oldest retained SHOWN row, which is over two seconds old below 13 fps', async () => {
  const sync = require('../.test-build/app/apps/video/video-av-sync').VideoAvSync.prototype, anchor = sync.anchor;
  const anchors = [];
  sync.anchor = function (pts, at) { anchors.push(pts); return anchor.call(this, pts, at); };
  try {
    const f = fixture(240, 80);
    f.state.oldestShown = true;
    f.player.audio = {sync: async () => {}, pause: async () => {}, close: async () => {}, position: () => 0};
    f.onView = () => { if (anchors.length >= 3) f.player.stop(); };
    await f.player.run();
    assert.equal(f.player.view.error, null);
    assert.ok(anchors.length >= 3, `anchors=${anchors.join(',')}`);
    assert.ok(anchors.at(-1) > anchors[0]);
  } finally { sync.anchor = anchor; }
});

test('Shown anchors stay on phone time when the lens tick runs 2% fast and replies carry their tick', async () => {
  const sync = require('../.test-build/app/apps/video/video-av-sync').VideoAvSync.prototype, anchor = sync.anchor;
  const anchors = [];
  sync.anchor = function (pts, at) { anchors.push({pts, at}); return anchor.call(this, pts, at); };
  try {
    const f = fixture(400, 100);
    f.state.oldestShown = true; f.state.tickScale = 1.02; f.state.replyTicks = true;
    f.player.audio = {sync: async () => {}, pause: async () => {}, close: async () => {}, position: () => 0};
    f.onView = () => { if (anchors.length >= 6) f.player.stop(); };
    await f.player.run();
    assert.equal(f.player.view.error, null);
    const shownAt = new Map(f.state.shown.map(row => [row.pts, row.at]));
    const errors = anchors.map(a => Math.round(Math.abs(a.at - shownAt.get(a.pts))));
    assert.ok(anchors.length >= 6, `anchors=${anchors.length}`);
    // The START mapping is off by 2% of the session time; a reply tick only by 2% of a row's age.
    assert.ok(Math.max(...errors) < 100, `anchor errors ${errors.join(',')} ms`);
  } finally { sync.anchor = anchor; }
});

test('Picture-led audio starts at the first shown frame with a seek, then plays or holds without extra seeks', async () => {
  const f = fixture(40);
  const clock = {playing: false, base: 0, at: 0, speed: 1}, events = [];
  const now = () => f.player.clock();
  const position = () => clock.playing ? clock.base + (now() - clock.at) * clock.speed : clock.base;
  f.player.audio = {
    sync: async (target, playing, speed, tolerance) => {
      const current = position();
      clock.base = Math.abs(current - target) > tolerance ? target : current; clock.at = now();
      clock.playing = playing; clock.speed = speed; events.push({kind: 'sync', target, tolerance});
    },
    pause: async () => { clock.base = position(); clock.at = now(); clock.playing = false; events.push({kind: 'pause'}); },
    close: async () => {},
    position,
  };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  const first = events.findIndex(e => e.kind === 'sync');
  assert.ok(first >= 0 && events[first].tolerance === 0, 'starts with a seek to the shown picture');
  assert.ok(events.every(e => e.kind !== 'sync' || e.tolerance === 0 || e.tolerance === 1_000_000_000));
  assert.ok(f.player.view.position > 0);
});

test('The audio timing setting moves the start seek that far ahead of the shown picture', async () => {
  const starts = [];
  for (const offset of [0, 300]) {
    const f = fixture(40); f.state.audioOffsetMs = offset;
    const clock = {playing: false, base: 0, at: 0, speed: 1}, targets = [];
    const now = () => f.player.clock();
    const position = () => clock.playing ? clock.base + (now() - clock.at) * clock.speed : clock.base;
    f.player.audio = {
      sync: async (target, playing, speed, tolerance) => {
        const current = position();
        clock.base = Math.abs(current - target) > tolerance ? target : current; clock.at = now();
        clock.playing = playing; clock.speed = speed; if (tolerance === 0) targets.push(target);
      },
      pause: async () => { clock.base = position(); clock.at = now(); clock.playing = false; },
      close: async () => {},
      position,
    };
    await f.player.run();
    assert.equal(f.player.view.error, null);
    starts.push(targets[0]);
  }
  assert.equal(starts[1] - starts[0], 300);
});

function clockedAudio(f) {
  const clock = {playing: false, base: 0, at: 0, speed: 1}, events = [];
  const now = () => f.player.clock();
  const position = () => clock.playing ? clock.base + (now() - clock.at) * clock.speed : clock.base;
  f.player.audio = {
    sync: async (target, playing, speed, tolerance) => {
      const current = position();
      clock.base = Math.abs(current - target) > tolerance ? target : current; clock.at = now();
      clock.playing = playing; clock.speed = speed; events.push({kind: 'sync', target, speed, tolerance, at: now()});
    },
    pause: async () => { clock.base = position(); clock.at = now(); clock.playing = false; events.push({kind: 'pause', at: now()}); },
    close: async () => {},
    position,
  };
  return {events, position};
}

function paceRecorder(f, position) {
  const paces = [];
  f.protocol.pace = async (stream, tokens, ordinal, ticks) => {
    paces.push({ordinal, ticks: [...ticks], at: f.player.clock(), heard: position()});
    return [1, 2].map(() => { const row = new Uint8Array(36); row.set([1, VIDEO.pace, 0]); return row; });
  };
  return paces;
}

test('Audio master: a stalled picture restarts ahead at the audio once, never pausing or seeking the audio', async () => {
  const f = fixture(150); f.state.tickScale = 1.014; f.state.replyTicks = true;
  const {events} = clockedAudio(f);
  const paces = paceRecorder(f, () => 0);
  // After the second PACE the lenses stall: no pictures shown and no decoder room,
  // as when decoding or delivery stops. A new START (the skip) clears it.
  const owned = f.protocol.owned, start = f.protocol.start, pace = f.protocol.pace;
  f.protocol.pace = async (...args) => { const rows = await pace(...args); if (paces.length === 3) f.state.stall = true; return rows; };
  f.protocol.owned = async (op, stream, tokens, length, value) => {
    if (op !== VIDEO.credits) return owned(op, stream, tokens, length, value);
    // Like the firmware's decoded queue, decoding runs at most six pictures past the
    // screen (three parameter NALs precede the pictures); a stall shows nothing new.
    const rows = f.state.stall ? [1, 2].map(() => { const raw = new Uint8Array(6); put(raw, 0, f.state.expected); return raw; }) :
      await owned(op, stream, tokens, length, value);
    const free = Math.max(0, Math.min(4, 3 + f.state.shown.length + 6 - f.state.expected));
    for (const raw of rows) raw[4] = 32 | free;
    return rows;
  };
  f.protocol.start = async (...args) => { f.state.stall = false; return start(...args); };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  const starts = f.calls.filter((row) => Array.isArray(row) && row[0] === 'start');
  assert.ok(starts.length >= 2 && starts.length <= 4, `starts ${starts.length}`);
  const syncs = events.filter((e) => e.kind === 'sync');
  assert.equal(syncs.length, 1, JSON.stringify(events)); // the first shown picture only
  assert.ok(!events.some((e) => e.kind === 'pause' && e.at < f.player.clock() - 1000));
  assert.ok(paces.length > 1);
});

test('Audio master: PACE firmware gets the pictures paced while audio plays untouched at normal speed', async () => {
  // Pictures here come slightly faster than real time, so only the pacing arithmetic is under test.
  const f = fixture(150, 50); f.state.tickScale = 1.014; f.state.replyTicks = true;
  const {events, position} = clockedAudio(f);
  const paces = [];
  f.protocol.pace = async (stream, tokens, ordinal, ticks) => {
    paces.push({ordinal, ticks: [...ticks], at: f.player.clock(), heard: position()});
    return [1, 2].map(() => { const row = new Uint8Array(36); row.set([1, VIDEO.pace, 0]); return row; });
  };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  // The probe asks for a picture 20 s out, which firmware ignores.
  assert.equal(paces[0].ordinal, 1);
  assert.ok(paces[0].ticks.every((tick) => tick > Math.round(paces[0].at * 1.014) + 19_000));
  const real = paces.slice(1);
  assert.ok(real.length >= 2, `paces ${real.length}`);
  // Audio starts once on the shown picture at normal speed, then is never nudged, paused or re-seeked.
  const syncs = events.filter((e) => e.kind === 'sync');
  assert.ok(syncs.length >= 1 && syncs.every((e) => e.speed === 1), JSON.stringify(syncs));
  const started = syncs[0].at;
  assert.ok(!events.some((e) => e.at > started && (e.kind === 'pause' && e.at < real.at(-1).at || e.kind === 'sync' && e !== syncs[0])),
    JSON.stringify(events));
  const pts = f.clip.pictures.map((picture) => picture.pts);
  for (const pace of real) {
    // Picture N is due when the audio heard reaches its time, in each lens's 1.4%-fast clock.
    const due = pace.at + pts[pace.ordinal - 1] - pace.heard;
    assert.ok(due >= pace.at + 400 - 70, `due ${due} at ${pace.at}`);
    for (const tick of pace.ticks) assert.ok(Math.abs((tick - Math.round(due * 1.014)) | 0) <= 100, `tick ${tick} due ${due}`);
  }
  assert.ok(real.every((pace, i) => !i || pace.ordinal > real[i - 1].ordinal));
});

test('Firmware without PACE keeps picture-led audio sync', async () => {
  const f = fixture(40);
  clockedAudio(f);
  let calls = 0;
  f.protocol.pace = async () => { calls++; return [1, 2].map(() => { const row = new Uint8Array(36); row.set([1, 7, 1]); return row; }); };
  await f.player.run();
  assert.equal(f.player.view.error, null);
  assert.equal(calls, 1); // only the probe
});
