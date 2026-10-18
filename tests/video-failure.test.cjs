const test = require('node:test');
const assert = require('node:assert/strict');
const {videoFailureLines, videoNalChecksum} = require('../.test-build/app/apps/video/video-failure');
const {VideoProtocol, parseVideoStatus} = require('../.test-build/app/apps/video/video-protocol');
function put(row, at, value) { new DataView(row.buffer).setUint32(at, value, true); }
function evidence(side = 1) {
  const rows = [0, 1].map(mode => { const row = new Uint8Array(128); row.set([1, 7, 0, 7, mode, 1, side, 1]); put(row, 8, 7); return row; });
  const [d, h] = rows, bytes = Uint8Array.of(0x61, 1, 2), checksum = videoNalChecksum(bytes);
  [[20, 12], [24, 3], [28, 1], [32, checksum], [36, checksum], [40, 4], [60, 99], [92, 1], [120, 1], [124, 1]].forEach(([a, v]) => put(d, a, v));
  put(h, 12, 12); put(h, 16, 1); put(h, 32, 11); put(h, 36, checksum); h[40] = 3; h[42] = 1;
  return {rows, sent: [11, 12].map(sequence => ({sequence, source: sequence + 100, type: 1, length: 3, checksum}))};
}
test('FNV matches firmware including unsigned multiplication and empty input', () => {
  assert.equal(videoNalChecksum(new TextEncoder().encode('hello')), 0x4f9f2cab);
  assert.equal(videoNalChecksum(new Uint8Array()), 2166136261);
});
test('Retained current and previous NALs compare only within the same stream', () => {
  const {rows, sent} = evidence();
  let lines = videoFailureLines(1, 7, ...rows, sent);
  assert.equal(lines.filter(line => / NAL .* match/.test(line)).length, 2);
  assert.ok(lines.some(line => /source=112/.test(line)));
  sent[1].checksum++;
  assert.ok(videoFailureLines(1, 7, ...rows, sent).some(line => /failing MISMATCH/.test(line)));
  put(rows[0], 36, 42);
  assert.ok(videoFailureLines(1, 7, ...rows, sent).at(-1).includes('MISMATCH during decode'));
  assert.ok(videoFailureLines(1, 8, ...rows, sent).some(line => line.includes('STALE STREAM')));
  assert.ok(videoFailureLines(1, 7, ...rows, []).some(line => line.includes('NO PHONE EVIDENCE')));
  put(rows[0], 120, 0);
  assert.match(videoFailureLines(1, 7, ...rows, sent).at(-1), /second checksum not sampled/);
});
test('Reject mixed, truncated, wrong-lens and malformed retained snapshots', () => {
  for (const mutate of [r => r[0].subarray(0, 127), r => {r[1][6] = 2;},
    r => {put(r[1], 8, 8);}, r => {put(r[1], 16, 9);}, r => {r[1][7] = 0;}]) {
    const {rows, sent} = evidence(); const replacement = mutate(rows); if (replacement) rows[0] = replacement;
    assert.throws(() => videoFailureLines(1, 7, ...rows, sent));
  }
  const {rows} = evidence(); rows.forEach(row => row[7] = 0);
  assert.match(videoFailureLines(1, 7, ...rows, [])[0], /no retained/);
});
test('Queries fetch lenses separately with explicit kind and row selectors', async () => {
  const calls = []; let request = 10;
  const p = new VideoProtocol({epoch: () => 1, exchange: async (raw, length, side) => {
    calls.push([raw.slice(), length, side]); return [evidence(side).rows[raw[9]]];
  }}, () => request++);
  for (const side of [1, 2]) for (const mode of [0, 1]) await p.failureDiagnostics(side, mode);
  assert.deepEqual(calls.map(([raw, length, side]) => [raw[1], raw[8], raw[9], length, side]),
    [[7, 7, 0, 128, 1], [7, 7, 1, 128, 1], [7, 7, 0, 128, 2], [7, 7, 1, 128, 2]]);
  await assert.rejects(p.failureDiagnostics(3, 0));
});
