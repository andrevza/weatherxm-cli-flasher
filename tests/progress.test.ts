import { describe, expect, it } from 'vitest';
import { ProgressReporter, formatProgressLine, progressSnapshot } from '../src/progress.js';

describe('progress accounting and rendering', () => {
  it('calculates percent, moving speed and ETA only from completed bytes', () => {
    const snapshot = progressSnapshot({ stage: 'Reading ota_1', completed: 60, total: 100 }, 0, 5000, 10000, 10);
    expect(snapshot).toMatchObject({ percent: 60, elapsedMs: 10000, idleMs: 5000, speedBytesPerSecond: 10, etaMs: 4000 });
    expect(formatProgressLine(snapshot)).toContain('60.0% (60 B / 100 B)');
    expect(formatProgressLine(snapshot, true)).toContain('████████████');
  });

  it('keeps unknown-length work percentage- and ETA-free and reports stall activity', () => {
    const snapshot = progressSnapshot({ stage: 'Connecting to ROM', detail: 'waiting for response' }, 0, 0, 20_000);
    const rendered = formatProgressLine(snapshot);
    expect(rendered).toContain('elapsed 00:20');
    expect(rendered).toContain('no byte progress for 00:20');
    expect(rendered).not.toContain('%');
    expect(rendered).not.toContain('ETA');
  });

  it('reports actual byte updates and terminal completion to the configured stream', () => {
    let now = 0;
    const output: string[] = [];
    const reporter = new ProgressReporter({ write: (text) => output.push(text), tty: false, now: () => now, intervalMs: 5000 });
    reporter.stage('Downloading firmware', 100);
    now = 10000;
    reporter.bytes(50, 100);
    reporter.finish('complete');
    expect(output.join('')).toContain('50.0% (50 B / 100 B)');
    expect(output.join('')).toContain('COMPLETE');
  });
});
