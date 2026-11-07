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
  const etaMs = known && speedBytesPerSecond && speedBytesPerSecond > 0 && elapsedMs >= 1000
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

export function formatProgressLine(snapshot: ProgressSnapshot, tty = false, width = 100): string {
  const elapsed = formatDuration(snapshot.elapsedMs);
  if (snapshot.percent === null) {
    if (snapshot.state === 'complete') return `${snapshot.stage} DONE (${(snapshot.elapsedMs / 1000).toFixed(1)}s)`;
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') return `${snapshot.stage} ${snapshot.state.toUpperCase()} (${(snapshot.elapsedMs / 1000).toFixed(1)}s)${snapshot.detail && snapshot.detail !== 'active' ? ` — ${snapshot.detail}` : ''}`;
    const waiting = snapshot.elapsedMs >= 5000 ? ` (still working; ${elapsed} elapsed)` : '';
    return `${snapshot.stage}...${waiting}`;
  }

  const percent = snapshot.state === 'running' ? Math.min(99.9, snapshot.percent) : snapshot.percent;
  const detail = `${formatBytes(snapshot.completed!)} / ${formatBytes(snapshot.total!)}`;
  const speed = snapshot.speedBytesPerSecond === null ? '' : ` | ${formatBytes(snapshot.speedBytesPerSecond)}/s`;
  const eta = snapshot.etaMs === null ? '' : ` | ETA ${formatDuration(snapshot.etaMs)}`;
  const elapsedText = snapshot.elapsedMs >= 1000 || snapshot.state !== 'running' ? ` | ${elapsed} elapsed` : '';
  const stalled = snapshot.idleMs >= 15_000 && snapshot.state === 'running'
    ? ` | no byte progress for ${formatDuration(snapshot.idleMs)}; still active` : '';
  const stateText = snapshot.state && snapshot.state !== 'running' ? ` — ${snapshot.state.toUpperCase()}${snapshot.state === 'failed' && snapshot.detail && snapshot.detail !== 'active' ? `: ${snapshot.detail}` : ''}` : '';
  if (!tty) return `${snapshot.stage}: ${percent.toFixed(1)}% | ${detail}${speed}${elapsedText}${eta}${stalled}${stateText}`;
  const barWidth = Math.max(4, Math.min(20, width - 42));
  const filled = Math.max(0, Math.min(barWidth, Math.floor(percent / 100 * barWidth)));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
  const line = `${snapshot.stage} [${bar}] ${percent.toFixed(1)}% | ${detail}${speed}${eta}${stalled}${stateText}`;
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
}

/** Serializes diagnostics and progress on stderr without changing process streams. */
export class OutputCoordinator {
  private activeTtyLine = false;
  private lastProgress = '';
  private suspended = false;

  constructor(private readonly options: { write: (text: string) => void; tty: boolean; width?: () => number }) {}

  progress(text: string): void {
    if (text === this.lastProgress && (this.activeTtyLine || !this.options.tty)) return;
    this.lastProgress = text;
    if (this.suspended) return;
    if (!this.options.tty) { this.options.write(`${text}\n`); return; }
    this.options.write(`\r\u001b[2K${text}`);
    this.activeTtyLine = true;
  }

  finishProgress(text: string): void {
    this.lastProgress = '';
    if (this.suspended) { this.activeTtyLine = false; return; }
    if (this.options.tty && this.activeTtyLine) this.options.write('\r\u001b[2K');
    this.activeTtyLine = false;
    const width = Math.max(20, this.options.width?.() ?? 100);
    const finalText = this.options.tty && text.length > width ? `${text.slice(0, width - 1)}…` : text;
    this.options.write(`${finalText}\n`);
  }

  log(message: string): void {
    const resume = !this.suspended && this.options.tty && this.activeTtyLine;
    if (resume) this.options.write('\r\u001b[2K');
    this.activeTtyLine = false;
    const clean = String(message).replaceAll('\r', '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const lines = clean.split('\n');
    for (const line of lines) if (line.length) this.options.write(`${line}\n`);
    if (resume && this.lastProgress) {
      const width = Math.max(20, this.options.width?.() ?? 100);
      const restored = this.lastProgress.length <= width ? this.lastProgress : `${this.lastProgress.slice(0, width - 1)}…`;
      this.options.write(`\r${restored}`);
      this.activeTtyLine = true;
    }
  }

  suspend(): void {
    if (this.suspended) return;
    if (this.options.tty && this.activeTtyLine) this.options.write('\r\u001b[2K');
    this.activeTtyLine = false;
    this.suspended = true;
  }

  resume(): void { this.suspended = false; }
}

/** Progress reports use only completed bytes and share the diagnostic output coordinator. */
export class ProgressReporter {
  private current: ProgressEvent | null = null;
  private startedAt = 0;
  private lastProgressAt = 0;
  private lastSampleAt = 0;
  private lastSampleBytes = 0;
  private speed: number | null = null;
  private lastRenderAt = 0;
  private lastRendered = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private suspended = false;
  private resumeTimer = false;

