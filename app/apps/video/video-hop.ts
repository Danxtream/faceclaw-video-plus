import { videoU32 } from "./video-protocol";

export const VIDEO_HOP_STAGES = ["receiveToForward", "bridgeEnqueueCalls", "recordAssembly",
  "localDispatchToAck", "forwardToPeerAck", "peerAckToBleEnqueue", "receiveToConfirmationEnqueue"] as const;

/** Each sample is a same-lens tick span, not a synchronized one-way wire delay. */
export function parseVideoHop(raw: Uint8Array, stream: number, token: number, side: number) {
  if (raw.length !== 172 || raw[0] !== 1 || raw[1] !== 7 || raw[2] || raw[3] !== 8 || raw[4] !== 0 ||
      raw[5] !== 1 || raw[6] !== side || ![1, 2].includes(raw[7]) || videoU32(raw, 8) !== stream || videoU32(raw, 12) !== token)
    throw new Error("Invalid video hop identity");
  const flags = videoU32(raw, 28);
  const stages = Array.from({length: VIDEO_HOP_STAGES.length}, (_, i) => {
    const at = 32 + i * 20, count = videoU32(raw, at), sumTicks = videoU32(raw, at + 4), maxTicks = videoU32(raw, at + 8);
    const bins = Array.from({length: 4}, (_, j) => raw[at + 12 + j * 2] | raw[at + 13 + j * 2] << 8);
    if (!(flags & 1) && (bins.reduce((a, b) => a + b, 0) !== count || sumTicks < maxTicks || (!count && sumTicks)))
      throw new Error("Invalid video hop counters");
    let accumulated = 0;
    const p95Bin = count ? bins.findIndex(n => (accumulated += n) >= Math.ceil(count * 0.95)) : -1;
    return {stage: VIDEO_HOP_STAGES[i], count, sumTicks, meanTicks: count ? sumTicks / count : null,
      maxTicks, bins, p95UpperTicks: p95Bin < 0 ? null : [1, 8, 32, ">32"][p95Bin]};
  });
  return {side, stream, token, origin: raw[7], pending: raw[16], maxPending: raw[17],
    elapsedTicks: videoU32(raw, 20), liveForwardTicks: videoU32(raw, 24), flags, stages};
}
