import { videoSeekPoint, type VideoSource } from "./video-clip";
import { VIDEO, VideoProtocol, videoU32, type VideoStatus } from "./video-protocol";
import { parsePlayback, parseShown, parseVideoPhy, videoRestored, videoLive, videoOwnedSnapshot, videoTickSpan, videoCopyRate,
  type VideoPhy, type VideoShown, type VideoPlaybackState } from "./video-observations";

/** Audio stays on the phone's existing media route; all methods are asynchronous. */
export interface VideoAudio {
  sync(position: number, playing: boolean, speed: number, tolerance: number): Promise<void>;
  pause(): Promise<void>;
  close(): Promise<void>;
}
export const silentVideoAudio: VideoAudio = { sync: async () => {}, pause: async () => {}, close: async () => {} };
export type VideoOptions = { native: boolean; dither: boolean; radio: boolean };
export type VideoPlaybackView = {
  active: boolean; paused: boolean; menuOpen: boolean; selection: number; native: boolean;
  position: number; duration: number; fps: number | null; intervals: number;
  lostReports: number; audioUncertainty: number | null; error: string | null;
  cleanupFailed: boolean;
  hostPhy: string;
};
type Protocol = Pick<VideoProtocol, "capabilities" | "status" | "radioSelection" | "timeline" | "start" | "owned" | "metadata" | "sendNals" | "shown" | "phy">;
type Intent = { kind: "pause" | "seek" | "scale" | "menu"; value: number | boolean; resolve: () => void; reject: (error: unknown) => void };
type Generation = { stream: number; tokens: number[]; idr: number; target: number; prefix: number[]; firstNal: number; index: number; count: number; metadata: number; paused: boolean; reached: boolean; oldPhy: VideoPhy[]; started: number };

