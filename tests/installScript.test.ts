import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const installer = resolve('scripts/install-wg1200.sh');
const standalone = process.env.WG1200_STANDALONE_BINARY;
const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function setup(os: string, arch: string, payload?: string) {
  const root = mkdtempSync(join(tmpdir(), 'wg1200-install-test-'));
  dirs.push(root);
  const bin = join(root, 'mock-bin');
  const installDir = join(root, 'install with spaces');
  mkdirSync(bin);
  const asset = payload ?? join(root, 'fixture-executable');
  const marker = join(root, 'executed');
  if (!payload) writeFileSync(asset, `#!/bin/sh\nprintf 'ran\\n' >> '${marker}'\ncase "$1" in --version) echo "WeatherXM WG1200 Flasher vtest";; --help) echo "wg1200 help fixture";; *) exit 2;; esac\n`, { mode: 0o755 });
  const assetName = artifactFor(os, arch);
  const hash = createHash('sha256').update(readFileSync(asset)).digest('hex');
  writeFileSync(join(root, 'SHA256SUMS'), `${hash}  ${assetName}\n`);
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$WG1200_TEST_OS";; -m) printf "%s\\n" "$WG1200_TEST_ARCH";; *) exit 2;; esac\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto|--proto-redir) shift 2 ;;
    --fail|--location|--silent|--show-error|--tlsv1.2) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$WG1200_TEST_URL_LOG"
case "$url" in
  */SHA256SUMS) /bin/cp "$WG1200_TEST_SUMS" "$output" ;;
  */"$WG1200_TEST_ASSET_NAME") /bin/cp "$WG1200_TEST_PAYLOAD" "$output" ;;
  *) exit 4 ;;
esac
`, { mode: 0o755 });
  const urls = join(root, 'requested-urls.txt');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    WG1200_GITHUB_REPOSITORY: 'test-owner/test-project',
    WG1200_RELEASE_TAG: 'v1.2.3',
    WG1200_INSTALL_DIR: installDir,
    WG1200_TEST_OS: os,
    WG1200_TEST_ARCH: arch,
    WG1200_TEST_PAYLOAD: asset,
    WG1200_TEST_SUMS: join(root, 'SHA256SUMS'),
    WG1200_TEST_ASSET_NAME: assetName,
    WG1200_TEST_URL_LOG: urls,
    WG1200_TEST_EXECUTION_MARKER: marker,
  };
  return { root, installDir, assetName, urls, env };
}

function artifactFor(os: string, arch: string): string {
  if (os === 'Darwin' && ['arm64', 'aarch64'].includes(arch)) return 'weatherxm-flash-macos-arm64';
  if (os === 'Linux' && ['arm64', 'aarch64'].includes(arch)) return 'weatherxm-flash-linux-arm64';
  if (os === 'Linux' && ['x86_64', 'amd64'].includes(arch)) return 'weatherxm-flash-linux-x64';
  throw new Error('unsupported test platform');
}

function install(env: NodeJS.ProcessEnv) {
  return spawnSync('/bin/sh', [installer], { encoding: 'utf8', env });
}

describe('wg1200 installer', () => {
  it.each([
    ['Darwin', 'arm64', 'weatherxm-flash-macos-arm64'],
    ['Darwin', 'aarch64', 'weatherxm-flash-macos-arm64'],
    ['Linux', 'aarch64', 'weatherxm-flash-linux-arm64'],
    ['Linux', 'arm64', 'weatherxm-flash-linux-arm64'],
    ['Linux', 'x86_64', 'weatherxm-flash-linux-x64'],
    ['Linux', 'amd64', 'weatherxm-flash-linux-x64'],
  ])('selects and installs the expected release asset for %s/%s', (os, arch, expectedArtifact) => {
    const test = setup(os, arch);
    const result = install(test.env);
    expect(result.status).toBe(0);
    const requestedUrls = readFileSync(test.urls, 'utf8');
    expect(requestedUrls).toContain(`https://github.com/test-owner/test-project/releases/download/v1.2.3/SHA256SUMS`);
    expect(requestedUrls).toContain(`https://github.com/test-owner/test-project/releases/download/v1.2.3/${expectedArtifact}`);
    const installed = join(test.installDir, 'wg1200');
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(test.env.WG1200_TEST_EXECUTION_MARKER)).toBe(false);
    expect(execFileSync(installed, ['--version'], { encoding: 'utf8' })).toContain('WeatherXM WG1200 Flasher vtest');
    expect(execFileSync(installed, ['--help'], { encoding: 'utf8' })).toContain('wg1200 help fixture');
  });

  it.each([['FreeBSD', 'x86_64'], ['Linux', 'riscv64'], ['Darwin', 'x86_64']])('rejects unsupported platform %s/%s before downloading', (os, arch) => {
    const test = setup('Linux', 'x86_64');
    test.env.WG1200_TEST_OS = os;
    test.env.WG1200_TEST_ARCH = arch;
    const result = install(test.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unsupported platform: ${os}/${arch}`);
    expect(existsSync(test.urls)).toBe(false);
  });

  it('rejects a checksum mismatch and does not install the file', () => {
    const test = setup('Linux', 'x86_64');
    writeFileSync(join(test.root, 'SHA256SUMS'), `${'0'.repeat(64)}  ${test.assetName}\n`);
    const result = install(test.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed SHA-256 verification');
    expect(existsSync(join(test.installDir, 'wg1200'))).toBe(false);
    expect(existsSync(test.env.WG1200_TEST_EXECUTION_MARKER)).toBe(false);
  });

  it('does not overwrite an existing installation or download anything', () => {
    const test = setup('Linux', 'x86_64');
    mkdirSync(test.installDir, { recursive: true });
    const target = join(test.installDir, 'wg1200');
    writeFileSync(target, 'keep existing file');
    const result = install(test.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('already exists');
    expect(readFileSync(target, 'utf8')).toBe('keep existing file');
    expect(existsSync(test.urls)).toBe(false);
  });

  it.skipIf(!standalone)('installs the actual standalone executable and verifies its version, help, and release metadata', () => {
    const os = process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : 'Unsupported';
    const arch = process.arch;
    const test = setup(os, arch, standalone);
    const result = install(test.env);
    expect(result.status).toBe(0);
    const installed = join(test.installDir, 'wg1200');
    const embedded = JSON.parse(execFileSync(installed, ['--version', '--verbose', '--json'], { encoding: 'utf8' }));
    const buildMetadata = JSON.parse(execFileSync(installed, ['--build-info'], { encoding: 'utf8' }));
    expect(embedded.version).toBe(buildMetadata.packageVersion);
    expect(embedded.buildTimestamp).toBe(buildMetadata.builtAt);
    expect(embedded.sourceSha256).toBe(buildMetadata.sourceSha256);
    expect(execFileSync(installed, ['--version'], { encoding: 'utf8' })).toContain(`v${embedded.version}`);
    expect(execFileSync(installed, ['--help'], { encoding: 'utf8' })).toContain('USAGE');
  });
});
