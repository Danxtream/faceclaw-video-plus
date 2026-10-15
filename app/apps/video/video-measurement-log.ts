type Scope = {stream: number; tokens: readonly number[]};
const PREFIX = "Video measurement ";

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}

/** Aggregate JSON fragments, reassembled by scope/sample/phase/kind and part. */
export function videoMeasurementLogs(scope: Scope, sample: number, phase: string,
    groups: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [kind, value] of Object.entries(groups)) {
    const envelope = {...scope, sample, phase, kind};
    const encode = (part: number, parts: number, data: string) =>
      PREFIX + JSON.stringify({...envelope, part, parts, data});
    // Reserve the largest safe integer's width for both fragment identifiers.
    const room = 700 - utf8Bytes(encode(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ""));
    if (room < 32) throw new Error("Video measurement scope exceeds log budget");
    const pieces: string[] = [];
    let piece = "", bytes = 0;
    for (const char of JSON.stringify(value ?? null)) {
      const cost = utf8Bytes(JSON.stringify(char)) - 2;
      if (bytes + cost > room) { pieces.push(piece); piece = ""; bytes = 0; }
      piece += char; bytes += cost;
    }
    pieces.push(piece);
    pieces.forEach((data, part) => lines.push(encode(part, pieces.length, data)));
  }
  return lines;
}
