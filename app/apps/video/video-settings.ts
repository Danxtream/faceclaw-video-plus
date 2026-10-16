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
export const videoDeblockingSetting = new ConfigSettingBoolean({
  id: "video-deblocking", label: "Deblocking filter", storageKey: "video.deblocking", defaultValue: false,
});
export const videoConversionRateSetting = new ConfigSettingEnum<"10" | "15" | "20">({
  id: "video-conversion-rate", label: "Picture rate", storageKey: "video.conversionRate", defaultValue: "15",
  values: ["10", "15", "20"], formatValue: value => value + " fps",
});
export const videoConversionHeightSetting = new ConfigSettingEnum<"192" | "176">({
  id: "video-conversion-height", label: "Frame size", storageKey: "video.conversionHeight", defaultValue: "176",
  values: ["192", "176"], formatValue: value => "320x" + value,
});
export const videoDetailedReportsSetting = new ConfigSettingBoolean({
  id: "video-detailed-reports", label: "Video detailed reports", storageKey: "video.detailedReports", defaultValue: false,
});

/** Generation settings are read only at START/seek, never on a settings callback. */
export function configuredVideoOptions(): VideoOptions {
  return { native: videoScaleSetting.get() === "native", dither: videoDitherSetting.get(), radio: videoRadioSetting.get() === "video",
    detailedReports: videoDetailedReportsSetting.get(), blackFloor: Number(videoBlackFloorSetting.get()) as 0 | 0.25 | 0.5 | 1 };
}
/** These are Video settings, not entries in the firmware's playback pause menu. */
export function videoSettingsMenuItems() {
  return [enumSettingMenuItem(videoScaleSetting), enumSettingMenuItem(videoRadioSetting),
    toggleSettingMenuItem(videoDitherSetting), enumSettingMenuItem(videoBlackFloorSetting), toggleSettingMenuItem(videoDeblockingSetting)];
}
