import { VIDEO, videoU32 } from "./video-protocol";

/** Local ticks wrap; zero is a valid capture, not an absent sample. */
export function videoTickSpan(after: number, before: number): number {
  const span = (after - before) >>> 0;
  if (span >= 0x80000000) throw new Error("Video tick span is not forward and bounded");
  return span;
}

export type VideoPlaybackState = {
  result: number; lens: number; stream: number; token: number; paused: boolean;
  requestedPause: boolean; shown: number; position: number; duration: number; pending: boolean;
  menuOpen: boolean; selection: number; nativeSelected: boolean; nativeActive: boolean;
  seekSerial: number; seekTarget: number;
};

/** Validate the reporting lens and both owner identities before reading position. */
export function parsePlayback(raw: Uint8Array, lens: number, stream: number, token: number): VideoPlaybackState {
  if (![36, 48].includes(raw.length) || raw[0] !== 1 ||
      ![VIDEO.pause, VIDEO.resume, VIDEO.playback, VIDEO.menu, VIDEO.scale].includes(raw[1] as never) ||
      (!raw[2] && (raw[3] !== lens || videoU32(raw, 4) !== stream || videoU32(raw, 8) !== token)) ||
      [12, 16, 32].some((offset) => videoU32(raw, offset) > 1) || videoU32(raw, 24) > videoU32(raw, 28))
    throw new Error("Playback report owner or state mismatch");
  const view = raw.length === 48 ? videoU32(raw, 36) : 0;
  if (view & ~63 || (view & 15) > 9 || ((view & 15) && !(view & 1)) ||
      (raw.length === 48 && videoU32(raw, 44) > videoU32(raw, 28))) throw new Error("Invalid firmware menu view");
  return { result: raw[2], lens, stream, token, paused: !!videoU32(raw, 12), requestedPause: !!videoU32(raw, 16),
    shown: videoU32(raw, 20), position: videoU32(raw, 24), duration: videoU32(raw, 28), pending: !!videoU32(raw, 32),
    menuOpen: !!(view & 1), selection: view >>> 1 & 7, nativeSelected: !!(view & 16), nativeActive: !!(view & 32),
    seekSerial: raw.length === 48 ? videoU32(raw, 40) : 0, seekTarget: raw.length === 48 ? videoU32(raw, 44) : 0 };
}

export type VideoShown = { serial: number; ordinal: number; pts: number; copyTick: number; triggerTick: number; lost: number; uncertain: boolean };
/** Busy has no capture yet; ring loss is retained, not mistaken for an optical frame. */
export function parseShown(raw: Uint8Array, lens: number, stream: number, token: number): VideoShown | null {
  if (raw.length !== 72 || raw[0] !== 1 || raw[1] !== VIDEO.shown) throw new Error("Invalid SHOWN report");
  if (raw[2] === 3) return null;
  const serial = videoU32(raw, 12), first = videoU32(raw, 40), high = videoU32(raw, 44), lost = videoU32(raw, 48);
  if (raw[2] || raw[3] !== lens || videoU32(raw, 4) !== stream || videoU32(raw, 8) !== token ||
      !first || serial < first || serial > high || lost !== first - 1 || !videoU32(raw, 16) || videoU32(raw, 36) & ~63)
    throw new Error("Invalid SHOWN owner or ring capture");
  return { serial, ordinal: videoU32(raw, 16), pts: videoU32(raw, 20), copyTick: videoU32(raw, 24),
    triggerTick: videoU32(raw, 28), lost, uncertain: videoU32(raw, 60) === 0xffffffff };
}

export type VideoPhyLink = {
  epoch: number; bound: boolean; connected: boolean; valid: boolean; beforeValid: boolean; afterValid: boolean;
  uncertain: boolean; phase: number; status: number; owners: number; pending: boolean; permission: number;
  current: number; before: number; after: number;
};
export type VideoPhy = { lens: number; tick: number; links: VideoPhyLink[] };

/** Preserve all bound-link health; a wire-fed peer's safe fallback is allowed. */
export function parseVideoPhy(raw: Uint8Array, lens: number): VideoPhy {
  if (raw.length !== 128 || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 1 ||
      raw[8] !== 1 || raw[9] !== 32 || raw[10] !== 3 || raw[11] !== lens || raw[116] > 2 || raw[117] > 2 ||
      raw[118] > 3 || raw[119] || raw.slice(124).some(Boolean)) throw new Error("Invalid video PHY report");
  const links: VideoPhyLink[] = [];
  for (let i = 0; i < 3; i++) {
    const p = raw.slice(12 + i * 32, 44 + i * 32), flags = p[1];
    const link = { epoch: videoU32(p, 4), connected: !!(flags & 1), bound: !!(flags & 2), valid: !!(flags & 4),
      beforeValid: !!(flags & 8), afterValid: !!(flags & 16), uncertain: !!(flags & 128), phase: p[2], status: p[3],
      owners: p[26], pending: !!(flags & 64), permission: videoU32(p, 28),
      before: p[20] | p[21] << 8, current: p[22] | p[23] << 8, after: p[24] | p[25] << 8 };
    if (p[0] !== i + 1 || link.phase > 9 || link.owners > 2 || p[27] > 2 ||
        (flags & 31 && !link.epoch) || (flags & 30 && !link.connected) ||
        !!(flags & 32) !== !!link.owners || !!(flags & 64) !== !!p[27] ||
        [[link.valid, 22], [link.beforeValid, 20], [link.afterValid, 24]].some(([valid, offset]) =>
          valid && (![1, 2, 3].includes(p[Number(offset)]) || ![1, 2, 3].includes(p[Number(offset) + 1]))))
      throw new Error("Inconsistent video PHY sample");
    links.push(link);
  }
  return { lens, tick: videoU32(raw, 4), links };
}

/** Every old bound link must survive; every lifecycle-owned original pair returns. */
export function videoRestored(before: readonly VideoPhy[], after: readonly VideoPhy[]): boolean {
  let ready = true;
  for (let side = 0; side < 2; side++) for (let i = 0; i < 3; i++) {
    const old = before[side].links[i], now = after[side].links[i];
    if (!old.bound) continue;
    if (!now.bound || !now.connected || now.epoch !== old.epoch || now.uncertain || now.status || !now.valid)
      throw new Error("Video host link changed or PHY restoration is uncertain");
    if (now.pending || now.owners || now.permission || [5, 6, 7].includes(now.phase)) { ready = false; continue; }
    if ((old.owners || old.permission) && (!old.beforeValid || !now.afterValid ||
        old.before !== now.after || old.before !== now.current)) throw new Error("Video original PHY pair was not restored");
  }
  return ready;
}

/** A copied-picture interval is not an optical rate or an exclusive CPU time. */
export function videoCopyRate(first: VideoShown, last: VideoShown): { fps: number | null; intervals: number; milliseconds: number } {
  const intervals = last.ordinal - first.ordinal;
  const milliseconds = videoTickSpan(last.copyTick, first.copyTick);
  return { fps: intervals > 0 && milliseconds > 0 ? intervals * 1000 / milliseconds : null, intervals, milliseconds };
}
