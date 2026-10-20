import { videoU32 } from "./video-protocol";

/** Samples are approximate validated heap views, never a stock allocation trace. */
export function videoMemoryLines(raw: Uint8Array, stream: number, token: number, side: number): string[] {
  if (raw.length !== 128 || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 9 ||
      raw[4] !== 1 || raw[5] & ~7 || raw[6] !== side || raw[7] > 1 ||
      videoU32(raw, 8) !== stream || videoU32(raw, 12) !== token || !videoU32(raw, 16))
    throw new Error("Unsupported video memory identity");
  const lines = ["cached", "display", "other"].map((heap, index) => {
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
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint16(30, true) === 1) {
    const names = ["syncWaiting", "bleWaiting", "uartRxBytes", "activeReturnCalls", "activeReplyCalls"];
    lines.push(`Video memory stream=${stream} side=${side} at=cachedMinimum queuesApproximate=1 ` +
      names.map((name, i) => `${name}=${view.getUint16(20 + i * 2, true) === 65535 ? "unavailable" : view.getUint16(20 + i * 2, true)}`).join(" "));
  }
  return lines;
}

/** First-refusal snapshot is lock-protected, unlike the approximate minima. */
export function videoHeapShapeLines(raw: Uint8Array, stream: number, token: number, side: number): string[] {
  if (raw.length !== 128 || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 10 || raw[4] !== 1 ||
      raw[6] !== side || videoU32(raw, 8) !== stream || videoU32(raw, 12) !== token || !videoU32(raw, 16))
    throw new Error("Unsupported video heap shape identity");
  const status = videoU32(raw, 32);
  if (status !== 1) return [`Video memory shape stream=${stream} side=${side} unavailable=${["not-refused", "", "heap-lock-busy", "invalid-chain", "meter-busy"][status] ?? "unknown-status"}`];
  return [`Video memory shape stream=${stream} side=${side} usedBlocks=${videoU32(raw, 36)} ` +
    `smallUsedLe512=${videoU32(raw, 40)} usedPayload=${videoU32(raw, 44)} freePayload=${videoU32(raw, 48)} ` +
    `largestUsed=${Array.from({length: 4}, (_, i) => `${videoU32(raw, 52 + i * 8).toString(16)}:${videoU32(raw, 56 + i * 8)}`).join(",")}`];
}
