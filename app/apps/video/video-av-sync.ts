/** Phone audio follows the picture the glasses actually show. */
export type VideoAvAction =
  | { kind: "none" }
  | { kind: "pause"; reason: string; lag: number | null }
  | { kind: "play"; position: number; seek: boolean; speed: number; reason: string; lag: number | null };

export type VideoAvOptions = {
  /** One picture at the firmware's fixed 16 fps cadence. */
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
  speedStep: number;
  speedIntervalMs: number;
  /** Anchors this far apart measure the long-term picture rate. */
  rateWindowMs: number;
};

// The sandbox's hold rule (playback-controller.ts updateAudioSyncHold):
// hold beyond max(80 ms, 1.5 frames), resume at max(50 ms, half a frame) behind.
export const VIDEO_AV_DEFAULTS: VideoAvOptions = {
  frameMs: 62.5, holdMs: Math.max(80, 62.5 * 1.5), resumeMs: Math.max(50, 62.5 / 2), behindMs: 150,
  seekLeadMs: 60, minSpeed: 0.95, speedStep: 0.015, speedIntervalMs: 3000, rateWindowMs: 4000,
};

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

  constructor(private readonly duration: number, private readonly options: VideoAvOptions = VIDEO_AV_DEFAULTS) {
    this.lead = options.seekLeadMs;
  }

  /** The picture kept moving for `milliseconds` while audio sought and started. */
  seekTook(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    // Stay below the hold threshold so a fast seek never starts ahead of a hold.
    const bounded = Math.min(milliseconds, this.options.holdMs - 20);
    this.lead = Math.round((this.lead + bounded) / 2);
  }

  get measuredRate(): number { return this.rate; }

  /** Picture `pts` appeared on both lenses at phone time `at`. */
  anchor(pts: number, at: number): void {
    if (!Number.isFinite(pts) || !Number.isFinite(at)) return;
    if (this.anchorPts !== null && at <= this.anchorAt) return;
    if (!this.rateFrom || pts < this.rateFrom.pts) this.rateFrom = { pts, at };
    else if (at - this.rateFrom.at >= this.options.rateWindowMs) {
      const measured = Math.max(0, Math.min(1, (pts - this.rateFrom.pts) / (at - this.rateFrom.at)));
      this.rate = (this.rate + measured) / 2;
      this.rateFrom = { pts, at };
    }
    this.anchorPts = pts; this.anchorAt = at;
  }

  /** Newest picture the decoder has taken; the screen cannot run past it. */
  available(pts: number | null): void { this.cap = pts; }

  /** Restart from a known still picture, e.g. at resume. */
  restart(pts: number, at: number): void {
    this.anchorPts = pts; this.anchorAt = at; this.rateFrom = { pts, at };
    this.holding = false; this.started = false;
  }

  /** The estimated picture time on screen now, or null before the first anchor. */
  video(now: number): number | null {
    if (this.anchorPts === null) return null;
    let estimate = this.anchorPts + Math.max(0, now - this.anchorAt);
    // The decoder's newest picture may still be decoding; the screen trails it.
    if (this.cap !== null) estimate = Math.min(estimate, Math.max(this.anchorPts, this.cap - this.options.frameMs));
    return Math.min(estimate, this.duration);
  }

  private targetSpeed(now: number): number {
    const desired = Math.round(Math.max(this.options.minSpeed, Math.min(1, this.rate)) * 1000) / 1000;
    if (Math.abs(desired - this.speed) >= this.options.speedStep && now - this.speedAt >= this.options.speedIntervalMs) {
      this.speed = desired; this.speedAt = now;
    }
    return this.speed;
  }

  private play(position: number, seek: boolean, speed: number, reason: string, lag: number): VideoAvAction {
    this.playingSpeed = speed;
    return { kind: "play", position: Math.max(0, Math.min(this.duration, position)), seek, speed, reason, lag };
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
      return this.play(video + this.lead, true, speed, reason, lag);
    };
    if (!playing) {
      if (!this.started) return resync("start at the shown picture");
      if (!this.holding) return resync("restart at the shown picture");
      if (lag < -this.options.behindMs) return resync("picture far ahead of held audio");
      if (lag <= -this.options.resumeMs) {
        this.holding = false;
        return this.play(audio, false, speed, "picture caught up", lag);
      }
      return { kind: "none" };
    }
    if (lag > this.options.holdMs) {
      this.holding = true;
      return { kind: "pause", reason: "audio ahead of the picture", lag };
    }
    if (lag < -this.options.behindMs) return resync("audio behind the picture");
    if (speed !== this.playingSpeed) return this.play(audio, false, speed, "match the picture rate", lag);
    return { kind: "none" };
  }
}
