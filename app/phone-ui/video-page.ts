import { type EventData, type Page } from "@nativescript/core";
import { VideoViewModel } from "./video-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  const context = page.navigationContext as {tab?: number} | undefined;
  page.bindingContext = new VideoViewModel(context?.tab ?? 0);
}
export function loaded(args: EventData): void { ((args.object as Page).bindingContext as VideoViewModel).attach(); }
export function unloaded(args: EventData): void { ((args.object as Page).bindingContext as VideoViewModel).dispose(); }
