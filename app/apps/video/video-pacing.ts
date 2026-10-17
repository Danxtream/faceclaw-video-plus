import { videoSeekPoint, type VideoClip } from "./video-clip";

/**
 * Audio-master pacing (firmware PACE, op 25): the phone's audio clock decides
 * when each picture is due, expressed in each lens's own millisecond tick.
 * These models are pure so the timing can be tested without a link.
 */

type LensSample = { mid: number; rtt: number; tick: number };

/**
 * A lens's free-running millisecond tick against the phone clock. Each reading
 * was taken somewhere between sending a query and receiving its reply, so the
 * midpoint carries up to half the round trip of error: offsets come from the
 * tightest recent reading, and the rate (the lens tick runs about 1-2% fast on
 * pair 1) from a weighted fit over the window.
 */
export class VideoLensClock {
  private samples: LensSample[] = [];
  private fitted = 1;

  constructor(private readonly windowMs = 60_000, private readonly limit = 32) {}

  /** A tick read during [sent, received] on the phone clock. */
  add(sent: number, received: number, tick: number): void {
    if (!Number.isFinite(sent) || !(received >= sent) || !Number.isInteger(tick)) return;
    this.samples.push({ mid: (sent + received) / 2, rtt: received - sent, tick: tick >>> 0 });
    while (this.samples.length > this.limit || (this.samples.length > 3 && received - this.samples[0].mid > this.windowMs))
      this.samples.shift();
    this.fit();
  }

  get ready(): boolean { return this.samples.length > 0; }
  /** Lens ticks per phone millisecond; 1 until the fit spans 8 s. */
  get rate(): number { return this.fitted; }

  /** The lens tick at phone time `at`, or null before any reading. */
  tickAt(at: number): number | null {
    let best: LensSample | null = null, score = Infinity;
    for (const sample of this.samples) {
      // A reading's error grows with its age through any rate error (about 1 ms per second).
      const value = sample.rtt / 2 + Math.abs(at - sample.mid) / 1000;
      if (value < score) { score = value; best = sample; }
    }
    return best ? (best.tick + Math.round((at - best.mid) * this.fitted)) >>> 0 : null;
  }

  private fit(): void {
    const s = this.samples;
    if (s.length < 3 || s[s.length - 1].mid - s[0].mid < 8000) return;
    let w = 0, x = 0, y = 0;
    const base = s[0];
    const points = s.map((sample) => ({ x: sample.mid - base.mid, y: (sample.tick - base.tick) | 0, w: 1 / (sample.rtt + 10) }));
    for (const p of points) { w += p.w; x += p.w * p.x; y += p.w * p.y; }
    const mx = x / w, my = y / w;
    let sxy = 0, sxx = 0;
    for (const p of points) { sxy += p.w * (p.x - mx) * (p.y - my); sxx += p.w * (p.x - mx) ** 2; }
    const rate = sxx > 0 ? sxy / sxx : 1;
    if (rate > 0.95 && rate < 1.05) this.fitted = rate;
  }
}

/** The media time being heard, from audio positions read while playing at normal speed. */
export class VideoAudioClock {
  private offsets: number[] = [];
  private from = 0;

  /** Forget readings after a seek or start; positions settle for `settleMs` first. */
  reset(at: number, settleMs = 500): void { this.offsets = []; this.from = at + settleMs; }

  add(at: number, position: number | null): void {
    if (position === null || !Number.isFinite(position) || at < this.from) return;
    this.offsets.push(position - at);
    if (this.offsets.length > 15) this.offsets.shift();
  }

  /** Media milliseconds heard at phone time `at`, or null before enough readings. */
  heard(at: number): number | null {
    if (this.offsets.length < 3) return null;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[sorted.length >> 1] + at;
  }
}

/** Ticks between ordinals `delta` apart at `fps`, exactly as the firmware spaces deadlines. */
export function videoPaceSpan(fps: number, delta: number): number {
  const steps = Math.abs(delta), span = Math.floor(steps / fps) * 1000 + Math.floor((steps % fps) * 1000 / fps);
  return delta < 0 ? -span : span;
}

export type VideoPacePlan = { ordinal: number; due: number; ticks: [number, number] };

/**
 * The picture to re-anchor and its due tick on each lens. Picture N with time P
 * should appear when the audio heard reaches P + offset (Audio timing: positive
 * plays sound earlier); `latency` (copy minus due, in ticks) is subtracted so
 * the copy, not the deadline, lands on time. The chosen picture is the first
 * one due at least `lead` ms from now, so the command arrives before it.
 */
export function videoPacePlan(input: {
  now: number; heard: number; offset: number; pts: readonly number[]; first: number;
  lead: number; clocks: readonly VideoLensClock[]; latency: number;
}): VideoPacePlan | null {
  const { now, heard, offset, pts, lead, clocks, latency } = input;
  if (!pts.length || clocks.length !== 2) return null;
  let ordinal = Math.max(1, Math.min(input.first, pts.length));
  const dueAt = (o: number) => now + pts[o - 1] + offset - heard;
  while (ordinal < pts.length && dueAt(ordinal) < now + lead) ordinal++;
  // Past the last picture's time there is nothing left to schedule: the
  // schedule already sent lets the remaining pictures catch up.
  if (dueAt(ordinal) < now + lead) return null;
  const due = dueAt(ordinal), left = clocks[0].tickAt(due), right = clocks[1].tickAt(due);
  if (left === null || right === null) return null;
  const shift = Math.round(latency);
  return { ordinal, due, ticks: [(left - shift) >>> 0, (right - shift) >>> 0] };
}

/**
 * Where to restart a stalled picture so it lands on the audio: the picture at
 * `milliseconds` when its keyframe is at most `maxPreroll` pictures back
 * (decode-only catch-up), otherwise the next keyframe after it.
 */
export function videoSkipTarget(clip: VideoClip, milliseconds: number, maxPreroll: number): number {
  const at = Math.max(0, Math.min(milliseconds, clip.pictures[clip.pictures.length - 1].pts));
  let point: { frame: number; idr: number } | null = null;
  try { point = videoSeekPoint(clip, at); } catch { point = null; }
  if (point && point.frame - point.idr <= maxPreroll) return clip.pictures[point.frame].pts;
  const from = point ? point.frame : 0;
  for (let i = from + 1; i < clip.pictures.length; i++) if (clip.pictures[i].idr) return clip.pictures[i].pts;
  return clip.pictures[point ? point.frame : 0].pts;
}
