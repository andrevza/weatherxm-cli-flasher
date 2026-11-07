#!/usr/bin/env node
import { backupDiscoveredPartition, backupInactiveOta, checkExitCode, checkFirmware, checkFirmwareSecurity, diagnoseOtaImage, flashDevice, inspectDevice, readDeviceSecurity, serializeFirmwareCheckResult, stageOnlyConfirmationPhrase, StageOnlyOperationError, stageOnlyFirmware, summarizeInspection } from './device.js';
import { catalogRows, DEFAULT_MANIFEST_URL, fetchCatalog } from './catalog.js';
import { getOfficialFirmware } from './firmwareStore.js';
import { compareBackupToFirmware, compareFirmwareFiles } from './firmwareCompare.js';
import { OutputCoordinator, ProgressReporter } from './progress.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import packageMetadata from '../package.json';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { finished } from 'node:stream/promises';
import { analyzeBootLogs, LogSanitizer } from './upstream/flasher/serialLog.js';
import { formatSanitizedMonitorLine, monitorColorEnabled, monitorSerial, type MonitorLevel, writeMonitorOutput } from './monitor.js';
import { formatCheckOutput, formatDryRunOutput, formatStatusOutput, standalonePresentationFixture } from './presentation.js';
import { redactOutput, standaloneRedactionFixture } from './redaction.js';
import { bindAbortOnSigint } from './interrupt.js';
import type { VerificationMode } from './verification.js';
import { ConfirmationCancelledError, retryExactConfirmation } from './verification.js';
import { confirmWithSuspendedProgress } from './operatorConfirmation.js';
import { activateOtaSlot, backupOtaMetadata, dryRunOtaActivation, readOtaStatus, restoreOtaMetadata } from './otaDevice.js';
import { renderHelp, resolveHelpTopic } from './help.js';

declare const __BUILD_METADATA__: { packageVersion: string; builtAt: string; sourceSha256: string; gitCommit: string | null; gitTag: string | null; gitDirty: boolean } | undefined;

type Args = { command: string; subcommand?: string; target?: string; firmwareKey?: string; helpTarget?: string; port?: string; baud: number; manifest: string; json: boolean; redact: boolean; verbose: boolean; yes: boolean; recover: boolean; force: boolean; dryRun: boolean; stageOnly: boolean; verifyMode?: VerificationMode; backupManifest?: string; metadataBackupManifest?: string; backupPath?: string; firmwareFile?: string; expectedSha256?: string; firmwareVersion?: string; offline: boolean; cacheDirectory?: string; traceSerial: boolean; monitor: boolean; boot: boolean; timestamp: boolean; level?: MonitorLevel; outputFile?: string; bootLogOutput?: string; raw: boolean; noColor: boolean; bootLogSeconds: number; };
const applicationName = 'WeatherXM WG1200 Flasher';

type SimpleVersionInfo = { application: string; version: string };
type VerboseVersionInfo = SimpleVersionInfo & { buildTimestamp: string | null; sourceSha256: string | null; gitCommit: string | null; gitTag: string | null; gitDirty: boolean | null; operatingSystem: string; architecture: string; runtimeVersion: string };
function versionInfo(verbose: true): VerboseVersionInfo;
function versionInfo(verbose: false): SimpleVersionInfo;
function versionInfo(verbose: boolean): VerboseVersionInfo | SimpleVersionInfo;
function versionInfo(verbose: boolean): VerboseVersionInfo | SimpleVersionInfo {
  const embedded = typeof __BUILD_METADATA__ === 'undefined' ? undefined : __BUILD_METADATA__;
  const base = { application: applicationName, version: embedded?.packageVersion ?? packageMetadata.version };
  return verbose ? {
    ...base,
    buildTimestamp: embedded?.builtAt ?? null,
    sourceSha256: embedded?.sourceSha256 ?? null,
    gitCommit: embedded?.gitCommit ?? null,
    gitTag: embedded?.gitTag ?? null,
    gitDirty: embedded?.gitDirty ?? null,
    operatingSystem: process.platform,
    architecture: process.arch,
    runtimeVersion: process.version,
  } : base;
}

function operatingSystemLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function renderVersion(args: string[]): boolean {
  if (args[0] === 'firmware' && args[1] === 'download' && args[2] && args.includes('--version')) return false;
  if (!args.includes('--version') && !args.includes('-v')) return false;
  const unsupported = args.filter((arg) => !['--version', '-v', '--verbose', '--json', '--redact'].includes(arg));
  if (unsupported.length) throw new Error(`Version options cannot be combined with commands or other options: ${unsupported.join(' ')}`);
  const verbose = args.includes('--verbose');
  const info = versionInfo(verbose);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  else if (verbose) {
    const details = versionInfo(true);
    process.stdout.write(`${details.application}\nVersion: ${details.version}\nBuild timestamp: ${details.buildTimestamp ?? 'unavailable'}\nSource SHA-256: ${details.sourceSha256 ?? 'unavailable'}\nGit commit: ${details.gitCommit ?? 'unavailable'}\nGit tag: ${details.gitTag ?? 'none'}\nWorking tree: ${details.gitDirty === null ? 'unknown' : details.gitDirty ? 'dirty' : 'clean'}\nOperating system: ${operatingSystemLabel(details.operatingSystem)}\nArchitecture: ${details.architecture}\nRuntime: Node.js ${details.runtimeVersion}\n`);
  }
  else process.stdout.write(`${info.application} v${info.version}\n`);
  return true;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let helpRequested = false;
  let manifestProvided = false;
  let bootLogProvided = false;
  let optionTarget: string | undefined;
  const out: Args = { command: '', baud: 115200, manifest: DEFAULT_MANIFEST_URL, json: false, redact: false, verbose: false, yes: false, recover: false, force: false, dryRun: false, stageOnly: false, offline: false, traceSerial: false, monitor: false, boot: false, timestamp: false, raw: false, noColor: false, bootLogSeconds: 15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = argv[++i];
    else if (arg === '--target') optionTarget = argv[++i];
    else if (arg === '--metadata-backup-manifest') out.metadataBackupManifest = argv[++i];
    else if (arg === '--baud') out.baud = Number(argv[++i]);
    else if (arg === '--manifest') { out.manifest = argv[++i]; manifestProvided = true; }
    else if (arg === '--json') out.json = true;
    else if (arg === '--redact') out.redact = true;
    else if (arg === '--verbose') out.verbose = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--recover') out.recover = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--stage-only') out.stageOnly = true;
    else if (arg === '--verify-mode') {
      const mode = argv[++i];
      if (mode !== 'fast' && mode !== 'thorough') throw new Error('--verify-mode must be fast or thorough');
      out.verifyMode = mode;
    }
    else if (arg === '--backup-manifest') out.backupManifest = argv[++i];
    else if (arg === '--backup') out.backupPath = argv[++i];
    else if (arg === '--firmware') out.firmwareKey = argv[++i];
    else if (arg === '--firmware-file') out.firmwareFile = argv[++i];
    else if (arg === '--expected-sha256') out.expectedSha256 = argv[++i];
    else if (arg === '--version' && argv[i + 1] && !argv[i + 1].startsWith('-')) out.firmwareVersion = argv[++i];
    else if (arg === '--offline') out.offline = true;
    else if (arg === '--cache-dir') out.cacheDirectory = argv[++i];
    else if (arg === '--trace-serial') out.traceSerial = true;
    else if (arg === '--monitor') out.monitor = true;
    else if (arg === '--boot') out.boot = true;
    else if (arg === '--timestamp') out.timestamp = true;
    else if (arg === '--level') out.level = argv[++i] as MonitorLevel;
    else if (arg === '--output') out.outputFile = argv[++i];
    else if (arg === '--boot-log-output') out.bootLogOutput = argv[++i];
    else if (arg === '--raw') out.raw = true;
    else if (arg === '--no-color') out.noColor = true;
    else if (arg === '--boot-log-seconds' || arg === '--boot-capture-seconds') { out.bootLogSeconds = Number(argv[++i]); bootLogProvided = true; }
    else if (arg === '--help' || arg === '-h') helpRequested = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  out.command = helpRequested ? 'help' : positional[0] || 'help';
  if (helpRequested) out.helpTarget = resolveHelpTopic(positional);
  out.subcommand = positional[1];
  out.target = optionTarget ?? positional[2];
  if (!Number.isInteger(out.baud) || out.baud < 1200 || out.baud > 2000000) throw new Error('Baud rate must be an integer from 1200 to 2000000');
  if (!helpRequested) {
    if (out.force && out.command !== 'flash') throw new Error('--force is supported only by flash');
    if (out.dryRun && !(out.command === 'flash' || (out.command === 'ota' && out.subcommand === 'activate'))) throw new Error('--dry-run is supported only by flash and ota activate');
    if (out.stageOnly && out.command !== 'flash') throw new Error('--stage-only is supported only by flash');
    if (out.verifyMode && !['fast', 'thorough'].includes(out.verifyMode)) throw new Error('--verify-mode must be fast or thorough');
    if (out.verifyMode && !out.stageOnly && !(out.command === 'ota' && ['status', 'activate'].includes(out.subcommand ?? ''))) throw new Error('--verify-mode requires flash --stage-only, ota status, or ota activate');
    if (out.backupManifest && out.command !== 'flash') throw new Error('--backup-manifest is supported only by flash --stage-only');
    if ((out.yes || out.recover) && out.command !== 'flash') throw new Error('--yes and --recover are supported only by flash');
    if (manifestProvided && !['firmware', 'check', 'flash', 'security'].includes(out.command)) throw new Error('--manifest is supported only by firmware list/download/compare, check, flash, and security check');
    if (manifestProvided && out.command === 'flash' && out.subcommand === 'diagnose') throw new Error('--manifest is not supported by read-only flash diagnose, which uses the approved pinned image');
    if (manifestProvided && out.command === 'security' && out.subcommand !== 'check') throw new Error('--manifest is supported only by security check');
    if (out.traceSerial && !['info', 'verify', 'status', 'check', 'flash', 'security', 'ota'].includes(out.command)) throw new Error('--trace-serial requires a device command');
    if (out.monitor && !['info', 'verify', 'status', 'check', 'flash'].includes(out.command)) throw new Error('--monitor requires a device operation');
    if (out.boot && out.command !== 'monitor') throw new Error('--boot is supported only by monitor');
    if ((out.timestamp || out.level || out.raw || out.noColor) && out.command !== 'monitor' && !out.monitor && !(out.command === 'ota' && ['activate', 'restore'].includes(out.subcommand ?? '') && !out.dryRun && !out.level && !out.raw)) throw new Error('Monitor formatting options require monitor, ota activate, or ota restore');
    if (out.level && !['error', 'warn', 'info', 'debug', 'verbose'].includes(out.level)) throw new Error('--level must be error, warn, info, debug, or verbose');
    if (!Number.isInteger(out.bootLogSeconds) || out.bootLogSeconds < 0 || out.bootLogSeconds > 3600) throw new Error('--boot-log-seconds must be an integer from 0 to 3600');
    if (out.command === 'ota' && ['activate', 'restore'].includes(out.subcommand ?? '') && out.bootLogSeconds < 15) throw new Error('OTA activation and restoration boot capture must be at least 15 seconds');
    if (bootLogProvided && out.command !== 'flash' && !(out.command === 'ota' && ['activate', 'restore'].includes(out.subcommand ?? ''))) throw new Error('--boot-log-seconds is supported only by flash, ota activate, or ota restore');
    if (out.stageOnly && (out.subcommand !== 'weatherxm' || out.yes || out.force || out.recover || out.dryRun || out.monitor)) {
      throw new Error('--stage-only requires flash weatherxm and interactive confirmation; --yes, --force, --recover, --dry-run, and --monitor are not permitted');
    }
    if (out.command === 'flash' && out.subcommand === 'diagnose' && (!['ota_0', 'ota_1'].includes(out.target ?? '') || out.stageOnly || out.dryRun || out.yes || out.force || out.recover || out.monitor || out.backupManifest || out.verifyMode)) {
      throw new Error('flash diagnose requires --target ota_0|ota_1 and is read-only; write, stage, verification-mode, and monitor options are not supported');
    }
    if (out.stageOnly && manifestProvided && out.manifest !== DEFAULT_MANIFEST_URL) throw new Error('--stage-only accepts only the pinned official WeatherXM firmware manifest');
    if (out.backupManifest && !out.stageOnly) throw new Error('--backup-manifest requires --stage-only');
    if (out.command === 'ota' && (!['status', 'backup', 'activate', 'restore'].includes(out.subcommand ?? '') || out.yes || out.force || out.recover || out.stageOnly || out.monitor || (out.subcommand === 'backup' && !out.outputFile) || (out.subcommand !== 'backup' && out.outputFile) || (out.subcommand === 'activate' && (!['ota_0', 'ota_1'].includes(out.target ?? '') || !out.metadataBackupManifest)) || (out.subcommand === 'restore' && (!out.metadataBackupManifest || out.target || out.dryRun)))) throw new Error('ota supports status, backup --output, activate --target and restore, both requiring --metadata-backup-manifest');
    if (out.metadataBackupManifest && !(out.command === 'ota' && ['activate', 'restore'].includes(out.subcommand ?? ''))) throw new Error('--metadata-backup-manifest requires ota activate or ota restore');
    if (out.command === 'ota' && out.subcommand === 'status' && (out.target || out.dryRun)) throw new Error('ota status does not accept --target or --dry-run');
    if (out.command === 'backup' && (!(['inactive', 'active'].includes(out.subcommand ?? '') || (out.subcommand === 'partition' && Boolean(out.target))) || !out.outputFile || out.yes || out.force || out.recover || out.dryRun || out.stageOnly || out.monitor || out.timestamp || out.level || out.raw || out.noColor)) {
      throw new Error('backup requires `backup <active|inactive> --port <path> --output <file>` or `backup partition <name> --port <path> --output <file>`; it never overwrites existing files');
    }
    if (out.firmwareVersion && !(out.command === 'firmware' && out.subcommand === 'download')) throw new Error('--version <version> is supported only by firmware download');
    if (out.backupPath && !(out.command === 'firmware' && out.subcommand === 'compare')) throw new Error('--backup is supported only by firmware compare');
    if (out.firmwareFile && !(out.command === 'firmware' && out.subcommand === 'compare')) throw new Error('--firmware-file is supported only by firmware compare');
    if (out.firmwareKey && !(out.command === 'firmware' && out.subcommand === 'compare')) throw new Error('--firmware is supported only by firmware compare');
    if (out.expectedSha256 && !(out.command === 'firmware' && out.subcommand === 'compare' && out.firmwareFile)) throw new Error('--expected-sha256 requires firmware compare --firmware-file');
    if (out.offline && !(['firmware', 'flash', 'check'].includes(out.command) || (out.command === 'ota' && out.subcommand === 'activate'))) throw new Error('--offline is supported only by firmware, check, flash, and ota activate commands');
    if (out.cacheDirectory && !(['firmware', 'flash', 'check'].includes(out.command) || (out.command === 'ota' && out.subcommand === 'activate'))) throw new Error('--cache-dir is supported only by firmware, check, flash, and ota activate commands');
    if (out.command === 'firmware' && !['list', 'download', 'compare'].includes(out.subcommand ?? '')) throw new Error('firmware supports list, download, and compare');
    if (out.command === 'firmware' && out.subcommand === 'list' && (out.offline || out.cacheDirectory)) throw new Error('firmware list reads the catalog directly and does not accept --offline or --cache-dir');
    if (out.command === 'firmware' && out.subcommand === 'download' && !['weatherxm', 'meshtastic'].includes(out.target ?? '')) throw new Error('firmware download requires weatherxm or meshtastic');
    if (out.command === 'firmware' && out.subcommand === 'compare' && (!out.backupPath || (Boolean(out.firmwareKey) === Boolean(out.firmwareFile)))) throw new Error('firmware compare requires --backup and exactly one of --firmware <key> or --firmware-file <path>');
    if (out.outputFile && out.command !== 'backup' && !(out.command === 'ota' && out.subcommand === 'backup') && out.command !== 'monitor' && !out.monitor) throw new Error('--output is supported by backup or monitor');
    if (out.bootLogOutput && !(out.command === 'ota' && ['activate', 'restore'].includes(out.subcommand ?? ''))) throw new Error('--boot-log-output is supported only by ota activate and ota restore');
    if (out.command === 'monitor' && out.json) throw new Error('--json is not supported by the continuous monitor command');
  }
  return out;
}

let activeProgress: ProgressReporter | undefined;

function createProgress(args: Args): ProgressReporter {
  const tty = Boolean(process.stderr.isTTY) && process.env.TERM !== 'dumb';
  const coordinator = new OutputCoordinator({ write: (text) => process.stderr.write(text), tty,
    width: () => Math.max(20, Math.min(160, process.stderr.columns || 100)) });
  const reporter = new ProgressReporter({
    coordinator, tty, intervalMs: tty ? 1000 : 5000, width: () => Math.max(20, Math.min(160, process.stderr.columns || 100)),
  });
  activeProgress = reporter;
  return reporter;
}

