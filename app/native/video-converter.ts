import { Utils } from "@nativescript/core";

declare const com: any;

export type VideoConversionState = {running: boolean; stage: string; progress: number; source?: string; output?: string; error?: string};

/** The native foreground job remains independent of UI and glasses sessions. */
export function videoConversionState(): VideoConversionState {
  if (!global.isAndroid) return {running: false, stage: "unavailable", progress: 0};
  const value = JSON.parse(String(com.faceclaw.app.VideoConversionService.snapshotJson()));
  if (typeof value.running !== "boolean" || typeof value.stage !== "string" || !Number.isFinite(value.progress) ||
      value.progress < 0 || value.progress > 1) throw new Error("Invalid video conversion state");
  return value;
}
export type VideoConversionContrast = "default" | "medium" | "high" | "veryhigh";
export type VideoConversionKeyframes = "default" | "large";
export type VideoConversionBitrate = "110" | "150" | "200" | "250" | "300" | "400" | "auto";
export type VideoConversionFrame = "320x192" | "320x176" | "384x216" | "448x252" | "480x270" | "512x288";
export function convertVideo(path: string, deblocking = false, overwrite = false, fps: 10 | 15 | 20 | 24 = 15, frame: VideoConversionFrame = "320x176",
  contrast: VideoConversionContrast = "default", keyframes: VideoConversionKeyframes = "default",
  bitrate: VideoConversionBitrate = "110"): void {
  if (!global.isAndroid) throw new Error("Video conversion requires Android");
  if (videoConversionState().running) throw new Error("Another video conversion is running");
  if (![10, 15, 20, 24].includes(fps)) throw new Error("Choose 10, 15, 20 or 24 fps");
  if (!["320x192", "320x176", "384x216", "448x252", "480x270", "512x288"].includes(frame)) throw new Error("Choose a supported frame size");
  if (!["default", "medium", "high", "veryhigh"].includes(contrast)) throw new Error("Choose Default, Medium, High or Very high contrast");
  if (!["default", "large"].includes(keyframes)) throw new Error("Choose Default or Large keyframes");
  if (!["110", "150", "200", "250", "300", "400", "auto"].includes(bitrate)) throw new Error("Choose Auto or 110, 150, 200, 250, 300 or 400 kbps bitrate");
  com.faceclaw.app.VideoConversionService.start(Utils.android.getApplicationContext(), path, deblocking, overwrite, fps, frame,
    contrast, keyframes, bitrate);
}
export function cancelVideoConversion(): void {
  if (global.isAndroid && videoConversionState().running) com.faceclaw.app.VideoConversionService.cancel(Utils.android.getApplicationContext());
}
