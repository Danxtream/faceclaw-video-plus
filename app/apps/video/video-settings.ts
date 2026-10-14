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
export const videoDeblockingSetting = new ConfigSettingBoolean({
  id: "video-deblocking", label: "Deblocking filter", storageKey: "video.deblocking", defaultValue: false,
});

/** Generation settings are read only at START/seek, never on a settings callback. */
export function configuredVideoOptions(): VideoOptions {
  return { native: videoScaleSetting.get() === "native", dither: videoDitherSetting.get(), radio: videoRadioSetting.get() === "video" };
}
/** These are Video settings, not entries in the firmware's playback pause menu. */
export function videoSettingsMenuItems() {
  return [enumSettingMenuItem(videoScaleSetting), enumSettingMenuItem(videoRadioSetting),
    toggleSettingMenuItem(videoDitherSetting), toggleSettingMenuItem(videoDeblockingSetting)];
}
