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
export function convertVideo(path: string, deblocking = false, overwrite = false, fps: 10 | 15 | 20 = 15, landscapeHeight: 176 | 192 = 176): void {
  if (!global.isAndroid) throw new Error("Video conversion requires Android");
  if (videoConversionState().running) throw new Error("Another video conversion is running");
  if (![10, 15, 20].includes(fps)) throw new Error("Choose 10, 15 or 20 fps");
  if (![176,192].includes(landscapeHeight)) throw new Error("Choose a 320x192 or 320x176 frame");
  com.faceclaw.app.VideoConversionService.start(Utils.android.getApplicationContext(), path, deblocking, overwrite, fps, landscapeHeight);
}
export function cancelVideoConversion(): void {
  if (global.isAndroid && videoConversionState().running) com.faceclaw.app.VideoConversionService.cancel(Utils.android.getApplicationContext());
}
