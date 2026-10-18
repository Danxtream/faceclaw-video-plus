import { externalStorageRootPath, listDirectory, statPath, type DirectoryEntry } from "./file-access";
import { getStringSetting, setStringSetting } from "./settings-store";

declare const java: any;

const RESUME_KEY = "video.resumeState.v1";
export type VideoResumeState = {path: string; positionMs: number};

export function g2VideoDirectoryPath(): string { return `${externalStorageRootPath()}/Download/G2`; }
export function ensureG2VideoDirectory(): string {
  const path = g2VideoDirectoryPath();
  const directory = new java.io.File(path);
  if (!directory.isDirectory() && !directory.mkdirs()) throw new Error("Could not open Download/G2");
  return path;
}
export function isG2VideoPickerFile(name: string): boolean { return /\.(mp4|h264|264)$/i.test(name); }
export function g2VideoMetadataPath(path: string): string { return path.replace(/\.(mp4|h264|264)$/i, ".g2.json"); }
export function resolveG2H264Path(path: string): string | null {
  const choices = /\.(h264|264)$/i.test(path) ? [path] : /\.mp4$/i.test(path) ?
    [path.replace(/\.mp4$/i, ".h264"), path.replace(/\.mp4$/i, ".264")] : [];
  return choices.find((candidate) => { const file = statPath(candidate); return !!file && !file.isDirectory; }) ?? null;
}
export function pairedMp4Path(path: string): string | null {
  if (!/\.(h264|264)$/i.test(path)) return null;
  const candidate = path.replace(/\.(h264|264)$/i, ".mp4");
  const file = statPath(candidate);
  return file && !file.isDirectory ? candidate : null;
}
/** Preserve the old paired-movie de-duplication and standalone silent streams. */
export function shouldShowG2VideoEntry(entry: DirectoryEntry): boolean {
  if (entry.isDirectory) return true;
  if (/\.mp4$/i.test(entry.name)) return resolveG2H264Path(entry.path) !== null;
  return /\.(h264|264)$/i.test(entry.name) && pairedMp4Path(entry.path) === null;
}
export function listG2Videos(directory = g2VideoDirectoryPath()): DirectoryEntry[] { return (listDirectory(directory) ?? []).filter(shouldShowG2VideoEntry); }
export function listG2ConversionSources(directory = g2VideoDirectoryPath()): DirectoryEntry[] {
  return (listDirectory(directory) ?? []).filter((entry) => !entry.isDirectory && /\.mp4$/i.test(entry.name));
}
/** Subfolders of a G2 library folder, for browsing below Download/G2. */
export function listG2Folders(directory = g2VideoDirectoryPath()): DirectoryEntry[] {
  return (listDirectory(directory) ?? []).filter((entry) => entry.isDirectory);
}
/** One last-video key, matching the old library; no per-video index upgrade. */
export function loadVideoResumeState(): VideoResumeState | null {
  try {
    const value = JSON.parse(getStringSetting(RESUME_KEY, "null"));
    if (!value || typeof value.path !== "string" || !value.path || !Number.isFinite(value.positionMs) || value.positionMs < 0)
      return null;
    return {path: value.path, positionMs: Math.round(value.positionMs)};
  } catch { return null; }
}
export function resumePositionFor(path: string): number { const state = loadVideoResumeState(); return state?.path === path ? state.positionMs : 0; }
export function saveVideoResumeState(path: string, positionMs: number): void {
  if (!path || !Number.isFinite(positionMs) || positionMs < 0) throw new Error("Invalid video resume position");
  setStringSetting(RESUME_KEY, JSON.stringify({path, positionMs: Math.round(positionMs)}));
}
