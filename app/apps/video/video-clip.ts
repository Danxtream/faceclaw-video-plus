/** Audited conversion metadata; file offsets and pictures remain distinct. */
export type VideoNal = { offset: number; bytes: number; type: number; sha256: string };
export type VideoPicture = { pts: number; nal: number; idr: boolean; sps: number; pps: number };
export type VideoAudit = { bytes: number; sha256: string; nals: VideoNal[] };
export type VideoClip = {
  version: 1; width: 320; height: 192; fps: 16; duration: number;
  range: "full"; deblocking: boolean; encoder: string; options: string[];
  source: { name: string; bytes: number; sha256: string };
  h264: VideoAudit; pictures: VideoPicture[];
};

function integer(value: unknown, min: number, max = 0xfffffffe): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function hash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }

/** Refuse unknown or stale sidecars rather than guessing an unaudited timeline. */
export function parseVideoClip(value: unknown, audit: VideoAudit): VideoClip {
  const clip = value as VideoClip;
  if (!clip || clip.version !== 1 || clip.width !== 320 || clip.height !== 192 || clip.fps !== 16 ||
      clip.range !== "full" || typeof clip.deblocking !== "boolean" || !integer(clip.duration, 1) ||
      typeof clip.encoder !== "string" || !clip.encoder || !Array.isArray(clip.options) ||
      !clip.options.every((option) => typeof option === "string") || !clip.source ||
      typeof clip.source.name !== "string" || !/^[^/\\]+\.mp4$/i.test(clip.source.name) || !integer(clip.source.bytes, 1, Number.MAX_SAFE_INTEGER) ||
      !hash(clip.source.sha256) || !clip.h264 || !hash(clip.h264.sha256) ||
      clip.h264.bytes !== audit.bytes || clip.h264.sha256 !== audit.sha256 ||
      !Array.isArray(clip.h264.nals) || clip.h264.nals.length !== audit.nals.length || !audit.nals.length)
    throw new Error("Missing, unsupported or stale audited video sidecar");
  for (let i = 0; i < audit.nals.length; i++) {
    const actual = audit.nals[i], saved = clip.h264.nals[i];
    if (!saved || !integer(actual.offset, 3, Number.MAX_SAFE_INTEGER) || !integer(actual.bytes, 1, 4086) ||
        !hash(actual.sha256) || saved.offset !== actual.offset || saved.bytes !== actual.bytes ||
        saved.type !== actual.type || saved.sha256 !== actual.sha256 || actual.offset + actual.bytes > audit.bytes)
      throw new Error("Audited NAL index does not match video source");
  }
  if (!Array.isArray(clip.pictures) || !clip.pictures.length) throw new Error("Missing audited picture map");
  let lastNal = -1;
  let lastIdr = -1;
  let activeSps = -1;
  let activePps = -1;
  for (let i = 0; i < clip.pictures.length; i++) {
    const frame = clip.pictures[i];
    if (!frame || frame.pts !== Math.round(i * 1000 / 16) || !integer(frame.nal, 0, audit.nals.length - 1) ||
        frame.nal <= lastNal || typeof frame.idr !== "boolean" || !integer(frame.sps, 0, frame.nal - 1) ||
        !integer(frame.pps, 0, frame.nal - 1)) throw new Error("Invalid audited picture timeline");
    for (let n = lastNal + 1; n <= frame.nal; n++) {
      if (audit.nals[n].type === 7) activeSps = n;
      if (audit.nals[n].type === 8) activePps = n;
      if ([1, 5].includes(audit.nals[n].type) && n !== frame.nal)
        throw new Error("Multiple or unmapped VCL NALs are unsupported");
    }
    if (frame.sps !== activeSps || frame.pps !== activePps || audit.nals[frame.sps].type !== 7 ||
        audit.nals[frame.pps].type !== 8 || audit.nals[frame.nal].type !== (frame.idr ? 5 : 1))
      throw new Error("Picture map lacks active SPS/PPS or correct finishing NAL");
    if (frame.idr) lastIdr = i;
    if (lastIdr < 0 || i - lastIdr > 255) throw new Error("Seek exceeds firmware hidden-preroll limit");
    lastNal = frame.nal;
  }
  if (audit.nals.slice(lastNal + 1).some((nal) => [1, 5].includes(nal.type)) ||
      clip.duration !== Math.round(clip.pictures.length * 1000 / 16)) throw new Error("Incomplete picture map or duration");
  return clip;
}

/** Nearest preceding IDR plus its active parameter sets, never a P-frame reset. */
export function videoSeekPoint(clip: VideoClip, milliseconds: number): { frame: number; idr: number; preroll: number } {
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid seek position");
  const frame = Math.min(clip.pictures.length - 1, Math.max(0, Math.floor(milliseconds * 16 / 1000)));
  let idr = frame;
  while (idr > 0 && !clip.pictures[idr].idr) idr--;
  if (!clip.pictures[idr].idr || frame - idr > 255) throw new Error("No bounded IDR seek point");
  return { frame, idr, preroll: frame - idr };
}

export interface VideoSource {
  readonly clip: VideoClip;
  readonly uploadHandle?: unknown;
  readNal(index: number): Promise<Uint8Array>;
  close(): void;
}
