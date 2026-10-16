import { VIDEO_DEFAULT_RATE, type VideoPictureRate } from "./video-rate";

/** Phone audio follows the picture the glasses actually show. */
export type VideoAvAction =
  | { kind: "none" }
  | { kind: "pause"; reason: string; lag: number | null }
  | { kind: "play"; position: number; seek: boolean; speed: number; reason: string; lag: number | null };

export type VideoAvOptions = {
  /** One picture at the clip's fixed cadence. */
  frameMs: number;
  /** Hold audio when it runs this far ahead of the picture. */
  holdMs: number;
  /** Resume held audio once it is this far behind the picture. */
  resumeMs: number;
  /** Seek audio forward when it falls this far behind the picture. */
  behindMs: number;
  /** First guess of how long a MediaPlayer seek takes; learned afterwards. */
  seekLeadMs: number;
  /** Slow steady drift is absorbed by speed, not by audible holds. */
  minSpeed: number;
  /** The lenses pace pictures by their own tick, which can run slightly fast against the phone. */
  maxSpeed: number;
  speedStep: number;
  speedIntervalMs: number;
  /** Anchors this far apart measure the long-term picture rate. */
  rateWindowMs: number;
  /** After a seek or start, wait this long and for audio to move before judging it. */
  settleMs: number;
  /** Give up waiting for audio to move after this long. */
  settleLimitMs: number;
  /** At most one corrective seek per interval. */
  resyncIntervalMs: number;
  /** Audio must stay behind this long before a corrective seek. */
  behindConfirmMs: number;
  /** A smaller steady lag is corrected once it has lasted this long. */
  steadyBehindMs: number;
  steadyConfirmMs: number;
};

// The sandbox's hold rule (playback-controller.ts updateAudioSyncHold):
// hold beyond max(80 ms, 1.5 frames), resume at max(50 ms, half a frame) behind.
export const VIDEO_AV_DEFAULTS: VideoAvOptions = {
  frameMs: 1000 / VIDEO_DEFAULT_RATE, holdMs: Math.max(80, 1500 / VIDEO_DEFAULT_RATE), resumeMs: Math.max(50, 500 / VIDEO_DEFAULT_RATE), behindMs: 200,
  // A lens tick about 2% fast needs fine speed steps (1.5% stopped short and left a seek every
  // few seconds), and an 8 s rate window keeps report timing noise from hunting the speed.
  seekLeadMs: 60, minSpeed: 0.95, maxSpeed: 1.05, speedStep: 0.004, speedIntervalMs: 3000, rateWindowMs: 8000,
  settleMs: 500, settleLimitMs: 2000, resyncIntervalMs: 1500, behindConfirmMs: 300,
  steadyBehindMs: 100, steadyConfirmMs: 2000,
};
/** Keep the existing frame-based hold policy at the selected clip cadence. */
export function videoAvOptions(fps: VideoPictureRate): VideoAvOptions {
  return {...VIDEO_AV_DEFAULTS, frameMs: 1000 / fps, holdMs: Math.max(80, 1500 / fps), resumeMs: Math.max(50, 500 / fps)};
}

/**
 * A video clock from exact paired SHOWN anchors, extrapolated at the fixed
 * cadence and capped by the newest picture the decoder has taken, so it stops
 * when the glasses' queue runs dry instead of running ahead of the screen.
 */
export class VideoAvSync {
  private anchorPts: number | null = null;
  private anchorAt = 0;
  private cap: number | null = null;
  private rateFrom: { pts: number; at: number } | null = null;
  private rate = 1;
  private speed = 1;
  private speedAt = Number.NEGATIVE_INFINITY;
  private playingSpeed = 1;
  private holding = false;
  private started = false;
  private lead: number;
  private actionAt: number | null = null;
  private actionPosition = 0;
  private resyncAt = Number.NEGATIVE_INFINITY;
  private behindSince: number | null = null;

  constructor(private readonly duration: number, private readonly options: VideoAvOptions = VIDEO_AV_DEFAULTS) {
    this.lead = options.seekLeadMs;
  }

  /** The picture kept moving for `milliseconds` while audio sought and started. */
  seekTook(milliseconds: number): void { this.learnLead(milliseconds); }

  private learnLead(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.lead = Math.round((this.lead + Math.min(milliseconds, 400)) / 2);
  }

  get measuredRate(): number { return this.rate; }

  /** Picture `pts` appeared on both lenses at phone time `at`. */
  anchor(pts: number, at: number): void {
    if (!Number.isFinite(pts) || !Number.isFinite(at)) return;
    if (this.anchorPts !== null && at <= this.anchorAt) return;
    if (!this.rateFrom || pts < this.rateFrom.pts) this.rateFrom = { pts, at };
    else if (at - this.rateFrom.at >= this.options.rateWindowMs) {
      const measured = Math.max(0, Math.min(this.options.maxSpeed, (pts - this.rateFrom.pts) / (at - this.rateFrom.at)));
      this.rate = (this.rate + measured) / 2;
      this.rateFrom = { pts, at };
    }
    this.anchorPts = pts; this.anchorAt = at;
  }

