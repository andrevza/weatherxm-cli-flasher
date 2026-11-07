import { describe, expect, it } from 'vitest';
import { OutputCoordinator, ProgressReporter, formatProgressLine, progressSnapshot } from '../src/progress.js';
import { redactOutput } from '../src/redaction.js';

describe('progress accounting and rendering', () => {
  it('calculates speed and ETA only from completed bytes after a meaningful sample', () => {
    const snapshot = progressSnapshot({ stage: 'Reading ota_1', completed: 60, total: 100, state: 'running' }, 0, 5000, 10000, 10);
    expect(snapshot).toMatchObject({ percent: 60, elapsedMs: 10000, idleMs: 5000, speedBytesPerSecond: 10, etaMs: 4000 });
    expect(formatProgressLine(snapshot)).toContain('60.0% | 60 B / 100 B | 10 B/s');
    expect(formatProgressLine(snapshot, true)).toContain('████');
  });

  it('renders status-only stages without invented transfer metrics and gives short operations a stable result', () => {
    const status = progressSnapshot({ stage: 'Connecting to ROM', detail: 'waiting', state: 'running' }, 0, 0, 20_000);
    const rendered = formatProgressLine(status);
    expect(rendered).toContain('still working; 00:20 elapsed');
    expect(rendered).not.toMatch(/speed|ETA|\d+ B \/|%/);
    expect(formatProgressLine({ ...status, state: 'complete', elapsedMs: 100, idleMs: 100 })).toBe('Connecting to ROM DONE (0.1s)');
  });

  it('reports a long known-length stall without declaring failure', () => {
    const snapshot = progressSnapshot({ stage: 'Reading ota_1', completed: 50, total: 100, state: 'running' }, 0, 0, 20_000, 10);
    expect(formatProgressLine(snapshot)).toContain('no byte progress for 00:20; still active');
  });

  it('coordinates progress, rapid esptool logs, and resumed progress without line corruption', () => {
    let now = 0;
    const output: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => output.push(text), tty: true, width: () => 80 });
    const reporter = new ProgressReporter({ coordinator, tty: true, now: () => now, intervalMs: 5000, width: () => 80 });
    reporter.stage('Reading ota_1', 100);
    now = 1000;
    reporter.bytes(40, 100);
    coordinator.log('[esptool] read response received');
    coordinator.log('[esptool] next request sent');
    now = 2000;
    reporter.bytes(70, 100);
    reporter.finish('complete');
    const rendered = output.join('');
    expect(rendered).toContain('\r\u001b[2K[esptool] read response received\n\r');
    expect(rendered).toContain('[esptool] next request sent\n\r');
    expect(rendered).toContain('100.0%');
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\r')).toBe(false);
  });

  it('uses a single TTY line within narrow terminal width', () => {
    const snapshot = progressSnapshot({ stage: 'Independently verifying ota_1 backup', completed: 40, total: 100, state: 'running' }, 0, 1000, 2000, 5);
    const line = formatProgressLine(snapshot, true, 40);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(40);
  });

  it('uses complete redirected lines and strips terminal controls from diagnostics', () => {
    const output: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => output.push(text), tty: false });
    coordinator.log('\u001b[31m[serial] complete\r');
    coordinator.progress('Reading ota_1: 25.0%');
    coordinator.finishProgress('Reading ota_1 DONE');
    const rendered = output.join('');
    expect(rendered).toBe('[serial] complete\nReading ota_1: 25.0%\nReading ota_1 DONE\n');
    expect(rendered).not.toMatch(/[\r\u001b]/);
  });

  it('does not show transient zero-duration speed and preserves slow real throughput', () => {
    let now = 0;
    const output: string[] = [];
    const reporter = new ProgressReporter({ write: (text) => output.push(text), tty: false, now: () => now, intervalMs: 5000 });
    reporter.stage('Hashing firmware', 100);
    reporter.bytes(100, 100);
    reporter.finish('complete');
    expect(output.join('')).toContain('DONE (0.0s)');
    expect(output.join('')).not.toContain('/s');

    const slow = new ProgressReporter({ write: (text) => output.push(text), tty: false, now: () => now, intervalMs: 5000 });
    slow.stage('Reading ota_1', 100);
    now = 10_000;
    slow.bytes(10, 100);
    slow.status('waiting for next chunk');
    expect(output.join('')).toContain('1 B/s');
    slow.finish('cancelled');
  });

  it('prints a non-TTY operation immediately and includes elapsed time for cancellation and failure', () => {
    let now = 0;
    const output: string[] = [];
    const reporter = new ProgressReporter({ write: (text) => output.push(text), tty: false, now: () => now, intervalMs: 1000 });
    reporter.stage('Connecting to ESP32-S3');
    expect(output.join('')).toContain('Connecting to ESP32-S3...\n');
    now = 1250;
    reporter.finish('cancelled');
    expect(output.join('')).toContain('CANCELLED (1.3s)');
    expect(output.join('')).not.toMatch(/[\r\u001b]/);

    const failed: string[] = [];
    const second = new ProgressReporter({ write: (text) => failed.push(text), tty: false, now: () => now, intervalMs: 1000 });
    second.stage('Reading otadata', 8192);
    now += 1750;
    second.bytes(4096, 8192);
    second.finish('failed');
    expect(failed.join('')).toContain('FAILED');
    expect(failed.join('')).toContain('00:01 elapsed');
  });

  it('suppresses identical updates while preserving changed byte milestones', () => {
    let now = 0;
    const output: string[] = [];
    const reporter = new ProgressReporter({ write: (text) => output.push(text), tty: false, now: () => now, intervalMs: 1000 });
    reporter.stage('Connecting to ROM');
    reporter.status('waiting for ROM');
    reporter.status('waiting for ROM');
    now = 1000;
    reporter.finish('complete');
    const lines = output.join('').trimEnd().split('\n');
    expect(lines.filter((line) => line === 'Connecting to ROM...')).toHaveLength(1);
    expect(lines.at(-1)).toContain('Connecting to ROM DONE');
  });

  it('leaves no carriage return behind on cancellation or failure and allows redaction at the output boundary', () => {
    const output: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => output.push(text), tty: true });
    const reporter = new ProgressReporter({ coordinator, tty: true, now: () => 0 });
    reporter.stage('Reading device 00:11:22:33:44:55', 100);
    reporter.finish('cancelled');
    const raw = output.join('');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\r')).toBe(false);
    expect(redactOutput(raw)).not.toContain('00:11:22:33:44:55');
  });

  it('clears an active progress line on failure and preserves the partial completed-byte count', () => {
    let now = 0;
    const output: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => output.push(text), tty: true });
    const reporter = new ProgressReporter({ coordinator, tty: true, now: () => now });
    reporter.stage('Reading ota_1', 100);
    now = 1000;
    reporter.bytes(30, 100);
    reporter.finish('failed');
    const rendered = output.join('');
    expect(rendered).toContain('30.0%');
    expect(rendered).toContain('FAILED');
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\r')).toBe(false);
  });

  it('keeps JSON stdout separate from coordinated stderr diagnostics', () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => stderr.push(text), tty: false });
    const reporter = new ProgressReporter({ coordinator, tty: false, now: () => 0 });
    reporter.stage('Connecting to ROM');
    reporter.log('[esptool] connected');
    reporter.finish('complete');
    stdout.push(JSON.stringify({ outcome: 'OK' }));
    expect(JSON.parse(stdout.join(''))).toEqual({ outcome: 'OK' });
    expect(stderr.join('')).toContain('[esptool] connected\n');
    expect(stderr.join('')).not.toContain('\u001b');
  });

  it('suspends active TTY progress without restoring over readline input, then resumes on a fresh stage', () => {
    const output: string[] = [];
    const coordinator = new OutputCoordinator({ write: (text) => output.push(text), tty: true, width: () => 100 });
    const reporter = new ProgressReporter({ coordinator, tty: true, intervalMs: 10, now: () => 0 });
    reporter.stage('Pre-confirmation verification', 100);
    reporter.suspend();
    reporter.log('Waiting for confirmation');
    reporter.status('this progress update must stay hidden');
    const duringPrompt = output.join('');
    expect(duringPrompt).toContain('Waiting for confirmation\n');
    expect(duringPrompt).not.toContain('this progress update must stay hidden');
    reporter.resume();
    reporter.stage('Writing OTA metadata sector', 4096);
    expect(output.join('')).toContain('Writing OTA metadata sector');
    reporter.finish('cancelled');
  });
});
