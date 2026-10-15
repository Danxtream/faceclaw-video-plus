import { videoU32 } from "./video-protocol";

declare const console: { error(message: string): void };
export type VideoRateWindow = {
  serial: number; start: number; shown: number; gap: number; input: number; output: number;
  service: number; overrun: number; decodeMax: number; notReady: number; flags: number; ordinal: number;
  reportOverlap?: boolean; controlOverlap?: boolean;
  phases: number[];
};
type Distribution = { n: number; minimum: number; histogram: Map<number, number> };
const distribution = (): Distribution => ({n: 0, minimum: Infinity, histogram: new Map()});
function add(d: Distribution, fps: number): void {
  d.n++; d.minimum = Math.min(d.minimum, fps); d.histogram.set(fps, (d.histogram.get(fps) ?? 0) + 1);
}
function result(d: Distribution): { n: number; minimum: number | null; low1: number | null } {
  let rank = Math.ceil(d.n * 0.01), low: number | null = null;
  for (const [fps, count] of [...d.histogram].sort((a, b) => a[0] - b[0])) {
    rank -= count; if (rank <= 0) { low = fps; break; }
  }
  return {n: d.n, minimum: d.n ? d.minimum : null, low1: low};
}

/** Read-only summaries never drive credits, audio, controls or recovery. */
export class VideoMeasurement {
  readonly cursors = [1, 1];
  readonly dipCursors = [1, 1];
  private generation = [0, 0];
  private high = [0, 0];
  private ended = [false, false];
  private pending = [new Map<number, VideoRateWindow>(), new Map<number, VideoRateWindow>()];
  private lenses = [distribution(), distribution()];
  private paired = distribution();
  private sliding = distribution();
  private slidingBad = 0;
  private previous: VideoRateWindow[] | null = null;
  private missing = 0;
  private bad = 0;
  private paused = 0;
  private runStart = 0;
  private runLength = 0;
  private longest = 0;
  private maxGap = 0;
  private gapHistograms: number[][] = [[], []];
  private unavailable = 0;
  private supported = false;
  private lastPair = 0;
  private causes: Record<string, number> = {};
  private overlaps = {report: 0, control: 0};
  private reportSpans: {from: number; to: number; kind: string}[] = [];
  private spanTotals: Record<string, {count: number; totalMs: number; maxMs: number}> = {};
  constructor(private readonly stream: number, private readonly tokens: readonly number[]) {}

