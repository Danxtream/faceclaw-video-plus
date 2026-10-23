/** Coded buffers remain macroblock-aligned; the lit picture may have odd edges. */
export type VideoPictureRect = { x: number; y: number; width: number; height: number };
export type VideoGeometry = { width: number; height: number; picture?: VideoPictureRect };

/** Mid canvases fill the panel's full width (640 / width) on firmware that advertises them;
 *  each coded height is its 16:9 picture height rounded up to whole macroblocks. */
export const MID_VIDEO_CANVASES: readonly (readonly [number, number])[] = [[384, 224], [448, 256], [480, 272], [512, 288]];

/** Legacy sidecars had no rectangle and always occupied the 320x192 canvas. */
export function videoGeometry(value: VideoGeometry): Required<VideoGeometry> {
  const width = value.width ?? 320, height = value.height ?? 192;
  if (!((width === 320 && [192, 176].includes(height)) || (width === 144 && height === 240) ||
      MID_VIDEO_CANVASES.some(([w, h]) => w === width && h === height)))
    throw new Error("Unsupported video frame size; re-convert this clip.");
  const picture = value.picture ?? (width === 320 && height === 192 ? { x: 0, y: 0, width, height } : null);
  if (!picture || ![picture.x, picture.y, picture.width, picture.height].every(Number.isSafeInteger) ||
      picture.x < 0 || picture.y < 0 || picture.width < 1 || picture.height < 1 ||
      picture.x + picture.width > width || picture.y + picture.height > height)
    throw new Error("Invalid or missing video picture rectangle; re-convert this clip.");
  return { width, height, picture: { ...picture } };
}

/** A mid canvas plays only full width, whatever the Video size setting says. */
export function midVideoGeometry(value: Required<VideoGeometry>): boolean {
  return value.width > 320;
}

/** Old firmware is safe only for an unchanged full legacy canvas. */
export function legacyVideoGeometry(value: Required<VideoGeometry>): boolean {
  return value.width === 320 && value.height === 192 && value.picture.x === 0 && value.picture.y === 0 &&
    value.picture.width === 320 && value.picture.height === 192;
}
