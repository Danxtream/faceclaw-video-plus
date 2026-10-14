import { File } from "@nativescript/core";
import { parseVideoClip, type VideoSource, type VideoAudit } from "../apps/video/video-clip";

declare const com: any;

/** Open a sidecar and stream the encoded source through the native bounded reader. */
export async function openVideoSource(path: string): Promise<VideoSource> {
  if (!global.isAndroid || !path.toLowerCase().endsWith(".h264")) throw new Error("Select an Android H.264 video");
  const reader = new com.faceclaw.app.VideoFileReader(path);
  let closed = false;
  async function collect(): Promise<any> {
    while (!closed && Number(reader.poll()) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (closed) throw new Error("Video source closed");
    return JSON.parse(String(reader.takeResult()));
  }
  try {
    reader.beginAudit();
    const audit: VideoAudit = await collect();
    const sidecar = path.replace(/\.h264$/i, ".g2.json");
    const clip = parseVideoClip(JSON.parse(await File.fromPath(sidecar).readText()), audit);
    return {
      clip,
      readNal: async (index) => {
        if (closed) throw new Error("Video source closed");
        reader.beginRead(index);
        const hex: string = await collect();
        return Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
      },
      close: () => { if (!closed) { closed = true; reader.close(); } },
    };
  } catch (error) { reader.close(); throw error; }
}
