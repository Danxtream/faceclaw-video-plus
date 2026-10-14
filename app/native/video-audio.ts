import { type VideoAudio } from "../apps/video/video-playback";
import { type VideoClip } from "../apps/video/video-clip";

declare const com: any;

/** Asynchronous MP4 preparation/seek on Android's normal media output route. */
export async function openVideoAudio(encodedPath: string, clip: VideoClip): Promise<VideoAudio> {
  if (!global.isAndroid) throw new Error("Video audio requires Android");
  const path = encodedPath.replace(/[^/\\]+$/, clip.source.name);
  if (!/^[^/\\]+\.mp4$/i.test(clip.source.name)) throw new Error("Invalid source MP4 filename");
  const player = new com.faceclaw.app.VideoAudioPlayer();
  let closed = false;
  async function collect(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!closed && Number(player.poll()) === 0) {
      if (Date.now() > deadline) throw new Error("Phone audio operation timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (closed) throw new Error("Phone audio closed");
    player.takeResult();
  }
  try { player.beginPrepare(path, clip.source.bytes, clip.source.sha256); await collect(); }
  catch (error) { player.close(); throw error; }
  return {
    sync: async (position, playing, speed, tolerance) => {
      player.beginSync(Math.round(position), playing, speed, Math.round(tolerance)); await collect();
    },
    pause: async () => { player.beginPause(); await collect(); },
    close: async () => { if (!closed) { closed = true; player.close(); } },
  };
}