/** One writer processes uploads and controls; no callback or timer writes BLE. */
export class VideoPlayback {
  readonly view: VideoPlaybackView;
  private intents: Intent[] = [];
  private stopping = false;
  private started = false;
  private generation: Generation | null = null;
  private lastSeek = 0;
  private reportDue = 0;
  private progressAt = 0;
  private progress = -1;
  private copyFirst: VideoShown[] | null = null;
  private copyPrevious: VideoShown[] | null = null;
  private shownCount = 0;
  constructor(private readonly protocol: Protocol, private readonly source: VideoSource,
    private readonly audio: VideoAudio, private readonly options: () => VideoOptions,
    private readonly changed: (view: VideoPlaybackView) => void = () => {},
    private readonly countCopies: (count: number) => void = () => {},
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.view = { active: false, paused: false, menuOpen: false, selection: 0, native: false, position: 0,
      duration: source.clip.duration, fps: null, intervals: 0, lostReports: 0, audioUncertainty: null, error: null, cleanupFailed: false, hostPhy: "Unknown" };
  }
  private notify(): void { this.changed({ ...this.view }); }
  private enqueue(kind: Intent["kind"], value: Intent["value"]): Promise<void> {
    if (!this.view.active || this.stopping || this.intents.length >= 16) return Promise.reject(new Error("Video control unavailable or queue full"));
    return new Promise((resolve, reject) => this.intents.push({ kind, value, resolve, reject }));
  }
  pause(paused: boolean): Promise<void> { return this.enqueue("pause", paused); }
  seek(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds)) return Promise.reject(new Error("Invalid seek position"));
    return this.enqueue("seek", milliseconds);
  }
  scale(native: boolean): Promise<void> { return this.enqueue("scale", native); }
  menu(action: "open" | "close" | "next" | "previous" | "apply"): Promise<void> {
    return this.enqueue("menu", { open: 0, close: 1, next: 2, previous: 3, apply: 4 }[action]);
  }
  stop(): void { this.stopping = true; }
  private async phy(): Promise<VideoPhy[]> { return (await this.protocol.phy()).map((raw, i) => parseVideoPhy(raw, i + 1)); }
  private validateStatus(rows: VideoStatus[], stream?: number, tokens?: number[]): void {
    if (rows.length !== 2 || rows.some((row, i) => row.result || row.error || row.state === 4 ||
        (stream !== undefined && row.state !== 0 && row.stream !== stream) ||
        (tokens && row.state !== 0 && row.token !== tokens[i]))) throw new Error("Video owner or decoder status failed");
  }
  private async waitReady(stream: number): Promise<VideoStatus[]> {
    const deadline = this.clock() + 30_000;
    while (!this.stopping) {
      const rows = await this.protocol.status();
      this.validateStatus(rows, stream);
      if (rows.every((row) => row.state === 2 && row.token)) return rows;
      if (rows.some((row) => ![1, 2].includes(row.state)) || this.clock() > deadline) break;
      await this.sleep(20);
    }
    throw new Error("Video START did not reach both READY owners");
  }
  private async begin(targetMs: number, paused: boolean): Promise<void> {
    const rows = await this.protocol.status();
    this.validateStatus(rows);
    if (rows.some((row) => row.state !== 0)) throw new Error("Video START requires idle owners");
    const stream = Math.max(...rows.map((row) => row.high)) + 1;
    if (stream >= 0xffffffff) throw new Error("Video stream identity exhausted");
    const { frame: target, idr, preroll } = videoSeekPoint(this.source.clip, targetMs);
    const picture = this.source.clip.pictures[idr];
    const firstNal = idr === 0 ? 0 : picture.nal;
    const prefix = idr === 0 ? [] : [picture.sps, picture.pps];
    const oldPhy = await this.phy();
    if (oldPhy.some((side) => side.links.some((link) => link.bound &&
        (!link.connected || !link.valid || link.pending || link.owners || link.permission || link.uncertain || link.status))))
      throw new Error("Video START host links are not clean");
    const selection = this.options();
    await this.protocol.radioSelection(selection.radio);
    this.validateStatus(await this.protocol.timeline(stream, this.source.clip.duration, this.source.clip.pictures[target].pts));
    // Record the attempted stream before START so a partial admission gets STOP.
    this.generation = { stream, tokens: [], idr, target, prefix, firstNal, index: 0,
      count: prefix.length + this.source.clip.h264.nals.length - firstNal, metadata: 0,
      paused, reached: false, oldPhy, started: this.clock() };
    this.validateStatus(await this.protocol.start(stream, selection.native, selection.dither, selection.radio, preroll, paused), stream);
    const ready = await this.waitReady(stream);
    this.generation.tokens = ready.map((row) => row.token);
    const ownedPhy = await this.phy();
    videoLive(oldPhy, ownedPhy);
    this.generation.oldPhy = videoOwnedSnapshot(oldPhy, ownedPhy);
    this.view.native = selection.native;
    this.view.paused = paused;
    this.copyFirst = this.copyPrevious = null;
    this.shownCount = 0;
    this.reportDue = 0;
    this.progressAt = this.clock(); this.progress = -1;
    this.lastSeek = 0;
    this.notify();
  }
  private async retire(reset: boolean): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    // Capture actual lifecycle ownership, even after a partially failed START.
    let before = generation.oldPhy;
    let sampleFailure: unknown = null;
    try {
      before = videoOwnedSnapshot(generation.oldPhy, await this.phy());
    } catch (error) { before = generation.oldPhy; sampleFailure = error; }
    this.validateStatus(await this.protocol.status(reset ? VIDEO.reset : VIDEO.stop, generation.stream));
    const deadline = this.clock() + 30_000;
    while (true) {
      const rows = await this.protocol.status();
      this.validateStatus(rows);
      if (rows.every((row) => row.state === 0) && videoRestored(before, await this.phy())) break;
      if (this.clock() > deadline) throw new Error("Video cleanup or original PHY restoration timed out");
      await this.sleep(20);
    }
    this.generation = null;
    if (sampleFailure) throw sampleFailure;
  }
  private async playback(op: number = VIDEO.playback, value?: number): Promise<VideoPlaybackState[]> {
    const g = this.generation!;
    return (await this.protocol.owned(op, g.stream, g.tokens, op === VIDEO.menu || op === VIDEO.scale ? 48 : 36, value))
      .map((raw, i) => parsePlayback(raw, i + 1, g.stream, g.tokens[i]));
  }
  private async settle(paused?: boolean): Promise<VideoPlaybackState[]> {
    const deadline = this.clock() + 30_000;
    while (!this.stopping) {
      const rows = await this.playback();
      if (rows.some((row) => row.result && row.result !== 3)) throw new Error("Video control refused");
      if (rows.every((row) => !row.result && !row.pending && (paused === undefined ||
          row.paused === paused && row.requestedPause === paused))) return rows;
      if (this.clock() > deadline) break;
      if (!this.view.paused) await this.upload();
      await this.sleep(20);
    }
    throw new Error("Video control did not reach both actual states");
  }
  private async intent(request: Intent): Promise<void> {
    if (!this.generation!.reached) await this.preview();
    if (request.kind === "seek") {
      await this.audio.pause();
      await this.retire(true);
      await this.begin(Number(request.value), this.view.paused);
      await this.preview();
      return;
    }
    const op = request.kind === "pause" ? request.value ? VIDEO.pause : VIDEO.resume :
      request.kind === "scale" ? VIDEO.scale : VIDEO.menu;
    const value = request.kind === "pause" ? undefined : request.kind === "scale" ? request.value ? 1 : 2 : Number(request.value);
    const deadline = this.clock() + 30_000;
    while (true) {
      const rows = await this.playback(op, value);
      if (rows.some((row) => row.result && row.result !== 3)) throw new Error("Video control owner refused");
      if (rows.every((row) => !row.result)) break;
      if (this.stopping || this.clock() > deadline) throw new Error("Video control admission timed out");
      await this.sleep(20);
    }
    const settled = await this.settle(request.kind === "pause" ? Boolean(request.value) : undefined);
    const wasPaused = this.view.paused;
    this.view.paused = settled.every((row) => row.paused);
    if (wasPaused !== this.view.paused) this.copyFirst = this.copyPrevious = null;
    if (this.view.paused) await this.audio.pause();
    if (request.kind === "menu" || request.kind === "scale" || request.kind === "pause") {
      const menu = await this.playback(VIDEO.menu, 5);
      if (menu.some((row) => row.result)) throw new Error("Video menu result refused");
      const right = menu[1];
      this.view.menuOpen = right.menuOpen; this.view.selection = right.selection;
      this.view.native = right.nativeSelected;
      if (right.seekSerial !== this.lastSeek) {
        this.lastSeek = right.seekSerial;
        await this.audio.pause();
        await this.retire(true);
        await this.begin(right.seekTarget, right.paused);
        await this.preview();
      }
    }
    this.reportDue = 0;
    this.notify();
  }
  private async upload(): Promise<boolean> {
    const g = this.generation!;
    const credit = await this.protocol.owned(VIDEO.credits, g.stream, g.tokens, 6);
    const expected = credit.map((raw) => videoU32(raw, 0));
    let count = Math.min(4, g.count - g.index);
    for (let side = 0; side < 2; side++) {
      const packed = credit[side][4], state = packed >>> 4 & 7, capacity = packed & 8 ? 6 : 4, free = packed & 7;
      if (credit[side][5] || state !== 2 || free > capacity || expected[side] > g.index || g.index - expected[side] > capacity)
        throw new Error("Video owner credit window failed");
      count = Math.min(count, free, capacity + expected[side] - g.index);
    }
    if (count <= 0) return false;
    const records: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const sequence = g.index + i;
      const sourceIndex = sequence < g.prefix.length ? g.prefix[sequence] : g.firstNal + sequence - g.prefix.length;
      const pictureIndex = g.idr + g.metadata;
      const picture = this.source.clip.pictures[pictureIndex];
      if (picture && picture.nal === sourceIndex) {
        if (!await this.protocol.metadata(g.stream, g.metadata + 1, sequence, picture.pts)) break;
        g.metadata++;
      }
      records.push(await this.source.readNal(sourceIndex));
    }
    if (!records.length) return false;
    await this.protocol.sendNals(g.stream, g.index, records);
    g.index += records.length;
    return true;
  }
  private async observe(): Promise<void> {
    const g = this.generation!;
    const began = this.clock();
    const phy = await this.phy();
    videoLive(g.oldPhy, phy);
    g.oldPhy = videoOwnedSnapshot(g.oldPhy, phy);
    const left = parseShown(await this.protocol.shown(g.stream, g.tokens[0], 1), 1, g.stream, g.tokens[0]);
    if (!left) return;
    const right = parseShown(await this.protocol.shown(g.stream, g.tokens[1], 2, left.serial), 2, g.stream, g.tokens[1]);
    if (!right || left.ordinal !== right.ordinal || left.pts !== right.pts) return;
    const picture = this.source.clip.pictures[g.idr + left.ordinal - 1];
    if (!picture || picture.pts !== left.pts || g.idr + left.ordinal - 1 < g.target) throw new Error("Shown picture does not match audited seek timeline");
    const capturedPhy = await this.phy();
    videoLive(g.oldPhy, capturedPhy);
    g.oldPhy = videoOwnedSnapshot(g.oldPhy, capturedPhy);
    const pairs = phy[0].links.filter((link) => link.bound && link.valid).map((link) =>
      `${["", "1M", "2M", "Coded"][link.current & 255]}/${["", "1M", "2M", "Coded"][link.current >>> 8]}`);
    this.view.hostPhy = pairs.length ? [...new Set(pairs)].join(", ") : "Unknown";
    const captures = [left, right];
    const ages = captures.map((row, i) => videoTickSpan(capturedPhy[i].tick, row.copyTick));
    g.reached = true;
    this.view.position = left.pts;
    this.view.lostReports = Math.max(left.lost, right.lost);
    this.view.audioUncertainty = captures.some((row) => row.uncertain) ? null : this.clock() - began;
    const relative = left.ordinal - (g.target - g.idr);
    if (relative > this.shownCount) { this.countCopies(relative - this.shownCount); this.shownCount = relative; }
    if (!this.copyFirst) this.copyFirst = captures;
    const rates = captures.map((row, i) => videoCopyRate(this.copyFirst![i], row));
    this.view.fps = rates.every((rate) => rate.fps !== null) ? Math.min(...rates.map((rate) => rate.fps!)) : null;
    this.view.intervals = Math.min(...rates.map((rate) => rate.intervals));
    let speed = 1;
    if (this.copyPrevious && left.ordinal > this.copyPrevious[0].ordinal) {
      const spans = captures.map((row, i) => videoTickSpan(row.copyTick, this.copyPrevious![i].copyTick));
      speed = Math.min(...captures.map((row, i) => spans[i] ? (row.pts - this.copyPrevious![i].pts) / spans[i] : 1));
      speed = Math.max(0.25, Math.min(2, speed));
    }
    this.copyPrevious = captures;
    if (this.view.paused) await this.audio.sync(left.pts, false, 1, 0);
    else if (ages.some((age) => age > 2000)) await this.audio.pause();
    else await this.audio.sync(Math.min(this.source.clip.duration, left.pts + Math.min(...ages) * speed), true,
      speed, Math.max(100, this.clock() - began));
    this.notify();
  }
  private async preview(): Promise<void> {
    const deadline = this.clock() + 30_000;
    while (!this.generation!.reached && !this.stopping) {
      await this.upload();
      await this.observe();
      if (this.clock() > deadline) throw new Error("Seek target was not shown by both lenses");
      await this.sleep(10);
    }
    if (this.generation!.paused) await this.settle(true);
  }
  /** Run once through EOF or explicit STOP; seeks retain the same source/writer. */
  async run(position = 0, paused = false): Promise<void> {
    if (this.started) throw new Error("Video engine is single use");
    this.started = true;
    this.view.active = true; this.notify();
    let failure: unknown = null;
    try {
      await this.protocol.capabilities();
      if (this.stopping) return;
      await this.begin(position, paused);
      while (!this.stopping) {
        const intent = this.intents.shift();
        if (intent) {
          try { await this.intent(intent); intent.resolve(); } catch (error) { intent.reject(error); throw error; }
          continue;
        }
        const g = this.generation!;
        const uploaded = await this.upload();
        if (this.clock() >= this.reportDue) {
          await this.observe();
          this.reportDue = this.clock() + 500;
          const state = await this.playback();
          if (state.some((row) => row.result)) throw new Error("Video playback owner report refused");
          this.view.paused = state.every((row) => row.paused);
          if (this.view.paused) await this.audio.pause();
          const shown = Math.min(...state.map((row) => row.shown));
          if (shown !== this.progress) { this.progress = shown; this.progressAt = this.clock(); }
          if (g.index === g.count && state.every((row) => !row.paused && !row.pending &&
              row.shown === this.source.clip.pictures.length - g.target)) break;
          if (!this.view.paused && this.clock() - this.progressAt > 30_000) throw new Error("Video stopped making copy progress");
          this.notify();
        }
        if (!uploaded || this.view.paused) await this.sleep(20);
      }
    } catch (error) { failure = error; }
    finally {
      try { await this.audio.pause(); } catch (error) { failure ??= error; }
      try { await this.retire(false); } catch (error) {
        this.view.cleanupFailed = this.generation !== null;
        failure = new Error(`${failure ? String(failure) + "; " : ""}cleanup failed: ${error}`);
      }
      try { await this.audio.close(); } catch (error) { failure ??= error; }
      try { this.source.close(); } catch (error) { failure ??= error; }
      for (const intent of this.intents.splice(0)) intent.reject(new Error("Video ended before control completed"));
      this.view.active = false;
      this.view.error = failure ? String(failure) : null;
      this.notify();
    }
    if (failure) throw failure;
  }
}
