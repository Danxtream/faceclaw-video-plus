import { videoU32 } from "./video-protocol";

/** Samples are approximate validated heap views, never a stock allocation trace. */
export function videoMemoryLines(raw: Uint8Array, stream: number, token: number, side: number): string[] {
  if (raw.length !== 128 || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 9 ||
      raw[4] !== 1 || raw[5] & ~7 || raw[6] !== side || raw[7] > 1 ||
      videoU32(raw, 8) !== stream || videoU32(raw, 12) !== token || !videoU32(raw, 16))
    throw new Error("Unsupported video memory identity");
  return ["cached", "display", "other"].map((heap, index) => {
    const scope = `Video memory stream=${stream} side=${side} heap=${heap} contention=${raw[7]} approximate=1`;
    if (!(raw[5] & (1 << index))) return `${scope} unavailable=no-samples`;
    const at = 32 + index * 32;
    const [baseline, minimum, minLargest, decoder, presenter, outside, largestAtMin, samples] =
      Array.from({length: 8}, (_, field) => videoU32(raw, at + field * 4));
    if (!samples || minimum > baseline || minLargest > largestAtMin || largestAtMin > minimum)
      throw new Error("Inconsistent video memory counters");
    return `${scope} baselineFree=${baseline} minFree=${minimum} minLargest=${minLargest}` +
      ` largestAtMinFree=${largestAtMin} decoderLedgerAtMin=${decoder} presenterLedgerAtMin=${presenter}` +
      ` totalLedgerAtMin=${decoder + presenter} maxOutsideLedger=${outside === 0xffffffff ? "unavailable" : outside}` +
      ` samples=${samples}`;
  });
}
