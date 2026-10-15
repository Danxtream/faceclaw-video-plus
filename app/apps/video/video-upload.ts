/** One generation's already-audited seek map, transferred once to the native writer. */
export type VideoUploadPlan = {
  stream: number; tokens: number[]; prefix: number[]; firstNal: number; count: number;
  pictures: {nal: number; pts: number}[];
};
export type VideoUploadProgress = {
  index: number; metadata: number; consumed: number; budget: number;
  blocked: boolean; running: boolean; error: string;
};

/** A pause is a request; only a non-running snapshot proves the batch is fenced. */
export interface VideoUploadPump {
  resume(): void;
  pause(): void;
  snapshot(): VideoUploadProgress;
  close(): void;
}
