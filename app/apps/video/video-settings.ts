import { ConfigSettingBoolean, ConfigSettingEnum, enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type VideoOptions } from "./video-playback";

export const videoScaleSetting = new ConfigSettingEnum<"native" | "2x">({
  id: "video-scale", label: "Video size", storageKey: "video.scale", defaultValue: "native",
  values: ["native", "2x"], formatValue: (value) => value === "native" ? "Native" : "2x",
});
export const videoRadioSetting = new ConfigSettingEnum<"off" | "video">({
  id: "video-radio", label: "2M radio", storageKey: "video.blePhy", defaultValue: "video",
  values: ["off", "video"], formatValue: (value) => value === "off" ? "Off" : "Video-only",
  normalize: (value) => value === "1m" || value === "off" ? "off" : value === "2m" || value === "video" ? "video" : undefined,
});
export const videoDitherSetting = new ConfigSettingBoolean({
  id: "video-dither", label: "Dithering", storageKey: "video.dithering", defaultValue: false,
});
export const videoBlackFloorSetting = new ConfigSettingEnum<"0" | "0.25" | "0.5" | "1">({
  id: "video-black-floor", label: "Black floor", storageKey: "video.blackFloor", defaultValue: "1",
  values: ["0", "0.25", "0.5", "1"], formatValue: value => value,
});
/** Positive values play sound earlier than the picture, for headphones whose delay the phone
 *  does not report: 25 ms steps from 1000 ms later to 1000 ms earlier. */
export const VIDEO_AUDIO_OFFSETS: readonly string[] = Array.from({length: 81}, (_, i) => String(i * 25 - 1000));
export function formatVideoAudioOffset(value: string): string {
  const ms = Number(value);
  return ms === 0 ? "0 ms" : ms > 0 ? `Sound ${ms} ms earlier` : `Sound ${-ms} ms later`;
}
export const videoAudioOffsetSetting = new ConfigSettingEnum<string>({
  id: "video-audio-offset", label: "Audio timing", storageKey: "video.audioOffsetMs", defaultValue: "0",
  values: [...VIDEO_AUDIO_OFFSETS], formatValue: formatVideoAudioOffset,
});
/** Applies to the next conversion only, so the phone's Convert tab owns it, not the glasses. */
export const videoDeblockingSetting = new ConfigSettingBoolean({
  id: "video-deblocking", label: "Deblocking filter", storageKey: "video.deblocking", defaultValue: false,
});
export const videoConversionRateSetting = new ConfigSettingEnum<"10" | "15" | "20" | "24">({
  id: "video-conversion-rate", label: "Picture rate", storageKey: "video.conversionRate", defaultValue: "15",
  values: ["10", "15", "20", "24"], formatValue: value => value + " fps",
});
export type VideoConversionFrame = "320x192" | "320x176" | "384x216" | "448x252" | "480x270" | "512x288";
/** The 320-wide frames play at 2x or native size; the mid sizes fill the panel's full width.
 *  Earlier versions stored only the 320-wide height. */
export const videoConversionFrameSetting = new ConfigSettingEnum<VideoConversionFrame>({
  id: "video-conversion-height", label: "Frame size", storageKey: "video.conversionHeight", defaultValue: "320x176",
  values: ["320x192", "320x176", "384x216", "448x252", "480x270", "512x288"], formatValue: value => value,
  normalize: (value) => value === "192" ? "320x192" : value === "176" ? "320x176" : undefined,
});
/** How the converter turns color into gray; applies to the next conversion only. */
export const videoConversionContrastSetting = new ConfigSettingEnum<"default" | "medium" | "high" | "veryhigh">({
  id: "video-conversion-contrast", label: "Contrast", storageKey: "video.conversionContrast", defaultValue: "default",
  values: ["default", "medium", "high", "veryhigh"],
  formatValue: value => value === "default" ? "Default" : value === "medium" ? "Medium" : value === "high" ? "High" : "Very high",
});
/** Large keyframes need firmware that decodes several slices per picture; applies to the next conversion. */
export const videoConversionKeyframesSetting = new ConfigSettingEnum<"default" | "large">({
  id: "video-conversion-keyframes", label: "Keyframes", storageKey: "video.conversionKeyframes", defaultValue: "default",
  values: ["default", "large"], formatValue: value => value === "default" ? "Default" : "Large",
});
/** Applies only to the next conversion; higher caps are not a link-speed guarantee. */
export const videoConversionBitrateSetting = new ConfigSettingEnum<"110" | "150" | "200" | "250" | "300" | "400" | "auto">({
  id: "video-conversion-bitrate", label: "Bitrate", storageKey: "video.conversionBitrate", defaultValue: "110",
  values: ["110", "150", "200", "250", "300", "400", "auto"], formatValue: value => value === "auto" ? "Auto" : value + " kbps",
});
export const videoDetailedReportsSetting = new ConfigSettingBoolean({
  id: "video-detailed-reports", label: "Video detailed reports", storageKey: "video.detailedReports", defaultValue: false,
});

/** Generation settings are read only at START/seek, never on a settings callback;
 *  the phone-side audio offset is also read while playing. */
export function configuredVideoOptions(): VideoOptions {
  return { native: videoScaleSetting.get() === "native", dither: videoDitherSetting.get(), radio: videoRadioSetting.get() === "video",
    detailedReports: videoDetailedReportsSetting.get(), blackFloor: Number(videoBlackFloorSetting.get()) as 0 | 0.25 | 0.5 | 1,
    audioOffsetMs: Number(videoAudioOffsetSetting.get()) };
}
/** These are Video settings, not entries in the firmware's playback pause menu. */
export function videoSettingsMenuItems() {
  return [enumSettingMenuItem(videoScaleSetting), enumSettingMenuItem(videoRadioSetting),
    toggleSettingMenuItem(videoDitherSetting), enumSettingMenuItem(videoBlackFloorSetting)];
}