  constructor(private readonly options: {
    write?: (text: string) => void; coordinator?: OutputCoordinator; tty: boolean; now?: () => number;
    intervalMs?: number; width?: () => number;
  }) {}

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }
  log(message: string): void {
    if (this.options.coordinator) this.options.coordinator.log(message);
    else this.options.write?.(`${message.replaceAll('\r', '')}\n`);
  }

  event(event: ProgressEvent): void {
    if (!this.current || this.current.stage !== event.stage) this.stage(event.stage, event.total, event.detail);
    if (Number.isFinite(event.completed)) this.bytes(event.completed!, event.total);
    else if (event.detail) this.status(event.detail);
  }

  stage(stage: string, total?: number, detail = 'active'): void {
    this.finishCurrent('complete', true);
    const now = this.now();
    this.current = { stage, total, completed: total === undefined ? undefined : 0, state: 'running', detail };
    this.startedAt = this.lastProgressAt = this.lastSampleAt = now;
    this.lastSampleBytes = 0;
    this.speed = null;
    this.lastRenderAt = 0;
    this.lastRendered = '';
    this.timer = setInterval(() => this.render(this.now(), true), this.options.intervalMs ?? 1000);
    this.timer.unref?.();
    // Show the operation as soon as it starts. Long ROM handshakes and file
    // hashing must not leave the operator staring at an empty terminal.
    this.render(now, true);
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
    const interval = now - this.lastSampleAt;
    if (actual > this.lastSampleBytes && interval >= 250) {
      const instant = (actual - this.lastSampleBytes) * 1000 / interval;
      this.speed = this.speed === null ? instant : this.speed * 0.7 + instant * 0.3;
      this.lastSampleAt = now;
      this.lastSampleBytes = actual;
    }
    if (actual > previous) this.lastProgressAt = now;
    this.current = { ...this.current, completed: actual, total: total ?? this.current.total };
    this.render(now, false);
  }

  finish(state: 'complete' | 'failed' | 'cancelled' = 'complete', detail?: string): void {
    if (!this.current) return;
    if (detail) this.current = { ...this.current, detail };
    this.finishCurrent(state, true);
  }

  close(): void { this.finishCurrent('complete', true); }

  /** Stops terminal updates while readline owns the interactive terminal. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.resumeTimer = Boolean(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.coordinator?.suspend();
  }

  /** Restores progress after the prompt has completed; a fresh stage redraws cleanly. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.options.coordinator?.resume();
    if (this.resumeTimer && this.current?.state === 'running') {
      this.timer = setInterval(() => this.render(this.now(), true), this.options.intervalMs ?? 1000);
      this.timer.unref?.();
      this.render(this.now(), true);
    }
    this.resumeTimer = false;
  }

  private finishCurrent(state: 'complete' | 'failed' | 'cancelled', render: boolean): void {
    if (!this.current) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const now = this.now();
    const event = { ...this.current, state };
    if (state === 'complete' && event.total !== undefined) event.completed = event.total;
    if (render) {
      const snapshot = progressSnapshot(event, this.startedAt, this.lastProgressAt, now, this.speed);
      const text = state === 'complete' && snapshot.elapsedMs < 500
        ? `${event.stage} DONE (${(snapshot.elapsedMs / 1000).toFixed(1)}s)`
        : formatProgressLine(snapshot, this.options.tty, this.options.width?.() ?? 100);
      this.emitFinal(text);
    }
    this.current = null;
  }

  private render(now: number, heartbeat: boolean): void {
    if (!this.current || this.suspended) return;
    const interval = this.options.intervalMs ?? 1000;
    const minimumUpdateInterval = this.options.tty ? 250 : interval;
    if (!heartbeat && now - this.lastRenderAt < minimumUpdateInterval) return;
    const snapshot = progressSnapshot(this.current, this.startedAt, this.lastProgressAt, now, this.speed);
    const text = formatProgressLine(snapshot, this.options.tty, this.options.width?.() ?? 100);
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    this.emitProgress(text);
    this.lastRenderAt = now;
  }

  private emitProgress(text: string): void {
    if (this.options.coordinator) this.options.coordinator.progress(text);
    else this.options.write?.(`${text}\n`);
  }
  private emitFinal(text: string): void {
    if (this.options.coordinator) this.options.coordinator.finishProgress(text);
    else this.options.write?.(`${text}\n`);
  }
}
