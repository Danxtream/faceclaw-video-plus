import { Dialogs, Frame, Observable } from "@nativescript/core";
import { dashboardController } from "../g2/dashboard-controller";
import { hasAllFilesAccess, requestAllFilesAccess, statPath, type DirectoryEntry } from "../native/file-access";
import { ensureG2VideoDirectory, listG2Videos, listG2ConversionSources, listG2Folders, resolveG2H264Path, g2VideoMetadataPath } from "../native/g2-video-library";
import { convertVideo, cancelVideoConversion, videoConversionState } from "../native/video-converter";
import { openPhoneVideo } from "../apps/video";
import { activeVideoSession, observeVideoSession, type VideoSession } from "../apps/video/video-session";
import { VideoSeekControls } from "./video-seek-controls";
export { formatVideoTime } from "./video-seek-controls";
import { videoRadioSetting, videoScaleSetting, videoDitherSetting, videoBlackFloorSetting, videoDeblockingSetting, videoConversionRateSetting, videoConversionFrameSetting, videoConversionContrastSetting, videoConversionKeyframesSetting, videoConversionBitrateSetting, videoAudioOffsetSetting, VIDEO_AUDIO_OFFSETS } from "../apps/video/video-settings";

/** Segment order on the Convert tab; each list matches its SegmentedBar items. */
const VIDEO_CONVERSION_RATES = ["10", "15", "20", "24"] as const;
const VIDEO_CONVERSION_FRAMES = ["320x192", "320x176", "384x216", "448x252", "480x270", "512x288"] as const;
const VIDEO_CONVERSION_BITRATES = ["110", "150", "200", "250", "300", "400", "auto"] as const;

/** Strict remote time input, with no changes to the source's fixed frame cadence. */
export function parseVideoTime(text: string): number {
  const parts = text.trim().split(":");
  if (parts.length > 3 || !parts.length || parts.some((part) => !/^\d+$/.test(part)) ||
      parts.slice(1).some((part) => Number(part) >= 60)) throw new Error("Enter seconds, mm:ss or hh:mm:ss");
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 > 0xfffffffe) throw new Error("Invalid video time");
  return seconds * 1000;
}