  span(from: number, to: number, kind: string): void {
    if (to < from) { this.missing++; return; }
    this.reportSpans.push({from, to, kind});
    const total = this.spanTotals[kind] ??= {count: 0, totalMs: 0, maxMs: 0};
    total.count++; total.totalMs += to - from; total.maxMs = Math.max(total.maxMs, to - from);
    if (this.reportSpans.length > 128) this.reportSpans.shift();
  }
  unavailableSample(error: unknown): void {
    this.unavailable++;
    console.error(`Video measurement unavailable stream=${this.stream}: ${error}`);
  }
  /** The same frame's per-lens local-copy epochs define the two window grids. */
  accept(rows: readonly Uint8Array[], mode = 0, hostAnchors?: readonly number[]): boolean {
    if (rows.length !== 2 || ![0, 1, 2].includes(mode)) throw new Error("Missing paired cadence evidence");
    this.supported = true;
    let bad = false;
    rows.forEach((raw, side) => {
      if (raw.length !== (mode ? 128 : 144) || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 6 ||
          raw[4] !== 1 || raw[5] !== mode || raw[6] !== side + 1 || raw[7] & ~7 ||
          videoU32(raw, 8) !== this.stream || videoU32(raw, 16) !== this.tokens[side] ||
          !videoU32(raw, 12) || raw[29] !== (mode === 2 ? 4 : mode ? 32 : 56) || raw[28] > (mode === 2 ? 16 : mode ? 3 : 2) || raw[30] || raw[31])
        throw new Error("Invalid cadence evidence identity or schema");
      const generation = videoU32(raw, 12), high = videoU32(raw, 24);
      if (!mode) { this.high[side] = high; this.ended[side] = !!(raw[7] & 2); }
      if (this.generation[side] && generation !== this.generation[side]) throw new Error("Cadence generation changed");
      this.generation[side] = generation;
      if (raw[7] & 4) this.missing++;
      if (mode === 2) {
        const histogram = Array.from({length: 16}, (_, i) => videoU32(raw, 32 + i * 4));
        if (raw[28] !== 16 || histogram.reduce((a, b) => a + b, 0) !== high) throw new Error("Invalid gap histogram");
        this.gapHistograms[side] = histogram;
        this.maxGap = Math.max(this.maxGap, videoU32(raw, 96));
        return;
      }
      const cursors = mode ? this.dipCursors : this.cursors;
      for (let i = 0; i < raw[28]; i++) {
        const at = 32 + i * raw[29], serial = videoU32(raw, at);
        if (serial > high || serial < Math.max(1, high - 7) || serial < cursors[side])
          throw new Error("Invalid cadence history order");
        if (serial > cursors[side]) this.missing += serial - cursors[side];
        cursors[side] = serial + 1;
        if (mode) {
          console.error(`Video dip stream=${this.stream} side=${side + 1} row=${JSON.stringify(
            Array.from({length: 8}, (_, j) => videoU32(raw, at + j * 4)))}`);
          continue;
        }
        const v = Array.from({length: 14}, (_, j) => videoU32(raw, at + j * 4));
        const row: VideoRateWindow = {serial, start: v[1], shown: v[2], gap: v[3], input: v[4], output: v[5],
          service: v[6], overrun: v[7], decodeMax: v[8], notReady: v[9], flags: v[10], ordinal: v[11],
          phases: Array.from({length: 10}, (_, j) => (v[j < 8 ? 12 : 13] >>> ((j % 8) * 4)) & 15)};
        if (row.start !== ((serial - 1) * 1000 >>> 0) || row.shown > 1000 || row.flags & ~63 ||
            row.input + row.output + row.service > 1000 || row.notReady > 1000 || v[13] & ~255 ||
            row.phases.reduce((a,b) => a+b,0) !== row.shown)
          throw new Error("Inconsistent cadence window");
        if (row.flags & 32) this.missing++;
        this.pending[side].set(serial, row);
        const host = hostAnchors?.[side];
        const overlaps = host === undefined ? [] : this.reportSpans.filter(span =>
          span.to > host + row.start && span.from < host + row.start + 1000);
        row.reportOverlap = overlaps.some(s => s.kind === "report" || s.kind === "cadence-diagnostic");
        row.controlOverlap = overlaps.some(s => s.kind.startsWith("control:"));
        console.error(`Video shown-window stream=${this.stream} side=${side + 1} ` +
          `row=${JSON.stringify(row)} overlaps=${JSON.stringify(overlaps)} alignment=local-first-copy`);
        bad ||= serial > 1 && row.shown < 16 && !(row.flags & 16);
        if (this.pending[side].size > 8) {
          this.pending[side].delete(this.pending[side].keys().next().value!); this.missing++;
        }
      }
    });
    for (const [serial, left] of this.pending[0]) {
      const right = this.pending[1].get(serial);
      if (!right) continue;
      this.pending[0].delete(serial); this.pending[1].delete(serial);
      if (serial <= this.lastPair) throw new Error("Cadence pair moved backwards");
      if (this.lastPair && serial > this.lastPair + 1) { this.missing += serial - this.lastPair - 1; this.closeDip(); this.previous = null; }
      this.lastPair = serial;
      if (serial === 1) continue; // One explicitly reported warm-up second.
      if ((left.flags | right.flags) & 16) { this.paused++; this.closeDip(); this.previous = null; continue; }
      const fps = Math.min(left.shown, right.shown);
      add(this.lenses[0], left.shown); add(this.lenses[1], right.shown); add(this.paired, fps);
      add(this.sliding, fps); if (fps < 15.5) this.slidingBad++;
      if (this.previous) for (let phase = 1; phase < 10; phase++) {
        const rates = [left,right].map((row, side) => this.previous![side].phases.slice(phase).reduce((a,b)=>a+b,0) +
          row.phases.slice(0,phase).reduce((a,b)=>a+b,0));
        const rate = Math.min(...rates); add(this.sliding,rate); if (rate < 15.5) this.slidingBad++;
      }
      this.previous = [left,right];
      this.maxGap = Math.max(this.maxGap, left.gap, right.gap);
      if (fps < 15.5) {
        if (left.reportOverlap || right.reportOverlap) this.overlaps.report++;
        if (left.controlOverlap || right.controlOverlap) this.overlaps.control++;
        this.bad++;
        if (!this.runLength) this.runStart = left.start;
        this.runLength++; this.longest = Math.max(this.longest, this.runLength);
        const causes = [left, right].filter(r => r.shown < 16).map(r => this.cause(r));
        const cause = causes.every(c => c === causes[0]) ? causes[0] : "mixed_or_unknown";
        this.causes[cause] = (this.causes[cause] ?? 0) + 1;
      } else this.closeDip();
    }
    return bad;
  }
  private cause(r: VideoRateWindow): string {
    if (r.flags & 32) return "unknown";
    if (!r.notReady) return "presentation_or_sync";
    if (r.input && r.controlOverlap && !r.overrun) return "control_correlated";
    if (r.input && r.reportOverlap && !r.overrun) return "report_correlated";
    if (r.overrun && !r.input && !r.output) return "decode_service_correlated";
    if (r.input && !r.overrun && !r.output) return "delivery_suspected";
    return "mixed_or_unknown";
  }
  private closeDip(): void {
    if (this.runLength) console.error(`Video bad-window-run stream=${this.stream} startMs=${this.runStart} durationMs=${this.runLength * 1000}`);
    this.runLength = 0;
  }
  summary(final = false): Record<string, unknown> {
    if (final) this.closeDip();
    const complete = this.supported && !this.missing && !this.pending.some(p => p.size) &&
      this.cursors.every((cursor, side) => cursor > this.high[side]) && this.ended.every(Boolean);
    return {stream: this.stream, status: !final || !complete || !this.paired.n ? "inconclusive" :
      1 - this.bad / this.paired.n >= 0.99 ? "pass" : "fail", coverageMissing: this.missing,
      unavailable: this.unavailable, pending: this.pending.map(p => p.size), left: result(this.lenses[0]),
      right: result(this.lenses[1]), paired: result(this.paired), passingFraction: this.paired.n ? 1 - this.bad / this.paired.n : null,
      sliding100ms: {...result(this.sliding), passingFraction: this.sliding.n ? 1 - this.slidingBad / this.sliding.n : null},
      badWindows: this.bad, longestBadMs: this.longest * 1000, maxCopyGapMs: this.maxGap,
      causeWindows: {...this.causes}, overlappingBadWindows: {...this.overlaps}, pausedWindows: this.paused,
      causeConfidence: "readiness/input/service correlations, not exclusive CPU attribution; unknown retained",
      phoneSpans: {...this.spanTotals}, spanBasis: "inclusive brackets; nested categories must not be added",
      gapPercentileBounds: this.gapHistograms.map(histogram => [0.95, 0.99].map(q => {
        let rank = Math.ceil(q * histogram.reduce((a, b) => a + b, 0));
        if (!rank) return null;
        const bounds = [0, 15, 31, 47, 61, 62, 63, 64, 80, 100, 125, 250, 500, 1000, 5000, 0xffffffff];
        for (let i = 0; i < histogram.length; i++) {
          rank -= histogram[i]; if (rank <= 0) return {lowerMs: i ? bounds[i - 1] + 1 : 0, upperMs: i === 15 ? null : bounds[i]};
        }
        return null;
      })), gapBasis: "all generation intervals, includes requested pauses; histogram bounds, not exact quantiles",
      coarseTail: this.paired.n < 100, basis: "local-copy-completion; not optical; no shared-clock subtraction"};
  }
}
