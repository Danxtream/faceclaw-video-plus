import { openVideoSource } from "../../native/video-source";
import { openVideoAudio } from "../../native/video-audio";
import { createVideoProtocol } from "../../native/video-transport";
import { statPath } from "../../native/file-access";
import { saveVideoResumeState } from "../../native/g2-video-library";
import { VideoPlayback, silentVideoAudio, type VideoOptions, type VideoPlaybackView } from "./video-playback";

declare const com: any;

let current: VideoSession | null = null;
const listeners = new Set<() => void>();

/** One phone Video owner; the existing communicator still owns the connection. */
export class VideoSession {
  engine: VideoPlayback | null = null;
  view: VideoPlaybackView | null = null;
  opening = true;
  error: string | null = null;
  hasAudio = false;
  shownCopies = 0;
  private savedAt = 0;
  private cancelled = false;
  private started = false;
  private transportEpoch: number | null = null;
  constructor(readonly path: string, private readonly options: () => VideoOptions) {}
  get ownsDisplay(): boolean { return !!(this.view?.active || this.view?.cleanupFailed); }
  private notify(): void {
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.error("Video observer failed", error); }
    }
  }
  /** Open/hash media before START; cancellation during preparation never sends. */
  async run(position = 0): Promise<void> {
    if (this.started) throw new Error("Video session is single use");
    if (current && current !== this && (current.opening || current.ownsDisplay)) throw new Error("Another video owns the display");
    this.started = true;
    current = this;
    this.notify();
    let source: Awaited<ReturnType<typeof openVideoSource>> | null = null;
    let audio: Awaited<ReturnType<typeof openVideoAudio>> | null = null;
    try {
      source = await openVideoSource(this.path, () => this.cancelled);
      if (this.cancelled) return;
      const audioPath = this.path.replace(/[^/\\]+$/, source.clip.source.name);
      if (statPath(audioPath)) { audio = await openVideoAudio(this.path, source.clip, () => this.cancelled); this.hasAudio = true; }
      else audio = silentVideoAudio;
      if (this.cancelled) return;
      const active = com.faceclaw.app.FaceclawBleCommunicator.getActive();
      this.transportEpoch = Number(active?.getVideoTransport().getEpoch());
      this.engine = new VideoPlayback(createVideoProtocol(), source, audio, this.options, (view) => {
        this.view = view;
        if (this.shownCopies && (Date.now() - this.savedAt >= 1000 || !view.active)) {
          saveVideoResumeState(this.path, !view.active && !view.error && view.position + 63 >= view.duration ? 0 : view.position);
          this.savedAt = Date.now();
        }
        this.notify();
      }, (count) => {
        this.shownCopies += count;
        for (let i = 0; i < count; i++) com.faceclaw.app.FaceclawBleManager.recordDisplayFrameSent();
      });
      this.opening = false;
      // The engine owns source/audio from here, including failed START cleanup.
      source = null; audio = null;
      await this.engine.run(position);
    } catch (error) { this.error = String(error); throw error; }
    finally {
      try { source?.close(); }
      finally {
        try { await audio?.close(); }
        finally { this.opening = false; this.notify(); }
      }
    }
  }
  stop(): void { this.cancelled = true; this.engine?.stop(); }
  /** A retired communicator cannot be reused to hide a failed restoration. */
  get retired(): boolean {
    if (this.transportEpoch === null) return false;
    const active = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    return !active || !active.isSessionReady() || Number(active.getVideoTransport().getEpoch()) !== this.transportEpoch;
  }
}

export function activeVideoSession(): VideoSession | null {
  if (current && !current.opening && current.retired && !current.view?.active) current = null;
  return current;
}
export function observeVideoSession(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
