export interface ProgressEvent {
  stage: string;
  completed?: number;
  total?: number;
  state?: 'running' | 'complete' | 'failed' | 'cancelled';
  detail?: string;
}

export interface ProgressSnapshot extends ProgressEvent {
  elapsedMs: number;
  idleMs: number;
  speedBytesPerSecond: number | null;
  etaMs: number | null;
  percent: number | null;
}

export interface ProgressClock { now(): number; }

export function progressSnapshot(event: ProgressEvent, startedAt: number, lastProgressAt: number, now: number,
  speedBytesPerSecond: number | null = null): ProgressSnapshot {
  const elapsedMs = Math.max(0, now - startedAt);
  const idleMs = Math.max(0, now - lastProgressAt);
  const known = Number.isFinite(event.completed) && Number.isFinite(event.total) && (event.total ?? 0) > 0;
  const completed = known ? Math.max(0, Math.min(event.completed!, event.total!)) : undefined;
  const total = known ? event.total : undefined;
  const percent = known ? (completed! / total!) * 100 : null;
  const etaMs = known && speedBytesPerSecond && speedBytesPerSecond > 0
    ? Math.max(0, (total! - completed!) / speedBytesPerSecond * 1000) : null;
  return { ...event, completed, total, elapsedMs, idleMs, speedBytesPerSecond, etaMs, percent };
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatProgressLine(snapshot: ProgressSnapshot, tty = false): string {
  const elapsed = formatDuration(snapshot.elapsedMs);
  const speed = snapshot.speedBytesPerSecond === null ? 'unknown' : `${formatBytes(snapshot.speedBytesPerSecond)}/s`;
  if (snapshot.percent === null) {
    const stalled = snapshot.idleMs >= 15_000 ? `; no byte progress for ${formatDuration(snapshot.idleMs)}` : '';
    return `${snapshot.stage}: ${snapshot.detail ?? 'active'}; elapsed ${elapsed}; speed ${speed}${stalled}`;
  }
  const done = formatBytes(snapshot.completed!);
  const total = formatBytes(snapshot.total!);
  const stalled = snapshot.idleMs >= 15_000 ? `; no byte progress for ${formatDuration(snapshot.idleMs)}; operation remains active` : '';
  if (!tty) return `${snapshot.stage}: ${snapshot.percent.toFixed(1)}% (${done} / ${total}); speed ${speed}; elapsed ${elapsed}; ETA ${snapshot.etaMs === null ? 'calculating' : formatDuration(snapshot.etaMs)}${stalled}`;
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.floor(snapshot.percent / 100 * width)));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  return `${snapshot.stage}\n[${bar}] ${snapshot.percent.toFixed(1)}%\nCompleted: ${done} / ${total}\nSpeed: ${speed}\nElapsed: ${elapsed}\nETA: ${snapshot.etaMs === null ? 'calculating' : formatDuration(snapshot.etaMs)}${stalled}`;
}

/** A rate-limited stderr reporter. Byte counters must come from completed I/O. */
export class ProgressReporter {
  private current: ProgressEvent | null = null;
  private startedAt = 0;
  private lastProgressAt = 0;
  private lastSampleAt = 0;
  private lastSampleBytes = 0;
  private speed = 0;
  private lastRenderAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: {
    write: (text: string) => void; tty: boolean; now?: () => number; intervalMs?: number;
  }) {}

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }

  event(event: ProgressEvent): void {
    if (!this.current || this.current.stage !== event.stage) this.stage(event.stage, event.total, event.detail);
    if (Number.isFinite(event.completed)) this.bytes(event.completed!, event.total);
    else if (event.detail) this.status(event.detail);
  }

  stage(stage: string, total?: number, detail = 'active'): void {
    this.finishCurrent('complete', false);
    const now = this.now();
    this.current = { stage, total, completed: total === undefined ? undefined : 0, state: 'running', detail };
    this.startedAt = this.lastProgressAt = this.lastSampleAt = now;
    this.lastSampleBytes = 0;
    this.speed = 0;
    this.lastRenderAt = 0;
    this.render(now, true);
    this.timer = setInterval(() => this.render(this.now(), true), this.options.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  status(detail: string): void {
    if (!this.current) return;
    this.current = { ...this.current, detail };
    this.render(this.now(), true);
  }

  bytes(completed: number, total?: number): void {
    if (!this.current) return;
    const now = this.now();
    const previous = this.current.completed ?? 0;
    const actual = Math.max(previous, completed);
    const interval = Math.max(1, now - this.lastSampleAt);
    const instant = Math.max(0, actual - this.lastSampleBytes) * 1000 / interval;
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
    if (actual > previous) this.lastProgressAt = now;
    this.lastSampleAt = now;
    this.lastSampleBytes = actual;
    this.current = { ...this.current, completed: actual, total: total ?? this.current.total };
    this.render(now, false);
  }

  finish(state: 'complete' | 'failed' | 'cancelled' = 'complete', detail?: string): void {
    if (!this.current) return;
    if (detail) this.current = { ...this.current, detail };
    this.finishCurrent(state, true);
  }

  close(): void { this.finishCurrent('complete', true); }

  private finishCurrent(state: 'complete' | 'failed' | 'cancelled', render: boolean): void {
    if (!this.current) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const event = { ...this.current, state };
    this.current = null;
    if (render) {
      const now = this.now();
      const snapshot = progressSnapshot(event, this.startedAt, this.lastProgressAt, now, this.speed || null);
      this.options.write(`${formatProgressLine(snapshot, false)} — ${state.toUpperCase()}${this.options.tty ? '\n' : ''}`);
    }
  }

  private render(now: number, heartbeat: boolean): void {
    if (!this.current) return;
    const interval = this.options.intervalMs ?? 1000;
    if (!heartbeat && now - this.lastRenderAt < Math.min(interval, 250)) return;
    const snapshot = progressSnapshot(this.current, this.startedAt, this.lastProgressAt, now, this.speed || null);
    const text = formatProgressLine(snapshot, this.options.tty);
    if (this.options.tty) this.options.write(`\r${text.replaceAll('\n', ' | ')}`);
    else if (heartbeat || now - this.lastRenderAt >= interval) this.options.write(`${text}\n`);
    this.lastRenderAt = now;
  }
}
