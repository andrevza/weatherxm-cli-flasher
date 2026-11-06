import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', timeout: 15_000 });
}

describe('stage-only CLI guards', () => {
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
  });
});
