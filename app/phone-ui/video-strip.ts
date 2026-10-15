import { Dialogs, Observable, type EventData, type View } from "@nativescript/core";
import { activeVideoSession, observeVideoSession, type VideoSession } from "../apps/video/video-session";
import { VideoSeekControls } from "./video-seek-controls";

/** Compact remote for the existing session, independent of the selected main tab. */
export class VideoStripViewModel extends Observable {
  private timer: ReturnType<typeof setInterval> | null = null;
  private remove: (() => void) | null = null;
  private busy = false;
  private readonly seek = new VideoSeekControls<VideoSession>((key, value) => this.set(key, value),
    (session, value) => this.action(async () => { await session.engine?.seek(value); }));
  constructor() { super(); this.refresh(); }
  attach(): void {
    if (this.timer !== null) return;
    this.remove = observeVideoSession(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), 500); this.refresh();
  }
  dispose(): void {
    this.remove?.(); this.remove = null;
    if (this.timer !== null) clearInterval(this.timer); this.timer = null;
    this.seek.dispose();
  }
  private refresh(): void {
    const session = activeVideoSession(), view = session?.view;
    this.set("stripVisibility", view?.active ? "visible" : "collapse");
    this.set("canControl", !!view?.active && !this.busy);
    this.set("playSymbol", view?.paused ? "\u25b6" : "\u23f8");
    this.seek.update(view?.position ?? 0, view?.duration ?? 0, view?.active ? session : null);
  }
  private async action(command: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.refresh();
    try { await command(); }
    catch (error) { await Dialogs.alert({title: "Video", message: String(error), okButtonText: "OK"}); }
    finally { this.busy = false; this.refresh(); }
  }
  onToggleTap(): void {
    const player = activeVideoSession()?.engine;
    if (player) void this.action(() => player.pause(!player.view.paused));
  }
  onSeekChange(args: {value?: number; object?: {value?: number}}): void { this.seek.onChange(args); }
  onSeekTouch(args: {action?: string}): void { this.seek.onTouch(args); }
}

export function loaded(args: EventData): void {
  const view = args.object as View;
  if (!(view.bindingContext instanceof VideoStripViewModel)) view.bindingContext = new VideoStripViewModel();
  (view.bindingContext as VideoStripViewModel).attach();
}
export function unloaded(args: EventData): void {
  const model = (args.object as View).bindingContext;
  if (model instanceof VideoStripViewModel) model.dispose();
}