  /** Newest picture the decoder has taken; the screen cannot run past it. */
  available(pts: number | null): void { this.cap = pts; }

  /** Restart from a known still picture, e.g. at resume. */
  restart(pts: number, at: number): void {
    // The lenses refill before the held frame moves again; measure the rate from the first shown anchor instead.
    this.anchorPts = pts; this.anchorAt = at; this.rateFrom = null;
    this.holding = false; this.started = false;
  }

  /** The estimated picture time on screen now, or null before the first anchor. */
  video(now: number): number | null {
    if (this.anchorPts === null) return null;
    // Advance at the measured long-term picture rate, so a slow picture does
    // not overshoot between anchors and then snap back.
    let estimate = this.anchorPts + Math.max(0, now - this.anchorAt) * this.rate;
    // The decoder's newest picture may still be decoding; the screen trails it.
    if (this.cap !== null) estimate = Math.min(estimate, Math.max(this.anchorPts, this.cap - this.options.frameMs));
    return Math.min(estimate, this.duration);
  }

  /** A seek already interrupts audio, so it takes the exact measured speed; playing audio moves in steps. */
  private targetSpeed(now: number, seeking = false): number {
    const desired = Math.round(Math.max(this.options.minSpeed, Math.min(this.options.maxSpeed, this.rate)) * 1000) / 1000;
    // Speeds are rounded to 0.001, so allow for binary rounding when comparing against the step.
    if ((seeking || Math.abs(desired - this.speed) >= this.options.speedStep - 1e-9) &&
        now - this.speedAt >= this.options.speedIntervalMs) {
      this.speed = desired; this.speedAt = now;
    }
    return this.speed;
  }

  private play(now: number, position: number, seek: boolean, speed: number, reason: string, lag: number): VideoAvAction {
    const target = Math.max(0, Math.min(this.duration, position));
    this.playingSpeed = speed;
    this.actionAt = now; this.actionPosition = target; this.behindSince = null;
    if (seek) this.resyncAt = now;
    return { kind: "play", position: target, seek, speed, reason, lag };
  }

  /** A fresh seek or start needs time, and audible progress, before its lag means anything. */
  private settled(now: number, audio: number): boolean {
    if (this.actionAt === null) return true;
    const elapsed = now - this.actionAt;
    if (elapsed < this.options.settleMs) return false;
    if (audio < this.actionPosition + 50 && elapsed < this.options.settleLimitMs) return false;
    // Time audio stood still after the command is the real start latency.
    if (audio >= this.actionPosition + 50) this.learnLead(elapsed - (audio - this.actionPosition) / this.playingSpeed);
    this.actionAt = null;
    return true;
  }

  /** One decision; the caller performs it before asking again. */
  decide(now: number, audio: number | null, playing: boolean, paused: boolean): VideoAvAction {
    if (paused) {
      this.holding = false; this.started = false;
      return playing ? { kind: "pause", reason: "video paused", lag: null } : { kind: "none" };
    }
    const video = this.video(now);
    if (video === null) return playing ? { kind: "pause", reason: "waiting for the first shown picture", lag: null } : { kind: "none" };
    if (audio === null) return { kind: "none" };
    const lag = audio - video, speed = this.targetSpeed(now);
    const resync = (reason: string): VideoAvAction => {
      this.started = true; this.holding = false;
      return this.play(now, video + this.lead * this.rate, true, this.targetSpeed(now, true), reason, lag);
    };
    if (!playing) {
      if (!this.started) return resync("start at the shown picture");
      if (!this.holding) return resync("restart at the shown picture");
      if (lag < -this.options.behindMs && now - this.resyncAt >= this.options.resyncIntervalMs)
        return resync("picture far ahead of held audio");
      // Resume early by the start latency so audio begins just behind the picture.
      if (lag <= this.lead * this.rate - this.options.resumeMs) {
        this.holding = false;
        return this.play(now, audio, false, speed, "picture caught up", lag);
      }
      return { kind: "none" };
    }
    if (!this.settled(now, audio)) return { kind: "none" };
    if (lag > this.options.holdMs) {
      this.holding = true; this.behindSince = null;
      return { kind: "pause", reason: "audio ahead of the picture", lag };
    }
    if (lag < -this.options.steadyBehindMs) {
      this.behindSince ??= now;
      const confirm = lag < -this.options.behindMs ? this.options.behindConfirmMs : this.options.steadyConfirmMs;
      if (now - this.behindSince >= confirm && now - this.resyncAt >= this.options.resyncIntervalMs)
        return resync(lag < -this.options.behindMs ? "audio behind the picture" : "audio steadily behind the picture");
      return { kind: "none" };
    }
    this.behindSince = null;
    if (speed !== this.playingSpeed) return this.play(now, audio, false, speed, "match the picture rate", lag);
    return { kind: "none" };
  }
}
