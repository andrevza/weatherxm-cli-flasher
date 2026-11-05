import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

const builtExecutable = process.env.WG1200_STANDALONE_BINARY;
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('standalone executable packaging', () => {
  it.skipIf(!builtExecutable)('loads and calls the native SerialPort binding without project dependencies', () => {
    const executable = resolve(builtExecutable!);
    const cleanDir = mkdtempSync(join(tmpdir(), 'wxm-clean-executable-'));
    scratchDirs.push(cleanDir);
    const isolatedExecutable = join(cleanDir, basename(executable));
    copyFileSync(executable, isolatedExecutable);
    chmodSync(isolatedExecutable, 0o755);

    const output = execFileSync(isolatedExecutable, ['--serial-binding-smoke'], {
      cwd: cleanDir,
      encoding: 'utf8',
      env: { PATH: '', TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() },
      timeout: 30_000,
    });

    expect(output).toMatch(/^serial binding loaded; native API verified \(open, close, set, get, getBaudRate, update, flush, drain\)$/m);
  });

  it.skipIf(!builtExecutable)('prints structured, non-colored help and keeps input errors off JSON stdout', () => {
    const executable = resolve(builtExecutable!);
    const cleanDir = mkdtempSync(join(tmpdir(), 'wxm-clean-help-'));
    scratchDirs.push(cleanDir);
    const env = { PATH: '', TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), NO_COLOR: '1' };
    const help = execFileSync(executable, ['--help'], { cwd: cleanDir, encoding: 'utf8', env, timeout: 15_000 });
    expect(help).toContain('DEVICE COMMANDS');
    expect(help).toContain('check <firmware>');
    expect(help).toContain('monitor');
    expect(help).toContain('-v, --version');
    expect(help).not.toMatch(/\u001b\[/);
    const commandHelp = execFileSync(executable, ['check', '--help'], { cwd: cleanDir, encoding: 'utf8', env, timeout: 15_000 });
    expect(commandHelp).toContain('Never writes flash');
    expect(commandHelp).toContain('[--redact]');
    const monitorHelp = execFileSync(executable, ['monitor', '--help'], { cwd: cleanDir, encoding: 'utf8', env, timeout: 15_000 });
    expect(monitorHelp).toContain('receive-only');
    const securityHelp = execFileSync(executable, ['security', '--help'], { cwd: cleanDir, encoding: 'utf8', env, timeout: 15_000 });
    expect(securityHelp).toContain('security check <firmware>');
    const badInput = spawnSync(executable, ['check', 'weatherxm', '--json'], { cwd: cleanDir, encoding: 'utf8', env, timeout: 15_000 });
    expect(badInput.status).toBe(1);
    expect(badInput.stdout).toBe('');
    expect(badInput.stderr).toMatch(/requires --port/);
  });

  it.skipIf(!builtExecutable)('executes the embedded dual-slot status, check, and dry-run formatters', () => {
    const executable = resolve(builtExecutable!);
    const env = { PATH: '', TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), NO_COLOR: '1' };
    const fixture = (mode: string) => execFileSync(executable, ['--presentation-smoke', mode], { encoding: 'utf8', env, timeout: 15_000 });
    const status = fixture('status');
    expect(status).toContain('Active OTA Seq  4');
    expect(status).toContain('Target Slot     ota_0');
    expect(status).toContain('Target Offset   0x420000');
    expect(status).toContain('Next OTA Seq    5');
    expect(status).toContain('ota_1    ACTIVE');
    expect(status).toContain('WeatherXM 0.8.34-g86b609b');
    expect(status).toContain('cd90d5aa46a0');
    expect(status).toContain('ota_0    INACTIVE');
    expect(status).toContain('WeatherXM v0.6.1-dirty');
    expect(status).toContain('8d11a5d088fb');

    const check = fixture('check');
    expect(check).toContain('Selected          WeatherXM 0.8.34-g86b609b');
    expect(check).toContain('Comparison        IDENTICAL');
    expect(check).toContain('Inactive Slot     ota_0');

    const dryRun = fixture('dry-run');
    expect(dryRun).toContain('Firmware          weatherxm v0.6.2-2-g8f4dca2');
    expect(dryRun).toContain('Target Slot       ota_0');
    expect(dryRun).toContain('Target Offset     0x420000');
    expect(dryRun).toContain('Comparison        OLDER');
    expect(dryRun).toContain('DOWNGRADE BLOCKED');
    expect(dryRun).toContain('No flash operations performed.');
    const matchingDryRun = fixture('dry-run-match');
    expect(matchingDryRun).toContain('Selected firmware matches the build descriptor stored in the inactive OTA slot.');
  });

  it.skipIf(!builtExecutable)('redacts synthetic nested JSON and diagnostics in the actual executable', () => {
    const executable = resolve(builtExecutable!);
    const env = { PATH: '', TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), NO_COLOR: '1' };
    const raw = execFileSync(executable, ['--redaction-smoke'], { encoding: 'utf8', env, timeout: 15_000 });
    expect(raw).toContain('AA:BB:CC:DD:EE:FF');
    const safe = execFileSync(executable, ['--redact', '--redaction-smoke'], { encoding: 'utf8', env, timeout: 15_000 });
    expect(safe).toContain('[REDACTED MAC]');
    expect(safe).toContain('[REDACTED COMMON NAME]');
    expect(safe).toContain('[REDACTED CERTIFICATE FINGERPRINT]');
    expect(safe).toContain('[REDACTED PUBLIC KEY]');
    expect(safe).toContain('[REDACTED STATION ID]');
    expect(safe).toContain('[REDACTED PUBLIC KEY]');
    expect(safe).toContain('[REDACTED LOCATION]');
    expect(safe).toContain('[REDACTED CREDENTIAL]');
    expect(safe).toContain('"chip": "ESP32-S3"');
    expect(safe).not.toContain('AA:BB:CC:DD:EE:FF');
    expect(safe).not.toContain('gateway-secret.example');
    expect(safe).not.toContain('1234');
    expect(safe).not.toContain('AB12CD34EF56');
    expect(safe).not.toContain('station-123');
    expect(safe).not.toContain('serial-123');
    expect(safe).not.toContain('station-public-key');
    expect(safe).not.toContain('mqtt-secret');
    expect(safe).not.toContain('access-secret');
    expect(safe).not.toContain('-33.9');
    expect(safe).not.toContain('18.4');
    expect(safe).not.toContain('a'.repeat(64));
    expect(safe).not.toContain('b'.repeat(64));
  });

  it.skipIf(!builtExecutable)('reports embedded source and build metadata', () => {
    const executable = resolve(builtExecutable!);
    const metadata = JSON.parse(execFileSync(executable, ['--build-info'], { encoding: 'utf8', timeout: 15_000 }));
    const packageMetadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(metadata.packageVersion).toBe(packageMetadata.version);
    expect(metadata.packageVersion).toBeTruthy();
    expect(Number.isNaN(Date.parse(metadata.builtAt))).toBe(false);
    expect(metadata.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.gitCommit === null || /^[a-f0-9]{40}$/.test(metadata.gitCommit)).toBe(true);
    expect(metadata.gitTag === null || typeof metadata.gitTag === 'string').toBe(true);
    expect(typeof metadata.gitDirty).toBe('boolean');
  });

  it.skipIf(!builtExecutable)('reports concise and verbose versions without device or network access', () => {
    const executable = resolve(builtExecutable!);
    const env = { PATH: '', TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), NO_COLOR: '1' };
    const metadata = JSON.parse(execFileSync(executable, ['--build-info'], { encoding: 'utf8', env, timeout: 15_000 }));
    const help = execFileSync(executable, ['--help'], { encoding: 'utf8', env, timeout: 15_000 });
    expect(help).toContain(`v${metadata.packageVersion}`);
    expect(help).toContain('-v, --version');
    const long = execFileSync(executable, ['--version'], { encoding: 'utf8', env, timeout: 15_000 });
    const short = execFileSync(executable, ['-v'], { encoding: 'utf8', env, timeout: 15_000 });
    expect(long).toBe(`WeatherXM WG1200 Flasher v${metadata.packageVersion}\n`);
    expect(short).toBe(long);

    const verbose = execFileSync(executable, ['--version', '--verbose'], { encoding: 'utf8', env, timeout: 15_000 });
    expect(verbose).toContain(`Version: ${metadata.packageVersion}`);
    expect(verbose).toContain(`Build timestamp: ${metadata.builtAt}`);
    expect(verbose).toContain(`Source SHA-256: ${metadata.sourceSha256}`);
    expect(verbose).toContain(`Git commit: ${metadata.gitCommit ?? 'unavailable'}`);
    expect(verbose).toContain(`Git tag: ${metadata.gitTag ?? 'none'}`);
    expect(verbose).toContain(`Working tree: ${metadata.gitDirty ? 'dirty' : 'clean'}`);
    expect(verbose).toMatch(/Operating system: \w+/);
    expect(verbose).toMatch(/Architecture: \w+/);
    expect(verbose).toMatch(/Runtime: Node\.js v\d+\.\d+\.\d+/);

    const json = JSON.parse(execFileSync(executable, ['--version', '--verbose', '--json'], { encoding: 'utf8', env, timeout: 15_000 }));
    expect(json).toEqual({ application: 'WeatherXM WG1200 Flasher', version: metadata.packageVersion,
      buildTimestamp: metadata.builtAt, sourceSha256: metadata.sourceSha256,
      gitCommit: metadata.gitCommit, gitTag: metadata.gitTag, gitDirty: metadata.gitDirty,
      operatingSystem: process.platform, architecture: process.arch, runtimeVersion: expect.any(String) });
    const simpleJson = JSON.parse(execFileSync(executable, ['--version', '--json'], { encoding: 'utf8', env, timeout: 15_000 }));
    expect(simpleJson).toEqual({ application: 'WeatherXM WG1200 Flasher', version: metadata.packageVersion });
  });
});
