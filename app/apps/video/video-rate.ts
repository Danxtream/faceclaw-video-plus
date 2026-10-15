/** Rates supported by both the audited converter and the firmware timeline. */
export const VIDEO_PICTURE_RATES = [10, 15, 20] as const;
export type VideoPictureRate = typeof VIDEO_PICTURE_RATES[number];
export const VIDEO_DEFAULT_RATE: VideoPictureRate = 15;
/** Do not infer a cadence for unsupported or legacy sidecars. */
export function isVideoPictureRate(value: unknown): value is VideoPictureRate {
  return VIDEO_PICTURE_RATES.some(rate => value === rate);
}
