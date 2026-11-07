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
  it('exposes Thorough diagnosis only for an exact OTA slot and rejects write-related options', () => {
    const usage = run('flash', '--help');
    expect(usage.status).toBe(0);
    expect(usage.stdout).toContain('wg1200 flash diagnose');
    const wrongTarget = run('flash', 'diagnose', '--target', 'factory', '--port', '/dev/null');
    expect(wrongTarget.status).not.toBe(0);
    expect(wrongTarget.stderr).toContain('flash diagnose requires --target ota_0|ota_1 and is read-only');
    const stage = run('flash', 'diagnose', '--target', 'ota_0', '--stage-only', '--port', '/dev/null');
    expect(stage.status).not.toBe(0);
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
    expect(misplacedMode.stderr).toContain('--verify-mode requires flash --stage-only, ota status, or ota activate');
    const acceptedMode = run('flash', 'weatherxm', '--stage-only', '--verify-mode', 'thorough');
    expect(acceptedMode.status).not.toBe(0);
    expect(acceptedMode.stderr).toContain('flash requires --port');
    expect(run('flash', 'weatherxm', '--help').stdout).toContain('--verify-mode <mode>');
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
    const nonInteractive = run('backup', 'partition', 'factory', '--port', '/dev/null', '--output', '/tmp/wg1200-partition-test.bin');
    expect(nonInteractive.status).not.toBe(0);
    expect(nonInteractive.stderr).toContain('interactive terminal for explicit confirmation');
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
    expect(verboseHelp.stdout).toContain('--verbose           Show detailed operation diagnostics');
  });

  it('exposes OTA activation only with an explicit device-bound backup manifest', () => {
    const status = run('ota', 'status');
    expect(status.status).not.toBe(0); expect(status.stderr).toContain('ota status requires --port');
    const backup = run('ota', 'backup', '--output', '/tmp/otadata.bin');
    expect(backup.status).not.toBe(0); expect(backup.stderr).toContain('ota backup requires --port');
    const activate = run('ota', 'activate', '--target', 'ota_0', '--port', '/dev/null');
    expect(activate.status).not.toBe(0); expect(activate.stderr).toContain('--metadata-backup-manifest');
    const arbitrary = run('ota', 'activate', '--target', '0x13000', '--port', '/dev/null', '--dry-run');
    expect(arbitrary.status).not.toBe(0); expect(arbitrary.stderr).toContain('activate --target');
    expect(run('ota', '--help').stdout).toContain('OTA COMMANDS');
    const restore = run('ota', 'restore', '--port', '/dev/null');
    expect(restore.status).not.toBe(0); expect(restore.stderr).toContain('--metadata-backup-manifest');
    expect(run('ota', '--help').stdout).toContain('ota restore');
  });

  it('accepts configurable OTA boot capture durations but enforces the 15-second minimum', () => {
    const common = ['ota', 'activate', '--target', 'ota_0', '--metadata-backup-manifest', '/tmp/backup.json', '--port', '/dev/null', '--dry-run', '--offline'];
    const tooShort = run(...common, '--boot-capture-seconds', '14');
    expect(tooShort.status).not.toBe(0);
    expect(tooShort.stderr).toContain('boot capture must be at least 15 seconds');
    const extended = run(...common, '--boot-capture-seconds', '30');
    expect(extended.status).not.toBe(0);
    expect(extended.stderr).not.toContain('boot capture must be at least 15 seconds');
    expect(extended.stderr).toContain('offline');
  });

  it('keeps JSON stdout parseable while progress and diagnostics stay on redirected stderr', () => {
    const result = run('firmware', 'download', 'weatherxm', '--manifest', 'http://127.0.0.1:1/manifest.json', '--cache-dir', '/tmp/wg1200-empty-json-cache', '--json');
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'FIRMWARE DOWNLOAD FAILED' });
    expect(result.stderr).not.toMatch(/[\r\u001b]/);
    expect(result.stderr).toContain('Retrieving firmware catalog');
    expect(result.stdout).not.toContain('Retrieving firmware catalog');
  });

  it.each([
    ['status', ['ota', 'status', '--port', '/dev/null', '--json'], 'Opening serial port /dev/null'],
    ['backup', ['ota', 'backup', '--port', '/dev/null', '--output', '/tmp/wg1200-json-ota-backup.bin', '--json'], 'Opening serial port /dev/null'],
  ])('keeps ota %s JSON on stdout and emits redirected progress on stderr', (_name, args, operation) => {
    const result = run(...args);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'OTA OPERATION FAILED' });
    expect(result.stderr).toContain(operation);
    expect(result.stderr).not.toMatch(/[\r\u001b]/);
    expect(result.stdout).not.toContain(operation);
  });

  it.each(['fast', 'thorough'])('accepts ota status --verify-mode %s without weakening its read-only interface', (mode) => {
    const result = run('ota', 'status', '--verify-mode', mode, '--port', '/dev/null', '--json');
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'OTA OPERATION FAILED' });
    expect(result.stderr).not.toContain('--verify-mode requires');
  });

  it.each(['fast', 'thorough'])('accepts ota activate --verify-mode %s', (mode) => {
    const result = run('ota', 'activate', '--target', 'ota_0', '--metadata-backup-manifest', '/tmp/backup.json',
      '--verify-mode', mode, '--port', '/dev/null', '--dry-run');
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('--verify-mode requires');
  });
});
