import { type VideoNalEvidence } from "./video-failure";

/** One generation's already-audited seek map, transferred once to the native writer. */
export type VideoUploadPlan = {
  stream: number; tokens: number[]; prefix: number[]; firstNal: number; count: number;
  pictures: {nal: number; pts: number}[];
  /** Send each picture's VCL NAL with its frame time (firmware capability). */
  timed?: boolean;
  confirmationRoom?: boolean;
};
export type VideoUploadProgress = {
  index: number; metadata: number; consumed: number; budget: number;
  blocked: boolean; running: boolean; error: string;
  consumedL?: number; consumedR?: number; creditAgeMs?: number; measurement?: unknown;
};

/** A pause is a request; only a non-running snapshot proves the batch is fenced. */
export interface VideoUploadPump {
  resume(): void;
  pause(): void;
  snapshot(): VideoUploadProgress;
  close(): void;
  /** Recently attempted payloads; a failed pipeline need not have ACKed them. */
  evidence?(): VideoNalEvidence[];
  offerCredits?(stream: number, tokens: readonly number[], sent: number,
    rows: readonly Uint8Array[], ageMs: number): boolean;
}
