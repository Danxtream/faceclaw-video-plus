import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { VideoSession, observeVideoSession } from "./video-session";
import { type VideoOptions } from "./video-playback";

/** Existing EvenHub gestures control the firmware menu through the same writer. */
export class VideoPlaybackLayer implements Layer {
  readonly session: VideoSession;
  private readonly unsubscribe: () => void;
  private context: LayerContext | null = null;
  private requestedPause: boolean | null = null;
  private pauseSerial = 0;
  constructor(path: string, requestRender: () => void, options: () => VideoOptions = () => ({native: false, dither: false, radio: true}), position = 0) {
    this.session = new VideoSession(path, options);
    this.unsubscribe = observeVideoSession(() => {
      if (!this.session.opening && this.session.view && !this.session.view.active && !this.session.view.error &&
          this.context?.stack.topMatches((layer) => layer === this)) this.context.stack.pop();
      requestRender();
    });
    void this.session.run(position).catch((error) => { console.error("Video playback failed", String(error), error); requestRender(); });
  }
  paint(ctx: LayerContext): GrayImage {
    this.context = ctx;
    const {width, height} = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0), font = getDefaultSmallFont();
    image.drawText(font, 20, 8, "Video", 220);
    image.drawText(font, 20, 40, truncateText(font, this.session.path.split(/[/\\]/).pop() ?? "", width - 40), 200);
    const status = this.session.error ?? this.session.view?.error ?? (this.session.opening ? "Opening" : this.session.view?.active ? "Playing" : "Stopped");
    image.drawText(font, 20, 68, truncateText(font, status, width - 40), 180);
    const view = this.session.view;
    if (view) image.drawText(font, 20, 94, `${Math.floor(view.position / 1000)} / ${Math.floor(view.duration / 1000)} s`, 180);
    return image;
  }
  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") { this.session.stop(); ctx.stack.pop(); return; }
    const player = this.session.engine;
    if (!player?.view.active) return;
    let command: Promise<void> | null = null;
    if (event.type === "click") {
      if (player.view.menuOpen) command = player.menu("apply");
      else {
        const paused = !(this.requestedPause ?? player.view.paused), serial = ++this.pauseSerial;
        this.requestedPause = paused;
        command = player.pause(paused).finally(() => { if (serial === this.pauseSerial) this.requestedPause = null; });
      }
    }
    if (player.view.paused && event.type === "scroll-up") command = player.menu("previous");
    if (player.view.paused && event.type === "scroll-down") command = player.menu("next");
    void command?.catch((error) => { console.error("Video control failed", error); ctx.actions.requestRender(); });
  }
  onRemoved(): void { this.session.stop(); this.unsubscribe(); }
}
