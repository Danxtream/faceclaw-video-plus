import { type VideoUploadPlan, type VideoUploadPump } from "./video-upload";

declare const console: { error(...args: unknown[]): void };

/** Only missing query transport evidence may be dropped by passive callers. */
export class VideoReportUnavailable extends Error {
  constructor(readonly op: number, detail: string) { super(detail); }
}

/** Reviewed ID31 commands on a supplied, already authenticated transport. */
export interface VideoBackend {
  epoch(): number;
  exchange(payload: Uint8Array, bytes: number, targets: number, resultOffset: number): Promise<Uint8Array[]>;
  sendWindow(records: readonly Uint8Array[]): Promise<number[]>;
  sendPicture?(record: Uint8Array, metadata: Uint8Array): Promise<Uint8Array[]>;
  sendPipeline?(records: readonly Uint8Array[], following: readonly (Uint8Array | null)[]): Promise<number[]>;
  createUploadPump?(reader: unknown, plan: VideoUploadPlan): VideoUploadPump;
  configureEvidence?(enabled: boolean): void;
}

export const VIDEO = {
  caps: 0, start: 1, stop: 2, reset: 3, status: 4, nal: 6,
  credits: 10, timeline: 11, playbackCaps: 13, metadata: 14, shown: 15,
  pause: 16, resume: 17, playback: 18, menu: 19, scale: 20, radio: 21,
} as const;

/** Read a wire uint32 without signed conversion or alignment assumptions. */
export function videoU32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new Error("Truncated video field");
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0;
}

function put(data: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid video integer");
  for (let i = 0; i < 4; i++) data[offset + i] = value >>> (8 * i);
}

export type VideoStatus = {
  result: number; state: number; stream: number; token: number; high: number;
  error: number; expected: number; accepted: number; consumed: number;
  pictures: number; presented: number; copyTick: number; credits: number; capacity: number;
};

/** Accept only the fixed decoder contract and coherent active-owner counts. */
export function parseVideoStatus(raw: Uint8Array): VideoStatus {
  if (![128, 192].includes(raw.length) || raw[0] !== 1 || raw[1] !== 7 || raw[3] > 4 ||
      videoU32(raw, 32) !== 4096 || videoU32(raw, 36) !== 4086 ||
      raw[40] !== 64 || raw[41] !== 1 || raw[42] !== 192 || raw[43] !== 0 ||
      raw[44] !== 1 || raw[45] !== 2 || raw[46] !== 1 || raw[47] !== 1 ||
      raw[48] !== 4 || raw[49] !== 6 || ![0, 4, 6].includes(raw[50]) || raw[51] > raw[50])
    throw new Error("Unsupported video decoder contract");
  const row = { result: raw[2], state: raw[3], stream: videoU32(raw, 4), token: videoU32(raw, 8),
    high: videoU32(raw, 20), error: videoU32(raw, 24), expected: videoU32(raw, 52),
    accepted: videoU32(raw, 56), consumed: videoU32(raw, 60), pictures: videoU32(raw, 64),
    presented: videoU32(raw, 80), copyTick: videoU32(raw, 88), credits: raw[51], capacity: raw[50] };
  if (row.consumed > row.accepted || (row.state === 2 && row.presented > row.pictures))
    throw new Error("Inconsistent video counts");
  return row;
}

