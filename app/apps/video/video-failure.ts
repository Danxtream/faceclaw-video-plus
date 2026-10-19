/** Byte-level evidence only: matching checksums do not prove delivery order. */
export type VideoNalEvidence = {
  sequence: number; source: number; type: number; length: number; checksum: number;
};

/** FNV-1a over the raw NAL including its header, without Annex B prefix. */
export function videoNalChecksum(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

function word(raw: Uint8Array, at: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(at, true);
}

/** Validate the complete retained pair before comparing any stream sequence. */
export function videoFailureLines(side: number, stream: number, detail: Uint8Array,
  history: Uint8Array, recent: readonly VideoNalEvidence[]): string[] {
  for (const [mode, row] of [detail, history].entries()) {
    if (row.length !== 128 || row[0] !== 1 || row[1] !== 7 || row[2] || row[3] !== 7 ||
        row[4] !== mode || row[5] !== 1 || row[6] !== side || row[7] > 1)
      throw new Error(`Unsupported decode failure evidence side=${side} mode=${mode}`);
  }
  if (!detail[7] && !history[7]) return [`Video failure side=${side}: no retained decode failure`];
  if (!detail[7] || !history[7] || word(detail, 8) !== word(history, 8) ||
      word(detail, 20) !== word(history, 12) || word(history, 16) > 8 ||
      word(detail, 92) !== word(history, 16)) throw new Error(`Inconsistent decode failure evidence side=${side}`);
  const savedStream = word(detail, 8), sequence = word(detail, 20);
  const lines = [`Video failure side=${side} stream=${savedStream} attemptedStream=${stream} token=${word(detail, 12)}` +
    ` fault=0x${word(detail, 16).toString(16)} sequence=${sequence} reject=${word(detail, 40)} stage=${word(detail, 44)}` +
    ` mbEntered=${word(detail, 48)} mbCompleted=${word(detail, 52)} bitOffset=${word(detail, 56)}` +
    ` firstMb=${word(detail, 60)} frameNum=${word(detail, 64)} priorOpen=${word(detail, 68)}` +
    ` priorNextMb=${word(detail, 72)} priorFrameNum=${word(detail, 76)}` +
    ` allocationTag=${word(detail, 80)} allocationSize=${word(detail, 84)}` +
    ` runtimeAllocationTag=${word(detail, 96)} runtimeAllocationSize=${word(detail, 100)}` +
    ` powerStep=${word(detail, 104)} peerGeneration=${word(detail, 108)} peerStream=${word(detail, 112)} peerClosed=${word(detail, 116)}` +
    ` inputPinned=${word(detail, 120)} decoderPresent=${word(detail, 124)}` +
    // History bytes 20-31: presenter faults record their call site and state.
    ` task=${word(history, 20) ? "presenter" : "worker"} site=0x${word(history, 20).toString(16)}` +
    (word(history, 20) ? ` presenterStackUsed=${word(history, 24)} presenterGuards=${history[28]}` +
    ` presenterQueue=${history[30] | history[31] << 8}` : "")];
  if (!word(history, 20) && history[24]) {
    const count = (at: number) => {
      const value = history[at] | history[at + 1] << 8 | history[at + 2] << 16;
      return value === 0xffffff ? "unavailable" : value;
    };
    lines.push(`Video failure storage side=${side} stream=${savedStream} rule=${history[24]}` +
      ` liveSlots=${history[25]} cachedFree=${count(26)} cachedLargest=${count(29)}`);
  }
  const compare = (sequence: number, type: number, length: number, checksum: number, current: boolean): void => {
    const sent = savedStream === stream ? recent.find(row => row.sequence === sequence) : undefined;
    const verdict = savedStream !== stream ? "STALE STREAM" : !sent ? "NO PHONE EVIDENCE" :
      sent.type === type && sent.length === length && sent.checksum === checksum ? "match" : "MISMATCH";
    lines.push(`Video failure NAL side=${side} stream=${savedStream} sequence=${sequence} source=${sent?.source ?? "unknown"}` +
      ` type=${type} length=${length} checksum=${checksum} ${current ? word(detail, 120) ? "failing" : "last-not-pinned" : "previous"} ${verdict}` +
      (sent ? ` phoneType=${sent.type} phoneLength=${sent.length} phoneChecksum=${sent.checksum}` : ""));
  };
  for (let i = 0; i < word(history, 16); i++) {
    const at = 32 + i * 12;
    compare(word(history, at), history[at + 10], history[at + 8] | history[at + 9] << 8, word(history, at + 4), false);
  }
  compare(sequence, word(detail, 28), word(detail, 24), word(detail, 32), true);
  lines.push(`Video failure input side=${side} sequence=${sequence} entryChecksum=${word(detail, 32)}` +
    (word(detail, 120) ? ` failureChecksum=${word(detail, 36)} ${word(detail, 32) === word(detail, 36) ? "unchanged" : "MISMATCH during decode"}` :
      " no pinned input at fault; second checksum not sampled"));
  return lines;
}
