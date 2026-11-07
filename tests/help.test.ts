import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const topics: Array<{ args: string[]; title: string }> = [
  { args: ['--help'], title: 'USAGE' },
  { args: ['info', '--help'], title: 'DEVICE INFORMATION' },
  { args: ['verify', '-h'], title: 'VERIFY DEVICE' },
  { args: ['status', '--help'], title: 'DEVICE STATUS' },
  { args: ['check', '--help'], title: 'CHECK FIRMWARE' },
  { args: ['monitor', '--help'], title: 'SERIAL MONITOR' },
  { args: ['ota', '--help'], title: 'OTA COMMANDS' },
  { args: ['ota', 'status', '--help'], title: 'OTA STATUS' },
  { args: ['ota', 'backup', '--help'], title: 'OTA METADATA BACKUP' },
  { args: ['ota', 'activate', '--help'], title: 'OTA ACTIVATION' },
  { args: ['ota', 'restore', '-h'], title: 'EMERGENCY OTA METADATA RESTORE' },
  { args: ['backup', '--help'], title: 'BACKUP COMMANDS' },
  { args: ['backup', 'active', '--help'], title: 'BACK UP ACTIVE APPLICATION' },
  { args: ['backup', 'inactive', '-h'], title: 'BACK UP INACTIVE APPLICATION' },
  { args: ['backup', 'partition', '--help'], title: 'BACK UP A PARTITION' },
  { args: ['firmware', '--help'], title: 'FIRMWARE COMMANDS' },
  { args: ['firmware', 'list', '--help'], title: 'LIST FIRMWARE' },
  { args: ['firmware', 'download', '--help'], title: 'DOWNLOAD FIRMWARE' },
  { args: ['firmware', 'compare', '-h'], title: 'COMPARE FIRMWARE BACKUP' },
  { args: ['security', '--help'], title: 'SECURITY COMMANDS' },
  { args: ['security', 'check', '--help'], title: 'CHECK FIRMWARE SECURITY' },
  { args: ['flash', '--help'], title: 'FLASH COMMANDS' },
  { args: ['flash', 'weatherxm', '--help'], title: 'STAGE WEATHERXM FIRMWARE' },
  { args: ['flash', 'diagnose', '-h'], title: 'DIAGNOSE OTA IMAGE' },
];

function source(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    env: { ...process.env, NO_COLOR: '', TERM: 'dumb' } });
}

function standalone(args: string[]) {
  const binary = process.env.WG1200_STANDALONE_BINARY;
  if (!binary) return undefined;
  return spawnSync(resolve(binary), args, { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000, env: { ...process.env, NO_COLOR: '', TERM: 'dumb' } });
}

describe('structured CLI help', () => {
  it.each(topics)('routes source help for $args', ({ args, title }) => {
    const result = source(args);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(title);
    expect(result.stdout).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
    expect(result.stderr).toBe('');
  });

  for (const { args, title } of topics) it.skipIf(!process.env.WG1200_STANDALONE_BINARY)(`routes standalone help for ${args.join(' ')}`, () => {
    const result = standalone(args);
    if (!result) throw new Error('standalone help test requires WG1200_STANDALONE_BINARY');
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(title);
    expect(result.stdout).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
    expect(result.stderr).toBe('');
  });

  it('keeps OTA group help concise and routes each nested help page separately', () => {
    const group = source(['ota', '--help']).stdout;
    const backup = source(['ota', 'backup', '--help']).stdout;
    const activation = source(['ota', 'activate', '--help']).stdout;
    expect(group).toContain('wg1200 ota activate');
    expect(group).not.toContain('Source verification');
    expect(backup).toContain('Create a verified, device-bound backup');
    expect(backup).toContain('--output <file>');
    expect(backup).not.toContain('--verify-mode');
    expect(activation).toContain('--metadata-backup-manifest <file>');
    expect(activation).toContain('--dry-run');
    expect(activation).toContain('15 seconds minimum');
    const normalized = activation.replace(/\s+/g, ' ');
    expect(normalized).toContain('on-chip MD5');
    expect(normalized).toContain('physical SHA-256');
  });

  it('shows explicit guidance for unknown help topics and invalid commands', () => {
    const badHelp = source(['ota', 'not-a-command', '--help']);
    expect(badHelp.status).toBe(2);
    expect(badHelp.stdout).toContain("Run 'wg1200 ota --help'");
    const badCommand = source(['not-a-command']);
    expect(badCommand.status).not.toBe(0);
    expect(badCommand.stderr).toContain('Unknown command: not-a-command');
  });

  it.skipIf(process.platform !== 'linux')('uses color only in a TTY and wraps long help at 80 columns', () => {
    const command = `${process.execPath} --import tsx src/cli.ts ota activate --help`;
    const pty = spawnSync('script', ['-qec', `stty cols 80; ${command}`, '/dev/null'], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
      env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '' } });
    expect(pty.status).toBe(0);
    expect(pty.stdout).toMatch(/\u001b\[1;36m/);
    const plain = pty.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    expect(Math.max(...plain.split('\n').map((line) => line.length))).toBeLessThanOrEqual(80);
    const piped = source(['ota', 'activate', '--help']);
    expect(piped.stdout).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
    const binary = process.env.WG1200_STANDALONE_BINARY;
    if (binary) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const standalonePty = spawnSync('script', ['-qec', `stty cols 80; ${quote(resolve(binary))} ota backup --help`, '/dev/null'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 8_000, env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '' },
      });
      expect(standalonePty.status).toBe(0);
      expect(standalonePty.stdout).toMatch(/\u001b\[1;36m/);
      const standalonePlain = standalonePty.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
      expect(Math.max(...standalonePlain.split('\n').map((line) => line.length))).toBeLessThanOrEqual(80);
    }
  });
});