/** One serialized caller owns controls and uploads; requests survive exact replay. */
export class VideoProtocol {
  readonly epoch: number;
  private evidence = false;
  constructor(private readonly backend: VideoBackend, private readonly reserve: () => number | Promise<number>) {
    this.epoch = backend.epoch();
  }
  private check(): void {
    if (this.backend.epoch() !== this.epoch) throw new Error("Video connection generation changed; restart at IDR");
  }
  createUploadPump(reader: unknown, plan: VideoUploadPlan): VideoUploadPump | undefined {
    this.check();
    return reader === undefined ? undefined : this.backend.createUploadPump?.(reader, plan);
  }
  private async header(op: number, bytes: number): Promise<Uint8Array> {
    this.check();
    const raw = new Uint8Array(bytes);
    raw.set([31, op, 1, 0]);
    const id = await this.reserve();
    this.check();
    if (!Number.isInteger(id) || id < 1 || id >= 0xffffffff) throw new Error("Video request ID exhausted");
    put(raw, 4, id);
    return raw;
  }
  private async query(raw: Uint8Array, length: number, targets = 3, resultOffset = 2): Promise<Uint8Array[]> {
    this.check();
    const readOnly = [VIDEO.caps, VIDEO.status, 7, VIDEO.credits, VIDEO.playbackCaps, VIDEO.shown, VIDEO.playback].includes(raw[1]);
    for (let attempt = 0; ; attempt++) {
      let rows: Uint8Array[];
      try { rows = await this.backend.exchange(raw, length, targets, resultOffset); }
      catch (error) {
        this.check();
        if (!readOnly || !String(error).includes("Video query unavailable:")) throw error;
        console.error(`Video read query op=${raw[1]} request=${videoU32(raw, 4)} targets=${targets} attempt=${attempt + 1}: ${error}`);
        if (attempt) throw new VideoReportUnavailable(raw[1], String(error));
        const fresh = await this.header(raw[1], raw.length);
        fresh.set(raw.subarray(8), 8);
        raw = fresh;
        continue;
      }
      this.check();
      if (rows.length !== (targets === 3 ? 2 : 1) || rows.some((row) => row.length !== length))
        throw new Error("Missing lens video reply");
      return rows;
    }
  }
  async status(op: number = VIDEO.status, stream = 0): Promise<VideoStatus[]> {
    const raw = await this.header(op, op === VIDEO.reset || op === VIDEO.stop ? 12 : 8);
    if (raw.length === 12) put(raw, 8, stream);
    return (await this.query(raw, op === VIDEO.status ? 192 : 128)).map(parseVideoStatus);
  }
  async capabilities(): Promise<void> {
    if ((await this.status(VIDEO.caps)).some((row) => row.result || row.error)) throw new Error("Video capabilities refused");
    const rows = await this.query(await this.header(VIDEO.playbackCaps, 8), 16);
    if (rows.some((row) => row[0] !== 1 || row[1] !== 13 || row[2] || row[3] !== 255 ||
      row[4] !== 2 || row[5] !== 16 || row[6] !== 255 || (row[7] & 7) !== 7 || (row[7] & ~63)))
      throw new Error("Paired queued playback controls are not supported");
    this.evidence = rows.every(row => !!(row[7] & 32));
    this.backend.configureEvidence?.(this.evidence);
  }
  /** Read presenter-owned samples only when the paired firmware advertises them. */
  async clockEvidence(phase: number): Promise<void> {
    if (!this.evidence) return;
    if (![0, 1, 2].includes(phase)) throw new Error("Invalid clock phase");
    const raw = await this.header(7, 12); raw[8] = 5; raw[9] = phase;
    const rows = await this.query(raw, 128);
    rows.forEach((row, i) => {
      if (row[0] !== 1 || row[1] !== 7 || row[2] || row[3] !== 5 || row[4] !== phase || row[5] !== 1 || row[6] !== i + 1)
        throw new Error("Invalid clock evidence reply");
      const words = Array.from({length: 22}, (_, j) => videoU32(row, 8 + j * 4));
      const ticks = (words[5] - words[2]) >>> 0, cycles = (words[6] - words[3]) >>> 0;
      const qualified = (row[7] & 7) === 7 && !(row[7] & 24) && ticks >= 250 && ticks <= 1000;
      console.error(`Video clock side=${i + 1} phase=${phase} flags=${row[7]} stream=${words[0]} generation=${words[1]} ` +
        `cyclesPerMs=${qualified ? cycles / ticks : "unqualified"} perfRequest=${words[8] & 3} ` +
        `perfAck=${words[8] >>> 2 & 1} perfStatus=${words[8] >>> 3 & 3} manager=${words[15]} sdkMode=${words[17]} ` +
        `clockEnable=${words[9]} clockMisc=${words[10]} clockControl=${words[11]} ` +
        `pllControl=${words[12]} pllFraction=${words[13]} pllDividers=${words[14]} ` +
        `pllStatus=${words[20]} pllMux=${words[21]} raw=${JSON.stringify(words)}`);
    });
  }
  async radioSelection(enabled: boolean): Promise<void> {
    const raw = await this.header(VIDEO.radio, 12);
    put(raw, 8, enabled ? 1 : 0);
    const rows = await this.query(raw, 24);
    if (rows.some((row, index) => row[0] !== 1 || row[1] !== 21 || row[2] || row[3] !== index + 1 ||
        videoU32(row, 4) !== Number(enabled))) throw new Error("Video radio selection refused");
  }
  async phy(): Promise<Uint8Array[]> {
    // Firmware freezes this kind-1 snapshot, then queues a READ on an idle
    // bound link. START must poll for the resulting per-link sample.
    const raw = await this.header(7, 12);
    raw[8] = 1;
    return this.query(raw, 128);
  }
  async start(stream: number, native: boolean, dither: boolean, radio: boolean, preroll = 0, paused = false, targets = 3): Promise<VideoStatus[]> {
    if (![1, 2, 3].includes(targets)) throw new Error("Invalid START lens mask");
    const raw = await this.header(VIDEO.start, 24);
    if (!Number.isInteger(preroll) || preroll < 0 || preroll > 255) throw new Error("Unsupported seek preroll");
    put(raw, 8, stream);
    raw.set([64, 1, 192, 0, 1, 2, 4 | 8 | (native ? 1 : 0) | (dither ? 16 : 0) | (!radio ? 2 : 0) | (paused ? 32 : 0), preroll], 12);
    put(raw, 20, 63);
    return (await this.query(raw, 128, targets)).map(parseVideoStatus);
  }
  async timeline(stream: number, duration: number, pts: number): Promise<VideoStatus[]> {
    const raw = await this.header(VIDEO.timeline, 24);
    put(raw, 8, stream); put(raw, 12, duration); put(raw, 16, pts); raw[20] = 16; raw[22] = 1;
    return (await this.query(raw, 128)).map(parseVideoStatus);
  }
  async owned(op: number, stream: number, tokens: readonly number[], length: number, value?: number): Promise<Uint8Array[]> {
    if (tokens.length !== 2 || tokens.some((value) => !value)) throw new Error("Video owner token missing");
    const raw = await this.header(op, value === undefined ? 20 : 24);
    put(raw, 8, stream); put(raw, 12, tokens[0]); put(raw, 16, tokens[1]);
    if (value !== undefined) put(raw, 20, value);
    return this.query(raw, length, 3, op === VIDEO.credits ? 5 : 2);
  }
  async metadata(stream: number, ordinal: number, nal: number, pts: number): Promise<boolean> {
    const raw = await this.header(VIDEO.metadata, 24);
    put(raw, 8, stream); put(raw, 12, ordinal); put(raw, 16, nal); put(raw, 20, pts);
    const rows = await this.query(raw, 6, 3, 5);
    if (rows.some((row) => ![0, 3].includes(row[5]) || row[4] > 4 || (!row[5] && videoU32(row, 0) !== ordinal)))
      throw new Error("Picture metadata refused");
    return rows.every((row) => !row[5]);
  }
  async shown(stream: number, token: number, lens: number, cursor = 0): Promise<Uint8Array> {
    const raw = await this.header(VIDEO.shown, 20);
    put(raw, 8, stream); put(raw, 12, token); put(raw, 16, cursor);
    const row = (await this.query(raw, 72, lens))[0];
    if (row[0] !== 1 || row[1] !== VIDEO.shown || (!row[2] &&
        (row[3] !== lens || videoU32(row, 4) !== stream || videoU32(row, 8) !== token)))
      throw new Error("Shown report owner mismatch");
    return row;
  }
  private nalRecords(stream: number, first: number, nals: readonly Uint8Array[]): Uint8Array[] {
    this.check();
    if (nals.length < 1 || nals.length > 4 || first + nals.length >= 0xffffffff) throw new Error("Invalid NAL window");
    return nals.map((nal, index) => {
      if (!nal.length || nal.length > 4086) throw new Error("Complete NAL exceeds advertised limit");
      const record = new Uint8Array(10 + nal.length);
      record.set([31, 6]); put(record, 2, stream); put(record, 6, first + index); record.set(nal, 10);
      return record;
    });
  }
  async sendNals(stream: number, first: number, nals: readonly Uint8Array[]): Promise<void> {
    const masks = await this.backend.sendWindow(this.nalRecords(stream, first, nals));
    this.check();
    if (masks.length !== nals.length || masks.some((mask) => mask !== 3)) throw new Error("Paired NAL transport refused");
  }
  /** Only native transport pipelines; callers retain their granted NAL budget. */
  async sendPipeline(stream: number, first: number, nals: readonly Uint8Array[],
    following: readonly ({ordinal: number; nal: number; pts: number} | null)[]): Promise<number[]> {
    if (!this.backend.sendPipeline || following.length !== nals.length) throw new Error("Video pipeline unavailable");
    const records = this.nalRecords(stream, first, nals);
    const commands: (Uint8Array | null)[] = [];
    for (let i = 0; i < following.length; i++) {
      const next = following[i];
      if (!next) { commands.push(null); continue; }
      if (next.nal !== first + i + 1) throw new Error("Metadata must describe the next NAL");
      const raw = await this.header(VIDEO.metadata, 24);
      put(raw, 8, stream); put(raw, 12, next.ordinal); put(raw, 16, next.nal); put(raw, 20, next.pts);
      commands.push(raw);
    }
    const result = await this.backend.sendPipeline(records, commands);
    this.check();
    const [sent, admitted] = result;
    const expected = commands.slice(0, sent).filter(Boolean).length;
    if (result.length !== 2 || !Number.isInteger(sent) || sent < 1 || sent > records.length ||
        !Number.isInteger(admitted) || admitted < 0 || admitted > expected ||
        (admitted !== expected && (admitted !== expected - 1 || !commands[sent - 1])) ||
        (sent < records.length && admitted === expected)) throw new Error("Invalid video pipeline completion");
    return result;
  }
  /** Next-picture metadata may be busy; its NAL is never sent before acceptance. */
  async sendNalsWithMetadata(stream: number, first: number, nal: Uint8Array,
    next: {ordinal: number; nal: number; pts: number}): Promise<boolean> {
    if (next.nal !== first + 1) throw new Error("Metadata must describe the next NAL");
    if (!this.backend.sendPicture) { await this.sendNals(stream, first, [nal]); return this.metadata(stream, next.ordinal, next.nal, next.pts); }
    const record = this.nalRecords(stream, first, [nal])[0];
    const raw = await this.header(VIDEO.metadata, 24);
    put(raw, 8, stream); put(raw, 12, next.ordinal); put(raw, 16, next.nal); put(raw, 20, next.pts);
    const rows = await this.backend.sendPicture(record, raw);
    this.check();
    if (rows.length !== 2 || rows.some(row => row.length !== 6 || ![0, 3].includes(row[5]) ||
        row[4] > 4 || (!row[5] && videoU32(row, 0) !== next.ordinal))) throw new Error("Picture metadata refused");
    return rows.every(row => !row[5]);
  }
}
