import { videoSeekPoint, type VideoSource } from "./video-clip";
import { type VideoUploadPump, type VideoUploadProgress } from "./video-upload";
import { VideoAvSync, videoAvOptions, type VideoAvAction } from "./video-av-sync";
import { VideoMeasurement } from "./video-measurement";
import { videoMeasurementLogs } from "./video-measurement-log";
import { VIDEO, VideoProtocol, VideoReportUnavailable, videoStaleError, videoU32, type VideoStatus } from "./video-protocol";
import { parsePlayback, parseShown, parseVideoPhy, videoRestored, videoLive, videoOwnedSnapshot, videoTickSpan, videoCopyRate, videoPhyDetails,
  type VideoPhy, type VideoShown, type VideoPlaybackState } from "./video-observations";

declare const console: { error(message: string): void };

/** Audio stays on the phone's existing media route; all methods are asynchronous. */
export interface VideoAudio {
  sync(position: number, playing: boolean, speed: number, tolerance: number): Promise<void>;
  pause(): Promise<void>;
  close(): Promise<void>;
  /** Audio renderer position now (ms); enables picture-led sync. */
  position?(): number | null;
}
export const silentVideoAudio: VideoAudio = { sync: async () => {}, pause: async () => {}, close: async () => {} };
export type VideoOptions = { native: boolean; dither: boolean; radio: boolean; detailedReports?: boolean };
export type VideoPlaybackView = {
  active: boolean; paused: boolean; menuOpen: boolean; selection: number; native: boolean;
  position: number; duration: number; fps: number | null; intervals: number;
  lostReports: number; audioUncertainty: number | null; error: string | null;
  cleanupFailed: boolean;
  hostPhy: string;
};
type Protocol = Pick<VideoProtocol, "capabilities" | "status" | "radioSelection" | "timeline" | "start" | "owned" | "metadata" | "sendNals" | "shown" | "phy"> & Partial<Pick<VideoProtocol, "sendNalsWithMetadata" | "sendPipeline" | "createUploadPump" | "clockEvidence" | "rateEvidenceRows" | "measurementSnapshot" | "beginMeasurement" | "timedNal">>;
type Intent = { kind: "pause" | "seek" | "scale" | "menu"; value: number | boolean; resolve: () => void; reject: (error: unknown) => void };
type Generation = { stream: number; tokens: number[]; idr: number; target: number; prefix: number[]; firstNal: number; index: number; count: number; metadata: number; paused: boolean; reached: boolean; oldPhy: VideoPhy[]; started: number; anchor: VideoPhy[]; anchorAt: number; anchorUncertainty: number; detailedReports: boolean; pump?: VideoUploadPump };

class VideoCancelled extends Error { constructor() { super("Video cancelled"); } }