function help(topic?: string, plain = false) {
  const output = renderHelp(topic, packageMetadata.version, {
    color: !plain && Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb',
    width: stdout.columns || 80,
  });
  process.stdout.write(output);
  if (output.includes('\nUnknown help topic:')) process.exitCode = 2;
}


function formatSecurityResult(device: import('./upstream/flasher/secureBoot.js').SecureBootDeviceState,
  candidate?: import('./device.js').FirmwareSecurityCheckResult): string {
  const lines = [
    'WG1200 Secure Boot V2 Security',
    '────────────────────────────────',
    `Chip model      ${device.chip.model}`,
    `Chip revision   ${device.chip.revision ?? 'UNKNOWN'}`,
    `Secure Boot V2  ${device.secureBootV2.state.toUpperCase()} (${device.secureBootV2.status})`,
    `Secure version  ${device.secureVersion.value ?? 'UNKNOWN'} (${device.secureVersion.status})`,
    `Anti-rollback   ${device.antiRollbackEnforcement.state.toUpperCase()} — ${device.antiRollbackEnforcement.explanation}`,
    `Download mode   ${device.downloadMode.status === 'verified'
      ? `disableAll=${device.downloadMode.disableAllDownload}, disableUsbSerialJtag=${device.downloadMode.disableUsbSerialJtagDownload}, disableUsbOtg=${device.downloadMode.disableUsbOtgDownload}, secureDownload=${device.downloadMode.securityDownloadEnabled}`
      : 'UNKNOWN'}`,
    `Flash encryption ${device.flashEncryption.status === 'verified'
      ? `enabled=${device.flashEncryption.enabled}, SPI_BOOT_CRYPT_CNT=${device.flashEncryption.cryptCount}, manualEncryptDisabled=${device.flashEncryption.disableManualEncryption}`
      : 'UNKNOWN'}`,
    `Evidence        ${device.evidence.toUpperCase()}`,
    '',
    'KEY BLOCKS',
  ];
  for (const block of device.keyBlocks) {
    lines.push(`  BLOCK_KEY${block.block} purpose=${block.purpose} readProtection=${block.readProtected === null ? 'UNKNOWN' : block.readProtected ? 'enabled' : 'disabled'} Public key hash=${block.publicKeyHash ? block.publicKeyHash : block.digestStatus.toUpperCase()}`);
    const diagnostic = block.readDiagnostic;
    if (diagnostic?.errorCategory) {
      lines.push(`    Read diagnostic  ${diagnostic.operation} logicalSlot=${diagnostic.logicalSlot} physicalBlock=${diagnostic.physicalBlock} baseOffset=${diagnostic.registerBaseOffset} wordsRead=${diagnostic.wordsRead}/${diagnostic.expectedWords} error=${diagnostic.errorCategory}${diagnostic.failedWordIndex === null ? '' : ` wordIndex=${diagnostic.failedWordIndex} registerOffset=${diagnostic.failedRegisterOffset}`}`);
    }
  }
  lines.push('', 'KEY REVOCATION');
  for (const item of device.revocation) lines.push(`  digest${item.digestSlot}=${item.revoked === null ? 'UNKNOWN' : item.revoked ? 'REVOKED' : 'active'} (${item.status})`);
  if (candidate) {
    lines.push('', 'CANDIDATE FIRMWARE',
      `  Result          ${candidate.result}`,
      `  Firmware        ${candidate.firmware.key} ${candidate.firmware.version}`,
      `  Manifest SHA256 ${candidate.firmware.manifestSha256}`,
      `  Image structure ${candidate.image.imageFormatValid ? 'VALID' : 'INVALID'}`,
      `  Image digest    ${candidate.image.imageDigestValid ? 'VALID' : 'INVALID'}`,
      `  RSA-PSS         ${candidate.image.signatureValid ? 'VALID' : 'INVALID'}`,
      `  Secure version  ${candidate.firmware.descriptorSecureVersion} (${candidate.trust.securityVersionStatus})`,
      `  Device key      ${candidate.trust.trustedKeyMatch === null ? 'UNKNOWN' : candidate.trust.trustedKeyMatch ? 'MATCH' : 'NO MATCH'}`,
      `  Boot/rollback   NOT ESTABLISHED`,
      `  Assessment      ${candidate.explanation}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runMonitor(args: Args, header?: string): Promise<string[]> {
  if (!args.port) throw new Error(`${args.command} requires --port, for example --port /dev/ttyUSB0`);
  const target = args.json ? process.stderr : process.stdout;
  const file = args.outputFile ? createWriteStream(args.outputFile, { flags: 'a' }) : undefined;
  const color = monitorColorEnabled({ isTTY: Boolean(target.isTTY), noColor: args.noColor });
  try {
    const lines = await monitorSerial({
      portPath: args.port, baudRate: args.baud, boot: args.boot, redact: args.redact, timestamp: args.timestamp || args.boot, level: args.level,
      raw: args.raw, noColor: args.noColor, color, header,
      output: (value) => {
        const rendered = `${value}${value.endsWith('\n') ? '' : '\n'}`;
        writeMonitorOutput(rendered, args.redact, (text) => target.write(text), file ? (text) => file.write(text) : undefined);
      },
    });
    target.write('Serial port released.\n');
    return lines;
  } finally {
    if (file) {
      file.end();
      await finished(file);
    }
  }
}

/** Formats sanitized live boot lines through the same pipeline used by monitorSerial. */
function createOtaBootPresenter(args: Args): { onLine: (line: string) => void; savedText: () => string } {
  const saved: string[] = [];
  const sanitizer = new LogSanitizer({ suppressRadioPayloads: args.redact });
  const color = monitorColorEnabled({ isTTY: Boolean(process.stderr.isTTY), noColor: args.noColor });
  return {
    onLine: (line) => {
      const safeLine = sanitizer.sanitizeLine(line);
      if (safeLine === null) return;
      const formatted = formatSanitizedMonitorLine(safeLine, { timestamp: true, noColor: args.noColor, color });
      if (formatted === null) return;
      writeMonitorOutput(`${formatted}\n`, args.redact, (text) => process.stderr.write(text), (text) => saved.push(text));
    },
    savedText: () => saved.join(''),
  };
}

async function main() {
  if (renderVersion(process.argv.slice(2))) return;
  if (process.argv[2] === '--build-info') {
    process.stdout.write(`${JSON.stringify(typeof __BUILD_METADATA__ === 'undefined' ? { packageVersion: packageMetadata.version, builtAt: null, sourceSha256: null, gitCommit: null, gitTag: null, gitDirty: null } : __BUILD_METADATA__, null, 2)}\n`);
    return;
  }
  if (process.argv.includes('--redaction-smoke')) {
    for (const fixtureChunk of standaloneRedactionFixture()) process.stdout.write(fixtureChunk);
    return;
  }
  if (process.argv[2] === '--presentation-smoke') {
    const mode = process.argv[3];
    if (mode !== 'status' && mode !== 'check' && mode !== 'dry-run' && mode !== 'dry-run-match') throw new Error('--presentation-smoke requires status, check, dry-run, or dry-run-match');
    process.stdout.write(standalonePresentationFixture(mode));
    return;
  }
  if (process.argv[2] === '--serial-binding-smoke') {
    const native = (globalThis as typeof globalThis & { __weatherxmSerialPortNativeBinding?: Record<string, unknown> }).__weatherxmSerialPortNativeBinding;
    const requiredApi = ['open', 'close', 'set', 'get', 'getBaudRate', 'update', 'flush', 'drain'];
    const missing = requiredApi.filter((name) => typeof native?.[name] !== 'function');
    if (missing.length) throw new Error(`Embedded SerialPort addon is missing native API: ${missing.join(', ')}`);
    const { SerialPort } = await import('serialport');
    if (typeof SerialPort !== 'function') throw new Error('SerialPort package did not load');
    process.stdout.write(`serial binding loaded; native API verified (${requiredApi.join(', ')})\n`);
    return;
  }
  if (process.argv[2] === '--boot-health-smoke') {
    // Redacted excerpt supplied from the successful physical ota_1 boot. Kept
    // behind an internal validation flag so the actual SEA bundle exercises
    // the same parser without opening a serial port.
    const lines = [
      'I (1954) MAIN: LittleFS mounted successfully.',
      'W (2181) Utils: NVS diagnostics: initial=ESP_OK final=ESP_OK',
      'I (2696) Settings: All configuration keys loaded from NVS.',
      'I (11035) WiFi: Got IP: [REDACTED IP]',
      'Wi-Fi CONNECTED SUCCESSFULLY!',
      'Starting web server on port 80...',
      'I (11054) WebServer: Starting web server on port 80...',
      'I (11116) WiFi: Connected to internet!',
    ];
    process.stdout.write(`${JSON.stringify(analyzeBootLogs(lines), null, 2)}\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') return help(args.helpTarget, args.json || args.noColor);
  if (args.command === 'monitor') { await runMonitor(args); return; }
  if (args.command === 'ota') {
    if (!args.port) throw new Error(`ota ${args.subcommand} requires --port, for example --port /dev/ttyUSB0`);
    const progress = createProgress(args);
    const bootPresenter = ['activate', 'restore'].includes(args.subcommand ?? '') ? createOtaBootPresenter(args) : undefined;
    const cancellation = new AbortController();
    const removeInterrupt = bindAbortOnSigint(process, cancellation);
    try {
      let report: unknown;
      if (args.subcommand === 'status') {
        report = await readOtaStatus({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          verificationMode: args.verifyMode ?? 'fast', progress, signal: cancellation.signal });
        progress.log('OTA STATUS COMPLETE');
      }
      else if (args.subcommand === 'backup') {
        if (!args.outputFile) throw new Error('ota backup requires --output <file>');
        report = await backupOtaMetadata({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          outputPath: args.outputFile, progress, signal: cancellation.signal });
        progress.log('OTA METADATA BACKUP VERIFIED');
      } else if (args.subcommand === 'restore') {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('EMERGENCY OTA RECOVERY BLOCKED: explicit high-risk confirmation requires an interactive terminal');
        report = await restoreOtaMetadata({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          metadataBackupManifest: args.metadataBackupManifest!, progress, signal: cancellation.signal, bootLogSeconds: args.bootLogSeconds,
          onBootLine: bootPresenter!.onLine,
          confirm: async (plan) => {
            const phrase = `RESTORE OTA TARGET ${plan.target} SEQUENCE ${plan.sequence}`;
            return confirmWithSuspendedProgress({ phrase, progress, promptIntro: `High-risk recovery. Type exactly: ${phrase}`,
              acceptedMessage: 'Confirmation accepted.\nBeginning emergency OTA metadata restoration...',
              askPhrase: async (attempt, expected) => { if (attempt > 1) progress.log(`Required confirmation: ${expected}`); const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question('Waiting for confirmation: type the exact phrase and press Enter (or type CANCEL): ', { signal: cancellation.signal }); } finally { rl.close(); } },
              askRetry: async () => { const rl = createInterface({ input: stdin, output: stdout }); try { const v = (await rl.question('1) Retry  2) Cancel [1]: ', { signal: cancellation.signal })).trim(); return v === '' || v === '1' ? 'retry' : 'cancel'; } finally { rl.close(); } },
              onMismatch: (attempt, max) => progress.log(`Confirmation mismatch (${attempt}/${max}); no flash write has started.`),
            });
          } });
        const recovery = report as { bootSelectionVerified: boolean; applicationStarted: boolean; boot: { secureBootVerified: boolean; bootFailureObserved: boolean; captureError?: string | null; lines: string[]; healthDetails: { wifi: { status: string }; mqtt: { status: string }; internet: { status: string }; httpServer: { startup: string; reachable: { status: string } } } } };
        if (args.bootLogOutput) {
          await writeFile(resolvePath(args.bootLogOutput), bootPresenter!.savedText(), { encoding: 'utf8' });
          progress.log(`Boot log saved to ${resolvePath(args.bootLogOutput)}`);
        }
        progress.log(recovery.bootSelectionVerified ? 'RECOVERY BOOT SELECTION VERIFIED' : 'RECOVERY BOOT SELECTION NOT VERIFIED');
        progress.log(recovery.applicationStarted ? 'RECOVERY APPLICATION STARTED' : 'RECOVERY APPLICATION START NOT OBSERVED');
        progress.log(`Optional services: Wi-Fi ${recovery.boot.healthDetails.wifi.status}; HTTP ${recovery.boot.healthDetails.httpServer.startup}; internet ${recovery.boot.healthDetails.internet.status}; MQTT ${recovery.boot.healthDetails.mqtt.status}`);
        if (!recovery.boot.secureBootVerified) progress.log('SECURE BOOT VERIFICATION NOT OBSERVED');
        if (recovery.boot.bootFailureObserved) progress.log('APPLICATION FAILURE OBSERVED IN BOOT LOG');
        if (recovery.boot.captureError) progress.log(recovery.boot.captureError);
        if (!recovery.bootSelectionVerified || !recovery.applicationStarted || !recovery.boot.secureBootVerified || recovery.boot.bootFailureObserved || recovery.boot.captureError) process.exitCode = 1;
      } else if (args.dryRun) {
        report = await dryRunOtaActivation({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          target: args.target as 'ota_0' | 'ota_1', metadataBackupManifest: args.metadataBackupManifest, verificationMode: args.verifyMode ?? 'fast',
          offline: args.offline, cacheDirectory: args.cacheDirectory, progress, signal: cancellation.signal });
        progress.log('ACTIVATION DRY RUN COMPLETE — NO FLASH WRITES PERFORMED');
      } else {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('OTA ACTIVATION BLOCKED: explicit confirmation requires an interactive terminal');
        report = await activateOtaSlot({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          target: args.target as 'ota_0' | 'ota_1', metadataBackupManifest: args.metadataBackupManifest!, progress, signal: cancellation.signal,
          bootLogSeconds: args.bootLogSeconds, verificationMode: args.verifyMode ?? 'fast', offline: args.offline, cacheDirectory: args.cacheDirectory, onBootLine: bootPresenter!.onLine, confirm: async (plan) => {
            const phrase = `ACTIVATE ${plan.target} SEQUENCE ${plan.proposedUpdate.sequence}`;
            return confirmWithSuspendedProgress({ phrase, progress, promptIntro: `Type exactly: ${phrase}`,
              askPhrase: async (attempt, expected) => { if (attempt > 1) progress.log(`Required confirmation: ${expected}`); const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question('Waiting for confirmation: type the exact phrase and press Enter (or type CANCEL): ', { signal: cancellation.signal }); } finally { rl.close(); } },
              askRetry: async () => { const rl = createInterface({ input: stdin, output: stdout }); try { const v = (await rl.question('1) Retry  2) Cancel [1]: ', { signal: cancellation.signal })).trim(); return v === '' || v === '1' ? 'retry' : 'cancel'; } finally { rl.close(); } },
              onMismatch: (attempt, max) => progress.log(`Confirmation mismatch (${attempt}/${max}); no metadata write has started.`),
            });
          } });
        const activation = report as { bootSelectionVerified: boolean; applicationStarted: boolean; boot: { secureBootVerified: boolean; expectedFirmwareObserved: boolean | null; bootFailureObserved: boolean; bootVersion?: string; captureError?: string | null; lines: string[]; healthDetails: { wifi: { status: string }; mqtt: { status: string }; internet: { status: string }; httpServer: { startup: string; reachable: { status: string } } } } };
        if (args.bootLogOutput) {
          await writeFile(resolvePath(args.bootLogOutput), bootPresenter!.savedText(), { encoding: 'utf8' });
          progress.log(`Boot log saved to ${resolvePath(args.bootLogOutput)}`);
        }
        progress.log(activation.bootSelectionVerified ? 'BOOT SELECTION VERIFIED' : 'BOOT SELECTION NOT VERIFIED');
        progress.log(activation.boot.secureBootVerified ? 'SECURE BOOT SIGNATURE VERIFIED BY BOOTLOADER' : 'SECURE BOOT VERIFICATION NOT OBSERVED');
        progress.log(activation.applicationStarted ? 'APPLICATION STARTED' : 'APPLICATION START NOT OBSERVED');
        progress.log(`APPLICATION VERSION ${activation.boot.expectedFirmwareObserved === true ? 'VERIFIED' : activation.boot.expectedFirmwareObserved === false ? 'MISMATCH' : 'NOT OBSERVED'}${activation.boot.bootVersion ? ` (${activation.boot.bootVersion})` : ''}`);
        progress.log(`Optional services: Wi-Fi ${activation.boot.healthDetails.wifi.status}; HTTP ${activation.boot.healthDetails.httpServer.startup}; internet ${activation.boot.healthDetails.internet.status}; MQTT ${activation.boot.healthDetails.mqtt.status}`);
        if (activation.boot.bootFailureObserved) progress.log('APPLICATION FAILURE OBSERVED IN BOOT LOG');
        if (activation.boot.captureError) progress.log(activation.boot.captureError);
        if (!activation.bootSelectionVerified || !activation.applicationStarted || !activation.boot.secureBootVerified ||
            activation.boot.expectedFirmwareObserved !== true || activation.boot.bootFailureObserved || activation.boot.captureError) process.exitCode = 1;
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      const cancelled = cancellation.signal.aborted;
      progress.finish(cancelled ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) process.stdout.write(`${JSON.stringify({ outcome: cancelled ? 'OTA OPERATION CANCELLED' : 'OTA OPERATION FAILED', error: message }, null, 2)}\n`);
      progress.log(`${cancelled ? 'OTA OPERATION CANCELLED' : 'OTA OPERATION FAILED'}: ${message}`);
      process.exitCode = 1;
    } finally { removeInterrupt(); progress.close(); }
    return;
  }
  if (args.command === 'backup') {
    if (!args.port) throw new Error('backup requires --port, for example --port /dev/ttyUSB0');
    if (!args.outputFile) throw new Error('backup inactive requires --output <file>');
    const progress = createProgress(args);
    const cancellation = new AbortController();
    const onInterrupt = () => cancellation.abort();
    process.once('SIGINT', onInterrupt);
    try {
      if (args.subcommand === 'partition') {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('Sensitive partition backup requires an interactive terminal for explicit confirmation');
        const label = args.target!;
        progress.log(`\nSENSITIVE PARTITION BACKUP\nSelected partition: ${label}\nThis full device-specific dump may contain credentials, certificates, NVS data or other secrets. Protect the backup and manifest before sharing. No flash data will be written.`);
        const rl = createInterface({ input: stdin, output: stdout });
        let answer: string;
        try { answer = (await rl.question(`Type BACKUP ${label} to continue: `, { signal: cancellation.signal })).trim(); }
        finally { rl.close(); }
        if (answer !== `BACKUP ${label}`) throw new Error('explicit partition-backup confirmation was not accepted');
        const result = await backupDiscoveredPartition({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, verbose: args.verbose,
          outputPath: args.outputFile, label, progress, signal: cancellation.signal });
        const report = { outcome: 'PARTITION BACKUP VERIFIED', outputPath: args.outputFile, manifestPath: result.manifestPath,
          format: result.manifest.format, createdAt: result.manifest.createdAt, chip: result.manifest.chip,
          partition: result.manifest.partition, bytes: result.manifest.bytes, sha256: result.manifest.sha256,
          sensitive: true, independentReadbackVerified: true, tool: result.manifest.tool };
        if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(`PARTITION BACKUP VERIFIED\nFile: ${args.outputFile}\nManifest: ${result.manifestPath}\nPartition: ${label} @ 0x${result.manifest.partition.offset.toString(16)} (${result.manifest.bytes} bytes)\nSHA-256: ${result.manifest.sha256}\nIndependent readback: MATCH\nSensitive: YES — protect before sharing\n`);
        process.removeListener('SIGINT', onInterrupt); progress.close(); return;
      }
      const result = await backupInactiveOta({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, verbose: args.verbose,
        outputPath: args.outputFile, selection: args.subcommand as 'active' | 'inactive', progress, signal: cancellation.signal });
      const report = { outcome: 'BACKUP VERIFIED', backupFile: args.outputFile, manifestFile: result.manifestPath,
        partition: result.manifest.partition, bytes: result.manifest.bytes, sha256: result.manifest.sha256,
        independentReadbackVerified: result.manifest.independentReadbackVerified,
        firmwareVersion: result.manifest.firmwareVersion, signatureVerification: result.manifest.signatureVerification,
        restorationProven: false };
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`BACKUP VERIFIED\nFile: ${report.backupFile}\nManifest: ${report.manifestFile}\nPartition: ${report.partition.label} @ 0x${report.partition.offset.toString(16)} (${report.bytes} bytes)\nSHA-256: ${report.sha256}\nIndependent readback: ${report.independentReadbackVerified ? 'MATCH' : 'FAILED'}\nFirmware: ${report.firmwareVersion ?? 'UNKNOWN'}\nSignature: ${report.signatureVerification.status} — ${report.signatureVerification.explanation}\nRestore capability: NOT ESTABLISHED\n`);
    } catch (error) {
      progress.finish(cancellation.signal.aborted ? 'cancelled' : 'failed');
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) process.stdout.write(`${JSON.stringify({ outcome: 'BACKUP FAILED', error: message, successfulBackup: false }, null, 2)}\n`);
      else process.stderr.write(`BACKUP FAILED: ${message}\n`);
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', onInterrupt);
    progress.close();
    return;
  }
  if (args.command === 'firmware' && args.subcommand === 'list') {
    const progress = createProgress(args);
    progress.stage('Retrieving and validating official firmware catalog');
    const manifest = await fetchCatalog(args.manifest);
    progress.finish('complete');
    const rows = catalogRows(manifest);
    if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const fw of rows) process.stdout.write(`${fw.key.padEnd(20)} ${fw.label}  ${fw.bytes} bytes  sha256:${fw.sha256}\n`);
    return;
  }
  if (args.command === 'firmware' && args.subcommand === 'download') {
    const progress = createProgress(args);
    try {
      const firmware = await getOfficialFirmware({ key: args.target!, manifestUrl: args.manifest, version: args.firmwareVersion,
        offline: args.offline, cacheDirectory: args.cacheDirectory, progress: (event) => progress.event(event) });
      progress.finish('complete', firmware.reused ? 'verified cache entry reused' : 'downloaded and cryptographically verified');
      const result = { outcome: 'FIRMWARE VERIFIED', name: firmware.entry.name, key: args.target, version: firmware.entry.version,
        expectedSize: firmware.entry.bytes, expectedSha256: firmware.entry.sha256, actualSha256: firmware.verified.sha256,
        cachePath: firmware.cachePath, reused: firmware.reused, descriptor: firmware.descriptor,
        imageFormatValid: firmware.signature.imageFormatValid, imageDigestValid: firmware.signature.imageDigestValid,
        signatureVerified: firmware.signature.signatureValid, deviceSignerTrust: 'NOT CHECKED — requires read-only evidence from a specific gateway' };
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`FIRMWARE VERIFIED\n${result.name} ${result.version}\nSize: ${result.expectedSize} bytes\nSHA-256: ${result.actualSha256}\nImage structure: ${result.imageFormatValid ? 'VALID' : 'INVALID'}\nSecure Boot V2 signature: ${result.signatureVerified ? 'VERIFIED OFFLINE' : 'NOT VERIFIED'}\nDevice signer trust: ${result.deviceSignerTrust}\nCache: ${result.cachePath}${result.reused ? ' (reused)' : ' (saved)'}\n`);
    } catch (error) {
      progress.finish('failed');
      const report = { outcome: 'FIRMWARE DOWNLOAD FAILED', error: error instanceof Error ? error.message : String(error) };
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stderr.write(`${report.outcome}: ${report.error}\n`);
      process.exitCode = 1;
    } finally { progress.close(); }
    return;
  }
  if (args.command === 'firmware' && args.subcommand === 'compare') {
    const progress = createProgress(args);
    try {
      let report;
      if (args.firmwareFile) {
        progress.stage('Comparing backup and firmware image files');
        report = await compareFirmwareFiles(args.backupPath!, args.firmwareFile, args.expectedSha256);
        progress.finish('complete');
      }
      else {
        const firmware = await getOfficialFirmware({ key: args.firmwareKey!, manifestUrl: args.manifest,
          offline: args.offline, cacheDirectory: args.cacheDirectory, progress: (event) => progress.event(event) });
        report = await compareBackupToFirmware(args.backupPath!, firmware, (stage) => progress.event({ stage, detail: 'processing image data' }));
      }
      progress.finish('complete');
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${report.outcome}\nBackup image SHA-256: ${report.backup.imageSha256 ?? 'UNKNOWN'}\nFirmware image SHA-256: ${report.firmware.imageSha256 ?? 'UNKNOWN'}\nSame build identity: ${report.sameBuildIdentity ?? 'UNKNOWN'}\nSigning-key digest match: ${report.sameSigningKeyDigest ?? 'UNKNOWN'}\nBytes compared: ${report.exactBytesCompared}\nTrailing partition bytes: ${report.trailingPartitionBytes ?? 'UNKNOWN'}\n${report.explanation}\n`);
      if (!['EXACT IMAGE MATCH', 'MATCHING BUILD — IMAGE DIFFERENCES', 'DIFFERENT FIRMWARE BUILD'].includes(report.outcome)) process.exitCode = 1;
    } catch (error) {
      progress.finish('failed');
      const report = { outcome: 'COMPARISON INCOMPLETE', error: error instanceof Error ? error.message : String(error) };
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stderr.write(`${report.outcome}: ${report.error}\n`);
      process.exitCode = 1;
    } finally { progress.close(); }
    return;
  }
  if (args.command === 'security') {
    if (!args.port) throw new Error('security requires --port, for example --port /dev/ttyUSB0');
    if (args.subcommand !== undefined && args.subcommand !== 'check') throw new Error('security supports only the optional `check <firmware>` subcommand');
    if (args.subcommand === 'check' && !args.target) throw new Error('security check requires a firmware key: weatherxm or meshtastic');
    if (args.subcommand !== 'check' && args.target) throw new Error('Unexpected extra argument after security command');
    const progress = createProgress(args);
    if (args.subcommand === 'check') {
      const result = await checkFirmwareSecurity({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, verbose: args.verbose,
        firmwareKey: args.target!, manifestUrl: args.manifest, progress, offline: args.offline, cacheDirectory: args.cacheDirectory });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatSecurityResult(result.device, result));
    } else {
      const result = await readDeviceSecurity({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, verbose: args.verbose, progress });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatSecurityResult(result));
    }
    progress.close();
    return;
  }
  if (args.command === 'check') {
    if (!args.subcommand) throw new Error('check requires a firmware key: weatherxm or meshtastic');
    if (!args.port) throw new Error('check requires --port, for example --port /dev/ttyUSB0');
    const progress = createProgress(args);
    const result = await checkFirmware({ portPath: args.port, baudRate: args.baud, firmwareKey: args.subcommand, manifestUrl: args.manifest,
      traceSerial: args.traceSerial, verbose: args.verbose, progress, offline: args.offline, cacheDirectory: args.cacheDirectory });
    progress.close();
    if (args.json) process.stdout.write(serializeFirmwareCheckResult(result));
    else process.stdout.write(formatCheckOutput(result));
    process.exitCode = checkExitCode(result);
    if (args.monitor) await runMonitor(args);
    return;
  }
  if (args.command === 'flash') {
    if (!args.subcommand) throw new Error('flash requires a firmware key; run `wg1200 firmware list`');
    if (!args.port) throw new Error('flash requires --port, for example --port /dev/ttyUSB0');
    const progress = createProgress(args);
    if (args.subcommand === 'diagnose') {
      const result = await diagnoseOtaImage({ portPath: args.port, baudRate: args.baud, targetSlot: args.target as 'ota_0' | 'ota_1',
        traceSerial: args.traceSerial, verbose: args.verbose, progress, offline: args.offline, cacheDirectory: args.cacheDirectory });
      progress.close();
      const relative = result.byteComparison.firstDifference;
      const report = { ...result, byteComparison: { ...result.byteComparison,
        firstDifferenceFlashAddress: relative === null ? null : result.target.offset + relative,
        affectedFlashSectors: result.byteComparison.affectedSectors.map((sector) => result.target.offset / 0x1000 + sector) } };
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${result.outcome}\nTarget: ${result.target.slot} @ 0x${result.target.offset.toString(16)} (${result.target.imageLength} bytes)\nDevice MD5 before/after readback: ${result.deviceMd5.beforeRead} / ${result.deviceMd5.afterRead} (${result.deviceMd5.stable ? 'STABLE' : 'CHANGED'}; ${result.deviceMd5.matchesExpected ? 'MATCH' : 'MISMATCH'})\nPhysical SHA-256: ${result.physicalReadback.sha256} (${result.physicalReadback.matchesExpected ? 'MATCH' : 'MISMATCH'})\nByte comparison: ${result.byteComparison.differingBytes} differing bytes; first difference ${relative === null ? 'none' : `partition +0x${relative.toString(16)} / flash 0x${(result.target.offset + relative).toString(16)}`}\nDifference ranges: ${result.byteComparison.ranges.map((range) => `[+0x${range.start.toString(16)}, +0x${range.end.toString(16)})`).join(', ') || 'none'}\nAffected flash sectors: ${report.byteComparison.affectedFlashSectors.map((sector) => `0x${sector.toString(16)}`).join(', ') || 'none'}\nFlash writes: 0; OTA metadata writes: 0\n`);
      return;
    }
    if (args.stageOnly) {
      const stageAbort = new AbortController();
      const removeStageInterrupt = bindAbortOnSigint(process, stageAbort);
      const selectedVerificationMode: VerificationMode = args.verifyMode ?? 'fast';
      progress.log(`Verification mode: ${selectedVerificationMode.toUpperCase()}. Source SHA-256, Secure Boot signature and signer trust are mandatory. Fast uses device-side MD5 for target and preserved regions; Thorough adds full target SHA-256 readback.`);
      const chooseBackup = async (details: { targetSlot: 'ota_0'; targetOffset: number; targetLength: number; existingFirmware: string | null }) => {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('STAGING BLOCKED — OPERATOR CONFIRMATION REQUIRED: backup choice requires an interactive terminal');
        const defaultPath = join(homedir(), 'wg1200-stage-backups', `ota0-before-stage-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.bin`);
        progress.finish('complete', 'preflight complete; waiting for operator backup selection');
        progress.log(`\nPRE-FLASH BACKUP DECISION\nTarget: ${details.targetSlot} @ 0x${details.targetOffset.toString(16)} (${details.targetLength} bytes)\nExisting firmware to be overwritten: ${details.existingFirmware ?? 'UNKNOWN'}\n1) Create a new full-partition backup (recommended)\n2) Use an existing verified backup${args.backupManifest ? `: ${args.backupManifest}` : ''}\n3) Decline backup (staging will stop; this command currently requires a verified backup)`);
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          const defaultChoice = args.backupManifest ? '2' : '1';
          const selected = (await rl.question(`Choose 1, 2, or 3 [${defaultChoice}]: `, { signal: stageAbort.signal })).trim() || defaultChoice;
          if (selected === '3') return { choice: 'decline' as const };
          if (selected === '1') {
            const outputPath = (await rl.question(`New backup path [${defaultPath}]: `, { signal: stageAbort.signal })).trim() || defaultPath;
            return { choice: 'create' as const, outputPath };
          }
          if (selected === '2') {
            const manifestPath = args.backupManifest || (await rl.question('Existing backup manifest path: ', { signal: stageAbort.signal })).trim();
            if (!manifestPath) return { choice: 'decline' as const };
            return { choice: 'reuse' as const, manifestPath };
          }
          return { choice: 'decline' as const };
        } finally { rl.close(); }
      };
      const confirmStage = async (summary: Parameters<Parameters<typeof stageOnlyFirmware>[0]['confirm']>[0]) => {
        const phrase = stageOnlyConfirmationPhrase(summary);
        progress.finish('complete', 'preflight complete; waiting for explicit write confirmation');
        progress.log(`\nSTAGE-ONLY WRITE PLAN\nBackup freshness mode: ${summary.verificationMode.toUpperCase()}\nProtected-region mode: ${summary.protectedVerificationMode.toUpperCase()} (${summary.protectedVerificationMode === 'fast' ? 'device-side MD5 equality checks; routine accidental-change detection, not cryptographic authentication' : 'complete physical SHA-256 reads'})\nDevice: ${summary.deviceModel} ${summary.deviceName} via ${args.port}\nActive partition: ${summary.activeSlot}; firmware ${summary.activeFirmware ?? 'UNKNOWN'} (preserved)\nInactive partition: ${summary.targetSlot}; existing firmware ${summary.backupFirmwareVersion ?? 'UNKNOWN'} (will be overwritten)\nPartition bound: [0x${summary.targetOffset.toString(16)}, 0x${(summary.targetOffset + summary.targetLength).toString(16)})\nCandidate: WeatherXM ${summary.firmwareVersion}, ${summary.imageBytes} bytes\nCandidate SHA-256: ${summary.firmwareSha256}\nBackup: ${summary.backupFile}\nBackup SHA-256: ${summary.backupSha256}\nBackup image/signature: ${summary.backupFirmwareVersion ?? 'UNKNOWN'} / ${summary.backupSignatureStatus}; restore is not proven\nErase range: [0x${summary.eraseStart.toString(16)}, 0x${summary.eraseEnd.toString(16)})\nFlash encryption enabled: ${summary.flashEncryption}\nPreserved: active ota_1, bootloader, partition table, factory, credentials, NVS, calibration, SPIFFS\nOTA metadata: WILL NOT CHANGE\nAutomatic activation: WILL NOT OCCUR\nRisk: power loss or interrupted transfer may leave ota_0 partially erased or written; no recovery guarantee is implied.\nType exactly: ${phrase}`);
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('STAGING BLOCKED — OPERATOR CONFIRMATION REQUIRED: use an interactive terminal; --yes is not allowed');
        const accepted = await retryExactConfirmation({
          phrase,
          askPhrase: async (attempt, requiredPhrase) => {
            if (attempt > 1) progress.log(`Required full confirmation phrase:\n${requiredPhrase}`);
            const rl = createInterface({ input: stdin, output: stdout });
            try { return await rl.question('Confirm stage-only write (or type CANCEL): ', { signal: stageAbort.signal }); }
            finally { rl.close(); }
          },
          askRetry: async (attempt) => {
            progress.log(`1) Try again\n2) Cancel${attempt === 4 ? '\nThis is the last available retry.' : ''}`);
            const rl = createInterface({ input: stdin, output: stdout });
            try {
              const choice = (await rl.question('Choose [1]: ', { signal: stageAbort.signal })).trim();
              return choice === '' || choice === '1' ? 'retry' : 'cancel';
            } finally { rl.close(); }
          },
          onMismatch: (attempt, maximum) => progress.log(`Confirmation phrase does not match (${attempt}/${maximum}). No flash erase or write has started.${attempt === maximum ? '\nMaximum attempts reached; cancelling without flash changes.' : ''}`),
        });
        if (!accepted) throw new ConfirmationCancelledError();
        return true;
      };
      try {
        const result = await stageOnlyFirmware({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, verbose: args.verbose,
          backupManifestPath: args.backupManifest, chooseBackup, confirm: confirmStage, progress, offline: args.offline, cacheDirectory: args.cacheDirectory, signal: stageAbort.signal,
          verificationMode: selectedVerificationMode });
        if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`${result.outcome}\nVerification mode: ${result.verificationMode.toUpperCase()}\nBackup freshness checks:\n${result.backupFreshnessChecks.map((check) => `  ${check.algorithm} via ${check.method}: MATCH @ 0x${check.address.toString(16)} length ${check.length} (${(check.elapsedMs / 1000).toFixed(1)}s)`).join('\n')}\nUnchanged-region integrity audit:\n${result.protectedRegionChecks.map((check) => `  ${check.name}: ${check.status}${check.status === 'UNCHANGED' ? ` — ${check.algorithm} MATCH` : ''} @ 0x${check.offset.toString(16)} length ${check.length}`).join('\n')}\nFirmware Secure Boot V2 signature and device signer trust: VERIFIED\nFirmware source SHA-256: VERIFIED\nPost-write ESP32 MD5: ${result.actualMd5 === result.expectedMd5 ? 'MATCH' : 'MISMATCH'} (expected ${result.expectedMd5}; actual ${result.actualMd5})\n${result.verificationMode === 'thorough' ? `Independent physical SHA-256 readback: VERIFIED (${result.bytesRead} bytes); actual ${result.actualSha256}` : 'Independent physical SHA-256 readback: NOT RUN (Fast mode)'}\nTarget range: [0x${result.targetRange.start.toString(16)}, 0x${result.targetRange.end.toString(16)})\nErase range: [0x${result.eraseRange.start.toString(16)}, 0x${result.eraseRange.end.toString(16)})\nOTA metadata unchanged: YES\nActive ota_1 unchanged: YES\nAutomatic activation: NO\n`);
      } catch (error) {
        progress.finish('failed');
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof StageOnlyOperationError) {
          const cancelled = error.kind === 'operator_cancelled';
          const noWrite = !error.writeInitiated;
          const outcome = cancelled ? 'STAGING CANCELLED — NO FLASH MODIFICATIONS'
            : error.kind === 'device_reset_failed' ? 'STAGING FAILED — DEVICE RESET FAILED; POWER-CYCLE REQUIRED'
            : error.kind === 'post_write_verification_failed' ? 'STAGING FAILED — POST-WRITE VERIFICATION FAILED'
            : error.writeInitiated ? 'STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN'
            : error.kind === 'operator_declined' ? 'STAGING DECLINED — NO FLASH MODIFICATIONS'
            : 'STAGING BLOCKED — PREFLIGHT FAILED';
          const report = { outcome, error: message, writeInitiated: error.writeInitiated,
            ...(noWrite ? { noFlashModifications: true } : {}), normalBootResetSucceeded: error.normalBootResetSucceeded,
            serialPortReleased: error.serialPortReleased, targetVerification: error.targetVerification ?? null, integrityAudit: error.integrityAudit ?? null,
            otaMetadataModified: false, activation: 'BLOCKED' };
          const resetReport = error.normalBootResetSucceeded === true ? 'Returning gateway to normal boot... DONE'
            : error.normalBootResetSucceeded === false ? 'WARNING: normal boot reset failed; power-cycle the gateway before further use.'
            : 'No ROM connection was opened; reset was not required.';
          const portReport = error.serialPortReleased === true ? 'Serial port released.'
            : error.serialPortReleased === false ? 'WARNING: serial port release failed.' : 'Serial port was not opened.';
          if (!args.json) process.stderr.write(`${cancelled ? 'Stage-only operation cancelled.' : error.kind === 'operator_declined' ? 'Stage-only operation declined.' : 'Stage-only operation failed.'}\n${noWrite ? 'No flash erase or write initiated.' : 'A flash erase/write may have started; OTA activation was not attempted.'}\n${resetReport}\n${portReport}\n${error.targetVerification ? `\nTarget MD5: expected ${error.targetVerification.expectedMd5}; actual ${error.targetVerification.actualMd5 ?? 'UNAVAILABLE'}; ${error.targetVerification.result}\n` : ''}${error.integrityAudit ? `\nINTEGRITY AUDIT\n${error.integrityAudit.map((x) => `  ${x.name}: ${x.status}${x.actualDigest ? ` (${x.algorithm})` : ''} @ 0x${x.offset.toString(16)} length ${x.length}`).join('\n')}\nActivation: BLOCKED\n` : ''}\n${outcome}\n`);
          else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          process.exitCode = 1;
          return;
        }
        const outcome = message.startsWith('STAGING FAILED — PROTECTED') ? 'STAGING FAILED — PROTECTED REGION CHANGED'
          : message.startsWith('STAGING FAILED — VERIFICATION') ? 'STAGING FAILED — VERIFICATION MISMATCH'
          : message.startsWith('STAGING FAILED — TARGET') ? 'STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN'
          : message.startsWith('STAGING BLOCKED — BACKUP REQUIRED') ? 'STAGING BLOCKED — BACKUP DECLINED OR REQUIRED'
          : message.startsWith('STAGING BLOCKED — BACKUP') ? 'STAGING BLOCKED — BACKUP INVALID'
          : message.startsWith('STAGING BLOCKED — OPERATOR') ? 'STAGING BLOCKED — OPERATOR CONFIRMATION REQUIRED'
          : message.startsWith('STAGING BLOCKED') ? 'STAGING BLOCKED — PREFLIGHT FAILED'
          : 'STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN';
        if (args.json) process.stdout.write(`${JSON.stringify({ outcome, error: message, otaMetadataModified: false }, null, 2)}\n`);
        else process.stderr.write(`${message.startsWith(outcome) ? message : `${outcome}: ${message}`}\n`);
        process.exitCode = 1;
      } finally { removeStageInterrupt(); }
      progress.close();
      return;
    }
    const confirm = async (summary: Parameters<Parameters<typeof flashDevice>[0]['confirm']>[0]) => {
      const endOffset = summary.targetOffset + summary.bytes;
      progress.finish('complete', 'preflight complete; waiting for operator confirmation');
      progress.log(`\n${args.dryRun ? 'Firmware dry-run review' : 'Firmware write review'}${summary.recovery ? ' (RECOVERY MODE)' : ''}\nDevice: ${summary.deviceName}\nActive slot: ${summary.activeSlot}\nFirmware: ${summary.firmwareLabel} (${summary.firmwareKey})\nImage descriptor: ${summary.comparison.selected.type} ${summary.comparison.selected.version}; build ${summary.comparison.selected.build}\nInstalled descriptor: ${summary.comparison.installed.type} ${summary.comparison.installed.version}; build ${summary.comparison.installed.build}\nComparison: ${summary.comparison.kind} — ${summary.comparison.message}\nSize: ${summary.bytes} bytes\nSHA-256: ${summary.sha256}\nTarget: ${summary.targetSlot}, byte range [0x${summary.targetOffset.toString(16)}, 0x${endOffset.toString(16)})\nFactory firmware, active slot, credentials, NVS, calibration, and other protected partitions are outside the write range.`);
      if (args.dryRun) return true;
      if (args.yes) return true;
      if (!stdin.isTTY || !stdout.isTTY) throw new Error('No interactive terminal. Review the displayed write and pass --yes to confirm explicitly.');
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const reviewedDevice = args.redact ? '[REDACTED DEVICE ID]' : summary.deviceName;
        const phrase = `FLASH ${reviewedDevice} ${summary.firmwareKey}${summary.recovery ? ' RECOVERY' : ''}`;
        const answer = await rl.question(`Type ${phrase} to continue: `);
        return answer === phrase;
      } finally { rl.close(); }
    };
    const approveComparisonException = async (comparison: import('./upstream/flasher/firmwareComparison.js').FirmwareComparison) => {
      if (args.yes || !stdin.isTTY || !stdout.isTTY) return false;
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const phrase = comparison.kind === 'different-type'
          ? `APPROVE TYPE CHANGE ${comparison.installed.type} TO ${comparison.selected.type}`
          : `APPROVE VERSION ${comparison.selected.version}`;
        progress.finish('complete', 'preflight complete; waiting for comparison approval');
        progress.log(comparison.message);
        return (await rl.question(`This change needs separate approval. Type ${phrase} to continue: `)) === phrase;
      } finally { rl.close(); }
    };
    const result = await flashDevice({ portPath: args.port, baudRate: args.baud, firmwareKey: args.subcommand, manifestUrl: args.manifest,
      recovery: args.recover, force: args.force, dryRun: args.dryRun, traceSerial: args.traceSerial, verbose: args.verbose, confirm, approveComparisonException,
      bootLogSeconds: args.monitor ? 0 : args.bootLogSeconds, onBootLine: (line) => progress.log(`[boot] ${line}`), progress, offline: args.offline, cacheDirectory: args.cacheDirectory });
    progress.close();
    if (result.alreadyInstalled) {
      if (args.json) process.stdout.write(`${JSON.stringify({ alreadyInstalled: true, flashModified: false, comparison: result.comparison }, null, 2)}\n`);
      else process.stdout.write(`${result.comparison.message} No flashing necessary.\n`);
      if (args.monitor) await runMonitor(args);
      return;
    }
    if (result.dryRun) {
      if (args.json) process.stdout.write(`${JSON.stringify({ dryRun: true, installedFirmware: result.comparison.installed, selectedFirmware: result.comparison.selected, firmwareImageSha256: result.sha256, comparison: result.comparison.kind, target: { slot: result.targetSlot, offset: result.targetOffset }, ota: result.ota, firmwareSlots: result.firmwareSlots, inactiveMatch: result.inactiveMatch, writeBlockedReason: result.writeBlockedReason, flashModified: false }, null, 2)}\n`);
      else process.stdout.write(formatDryRunOutput(result));
      if (result.writeBlockedReason) process.stderr.write(`WRITE BLOCKED: ${result.writeBlockedReason}\n`);
      if (args.monitor) await runMonitor(args);
      return;
    }
    let finalResult = result;
    if (args.monitor) {
      const monitorHeader = `POST-FLASH BOOT MONITOR\n${'─'.repeat(46)}\nFlash verification       ${result.flashVerified ? 'PASSED' : 'NOT VERIFIED'}\nOTA metadata             ${result.otaMetadataVerified ? 'VERIFIED' : 'NOT VERIFIED'}\nProtected partitions     ${result.protectedPartitionsVerified ? 'UNCHANGED' : 'NOT VERIFIED'}\nPort                    ${args.port}\nBaud                    ${args.baud}\nMode                    Passive / Receive-only\nStatus                  CONNECTED\n\nListening for firmware startup...\nPress Ctrl+C to stop monitoring.\n`;
      const lines = await runMonitor(args, monitorHeader);
      const boot = analyzeBootLogs(lines, { slotOffset: result.targetOffset, firmwareVersion: result.comparison.selected.version });
      finalResult = { ...result, bootSignature: boot.detectedSign, bootVersion: boot.bootVersion,
        secureBootVerified: boot.secureBootVerified, bootObserved: boot.bootObserved,
        expectedSlotObserved: boot.expectedSlotObserved, expectedFirmwareObserved: boot.expectedFirmwareObserved,
        applicationStarted: boot.applicationStarted, applicationHealthy: boot.applicationHealthy, bootFailureObserved: boot.bootFailureObserved,
        bootFailureLines: boot.bootFailureLines, bootLines: boot.lines, bootHealth: boot.health, bootHealthDetails: boot.healthDetails };
    }
    if (args.json) {
      const { comparison: _comparison, ...flashFields } = finalResult;
      process.stdout.write(`${JSON.stringify({ ...flashFields, comparison: result.comparison.kind }, null, 2)}\n`);
    } else {
      const health = finalResult.bootHealthDetails;
      const optionalHealth = health ? `\nOptional services         Wi-Fi ${health.wifi.status}; HTTP ${health.httpServer.startup}; internet ${health.internet.status}; MQTT ${health.mqtt.status}` : '\nOptional services         NOT OBSERVED';
      process.stdout.write(`FLASH RESULT\n${'─'.repeat(46)}\nFlash verification       ${finalResult.flashVerified ? 'PASSED' : 'NOT VERIFIED'}\nOTA metadata             ${finalResult.otaMetadataVerified ? 'VERIFIED' : 'NOT VERIFIED'}\nProtected partitions     ${finalResult.protectedPartitionsVerified ? 'UNCHANGED' : 'NOT VERIFIED'}\n\nPOST-FLASH BOOT MONITOR\n${'─'.repeat(46)}\nBoot observed            ${finalResult.bootObserved ? 'YES' : 'NOT OBSERVED'}\nExpected OTA slot        ${finalResult.expectedSlotObserved === null ? 'NOT OBSERVED' : finalResult.expectedSlotObserved ? 'YES' : 'NO'}\nExpected firmware        ${finalResult.expectedFirmwareObserved === null ? 'NOT OBSERVED' : finalResult.expectedFirmwareObserved ? 'YES' : 'NO'}\nApplication startup      ${finalResult.applicationStarted ? 'OBSERVED' : 'NOT OBSERVED'}${optionalHealth}\nBoot failure             ${finalResult.bootFailureObserved ? 'OBSERVED' : 'NOT OBSERVED'}${finalResult.bootVersion ? `\nBoot version             ${finalResult.bootVersion}` : ''}\nBoot monitoring complete. Serial port released.\n`);
    }
    return;
  }
  if (!['info', 'verify', 'status'].includes(args.command)) throw new Error(`Unknown command: ${args.command}`);
  if (!args.port) throw new Error(`${args.command} requires --port, for example --port /dev/ttyUSB0`);
  const progress = createProgress(args);
  const inspection = await inspectDevice({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial,
    verbose: args.verbose, progress });
  progress.close();
  const summary = summarizeInspection(inspection);
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else if (args.command === 'status') {
    process.stdout.write(formatStatusOutput(summary));
  } else if (args.command === 'verify') {
    process.stdout.write(`WeatherXM WG1200 — Verification\n${'─'.repeat(36)}\nDevice       ${summary.deviceName ?? summary.hardware}\nChip         ${summary.chip}\nFlash        ${summary.flashBytes} bytes\nPartitions   Exact WG1200 layout\nIdentity     Valid\nResult       VERIFIED\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  if (args.monitor) await runMonitor(args);
}

if (process.argv.includes('--redact')) {
  for (const stream of [process.stdout, process.stderr]) {
    const originalWrite = stream.write.bind(stream);
    (stream as unknown as { write: (...args: any[]) => boolean }).write = (chunk: string | Uint8Array, ...args: any[]) =>
      originalWrite(redactOutput(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), ...args);
  }
}

main().catch((err: unknown) => {
  activeProgress?.finish('failed');
  const message = `wg1200: ${err instanceof Error ? err.message : String(err)}`;
  if (activeProgress) activeProgress.log(message);
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
