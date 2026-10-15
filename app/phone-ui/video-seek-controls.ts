/** Format the shared phone playback position without changing frame cadence. */
export function formatVideoTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60), tail = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}

/** Hold a user's target across refreshes and fence delayed seeks to that session. */
export class VideoSeekControls<T> {
  private owner: T | null = null;
  private position = 0;
  private duration = 0;
  private target: number | null = null;
  private dragging = false;
  private changed = false;
  private publishing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly set: (key: string, value: unknown) => void,
    private readonly seek: (owner: T, value: number) => Promise<void>) {}
  update(position: number, duration: number, owner: T | null): void {
    if (owner !== this.owner) { this.dispose(); this.owner = owner; }
    this.position = position; this.duration = duration;
    this.publish(!this.dragging && this.target === null);
  }
  private publish(position: boolean): void {
    this.publishing = true;
    try {
      const value = this.target ?? this.position;
      this.set("duration", Math.max(1, this.duration));
      if (position) this.set("position", value);
      this.set("timeLabel", `${formatVideoTime(value)} / ${formatVideoTime(this.duration)}`);
    } finally { this.publishing = false; }
  }
  onChange(args: {value?: number; object?: {value?: number}}): void {
    if (this.publishing || !this.owner) return;
    const value = Number(args.object?.value ?? args.value);
    if (!Number.isFinite(value) || !this.dragging && this.target === null && Math.abs(value - this.position) < 1) return;
    this.target = Math.max(0, Math.min(this.duration, value)); this.changed = true;
    this.publish(true);
    if (!this.dragging) this.schedule();
  }
  onTouch(args: {action?: string}): void {
    if (!this.owner) return;
    if (args.action === "down") {
      this.clearTimer(); this.dragging = true; this.changed = false;
      this.target ??= this.position;
    } else if (args.action === "up") {
      this.dragging = false;
      if (this.changed) this.schedule();
      else { this.target = null; this.publish(true); }
    } else if (args.action === "cancel") {
      this.clearTimer(); this.dragging = false; this.target = null; this.changed = false; this.publish(true);
    }
  }
  private schedule(): void {
    this.clearTimer();
    const owner = this.owner, value = this.target;
    if (!owner || value === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.owner !== owner || this.dragging) return;
      void this.seek(owner, value).finally(() => {
        if (this.owner === owner && this.target === value && !this.dragging) {
          this.target = null; this.changed = false; this.publish(true);
        }
      });
    }, 200);
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  dispose(): void { this.clearTimer(); this.owner = null; this.dragging = false; this.target = null; this.changed = false; }
}