/** One writer processes uploads and controls; no callback or timer writes BLE. */
export class VideoPlayback {
  readonly view: VideoPlaybackView;
  private intents: Intent[] = [];
  private stopping = false;
  private started = false;
  private generation: Generation | null = null;
  private lastSeek = 0;
  private reportDue = 0;
  private reportAt = 0;
  private progressAt = 0;
  private progress = -1;
  private copyFirst: VideoShown[] | null = null;
  private copyPrevious: VideoShown[] | null = null;
  private shownCount = 0;
  private reportSafe = false;
  private shownDue = 0;
  private ended = false;
  private consumed = -1;
  private creditBudget = 0;
  private metadataStaged = false;
  private av: VideoAvSync | null = null;
  private audioPlaying = false;
  private positionShownAt = 0;
  private rate = { at: 0, sent: 0, consumed: 0, sentPictures: 0, consumedPictures: 0, drops: 0 };
  private measurement: VideoMeasurement | null = null;
  private nativeMeasurement: unknown = null;
  private measurementSample = 0;
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
  stop(): void { this.stopping = true; this.generation?.pump?.pause(); }
  private async phy(): Promise<VideoPhy[]> {
    await this.suspendUpload();
    return (await this.protocol.phy()).map((raw, i) => parseVideoPhy(raw, i + 1));
  }
  private uploadProgress(): VideoUploadProgress {
    const g = this.generation!, row = g.pump!.snapshot();
    if (![row.index, row.metadata, row.consumed, row.budget].every(Number.isInteger) ||
        row.index < g.index || row.index > g.count || row.metadata < g.metadata || row.metadata > this.source.clip.pictures.length - g.idr ||
        row.consumed < -1 || row.consumed > row.index || row.budget < 0 || row.budget > 6 ||
        typeof row.running !== "boolean" || typeof row.blocked !== "boolean" || typeof row.error !== "string")
      throw new Error("Invalid native upload progress");
    g.index = row.index; g.metadata = row.metadata; this.creditBudget = row.budget;
    if (row.consumed > this.consumed) { this.consumed = row.consumed; this.progressAt = this.clock(); }
    if (row.error) throw new Error(row.error);
    this.nativeMeasurement = {timing: row.measurement ?? null, consumedL: row.consumedL,
      consumedR: row.consumedR, creditAgeMs: row.creditAgeMs, budget: row.budget};
    return row;
  }
  private async suspendUpload(): Promise<void> {
    const from = this.clock();
    const pump = this.generation?.pump;
    if (!pump) return;
    pump.pause();
    const deadline = this.clock() + 30_000;
    while (pump.snapshot().running) {
      if (this.clock() >= deadline) throw new Error("Native upload writer did not fence");
      await this.sleep(10);
    }
    this.uploadProgress();
    this.measurement?.span(from, this.clock(), "writer-fence");
  }
  private startPhyError(detail: string): Error {
    const message = `Video START host links are not clean: ${detail}`;
    console.error(message);
    return new Error(message);
  }
  private async cleanStartPhy(): Promise<VideoPhy[]> {
    const deadline = this.clock() + 8_000;
    let first: VideoPhy[];
    try { first = await this.phy(); }
    catch (error) { if (this.stopping) throw new VideoCancelled(); throw this.startPhyError(String(error)); }
    let current = first;
    // Kind-1 diagnostics queue READ after freezing the reply. Require a newer
    // per-link event tick, not merely a later report or an old valid sample.
    for (let polls = 0; ; polls++) {
      if (this.stopping) throw new VideoCancelled();
      const failed: string[] = [], waiting: string[] = [];
      for (let side = 0; side < 2; side++) {
        if (!current[side].links.some((link) => link.bound)) {
          failed.push(current[side].links.map((link, i) =>
            `failed=bound; ${videoPhyDetails(side + 1, i + 1, link)}`).join("; "));
        }
        for (let i = 0; i < 3; i++) {
          const old = first[side].links[i], link = current[side].links[i];
          if (!old.bound && !link.bound) continue;
          const fields = [old.bound !== link.bound && "bound", !link.connected && "connected",
            link.epoch !== old.epoch && "epoch", link.owners && "owners", link.permission && "permission",
            link.uncertain && "uncertain", link.status && "status",
            link.pending && (polls === 0 || link.operation !== 1) && "pending"].filter(Boolean);
          const details = videoPhyDetails(side + 1, i + 1, link);
          if (fields.length) failed.push(`failed=${fields.join(",")}; ${details}`);
          else {
            const missing = [!link.valid && "valid", link.pending && "pending",
              link.sampleTick === old.sampleTick && "fresh PHY sample"].filter(Boolean);
            if (missing.length) waiting.push(`waiting=${missing.join(",")}; ${details}`);
          }
        }
      }
      if (failed.length) throw this.startPhyError(failed.join("; "));
      if (this.clock() >= deadline || polls + 1 >= 80) {
        const evidence = waiting.length ? waiting : current.flatMap((side) => side.links.map((link, i) =>
          videoPhyDetails(side.lens, i + 1, link)));
        throw this.startPhyError(`PHY read timed out; ${evidence.join("; ")}`);
      }
      if (!waiting.length) return current;
      await this.sleep(100);
      try { current = await this.phy(); }
      catch (error) { if (this.stopping) throw new VideoCancelled(); throw this.startPhyError(`${String(error)}; ${waiting.join("; ")}`); }
    }
  }
  /** `beforeStart`: an idle lens's error from its finished stream is history that START clears. */
  private validateStatus(rows: VideoStatus[], operation: number = VIDEO.status, stream?: number, tokens?: number[],
    beforeStart = false): void {
    const name = Object.entries(VIDEO).find(([, value]) => value === operation)?.[0].toUpperCase() ?? "UNKNOWN";
    const failures = rows.length === 2 ? [] : [`operation=${name}(${operation}) expected=2 lenses received=${rows.length}`];
    rows.forEach((row, i) => {
      if (row.result || row.error && !(beforeStart && videoStaleError(row)) || row.state === 4 ||
          (stream !== undefined && row.state !== 0 && row.stream !== stream) ||
          (tokens && row.state !== 0 && row.token !== tokens[i]))
        failures.push(`${i === 0 ? "LEFT" : "RIGHT"} operation=${name}(${operation}) result=${row.result}` +
          ` state=${row.state} error=${row.error} stream=${row.stream} high=${row.high} token=${row.token}`);
    });
    if (failures.length) {
      const message = `Video owner or decoder status failed: ${failures.join("; ")}`;
      console.error(message);
      throw new Error(message);
    }
  }
  private async waitReady(stream: number): Promise<VideoStatus[]> {
    const deadline = this.clock() + 30_000;
    while (!this.stopping) {
      const rows = await this.protocol.status();
      this.validateStatus(rows, VIDEO.status, stream);
      if (rows.every((row) => row.state === 2 && row.token)) return rows;
      if (rows.some((row) => ![1, 2].includes(row.state)) || this.clock() > deadline) break;
      await this.sleep(20);
    }
    if (this.stopping) throw new VideoCancelled();
    throw new Error("Video START did not reach both READY owners");
  }
  private async begin(targetMs: number, paused: boolean): Promise<void> {
    this.measurement = null;
    const rows = await this.protocol.status();
    this.validateStatus(rows, VIDEO.status, undefined, undefined, true);
    if (rows.some((row) => row.state !== 0)) throw new Error("Video START requires idle owners");
    const stream = Math.max(...rows.map((row) => row.high)) + 1;
    if (stream >= 0xffffffff) throw new Error("Video stream identity exhausted");
    const { frame: target, idr, preroll } = videoSeekPoint(this.source.clip, targetMs);
    const picture = this.source.clip.pictures[idr];
    const firstNal = idr === 0 ? 0 : picture.nal;
    const prefix = idr === 0 ? [] : [picture.sps, picture.pps];
    const oldPhy = await this.cleanStartPhy();
    if (this.stopping) throw new VideoCancelled();
    const selection = this.options();
    await this.protocol.radioSelection(selection.radio);
    this.validateStatus(await this.protocol.timeline(stream, this.source.clip.duration, this.source.clip.pictures[target].pts, this.source.clip.fps),
      VIDEO.timeline, undefined, undefined, true);
    if (this.stopping) throw new VideoCancelled();
    // Record the attempted stream before START so a partial admission gets STOP.
    this.generation = { stream, tokens: [], idr, target, prefix, firstNal, index: 0,
      count: prefix.length + this.source.clip.h264.nals.length - firstNal, metadata: 0,
      paused, reached: false, oldPhy, started: this.clock(), anchor: oldPhy, anchorAt: this.clock(),
      anchorUncertainty: 0, detailedReports: !!selection.detailedReports };
    const start = await this.protocol.start(stream, selection.native, selection.dither, selection.radio, preroll, paused, 3, this.source.clip.fps);
    const retryDeadline = this.clock() + 1_000;
    for (let attempt = 0; ; attempt++) {
      if (this.stopping) throw new VideoCancelled();
      const mask = start.reduce((bits, row, i) => bits | (row.result === 4 && !row.error &&
        row.state === 0 && row.stream !== stream && row.high < stream ? 1 << i : 0), 0);
      // Only a proven unadmitted LEASE refusal may be retried. Preserve the
      // already-admitted peer and use a fresh request ID, not cached refusal.
      this.validateStatus(start.map((row, i) => mask & 1 << i ? {...row, result: 0} : row), VIDEO.start, stream);
      if (!mask) break;
      if (attempt >= 3 || this.stopping || this.clock() >= retryDeadline) {
        this.validateStatus(start, VIDEO.start, stream);
        break;
      }
      await this.sleep(200);
      if (this.stopping) throw new VideoCancelled();
      if (this.stopping || this.clock() >= retryDeadline) {
        this.validateStatus(start, VIDEO.start, stream);
        break;
      }
      const retry = await this.protocol.start(stream, selection.native, selection.dither, selection.radio, preroll, paused, mask, this.source.clip.fps);
      let index = 0;
      for (let i = 0; i < 2; i++) if (mask & 1 << i) start[i] = retry[index++];
    }
    const ready = await this.waitReady(stream);
    this.generation.tokens = ready.map((row) => row.token);
    await this.clockEvidence(0);
    const anchorBegin = this.clock();
    const ownedPhy = await this.phy();
    videoLive(oldPhy, ownedPhy);
    this.generation.oldPhy = videoOwnedSnapshot(oldPhy, ownedPhy);
    this.generation.anchor = ownedPhy;
    this.generation.anchorAt = (anchorBegin + this.clock()) / 2;
    this.generation.anchorUncertainty = (this.clock() - anchorBegin) / 2;
    this.updateHostPhy(ownedPhy);
    this.view.native = selection.native;
    this.view.paused = paused;
    this.copyFirst = this.copyPrevious = null;
    this.shownCount = 0;
    this.reportDue = 0;
    this.reportAt = this.clock();
    this.shownDue = 0; this.ended = false; this.consumed = -1;
    this.creditBudget = 0;
    this.progressAt = this.clock(); this.progress = -1;
    this.lastSeek = 0;
    this.av = this.audio.position ? new VideoAvSync(this.source.clip.duration, videoAvOptions(this.source.clip.fps)) : null;
    this.rate = { at: this.clock(), sent: 0, consumed: Math.max(0, this.consumed), sentPictures: 0, consumedPictures: 0, drops: 0 };
    this.measurement = new VideoMeasurement(stream, this.generation.tokens, this.source.clip.fps);
    this.nativeMeasurement = null;
    this.measurementSample = 0;
    this.protocol.beginMeasurement?.(stream);
    this.logMeasurement("start", {transportBaseline: this.readMeasurement()});
    const g = this.generation;
    g.pump = this.protocol.createUploadPump?.(this.source.uploadHandle, {
      stream, tokens: g.tokens, prefix: g.prefix, firstNal: g.firstNal, count: g.count,
      pictures: this.source.clip.pictures.slice(g.idr).map(({nal, pts}) => ({nal, pts})),
    });
    this.notify();
  }
  private async retire(reset: boolean): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    let pumpFailure: unknown = null;
    try { await this.suspendUpload(); } catch (error) { pumpFailure = error; }
    try { generation.pump?.close(); } catch (error) { pumpFailure ??= error; }
    generation.pump = undefined;
    // Capture actual lifecycle ownership, even after a partially failed START.
    let before = generation.oldPhy;
    let sampleFailure: unknown = pumpFailure;
    try {
      before = videoOwnedSnapshot(generation.oldPhy, await this.phy());
    } catch (error) { before = generation.oldPhy; sampleFailure = error; }
    const stopped = await this.protocol.status(reset ? VIDEO.reset : VIDEO.stop, generation.stream);
    // Firmware retains stream and stream_high after admission. Idle STALE with
    // a lower high-water proves this attempted stream never acquired an owner.
    this.validateStatus(stopped.map((row) => row.result === 2 && !row.error && row.state === 0 &&
      row.stream !== generation.stream && row.high < generation.stream ? {...row, result: 0} : row), reset ? VIDEO.reset : VIDEO.stop);
    const deadline = this.clock() + 30_000;
    while (true) {
      const rows = await this.protocol.status();
      this.validateStatus(rows);
      if (rows.every((row) => row.state === 0) && videoRestored(before, await this.phy())) break;
      if (this.clock() > deadline) throw new Error("Video cleanup or original PHY restoration timed out");
      await this.sleep(20);
    }
    // Never hold a user cancel/seek for observational tail reads. Normal EOF
    // gets a bounded drain; one already-running native request owns its deadline.
    const tailUntil = this.clock() + 3000, tail = !this.stopping && !reset;
    for (let i = 0; tail && i < 4 && this.clock() < tailUntil; i++) await this.collectMeasurement();
    for (let i = 0; tail && i < 3 && this.clock() < tailUntil; i++) await this.collectMeasurement(true);
    try {
      const histogram = tail && this.measurement && this.clock() < tailUntil ?
        await this.protocol.rateEvidenceRows?.(generation.stream, [0, 0], 2) : null;
      if (histogram) this.measurement?.accept(histogram, 2);
    } catch (error) { this.measurement?.unavailableSample(error); }
    this.logMeasurement("final", {shown: this.measurement?.summary(true) ?? null,
      pump: this.nativeMeasurement, transport: this.readMeasurement()});
    this.generation = null;
    await this.clockEvidence(2);
    if (sampleFailure) throw sampleFailure;
  }
  private async playback(op: number = VIDEO.playback, value?: number): Promise<VideoPlaybackState[]> {
    await this.suspendUpload();
    const g = this.generation!;
    return (await this.protocol.owned(op, g.stream, g.tokens, op === VIDEO.menu || op === VIDEO.scale ? 48 : 36, value))
      .map((raw, i) => parsePlayback(raw, i + 1, g.stream, g.tokens[i]));
  }
  private async clockEvidence(phase: number): Promise<void> {
    if (!this.protocol.clockEvidence) return;
    try { await this.protocol.clockEvidence(phase); }
    catch (error) { console.error(`Video clock evidence unavailable phase=${phase}: ${error}`); }
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
    if (this.stopping) throw new VideoCancelled();
    throw new Error("Video control did not reach both actual states");
  }
  private async intent(request: Intent): Promise<void> {
    if (this.stopping) throw new VideoCancelled();
    await this.suspendUpload();
    if (!this.generation!.reached) await this.preview();
    if (request.kind === "seek") {
      await this.pauseAudio();
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
      if (this.stopping) throw new VideoCancelled();
      if (this.clock() > deadline) throw new Error("Video control admission timed out");
      await this.sleep(20);
    }
    const settled = await this.settle(request.kind === "pause" ? Boolean(request.value) : undefined);
    const wasPaused = this.view.paused;
    this.setPaused(settled.every((row) => row.paused));
    if (wasPaused !== this.view.paused) {
      this.copyFirst = this.copyPrevious = null;
      // A resumed picture starts moving now from the frame the lenses held.
      if (!this.view.paused) this.av?.restart(Math.max(...settled.map((row) => row.position)), this.clock());
    }
    if (this.view.paused) await this.pauseAudio();
    else await this.syncAudio();
    if (request.kind === "menu" || request.kind === "scale" || request.kind === "pause") {
      const menu = await this.playback(VIDEO.menu, 5);
      if (menu.some((row) => row.result)) throw new Error("Video menu result refused");
      const right = menu[1];
      this.view.menuOpen = right.menuOpen; this.view.selection = right.selection;
      this.view.native = right.nativeSelected;
      if (right.seekSerial !== this.lastSeek) {
        this.lastSeek = right.seekSerial;
        await this.pauseAudio();
        await this.retire(true);
        await this.begin(right.seekTarget, right.paused);
        await this.preview();
      }
    }
    this.notify();
  }
  private async readNal(index: number): Promise<Uint8Array> {
    if (this.stopping) throw new VideoCancelled();
    try { return await this.source.readNal(index); }
    catch (error) { if (this.stopping) throw new VideoCancelled(); throw error; }
  }
  private async credits(): Promise<void> {
    await this.suspendUpload();
    const g = this.generation!;
    const began = this.clock();
    // Timed uploads ask for timeline room too; the pump spends it on timed NALs.
    const timed = this.protocol.timedNal === true && !!g.pump;
    const credit = timed ? await this.protocol.owned(VIDEO.credits, g.stream, g.tokens, 6, 1) :
      await this.protocol.owned(VIDEO.credits, g.stream, g.tokens, 6);
    if (credit.length !== 2 || credit.some(row => row.length !== 6)) throw new Error("Missing lens video reply");
    const expected = credit.map((raw) => videoU32(raw, 0));
    let budget = 6;
    for (let side = 0; side < 2; side++) {
      const packed = credit[side][4], state = packed >>> 4 & 7, capacity = packed & 8 ? 6 : 4, free = packed & 7;
      if (credit[side][5] & (timed ? 31 : 255) || (timed && (credit[side][5] >>> 5) > 6) ||
          packed & 128 || state !== 2 || free > capacity || expected[side] > g.index || g.index - expected[side] > capacity)
        throw new Error("Video owner credit window failed");
      budget = Math.min(budget, free, capacity + expected[side] - g.index);
    }
    this.creditBudget = budget;
    g.pump?.offerCredits?.(g.stream, g.tokens, g.index, credit, this.clock() - began);
    const consumed = Math.min(...expected);
    if (consumed !== this.consumed) { this.consumed = consumed; this.progressAt = this.clock(); }
  }
  private async upload(): Promise<boolean> {
    const g = this.generation!;
    if (g.pump) {
      const previous = g.index;
      g.pump.resume();
      await this.sleep(50);
      const row = this.uploadProgress();
      this.reportSafe = row.blocked || g.index === g.count;
      this.metadataStaged = false;
      return g.index > previous;
    }
    this.reportSafe = false;
    this.metadataStaged = false;
    if (!this.creditBudget || g.detailedReports || g.index === g.count) await this.credits();
    const count = Math.min(4, this.creditBudget, g.count - g.index);
    if (count <= 0) {
      const picture = this.source.clip.pictures[g.idr + g.metadata];
      const sourceIndex = g.index < g.prefix.length ? g.prefix[g.index] : g.firstNal + g.index - g.prefix.length;
      // Admit the next picture while blocked, so a slow sample cannot leave a
      // newly credited NAL waiting for its mandatory metadata round trip.
      if (!g.detailedReports && g.index < g.count && picture?.nal === sourceIndex) {
        if (await this.protocol.metadata(g.stream, g.metadata + 1, g.index, picture.pts)) {
          g.metadata++; this.metadataStaged = true;
        }
        return false;
      }
      this.reportSafe = true; return false;
    }
    const records: Uint8Array[] = [];
    if (!g.detailedReports && this.protocol.sendPipeline) {
      const following: ({ordinal: number; nal: number; pts: number} | null)[] = [];
      const sourceIndex = (sequence: number) => sequence < g.prefix.length ? g.prefix[sequence] : g.firstNal + sequence - g.prefix.length;
      const first = this.source.clip.pictures[g.idr + g.metadata];
      if (first?.nal === sourceIndex(g.index)) {
        if (!await this.protocol.metadata(g.stream, g.metadata + 1, g.index, first.pts)) return false;
        g.metadata++;
      }
      let metadata = g.metadata;
      for (let i = 0; i < count; i++) {
        records.push(await this.readNal(sourceIndex(g.index + i)));
        const next = this.source.clip.pictures[g.idr + metadata];
        const command = next?.nal === sourceIndex(g.index + i + 1) ?
          {ordinal: metadata + 1, nal: g.index + i + 1, pts: next.pts} : null;
        following.push(command);
        if (command) metadata++;
      }
      const [sent, admitted] = await this.protocol.sendPipeline(g.stream, g.index, records, following);
      g.index += sent; g.metadata += admitted; this.creditBudget -= sent;
      return true;
    }
    for (let i = 0; i < count; i++) {
      const sequence = g.index + i;
      const sourceIndex = sequence < g.prefix.length ? g.prefix[sequence] : g.firstNal + sequence - g.prefix.length;
      const pictureIndex = g.idr + g.metadata;
      const picture = this.source.clip.pictures[pictureIndex];
      if (picture && picture.nal === sourceIndex) {
        if (!await this.protocol.metadata(g.stream, g.metadata + 1, sequence, picture.pts)) break;
        g.metadata++;
      }
      records.push(await this.readNal(sourceIndex));
      // Do not hold a credited finishing NAL behind another picture's metadata.
      if ([1, 5].includes(this.source.clip.h264.nals[sourceIndex].type)) break;
    }
    if (!records.length) return false;
    const next = this.source.clip.pictures[g.idr + g.metadata];
    const nextSource = g.firstNal + g.index + records.length - g.prefix.length;
    if (!g.detailedReports && records.length === 1 && next?.nal === nextSource && this.protocol.sendNalsWithMetadata) {
      if (await this.protocol.sendNalsWithMetadata(g.stream, g.index, records[0],
        {ordinal: g.metadata + 1, nal: g.index + records.length, pts: next.pts})) g.metadata++;
    } else await this.protocol.sendNals(g.stream, g.index, records);
    g.index += records.length;
    this.creditBudget -= records.length;
    return true;
  }
  /** Map completed NAL ranges through the audited picture map, never to shown fps. */
  private pictureBound(sequence: number): number {
    const g = this.generation;
    if (!g || sequence < g.prefix.length) return 0;
    const next = g.firstNal + sequence - g.prefix.length, pictures = this.source.clip.pictures;
    let low = g.idr, high = pictures.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const end = pictures[middle + 1]?.nal ?? this.source.clip.h264.nals.length;
      if (end <= next) low = middle + 1; else high = middle;
    }
    return low - g.idr;
  }
  /** Native elapsed counters replace sampled blocked share; NALs are not pictures. */
  private logRate(): void {
    const g = this.generation, now = this.clock();
    if (!g || now - this.rate.at < 1000) return;
    const seconds = (now - this.rate.at) / 1000, consumed = Math.max(0, this.consumed);
    const sentPictures = this.pictureBound(g.index), consumedPictures = this.pictureBound(consumed);
    const video = this.av?.video(now) ?? null, audio = this.audio.position?.() ?? null;
    const lag = video === null || audio === null || !this.audioPlaying ? "--" : `${Math.round(audio - video)}ms`;
    this.logMeasurement("rate", {rate: {
      nalsSent: (g.index - this.rate.sent) / seconds, consumedNals: (consumed - this.rate.consumed) / seconds, lag,
      sentPictureBound: (sentPictures - this.rate.sentPictures) / seconds,
      consumedPictureBound: (consumedPictures - this.rate.consumedPictures) / seconds,
      admitted: g.metadata, paused: this.view.paused, drops: this.rate.drops},
      pump: this.nativeMeasurement, transport: this.readMeasurement(), shown: this.measurement?.summary() ?? null});
    this.rate = { at: now, sent: g.index, consumed, sentPictures, consumedPictures, drops: 0 };
  }
  private readMeasurement(): unknown {
    try { return this.protocol.measurementSnapshot?.() ?? null; }
    catch (error) { this.measurement?.unavailableSample(error); return null; }
  }
  private logMeasurement(phase: string, groups: Record<string, unknown>): void {
    const g = this.generation;
    if (g) for (const line of videoMeasurementLogs({stream: g.stream, tokens: g.tokens},
      this.measurementSample++, phase, groups)) console.error(line);
  }
  private async collectMeasurement(dips = false): Promise<void> {
    const g = this.generation, measurement = this.measurement;
    if (!g || !measurement || !this.protocol.rateEvidenceRows) return;
    const began = this.clock();
    try {
      const rows = await this.protocol.rateEvidenceRows(g.stream, dips ? measurement.dipCursors : measurement.cursors, Number(dips));
      if (!rows) return;
      const anchors = rows.map((raw, side) => raw[7] & 1 ? g.anchorAt + videoTickSpan(videoU32(raw, 20), g.anchor[side].tick) : undefined);
      const bad = measurement.accept(rows, Number(dips), anchors.every(a => a !== undefined) ? anchors as number[] : undefined);
      if (bad && !dips) {
        const events = await this.protocol.rateEvidenceRows(g.stream, measurement.dipCursors, 1);
        if (events) measurement.accept(events, 1);
      }
    } catch (error) { measurement.unavailableSample(error); }
    finally { measurement.span(began, this.clock(), "cadence-diagnostic"); }
  }
  private async pauseAudio(): Promise<void> {
    await this.audio.pause();
    this.audioPlaying = false;
  }
  /** Presentation time of the newest picture either decoder has taken, if shown. */
  private consumedPts(): number | null {
    const g = this.generation;
    if (!g || this.consumed <= g.prefix.length) return null;
    const source = g.firstNal + this.consumed - 1 - g.prefix.length, pictures = this.source.clip.pictures;
    let low = g.idr, high = pictures.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (pictures[middle].nal <= source) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found >= g.target ? pictures[found].pts : null;
  }
  /** Keep audio on the estimated picture: hold when ahead, seek when behind. */
  private async syncAudio(): Promise<void> {
    const g = this.generation;
    if (!this.av || !g?.reached || !this.audio.position) return;
    this.av.available(this.consumedPts());
    const now = this.clock();
    const action: VideoAvAction = this.av.decide(now, this.audio.position(), this.audioPlaying, this.view.paused);
    if (action.kind === "pause") {
      await this.pauseAudio();
      console.error(`Video audio hold: ${action.reason}${action.lag === null ? "" : ` lag=${Math.round(action.lag)}ms`}`);
    } else if (action.kind === "play") {
      // A huge tolerance keeps MediaPlayer's position when no seek is wanted.
      const began = this.clock();
      await this.audio.sync(action.position, true, action.speed, action.seek ? 0 : 1_000_000_000);
      if (action.seek) this.av.seekTook(this.clock() - began);
      this.audioPlaying = true;
      console.error(`Video audio ${action.seek ? "seek" : "play"}: ${action.reason} lag=${Math.round(action.lag ?? 0)}ms ` +
        `speed=${action.speed} rate=${this.av.measuredRate.toFixed(3)}`);
    }
    // Display only: let the time move between exact SHOWN reports.
    const video = this.view.paused ? null : this.av.video(now);
    if (video !== null && now - this.positionShownAt >= 1000) {
      this.view.position = Math.round(video); this.positionShownAt = now; this.notify();
    }
  }
  private updateHostPhy(phy: VideoPhy[]): void {
    const pairs = phy[0].links.filter((link) => link.bound && link.valid).map((link) =>
      `${["", "1M", "2M", "Coded"][link.current & 255]}/${["", "1M", "2M", "Coded"][link.current >>> 8]}`);
    this.view.hostPhy = pairs.length ? [...new Set(pairs)].join(", ") : "Unknown";
  }
  private async observe(): Promise<boolean> {
    const g = this.generation!;
    const began = this.clock();
    const phy = await this.phy();
    videoLive(g.oldPhy, phy);
    g.oldPhy = videoOwnedSnapshot(g.oldPhy, phy);
    const left = parseShown(await this.protocol.shown(g.stream, g.tokens[0], 1), 1, g.stream, g.tokens[0]);
    if (!left) return false;
    const right = parseShown(await this.protocol.shown(g.stream, g.tokens[1], 2, left.serial), 2, g.stream, g.tokens[1]);
    if (!right || left.ordinal !== right.ordinal || left.pts !== right.pts) return true;
    const picture = this.source.clip.pictures[g.idr + left.ordinal - 1];
    if (!picture || picture.pts !== left.pts || g.idr + left.ordinal - 1 < g.target) throw new Error("Shown picture does not match audited seek timeline");
    const capturedPhy = await this.phy();
    videoLive(g.oldPhy, capturedPhy);
    g.oldPhy = videoOwnedSnapshot(g.oldPhy, capturedPhy);
    this.updateHostPhy(phy);
    const captures = [left, right];
    const ages = captures.map((row, i) => videoTickSpan(capturedPhy[i].tick, row.copyTick));
    await this.applyShown(captures, ages, this.clock() - began);
    return true;
  }
  private async applyShown(captures: VideoShown[], ages: number[], uncertainty: number): Promise<void> {
    const g = this.generation!, [left, right] = captures;
    const picture = this.source.clip.pictures[g.idr + left.ordinal - 1];
    if (!picture || picture.pts !== left.pts || left.ordinal !== right.ordinal || left.pts !== right.pts ||
        g.idr + left.ordinal - 1 < g.target) throw new Error("Shown picture does not match audited seek timeline");
    g.reached = true;
    this.view.position = left.pts;
    this.view.lostReports = Math.max(left.lost, right.lost);
    this.view.audioUncertainty = captures.some((row) => row.uncertain) ? null : uncertainty;
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
    if (this.av) {
      const age = Math.min(...ages);
      // Ages come from firmware copy ticks, so an older retained row is still an
      // exact anchor; the ring holds about two seconds and cursor 0 reads its oldest.
      if (age <= 5000) this.av.anchor(left.pts, this.clock() - age);
      this.positionShownAt = this.clock();
      await this.syncAudio();
      this.notify();
      return;
    }
    if (this.view.paused) await this.audio.sync(left.pts, false, 1, 0);
    else if (ages.some((age) => age > 2000)) await this.audio.pause();
    else await this.audio.sync(Math.min(this.source.clip.duration, left.pts + Math.min(...ages) * speed), true,
      speed, Math.max(100, uncertainty));
    this.notify();
  }
  /** Paused time is not missing progress, so resuming restarts the copy-progress timer. */
  private setPaused(paused: boolean): void {
    if (this.view.paused && !paused) this.progressAt = this.clock();
    this.view.paused = paused;
  }
  private updatePlayback(rows: VideoPlaybackState[]): void {
    const g = this.generation!;
    if (rows.some((row) => row.result)) throw new Error("Video playback owner report refused");
    this.setPaused(g.paused && !g.reached || rows.every((row) => row.paused));
    const shown = Math.min(...rows.map((row) => row.shown));
    if (shown !== this.progress) { this.progress = shown; this.progressAt = this.clock(); }
    this.ended = g.index === g.count && this.shownCount === this.source.clip.pictures.length - g.target &&
      rows.every((row) => !row.paused && !row.pending &&
      row.shown === this.source.clip.pictures.length - g.target);
  }
  private deferReport(error: unknown, began: number): boolean {
    if (!(error instanceof VideoReportUnavailable) || this.stopping) return false;
    const now = this.clock();
    console.error(`Video passive report dropped; retry after backoff: ${error}`);
    this.rate.drops++;
    this.reportAt = now; this.reportDue = now + 1500; this.shownDue = now + 5000;
    // Missing evidence is not proof of stalled copies; do not invent progress.
    this.progressAt += now - began;
    return true;
  }
  /** Controls require evidence; passive reports may lose a transport sample. */
  private async report(required = false): Promise<void> {
    const began = this.clock();
    try { await this.reportStep(); }
    catch (error) { if (required || !this.deferReport(error, began)) throw error; }
    finally { this.measurement?.span(began, this.clock(), "report"); }
  }
  /** One passive step per blocked or stale turn; recheck input before the next. */
  private async reportStep(): Promise<void> {
    await this.suspendUpload();
    const g = this.generation!;
    const began = this.clock();
    this.reportAt = began; this.reportDue = began + 1500;
    if (this.view.paused && g.reached && !g.detailedReports) {
      await this.credits();
    } else if (began >= this.shownDue) {
      this.shownDue = began + 5000;
      if (g.detailedReports) {
        if (!await this.observe()) this.shownDue = began;
        this.updatePlayback(await this.playback());
        await this.clockEvidence(1);
      } else {
        const leftRaw = await this.protocol.shown(g.stream, g.tokens[0], 1), leftAt = this.clock();
        const left = parseShown(leftRaw, 1, g.stream, g.tokens[0]);
        if (!left) this.shownDue = began;
        else {
          const rightRaw = await this.protocol.shown(g.stream, g.tokens[1], 2, left.serial), rightAt = this.clock();
          const right = parseShown(rightRaw, 2, g.stream, g.tokens[1]);
          this.view.lostReports = Math.max(left.lost, right?.lost ?? 0);
          if (right && right.serial === left.serial && right.ordinal === left.ordinal && right.pts === left.pts) {
            // Capture both immediately; never age LEFT by a passive-report interval.
            const captures = [left, right], received = [leftAt, rightAt];
            // The START mapping drifts with the lens tick (about 2% fast against the phone on
            // pair 1), so age each copy against its reply tick instead; old firmware sends 0.
            const ages = captures.map((row, i) => Math.max(0, row.replyTick ?
              this.clock() - received[i] + videoTickSpan(row.replyTick, row.copyTick) :
              this.clock() - g.anchorAt - videoTickSpan(row.copyTick, g.anchor[i].tick)));
            await this.applyShown(captures, ages, g.anchorUncertainty + this.clock() - began);
            await this.clockEvidence(1);
          }
        }
      }
    } else if (g.index === g.count) this.updatePlayback(await this.playback());
    else await this.credits();
    await this.collectMeasurement();
    if (this.view.paused) await this.pauseAudio();
    this.notify();
  }
  private async preview(): Promise<void> {
    const deadline = this.clock() + 30_000;
    while (!this.generation!.reached && !this.stopping) {
      const uploaded = await this.upload();
      await this.report(true);
      if (this.clock() > deadline) throw new Error("Seek target was not shown by both lenses");
      if (!uploaded && !this.metadataStaged) await this.sleep(10);
    }
    if (this.stopping) throw new VideoCancelled();
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
          const began = this.clock();
          try { await this.intent(intent); intent.resolve(); } catch (error) { intent.reject(error); throw error; }
          finally { this.measurement?.span(began, this.clock(), `control:${intent.kind}`); }
          continue;
        }
        const g = this.generation!;
        let uploaded = false;
        if (this.view.paused && g.reached) { this.reportSafe = true; this.metadataStaged = false; }
        else {
          const began = this.clock();
          try { uploaded = await this.upload(); }
          catch (error) {
            if (!this.deferReport(error, began)) throw error;
            this.creditBudget = 0;
            await this.sleep(1500);
            this.progressAt += this.clock() - this.reportAt;
            continue;
          }
        }
        if (this.stopping) break;
        const stale = this.clock() - this.reportAt >= 1500;
        const report = (!g.reached || g.detailedReports || this.reportSafe || stale) && this.clock() >= this.reportDue;
        if (report) await this.report();
        await this.syncAudio();
        this.logRate();
        if (this.ended && !this.intents.length) break;
        if (!this.view.paused && this.clock() - this.progressAt > 30_000) throw new Error("Video stopped making copy progress");
        if ((!uploaded || this.view.paused) && !report && !this.metadataStaged) await this.sleep(20);
      }
    } catch (error) { if (!(error instanceof VideoCancelled)) failure = error; }
    finally {
      try { await this.pauseAudio(); } catch (error) { failure ??= error; }
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
