import { VideoProtocol, type VideoBackend } from "../apps/video/video-protocol";
import { getStringSetting } from "./settings-store";
import { Utils } from "@nativescript/core";

declare const com: any;

/** Bind the port to the existing communicator; never create a second BLE session. */
export function createVideoProtocol(ingressLeft = true): VideoProtocol {
  if (!global.isAndroid) throw new Error("Video transport requires Android");
  const active = com.faceclaw.app.FaceclawBleCommunicator.getActive();
  if (!active || !active.isSessionReady()) throw new Error("Glasses session is not ready");
  const transport = active.getVideoTransport();
  const uploadEpoch = Number(transport.getEpoch());
  const legacyNext = Number(getStringSetting("video.requestId", "1"));
  if (!Number.isInteger(legacyNext) || legacyNext < 1 || legacyNext >= 0xfffffffe) throw new Error("Invalid legacy video request identity");
  const identities = new com.faceclaw.app.VideoIdentityAllocator(Utils.android.getApplicationContext(), legacyNext);
  transport.configureEvidence(identities, false);
  async function collect(id: number): Promise<any> {
    const deadline = Date.now() + 30_000;
    while (Number(transport.pollOperation(id)) === 0) {
      if (Date.now() > deadline) throw new Error("Video operation deadline expired");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return JSON.parse(String(transport.takeOperation(id)));
  }
  const backend: VideoBackend = {
    epoch: () => Number(transport.getEpoch()),
    beginMeasurement: stream => transport.beginMeasurement(stream),
    measurementSnapshot: () => ({transport: JSON.parse(String(transport.measurementSnapshot())),
      identity: JSON.parse(String(identities.identityMeasurement()))}),
    configureEvidence: enabled => transport.configureEvidence(identities, enabled),
    createUploadPump: (reader, plan) => {
      const pump = new com.faceclaw.app.VideoUploadPump(transport, reader, identities, JSON.stringify(plan), ingressLeft, uploadEpoch);
      return {
        resume: () => pump.resumeUpload(), pause: () => pump.pauseUpload(), close: () => pump.closeUpload(),
        evidence: () => JSON.parse(String(pump.uploadEvidence())),
        offerCredits: (stream, tokens, sent, rows, ageMs) => {
          const packet = new Uint8Array(12);
          packet.set(rows[0]); packet.set(rows[1], 6);
          return Boolean(pump.offerCreditSnapshot(packet.buffer, stream, tokens[0], tokens[1], sent, ageMs));
        },
        snapshot: () => {
          const row = JSON.parse(String(pump.uploadSnapshot()));
          return {...row, error: row.error ? String(pump.uploadFailure()) : ""};
        },
      };
    },
    sendPipeline: async (records, following) => {
      const packet = new Uint8Array(1 + records.reduce((sum, record, i) => sum + 3 + record.length + (following[i] ? 24 : 0), 0));
      packet[0] = records.length;
      let offset = 1;
      records.forEach((record, i) => {
        packet[offset++] = record.length & 255; packet[offset++] = record.length >>> 8;
        packet.set(record, offset); offset += record.length;
        packet[offset++] = Number(!!following[i]);
        if (following[i]) { packet.set(following[i]!, offset); offset += 24; }
      });
      return collect(Number(transport.beginPipeline(packet.buffer, 3, ingressLeft)));
    },
    sendPicture: async (record, metadata) => {
      const raw = await collect(Number(transport.beginPicture(record.slice().buffer, metadata.slice().buffer, 3, ingressLeft)));
      return raw.map((hex: string) => Uint8Array.from(hex.match(/../g)!.map(pair => parseInt(pair, 16))));
    },
    exchange: async (payload, length, targets, resultOffset) => {
      const snapshot = payload.slice();
      const raw = await collect(Number(transport.beginExchange(snapshot.buffer, length, targets, ingressLeft, resultOffset)));
      return raw.map((hex: string) => Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16))));
    },
    sendWindow: async (records) => {
      const size = 1 + records.reduce((sum, record) => sum + 2 + record.length, 0);
      const packet = new Uint8Array(size);
      packet[0] = records.length;
      let offset = 1;
      for (const record of records) {
        packet[offset++] = record.length & 255;
        packet[offset++] = record.length >>> 8;
        packet.set(record, offset);
        offset += record.length;
      }
      return collect(Number(transport.beginWindow(packet.buffer, 3, ingressLeft)));
    },
  };
  return new VideoProtocol(backend, async () => {
    identities.beginReserve();
    while (Number(identities.poll()) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return Number(identities.takeResult());
  });
}
