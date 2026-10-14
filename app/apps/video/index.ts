import { type AppContext, type AppDefinition } from "../app-definition";
import { FileBrowserLayer } from "../files/file-browser";
import { createInProcessWindow, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { g2VideoDirectoryPath, ensureG2VideoDirectory, isG2VideoPickerFile, resolveG2H264Path,
  shouldShowG2VideoEntry, resumePositionFor } from "../../native/g2-video-library";
import { activeVideoSession, observeVideoSession } from "./video-session";
import { VideoPlaybackLayer } from "./video-playback-layer";
import { configuredVideoOptions, videoSettingsMenuItems } from "./video-settings";
import { MenuLayer } from "../../ui/menu";

let window: InProcessWindow | null = null;

/** Stop through the existing writer, retaining renderer ownership until cleanup. */
export async function stopVideoSession(): Promise<void> {
  const session = activeVideoSession();
  if (!session) return;
  session.stop();
  const deadline = Date.now() + 30_000;
  while (session.opening || session.view?.active) {
    if (Date.now() > deadline) throw new Error("Previous video did not stop");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (session.ownsDisplay) throw new Error("Video restoration failed; reconnect before another START");
}

/** Called after the Video window is launched by the controller's normal app route. */
export async function openPhoneVideo(path: string, position = resumePositionFor(path)): Promise<void> {
  if (!window) throw new Error("Video app window is not open");
  await stopVideoSession();
  window.stack.popIfTop((layer) => layer instanceof VideoPlaybackLayer);
  window.stack.push(new VideoPlaybackLayer(path, window.requestRender, configuredVideoOptions, position));
  window.requestRender();
}

async function launch(ctx: AppContext): Promise<void> {
  if (!global.isAndroid) throw new Error("Video requires Android");
  try { ensureG2VideoDirectory(); } catch (error) { console.warn(String(error)); }
  await ctx.launchInProcessApp("video", "window:video", (options) => {
    const browser = new FileBrowserLayer({title: "G2 Videos", rootPath: g2VideoDirectoryPath(), includeEntry: shouldShowG2VideoEntry,
      isSupportedFile: isG2VideoPickerFile,
      onFilePicked: (entry) => {
        const encoded = resolveG2H264Path(entry.path);
        if (encoded) void openPhoneVideo(encoded).catch((error) => ctx.appendLog(String(error)));
      }, onLeave: () => shell.yieldFocusToSidebar()});
    const remove = observeVideoSession(() => { browser.refreshEntries(); window?.requestRender(); ctx.requestShellRender(); });
    window = createInProcessWindow({appId: "video", windowId: "video", title: "Video", iconLetter: "Vi", icon: "film", closeable: true,
      actions: options.actions, baseLayer: browser, submitFrame: options.submitFrame, setSurfaceVisible: options.setSurfaceVisible,
      removeSurface: options.removeSurface, shouldSuppressRender: () => activeVideoSession()?.ownsDisplay ?? false,
      keepsScreenOn: () => activeVideoSession()?.view?.active ?? false,
      menuItems: () => [...browser.buildMenuItems(), {label: "Video settings", onSelect: (layer) => {
        layer.stack.pop(); layer.stack.push(new MenuLayer("Video settings", videoSettingsMenuItems(), {x: 20, y: 20, width: 360}));
      }}],
      onClosed: () => { remove(); window = null; options.onClosed(); },
    });
    return window;
  });
}
const videoApp: AppDefinition = {appId: "video", title: "Video", icon: "film", launch, showInLauncher: !global.isIOS};
export default videoApp;
