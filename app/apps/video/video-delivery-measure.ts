import { videoU32 } from "./video-protocol";

const STAGES = ["receiveToForward", "bridgeEnqueueCalls", "recordAssembly",
  "localDispatchToAck", "forwardToPeerAck", "peerAckToBleEnqueue", "receiveToConfirmationEnqueue"];

/** Local tick brackets end at copied enqueue, not physical radio transmission. */
export function videoDeliveryMeasureLines(raw: Uint8Array, stream: number, token: number, side: number): string[] {
  const mode = raw[4];
  if (![0, 1].includes(mode) || raw.length !== (mode ? 128 : 172) || raw[0] !== 1 || raw[1] !== 7 ||
      raw[2] || raw[3] !== 8 || raw[5] !== 2 || raw[6] !== side || ![1, 2].includes(raw[7]) ||
      videoU32(raw, 8) !== stream || videoU32(raw, 12) !== token)
    throw new Error("Invalid delivery measurement identity");
  const flags = videoU32(raw, 28), elapsed = videoU32(raw, 20);
  const scope = `Video measure stream=${stream} side=${side} origin=${raw[7]} mode=${mode} flags=${flags}`;
  if (flags & ~255 || raw[16] > raw[17]) throw new Error("Invalid delivery measurement flags or depth");
  if (mode) {
    const overlap = videoU32(raw, 96), incoming = videoU32(raw, 100);
    if (overlap > incoming) throw new Error("Invalid delivery overlap counts");
    const lines = [`${scope} incomingNals=${incoming} overlappingFirstFragments=${overlap}`];
    for (let i = 0; i < 4; i++) {
      const at = 32 + i * 16, count = videoU32(raw, at), sum = videoU32(raw, at + 4);
      const max = videoU32(raw, at + 8), bytes = videoU32(raw, at + 12);
      if (!(flags & 1) && (sum < max || (!count && (sum || bytes || max))))
        throw new Error("Invalid delivery size counters");
      lines.push(`${scope} wireRecordBytes=${["1..512", "513..1024", "1025..2048", "2049+"][i]}` +
        ` count=${count} bytes=${bytes} sumTicks=${sum} maxTicks=${max} meanTicks=${count ? sum / count : "none"}`);
    }
    return lines;
  }
  const lines: string[] = [];
  let forwards = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const at = 32 + i * 20, count = videoU32(raw, at), sum = videoU32(raw, at + 4), max = videoU32(raw, at + 8);
    const bins = Array.from({length: 4}, (_, j) => raw[at + 12 + j * 2] | raw[at + 13 + j * 2] << 8);
    if (!(flags & 1) && (bins.reduce((a, b) => a + b, 0) !== count || sum < max || (!count && (sum || max))))
      throw new Error("Invalid delivery timing counters");
    if (i === 4) forwards = sum;
    lines.push(`${scope} stage=${STAGES[i]} count=${count} sumTicks=${sum} maxTicks=${max}` +
      ` meanTicks=${count ? sum / count : "none"} bins1_8_32_over32=${bins.join(",")}`);
  }
  lines.unshift(`${scope} pending=${raw[16]} maxPendingLowerBound=${raw[17]} elapsedTicks=${elapsed}` +
    ` meanPending=${elapsed ? (forwards + videoU32(raw, 24)) / elapsed : "none"}`);
  return lines;
}