/** Library, converter and remote reuse the single Video session and native job. */
export class VideoViewModel extends Observable {
  private unsubscribers: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly seekControls = new VideoSeekControls<VideoSession>((key, value) => this.set(key, value),
    (session, value) => this.action(async () => { await session.engine?.seek(value); }));
  private refreshing = false;
  private libraryStamp: string | null = null;
  /** Folder shown in each tab; null is Download/G2 itself. Browsing never goes above it. */
  private libraryFolder: string | null = null;
  private convertFolder: string | null = null;
  constructor(tab = 0) { super(); this.set("tab", tab); this.set("status", ""); this.set("timeEntry", "0:00"); this.refresh(); }
  attach(): void {
    if (this.timer !== null) return;
    this.unsubscribers.push(observeVideoSession(() => this.refresh()));
    this.unsubscribers.push(dashboardController.subscribe((snapshot) => { this.set("connected", snapshot.phase === "connected"); }));
    this.timer = setInterval(() => this.refresh(), 500); this.refresh();
  }
  dispose(): void {
    for (const remove of this.unsubscribers.splice(0)) remove();
    if (this.timer !== null) clearInterval(this.timer); this.timer = null;
    this.seekControls.dispose();
  }
  private refresh(): void {
    this.refreshing = true;
    try {
      const access = hasAllFilesAccess();
      this.set("accessVisibility", access ? "collapse" : "visible");
      if (access) {
        const root = ensureG2VideoDirectory();
        // A folder deleted while shown falls back to Download/G2.
        if (this.libraryFolder && !statPath(this.libraryFolder)?.isDirectory) this.libraryFolder = null;
        if (this.convertFolder && !statPath(this.convertFolder)?.isDirectory) this.convertFolder = null;
        const libraryAt = this.libraryFolder ?? root, convertAt = this.convertFolder ?? root;
        const videos = listG2Videos(libraryAt).filter((entry) => !entry.isDirectory), sources = listG2ConversionSources(convertAt);
        const libraryFolders = listG2Folders(libraryAt), convertFolders = listG2Folders(convertAt);
        const stamp = `${libraryAt}|${convertAt}|` + [...libraryFolders, ...videos, ...convertFolders, ...sources]
          .map((entry) => `${entry.path}:${entry.modifiedMs}:${entry.sizeBytes}`).join(";");
        if (stamp !== this.libraryStamp) {
        this.libraryStamp = stamp;
        this.set("videos", [...this.folderRows(root, libraryAt, libraryFolders, (folder) => { this.libraryFolder = folder; }),
          ...videos.map((entry) => ({name: entry.name, entry, actionText: "▶", action: () => void this.play(entry),
            play: () => void this.play(entry)}))]);
        this.set("sources", [...this.folderRows(root, convertAt, convertFolders, (folder) => { this.convertFolder = folder; }),
          ...sources.map((entry) => ({name: entry.name, entry, actionText: "Convert", action: () => void this.convert(entry),
            convert: () => void this.convert(entry)}))]);
        }
      } else { this.libraryStamp = null; this.set("videos", []); this.set("sources", []); }
      const session = activeVideoSession(), view = session?.view;
      this.set("active", !!view?.active); this.set("canControl", !!view?.active && !this.busy);
      this.set("title", session?.path.split(/[/\\]/).pop() ?? "Video");
      this.set("playSymbol", view?.paused ? "\u25b6" : "\u23f8");
      this.seekControls.update(view?.position ?? 0, view?.duration ?? 0, view?.active ? session : null);
      this.set("fpsLabel", view?.fps === null || view?.fps === undefined ? "Copied fps: --" : `Copied ${view.fps.toFixed(1)} fps (${view.intervals} intervals)`);
      this.set("audioLabel", session ? session.hasAudio ? "MP4 audio" : "Silent" : "");
      this.set("radioIndex", videoRadioSetting.get() === "video" ? 1 : 0);
      this.set("scaleIndex", videoScaleSetting.get() === "native" ? 0 : 1);
      this.set("dither", videoDitherSetting.get()); this.set("deblocking", videoDeblockingSetting.get());
      this.set("blackFloorIndex", ["0", "0.25", "0.5", "1"].indexOf(videoBlackFloorSetting.get()));
      const offset = VIDEO_AUDIO_OFFSETS.indexOf(videoAudioOffsetSetting.get());
      this.set("audioOffsetLabel", `Audio timing: ${videoAudioOffsetSetting.displayValue()}`);
      this.set("canAudioLater", offset > 0); this.set("canAudioEarlier", offset < VIDEO_AUDIO_OFFSETS.length - 1);
      this.set("conversionRateIndex", VIDEO_CONVERSION_RATES.indexOf(videoConversionRateSetting.get()));
      this.set("conversionFrameIndex", VIDEO_CONVERSION_FRAMES.indexOf(videoConversionFrameSetting.get()));
      this.set("conversionFrameLabel", `Frame size: ${videoConversionFrameSetting.get()}` +
        (videoConversionFrameSetting.get().startsWith("320x") ? "" : " (fills the full width; mid sizes need newer glasses firmware)"));
      this.set("conversionContrastIndex", ["default", "medium", "high", "veryhigh"].indexOf(videoConversionContrastSetting.get()));
      this.set("conversionKeyframesIndex", ["default", "large"].indexOf(videoConversionKeyframesSetting.get()));
      this.set("conversionBitrateIndex", VIDEO_CONVERSION_BITRATES.indexOf(videoConversionBitrateSetting.get()));
      this.set("radioLabel", `Selected: ${videoRadioSetting.displayValue()} / Confirmed: ${view?.hostPhy ?? "Unknown"}`);
      const conversion = videoConversionState();
      this.set("conversionRunning", conversion.running); this.set("progress", conversion.progress * 100);
      this.set("conversionStatus", conversion.error ?? conversion.stage);
      this.set("cancelVisibility", conversion.running ? "visible" : "collapse");
      if (session?.error || view?.error) this.set("status", session?.error ?? view?.error);
    } catch (error) { this.set("status", String(error)); }
    finally { this.refreshing = false; }
  }
  private async action(command: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.refresh();
    try { await command(); } catch (error) { this.set("status", String(error)); }
    finally { this.busy = false; this.refresh(); }
  }
  private async play(entry: DirectoryEntry): Promise<void> {
    await this.action(async () => {
      const path = resolveG2H264Path(entry.path);
      if (!path) throw new Error("No converted H.264 stream");
      await dashboardController.openVideoWindow(); await openPhoneVideo(path); this.set("tab", 1);
    });
  }
  /** An Up row inside a subfolder, then one Open row per subfolder. */
  private folderRows(root: string, at: string, folders: DirectoryEntry[], show: (folder: string | null) => void) {
    const open = (folder: string | null) => () => { show(folder); this.libraryStamp = null; this.refresh(); };
    const rows = folders.map((entry) => ({name: `\u{1F4C1} ${entry.name}`, actionText: "Open", action: open(entry.path)}));
    if (at === root) return rows;
    const parent = at.slice(0, at.lastIndexOf("/"));
    return [{name: `⬆ Up from ${at.slice(root.length + 1)}`, actionText: "Up",
      action: open(parent.length > root.length ? parent : null)}, ...rows];
  }
  private async convert(entry: DirectoryEntry): Promise<void> {
    const existing = resolveG2H264Path(entry.path) !== null || statPath(g2VideoMetadataPath(entry.path)) !== null;
    if (existing && !await Dialogs.confirm({title: "Replace converted video?", message: entry.name, okButtonText: "Replace", cancelButtonText: "Cancel"})) return;
    try { convertVideo(entry.path, videoDeblockingSetting.get(), existing, Number(videoConversionRateSetting.get()) as 10 | 15 | 20 | 24,
      videoConversionFrameSetting.get(), videoConversionContrastSetting.get(),
      videoConversionKeyframesSetting.get(), videoConversionBitrateSetting.get()); this.refresh(); }
    catch (error) { this.set("status", String(error)); }
  }
  onAccessTap(): void { requestAllFilesAccess(); }
  onBackTap(): void { Frame.topmost()?.goBack(); }
  onCancelTap(): void { cancelVideoConversion(); }
  onConversionRateChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const rate = VIDEO_CONVERSION_RATES[args.object?.selectedIndex ?? -1];
    if (rate) videoConversionRateSetting.set(rate);
  }
  onConversionFrameChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const frame = VIDEO_CONVERSION_FRAMES[args.object?.selectedIndex ?? -1];
    if (frame) videoConversionFrameSetting.set(frame);
  }
  onConversionContrastChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const contrast = (["default", "medium", "high", "veryhigh"] as const)[args.object?.selectedIndex ?? -1];
    if (contrast) videoConversionContrastSetting.set(contrast);
  }
  onConversionKeyframesChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const keyframes = (["default", "large"] as const)[args.object?.selectedIndex ?? -1];
    if (keyframes) videoConversionKeyframesSetting.set(keyframes);
  }
  onConversionBitrateChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const bitrate = VIDEO_CONVERSION_BITRATES[args.object?.selectedIndex ?? -1];
    if (bitrate) videoConversionBitrateSetting.set(bitrate);
  }
  onToggleTap(): void { void this.action(async () => { const player = activeVideoSession()?.engine; if (player) await player.pause(!player.view.paused); }); }
  onStopTap(): void { activeVideoSession()?.stop(); }
  private jump(delta: number): void { void this.action(async () => { const player = activeVideoSession()?.engine; if (player) await player.seek(player.view.position + delta); }); }
  onBack30Tap(): void { this.jump(-30_000); }
  onBack10Tap(): void { this.jump(-10_000); }
  onForward10Tap(): void { this.jump(10_000); }
  onForward30Tap(): void { this.jump(30_000); }
  onTimeTap(): void { void this.action(async () => { const player = activeVideoSession()?.engine; if (player) await player.seek(parseVideoTime(String(this.get("timeEntry")))); }); }
  onSeekChange(args: {value?: number; object?: {value?: number}}): void {
    if (this.refreshing) return;
    this.seekControls.onChange(args);
  }
  onSeekTouch(args: {action?: string}): void { this.seekControls.onTouch(args); }
  onScaleChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const native = args.object?.selectedIndex === 0;
    if ((videoScaleSetting.get() === "native") === native) return;
    videoScaleSetting.set(native ? "native" : "2x");
    void this.action(async () => { await activeVideoSession()?.engine?.scale(native); });
  }
  onRadioChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const value = args.object?.selectedIndex === 0 ? "off" : "video";
    if (videoRadioSetting.get() !== value) videoRadioSetting.set(value);
  }
  onDitherChange(args: {object?: {checked?: boolean}}): void {
    if (!this.refreshing && videoDitherSetting.get() !== !!args.object?.checked) videoDitherSetting.set(!!args.object?.checked);
  }
  onBlackFloorChange(args: {object?: {selectedIndex?: number}}): void {
    if (this.refreshing) return;
    const floor = (["0", "0.25", "0.5", "1"] as const)[args.object?.selectedIndex ?? -1];
    if (floor !== undefined && videoBlackFloorSetting.get() !== floor) videoBlackFloorSetting.set(floor);
  }
  /** Applies to the playing video within a quarter second, so it can be tuned by ear. */
  onAudioEarlierTap(): void { this.stepAudioOffset(1); }
  onAudioLaterTap(): void { this.stepAudioOffset(-1); }
  private stepAudioOffset(step: 1 | -1): void {
    const next = VIDEO_AUDIO_OFFSETS[VIDEO_AUDIO_OFFSETS.indexOf(videoAudioOffsetSetting.get()) + step];
    if (next !== undefined) { videoAudioOffsetSetting.set(next); this.refresh(); }
  }
  onDeblockingChange(args: {object?: {checked?: boolean}}): void {
    if (!this.refreshing && videoDeblockingSetting.get() !== !!args.object?.checked) videoDeblockingSetting.set(!!args.object?.checked);
  }
}
