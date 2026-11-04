import { build } from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.bun) throw new Error('Standalone SEA builds require the Node.js runtime; Bun may silently leave an existing executable unchanged. Run this script with Node.js 26 or newer.');

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

const gitCommit = process.env.WG1200_GIT_COMMIT || gitOutput(['rev-parse', 'HEAD']);
const gitTag = process.env.WG1200_GIT_TAG || gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
const dirtyOverride = process.env.WG1200_GIT_DIRTY;
const gitDirty = dirtyOverride === 'true' ? true : dirtyOverride === 'false' ? false : gitStatus.status !== 0 || gitStatus.stdout.trim().length > 0;
if (process.env.GITHUB_REF_TYPE === 'tag' && (!gitCommit || gitDirty)) {
  throw new Error('Refusing to build an official tagged release from an uncommitted or non-Git source tree.');
}
const targets = {
  'linux-arm64': {
    name: 'weatherxm-flash-linux-arm64',
    addon: 'linux-arm64/@serialport+bindings-cpp.armv8.glibc.node',
  },
  'linux-x64': {
    name: 'weatherxm-flash-linux-x64',
    addon: 'linux-x64/@serialport+bindings-cpp.glibc.node',
  },
  'darwin-arm64': {
    name: 'weatherxm-flash-macos-arm64',
    addon: 'darwin-x64+arm64/@serialport+bindings-cpp.node',
  },
};

const target = `${process.platform}-${process.arch}`;
const output = targets[target];
if (!output) throw new Error(`Unsupported target ${target}. Choose: ${Object.keys(targets).join(', ')}`);
if (Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('Standalone builds require Node.js 26 or newer for the built-in --build-sea command.');
}

const addonPath = resolve(root, 'node_modules/@serialport/bindings-cpp/prebuilds', output.addon);
if (!existsSync(addonPath)) {
  throw new Error(`Missing native ${target} SerialPort addon. Run npm ci on a native ${target} build host.`);
}

const distDir = resolve(root, 'dist');
mkdirSync(distDir, { recursive: true });
const sourceFiles = [];
const collectSourceFiles = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(path);
    else if (entry.name.endsWith('.ts')) sourceFiles.push(path);
  }
};
collectSourceFiles(resolve(root, 'src'));
sourceFiles.sort();
const sourceHash = createHash('sha256');
for (const path of sourceFiles) {
  sourceHash.update(path.slice(root.length));
  sourceHash.update(readFileSync(path));
}
const buildMetadata = JSON.stringify({ packageVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  builtAt: new Date().toISOString(),
  sourceSha256: sourceHash.digest('hex'),
  gitCommit,
  gitTag,
  gitDirty,
});
const workDir = mkdtempSync(join(distDir, '.sea-build-'));
const executable = join(distDir, output.name);
const stagedExecutable = join(workDir, output.name);
const mainPath = join(workDir, 'main.cjs');
const seaConfigPath = join(workDir, 'sea-config.json');
const nativeLoaderPath = join(workDir, 'embedded-native-loader.cjs');
const stagedAddonName = '@serialport+bindings-cpp.node';
writeFileSync(nativeLoaderPath, `module.exports = function loadEmbeddedSerialPortBinding() {
  const binding = globalThis.__weatherxmSerialPortNativeBinding;
  if (!binding) throw new Error('Embedded SerialPort native binding was not initialized');
  return binding;
};\n`);

const bootstrap = `
// Rebind SEA's restricted require to Node's normal loader for the generated bundle.
delete process.env.ELECTRON_RUN_AS_NODE;
const { createRequire } = require('node:module');
require = createRequire(process.execPath);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { getAsset } = require('node:sea');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weatherxm-serialport-'));
const addonPath = path.join(tempRoot, ${JSON.stringify(stagedAddonName)});
fs.writeFileSync(addonPath, new Uint8Array(getAsset('serialport-addon.node')), { mode: 0o600 });
const addonModule = new Module(addonPath);
addonModule.filename = addonPath;
process.dlopen(addonModule, addonPath);
globalThis.__weatherxmSerialPortNativeBinding = addonModule.exports;
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));
`;

try {
  await build({
    entryPoints: [resolve(root, 'src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    packages: 'bundle',
    alias: { 'node-gyp-build': nativeLoaderPath },
    define: { __BUILD_METADATA__: buildMetadata },
    banner: { js: bootstrap },
    outfile: mainPath,
    logLevel: 'info',
  });

  writeFileSync(seaConfigPath, JSON.stringify({
    main: mainPath,
    output: stagedExecutable,
    assets: { 'serialport-addon.node': addonPath },
    useSnapshot: false,
    useCodeCache: false,
    useVfs: false,
    execArgvExtension: 'none',
    disableExperimentalSEAWarning: true,
  }, null, 2));

  const result = spawnSync(process.execPath, ['--build-sea', seaConfigPath], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(stagedExecutable, 0o755);

  if (target === 'linux-arm64') {
    const elfCheck = spawnSync(process.execPath, [resolve(root, 'scripts/validate-linux-elf.mjs'), stagedExecutable, addonPath, process.execPath], { cwd: root, encoding: 'utf8' });
    if (elfCheck.error) throw elfCheck.error;
    if (elfCheck.status !== 0) throw new Error(`Generated Linux ARM64 executable or embedded SerialPort addon is not compatible with 16 KB pages:\n${elfCheck.stderr || elfCheck.stdout}`);
    process.stdout.write(elfCheck.stdout);
  }

  if (process.platform === 'darwin') {
    const signed = spawnSync('codesign', ['--force', '--sign', '-', stagedExecutable], { cwd: root, stdio: 'inherit' });
    if (signed.error) throw signed.error;
    if (signed.status !== 0) process.exit(signed.status ?? 1);
  }

  const metadataRun = spawnSync(stagedExecutable, ['--build-info'], { encoding: 'utf8', timeout: 15000 });
  if (metadataRun.status !== 0) throw new Error(`Generated executable failed its embedded build-info check: ${metadataRun.stderr || metadataRun.error || metadataRun.status}`);
  const embedded = JSON.parse(metadataRun.stdout);
  if (embedded.sourceSha256 !== JSON.parse(buildMetadata).sourceSha256) throw new Error('Generated executable has stale or mismatched source metadata');
  const presentationRun = spawnSync(stagedExecutable, ['--presentation-smoke', 'status'], { encoding: 'utf8', timeout: 15000 });
  if (presentationRun.status !== 0 || !presentationRun.stdout.includes('FIRMWARE SLOTS') || !presentationRun.stdout.includes('NEXT INSTALLATION')) {
    throw new Error(`Generated executable failed its firmware-slot presentation check: ${presentationRun.stderr || presentationRun.error || presentationRun.status}`);
  }
  copyFileSync(stagedExecutable, executable);
  chmodSync(executable, 0o755);

  process.stdout.write(`Built ${executable}\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
