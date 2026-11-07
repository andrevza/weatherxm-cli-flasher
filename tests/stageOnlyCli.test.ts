import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { cleanupStageOnlyConnection, stageOnlyConfirmationPhrase } from '../src/device.js';
import { EventEmitter } from 'node:events';
import { bindAbortOnSigint } from '../src/interrupt.js';

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', timeout: 15_000 });
}

describe('stage-only CLI guards', () => {
  it('uses the same visible identity-free confirmation phrase with or without redaction', () => {
    const summary = { targetSlot: 'ota_0' as const, firmwareVersion: '0.8.34', firmwareSha256: 'a'.repeat(64) };
    const displayed = stageOnlyConfirmationPhrase(summary);
    const accepted = (input: string) => input === stageOnlyConfirmationPhrase(summary);
    expect(displayed).toBe(`STAGE ota_0 WeatherXM 0.8.34 ${'a'.repeat(64)}`);
    expect(displayed).not.toContain('WG1200');
    expect(accepted(displayed)).toBe(true);
    expect(accepted('yes')).toBe(false);
    expect(accepted(displayed.replace('ota_0', 'ota_1'))).toBe(false);
  });
  it('requests normal boot once and closes the serial transport after cancellation', async () => {
    const hardReset = vi.fn(async () => true);
    const disconnect = vi.fn(async (releaseReset: boolean) => ({ serialPortReleased: releaseReset === false }));
    const result = await cleanupStageOnlyConnection({ hardReset, disconnect });
    expect(result).toEqual({ normalBootResetSucceeded: true, serialPortReleased: true });
    expect(hardReset).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(false);
    const failed = await cleanupStageOnlyConnection({ hardReset: async () => false, disconnect });
    expect(failed.normalBootResetSucceeded).toBe(false);
  });
  it('turns repeated SIGINT events into cancellation without terminating the process handler', () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const cleanup = bindAbortOnSigint(source, controller);
    source.emit('SIGINT');
    source.emit('SIGINT');
    expect(controller.signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(source.listenerCount('SIGINT')).toBe(1);
    cleanup();
    expect(source.listenerCount('SIGINT')).toBe(0);
  });
  it('requires an interactive per-operation backup decision and refuses generic confirmation/bypass flags', () => {
    const noPort = run('flash', 'weatherxm', '--stage-only');
    expect(noPort.status).not.toBe(0);
    expect(noPort.stderr).toContain('flash requires --port');
    const yes = run('flash', 'weatherxm', '--stage-only', '--backup-manifest', '/tmp/backup.json', '--yes');
    expect(yes.status).not.toBe(0);
    expect(yes.stderr).toContain('--yes, --force, --recover, --dry-run, and --monitor are not permitted');
    const force = run('flash', 'weatherxm', '--stage-only', '--backup-manifest', '/tmp/backup.json', '--force');
    expect(force.status).not.toBe(0);
    expect(force.stderr).toContain('--yes, --force, --recover, --dry-run, and --monitor are not permitted');
    const unsupportedMode = run('flash', 'weatherxm', '--verify-mode', 'mystery');
    expect(unsupportedMode.status).not.toBe(0);
    expect(unsupportedMode.stderr).toContain('--verify-mode must be fast or thorough');
    const misplacedMode = run('flash', 'weatherxm', '--verify-mode', 'thorough');
    expect(misplacedMode.status).not.toBe(0);
    expect(misplacedMode.stderr).toContain('--verify-mode requires flash --stage-only');
    const acceptedMode = run('flash', 'weatherxm', '--stage-only', '--verify-mode', 'thorough');
    expect(acceptedMode.status).not.toBe(0);
    expect(acceptedMode.stderr).toContain('flash requires --port');
    expect(run('flash', '--help').stdout).toContain('--verify-mode fast|thorough');
  });

  it('does not accept a non-official manifest for the stage-only artifact', () => {
    const result = run('flash', 'weatherxm', '--stage-only', '--backup-manifest', '/tmp/backup.json', '--manifest', 'https://example.com/manifest.json');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pinned official WeatherXM firmware manifest');
  });

  it('requires an inactive backup file path and known subcommand', () => {
    const missing = run('backup', 'inactive', '--port', '/dev/null');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('backup requires `backup <active|inactive> --port <path> --output <file>`');
    const wrong = run('backup', 'factory', '--port', '/dev/null', '--output', '/tmp/not-written.bin');
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('backup requires `backup <active|inactive>');
  });

  it('accepts active OTA backup selection and validates dedicated firmware command arguments', () => {
    const active = run('backup', 'active');
    expect(active.status).not.toBe(0);
    expect(active.stderr).toContain('backup <active|inactive> --port <path> --output <file>');
    const versionFlag = run('firmware', 'download', 'weatherxm', '--version', '0.8.34', '--help');
    expect(versionFlag.status).toBe(0);
    const badVersion = run('firmware', 'download', 'weatherxm', '--version');
    expect(badVersion.status).not.toBe(0);
    const verboseHelp = run('--help', '--verbose');
    expect(verboseHelp.status).toBe(0);
    expect(verboseHelp.stdout).toContain('--verbose           Show coordinated ROM and transport diagnostics');
  });

  it('keeps JSON stdout parseable while progress and diagnostics stay on redirected stderr', () => {
    const result = run('firmware', 'download', 'weatherxm', '--offline', '--cache-dir', '/tmp/wg1200-empty-json-cache', '--json');
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'FIRMWARE DOWNLOAD FAILED' });
    expect(result.stderr).not.toMatch(/[\r\u001b]/);
  });
});
