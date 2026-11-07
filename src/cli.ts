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
import { finished } from 'node:stream/promises';
import { analyzeBootLogs } from './upstream/flasher/serialLog.js';
import { monitorSerial, type MonitorLevel, writeMonitorOutput } from './monitor.js';
import { formatCheckOutput, formatDryRunOutput, formatStatusOutput, standalonePresentationFixture } from './presentation.js';
import { redactOutput, standaloneRedactionFixture } from './redaction.js';
import { bindAbortOnSigint } from './interrupt.js';
import type { VerificationMode } from './verification.js';
import { ConfirmationCancelledError, retryExactConfirmation } from './verification.js';
import { activateOtaSlot, backupOtaMetadata, dryRunOtaActivation, readOtaStatus, restoreOtaMetadata } from './otaDevice.js';

declare const __BUILD_METADATA__: { packageVersion: string; builtAt: string; sourceSha256: string; gitCommit: string | null; gitTag: string | null; gitDirty: boolean } | undefined;

type Args = { command: string; subcommand?: string; target?: string; firmwareKey?: string; helpTarget?: string; port?: string; baud: number; manifest: string; json: boolean; redact: boolean; verbose: boolean; yes: boolean; recover: boolean; force: boolean; dryRun: boolean; stageOnly: boolean; verifyMode?: VerificationMode; backupManifest?: string; metadataBackupManifest?: string; backupPath?: string; firmwareFile?: string; expectedSha256?: string; firmwareVersion?: string; offline: boolean; cacheDirectory?: string; traceSerial: boolean; monitor: boolean; boot: boolean; timestamp: boolean; level?: MonitorLevel; outputFile?: string; raw: boolean; noColor: boolean; bootLogSeconds: number; };
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
    else if (arg === '--raw') out.raw = true;
    else if (arg === '--no-color') out.noColor = true;
    else if (arg === '--boot-log-seconds') { out.bootLogSeconds = Number(argv[++i]); bootLogProvided = true; }
    else if (arg === '--help' || arg === '-h') helpRequested = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  out.command = helpRequested ? 'help' : positional[0] || 'help';
  if (helpRequested) out.helpTarget = positional[0];
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
    if (manifestProvided && !['firmware', 'check', 'flash', 'security'].includes(out.command)) throw new Error('--manifest is supported only by firmware list, check, flash, and security check');
    if (out.traceSerial && !['info', 'verify', 'status', 'check', 'flash', 'security', 'ota'].includes(out.command)) throw new Error('--trace-serial requires a device command');
    if (out.monitor && !['info', 'verify', 'status', 'check', 'flash'].includes(out.command)) throw new Error('--monitor requires a device operation');
    if (out.boot && out.command !== 'monitor') throw new Error('--boot is supported only by monitor');
    if ((out.timestamp || out.level || out.outputFile || out.raw || out.noColor) && out.command !== 'monitor' && out.command !== 'backup' && !(out.command === 'ota' && out.subcommand === 'backup') && !out.monitor) throw new Error('Monitor formatting options require monitor or --monitor');
    if (out.level && !['error', 'warn', 'info', 'debug', 'verbose'].includes(out.level)) throw new Error('--level must be error, warn, info, debug, or verbose');
    if (!Number.isInteger(out.bootLogSeconds) || out.bootLogSeconds < 0 || out.bootLogSeconds > 3600) throw new Error('--boot-log-seconds must be an integer from 0 to 3600');
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
    if (out.command === 'firmware' && out.subcommand === 'download' && !['weatherxm', 'meshtastic'].includes(out.target ?? '')) throw new Error('firmware download requires weatherxm or meshtastic');
    if (out.command === 'firmware' && out.subcommand === 'compare' && (!out.backupPath || (Boolean(out.firmwareKey) === Boolean(out.firmwareFile)))) throw new Error('firmware compare requires --backup and exactly one of --firmware <key> or --firmware-file <path>');
    if (out.outputFile && out.command !== 'backup' && !(out.command === 'ota' && out.subcommand === 'backup') && out.command !== 'monitor' && !out.monitor) throw new Error('--output is supported by backup or monitor');
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

function help(command?: string, plain = false) {
  const tty = !plain && Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code: string, value: string) => tty ? `\u001b[${code}m${value}\u001b[0m` : value;
  const heading = (value: string) => paint('1;36', value);
  const commandRow = (name: string, description: string) => stdout.columns && stdout.columns < 58
    ? `  ${paint('1', name)}\n      ${description}\n`
    : `  ${paint('1', name.padEnd(28))}${description}\n`;
  const name = 'wg1200';
  if (command) {
    const details: Record<string, string> = {
      info: `USAGE\n  ${name} info --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nShows device identity, chip, flash layout and firmware descriptors. Enters ROM loader and resets the gateway. --monitor reopens a passive serial reader after inspection.`,
      verify: `USAGE\n  ${name} verify --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nValidates WG1200 identity, exact partition layout, partition-table MD5, credentials and OTA metadata. Read-only; resets the gateway.`,
      status: `USAGE\n  ${name} status --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nShows active firmware and OTA boot state. Read-only; resets the gateway.`,
      check: `USAGE\n  ${name} check <weatherxm|meshtastic> --port <path> [--baud <rate>] [--manifest <url>] [--json] [--redact] [--trace-serial] [--monitor]\n\nDownloads and validates the selected image, then compares its descriptor with the installed firmware. Never writes flash. All check outcomes exit 0; operational failures exit nonzero.`,
      monitor: `USAGE\n  ${name} monitor --port <path> [--baud <rate>] [--boot] [--redact] [--timestamp] [--level <severity>] [--output <file>] [--raw] [--no-color]\n\nWithout --boot, receives serial output in receive-only mode without toggling DTR/RTS. --boot installs the receive handler, then uses RTS to pulse EN while DTR keeps GPIO0 released for normal application boot. The serial connection remains open. Ctrl+C closes it.`,
      ota: `USAGE\n  ${name} ota status --port <path> [--verify-mode fast|thorough] [--json] [--redact]\n  ${name} ota backup --port <path> --output <file> [--json]\n  ${name} ota activate --target <ota_0|ota_1> --port <path> --metadata-backup-manifest <path> [--verify-mode fast|thorough] [--dry-run] [--json] [--redact]\n  ${name} ota restore --port <path> --metadata-backup-manifest <path> [--json] [--redact]\n\nActivation defaults to Fast: it authenticates the pinned official source image, then compares its exact image-length MD5 with both the target and selected recovery slot. Thorough additionally reads both full OTA partitions and verifies physical image SHA-256 and signatures. Unknown host signer trust is qualified only when the verified selected recovery slot and current device-bound metadata backup match; explicit invalid, revoked, untrusted, or incompatible results block. A transaction-specific interactive confirmation is required before writing one 4 KiB metadata sector. Bootloader Secure Boot and selected offset are reported separately after reset; metadata update alone is not boot success. Emergency restore verifies a historic device-bound backup and recovery app, then writes one new VALID selection record while preserving its peer sector. Create a fresh metadata backup before each activation.`,
      backup: `USAGE\n  ${name} backup <active|inactive> --port <path> --output <file> [--baud <rate>] [--json] [--redact] [--verbose]\n  ${name} backup partition <name> --port <path> --output <file> [--baud <rate>] [--json] [--redact] [--verbose]\n\nPartition backups support only exact discovered WG1200 allowlisted partitions. Full dumps may contain credentials, certificates or device-specific data; protect both file and manifest before sharing. Files use restrictive permissions, are independently SHA-256 verified and are never overwritten. These dumps are separate from ordinary OTA application backups and do not establish restore capability.`,
      firmware: `USAGE\n  ${name} firmware list [--manifest <url>] [--json] [--redact]\n  ${name} firmware download <weatherxm|meshtastic> [--version <version>] [--offline] [--json] [--verbose]\n  ${name} firmware compare --backup <path> (--firmware <key>|--firmware-file <path>) [--json]\n\nDownloads complete official images into ~/.cache/weatherxm-flash/firmware/ after hash, descriptor and Secure Boot V2 signature validation. Firmware comparison verifies the full-partition backup manifest and compares parsed application image bytes.`,
      security: `USAGE\n  ${name} security --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial]\n  ${name} security check <firmware> --port <path> [--baud <rate>] [--manifest <url>] [--json] [--redact] [--trace-serial]\n\nReads ESP32-S3 Secure Boot V2 eFuse state, or verifies a candidate image and compares it with readable device trust state. Read-only; enters the ROM loader and resets the gateway. Anti-rollback enforcement and app health are reported separately.`,
      flash: `USAGE\n  ${name} flash weatherxm --port <path> --stage-only [--verify-mode fast|thorough] [--backup-manifest <path>]\n  ${name} flash diagnose --target <ota_0|ota_1> --port <path> [--offline] [--json]\n\nNormal firmware installation remains blocked. Stage-only supports official WeatherXM 0.8.34 into ota_0 while ota_1 is live. Fast is the default: it verifies the target with device-side MD5 and audits preserved regions with MD5. Thorough adds full target SHA-256 readback and full protected-region SHA-256 checks. Both modes retain mandatory source SHA-256, Secure Boot V2 trust, backup validation and unchanged OTA metadata checks. A failed target check blocks activation, audits unchanged regions where possible, and never retries or rewrites automatically. flash diagnose is read-only: it repeats on-chip MD5, reads the selected signed image bytes, compares SHA-256 and reports differing byte offsets/sectors without writing. Confirmation permits five exact-phrase attempts with retry or cancel; no write begins without the complete phrase.`,
    };
    const detail = details[command];
    if (!detail) return process.stdout.write(`No command help is available for '${command}'. Run '${name} --help'.\n`);
    return process.stdout.write(`${heading(`WeatherXM WG1200 Flasher v${packageMetadata.version}`)}\n\n${detail}\n`);
  }
  let output = `${heading(`WeatherXM WG1200 Flasher                          v${packageMetadata.version}`)}\nSafe firmware management for WeatherXM gateways\n\n`;
  output += `${heading('USAGE')}\n  ${name} <command> [options]\n\n${heading('DEVICE COMMANDS')}\n`;
  output += commandRow('info', 'Show device and hardware information');
  output += commandRow('verify', 'Validate device identity and partitions');
  output += commandRow('status', 'Show firmware and OTA boot state');
  output += commandRow('ota status|backup|activate', 'Fast OTA status by default; thorough image verification is optional; activation is blocked and dry-run only');
  output += commandRow('check <firmware>', 'Check available firmware; read-only');
  output += commandRow('monitor', 'Passively stream serial console output');
  output += commandRow('backup active|inactive', 'Stream and verify a complete OTA application partition');
  output += commandRow('backup partition <name>', 'Save and verify a sensitive full partition dump');
  output += commandRow('security', 'Read Secure Boot V2 and firmware trust evidence');
  output += `\n${heading('FIRMWARE COMMANDS')}\n`;
  output += commandRow('firmware list', 'List available firmware releases');
  output += commandRow('firmware download', 'Download and verify an official image into the local cache');
  output += commandRow('firmware compare', 'Compare a backup with a verified firmware image offline');
  output += commandRow('flash <firmware>', 'Install to the inactive OTA slot');
  output += `\n${heading('MONITOR OPTIONS (monitor or --monitor)')}\n  --monitor           Continue passive monitoring after an operation\n  --boot              Reset via RTS/EN and capture startup from boot\n  --timestamp         Prefix received messages with host time\n  --level <severity>  Filter: error, warn, info, debug, verbose\n  --output <file>     Append received messages to a file\n  --raw               Print sanitized received lines without decoration\n  --no-color          Disable monitor colors\n\n`;
  output += `\n${heading('DEVICE OPTIONS (info, verify, status, check, flash, security)')}\n  --port <path>       Serial device path\n  --baud <rate>       Baud rate (default: 115200)\n  --trace-serial      Enable redacted serial diagnostics\n\n${heading('OUTPUT AND CATALOG OPTIONS')}\n  --json              Machine-readable output where supported\n  --manifest <url>    HTTPS manifest (list, check, flash, security check)\n  -h, --help          Show help\n\n${heading('FLASH OPTIONS')}\n  --dry-run           Validate and compare without writing\n  --verify-mode       Stage-only backup freshness: fast (default) or thorough\n  --force             Reinstall only an identical firmware build\n  --recover           Authorize targeted ambiguous-OTA recovery\n  --yes               Confirm the reviewed write (not version exceptions)\n  --boot-log-seconds  Boot capture duration (default: 15; 0 disables)\n\n${heading('EXAMPLES')}\n  ${name} info --port /dev/cu.usbserial-13210\n  ${name} monitor --port /dev/cu.usbserial-13210\n  ${name} check weatherxm --port /dev/cu.usbserial-13210 --monitor\n  ${name} security --port /dev/cu.usbserial-13210 --json\n  ${name} security check weatherxm --port /dev/cu.usbserial-13210\n  ${name} flash weatherxm --port /dev/cu.usbserial-13210 --dry-run\n\n${heading('SAFETY')}\n  Normal OTA installation is blocked; stage-only has fixed target and preflight.\n  Security commands read device eFuses and never program them.\n  Device inspection enters the ROM loader and resets the gateway.\n\nRun '${name} <command> --help' for command details.\n`;
  output = output.replace('  -h, --help          Show help', '  -v, --version       Show application version; add --verbose for build details\n  -h, --help          Show help');
  output = output.replace('  --manifest <url>', '  --redact            Mask device and certificate identifiers in output\n  --verbose           Show coordinated ROM and transport diagnostics\n  --manifest <url>');
  output = output.replace('  --boot-log-seconds  ', '  --stage-only        Write official 0.8.34 to ota_0 without activation\n  --backup-manifest   Require a verified inactive-slot backup\n  --boot-log-seconds  ');
  process.stdout.write(output);
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
  const color = Boolean(target.isTTY) && !args.noColor && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  try {
    const lines = await monitorSerial({
      portPath: args.port, baudRate: args.baud, boot: args.boot, redact: args.redact, timestamp: args.timestamp, level: args.level,
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
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') return help(args.helpTarget, args.json);
  if (args.command === 'monitor') { await runMonitor(args); return; }
  if (args.command === 'ota') {
    if (!args.port) throw new Error(`ota ${args.subcommand} requires --port, for example --port /dev/ttyUSB0`);
    const progress = createProgress(args);
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
          confirm: async (plan) => {
            const phrase = `RESTORE OTA TARGET ${plan.target} SEQUENCE ${plan.sequence}`;
            progress.log(`High-risk recovery. Type exactly: ${phrase}`);
            return retryExactConfirmation({ phrase,
              askPhrase: async (attempt, expected) => { if (attempt > 1) progress.log(`Required confirmation: ${expected}`); const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question('Confirm emergency metadata recovery (or type CANCEL): ', { signal: cancellation.signal }); } finally { rl.close(); } },
              askRetry: async () => { const rl = createInterface({ input: stdin, output: stdout }); try { const v = (await rl.question('1) Retry  2) Cancel [1]: ', { signal: cancellation.signal })).trim(); return v === '' || v === '1' ? 'retry' : 'cancel'; } finally { rl.close(); } },
              onMismatch: (attempt, max) => progress.log(`Confirmation mismatch (${attempt}/${max}); no flash write has started.`),
            });
          } });
        const recovery = report as { bootSelectionVerified: boolean; applicationStarted: boolean };
        progress.log(recovery.bootSelectionVerified ? 'RECOVERY BOOT SELECTION VERIFIED' : 'RECOVERY BOOT SELECTION NOT VERIFIED');
        progress.log(recovery.applicationStarted ? 'RECOVERY APPLICATION STARTED' : 'RECOVERY APPLICATION START NOT OBSERVED');
        if (!recovery.bootSelectionVerified || !recovery.applicationStarted) process.exitCode = 1;
      } else if (args.dryRun) {
        report = await dryRunOtaActivation({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          target: args.target as 'ota_0' | 'ota_1', metadataBackupManifest: args.metadataBackupManifest, verificationMode: args.verifyMode ?? 'fast',
          offline: args.offline, cacheDirectory: args.cacheDirectory, progress, signal: cancellation.signal });
        progress.log('ACTIVATION DRY RUN COMPLETE — NO FLASH WRITES PERFORMED');
      } else {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('OTA ACTIVATION BLOCKED: explicit confirmation requires an interactive terminal');
        report = await activateOtaSlot({ portPath: args.port, baudRate: args.baud, verbose: args.verbose, traceSerial: args.traceSerial,
          target: args.target as 'ota_0' | 'ota_1', metadataBackupManifest: args.metadataBackupManifest!, progress, signal: cancellation.signal,
          bootLogSeconds: args.bootLogSeconds, verificationMode: args.verifyMode ?? 'fast', offline: args.offline, cacheDirectory: args.cacheDirectory, confirm: async (plan) => {
            const phrase = `ACTIVATE ${plan.target} SEQUENCE ${plan.proposedUpdate.sequence}`;
            progress.log(`Type exactly: ${phrase}`);
            return retryExactConfirmation({ phrase,
              askPhrase: async (attempt, expected) => { if (attempt > 1) progress.log(`Required confirmation: ${expected}`); const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question('Confirm OTA metadata update (or type CANCEL): ', { signal: cancellation.signal }); } finally { rl.close(); } },
              askRetry: async () => { const rl = createInterface({ input: stdin, output: stdout }); try { const v = (await rl.question('1) Retry  2) Cancel [1]: ', { signal: cancellation.signal })).trim(); return v === '' || v === '1' ? 'retry' : 'cancel'; } finally { rl.close(); } },
              onMismatch: (attempt, max) => progress.log(`Confirmation mismatch (${attempt}/${max}); no metadata write has started.`),
            });
          } });
        const activation = report as { bootSelectionVerified: boolean; applicationStarted: boolean; boot: { secureBootVerified: boolean } };
        progress.log(activation.bootSelectionVerified ? 'BOOT SELECTION VERIFIED' : 'BOOT SELECTION NOT VERIFIED');
        progress.log(activation.boot.secureBootVerified ? 'SECURE BOOT SIGNATURE VERIFIED BY BOOTLOADER' : 'SECURE BOOT VERIFICATION NOT OBSERVED');
        progress.log(activation.applicationStarted ? 'APPLICATION STARTED' : 'APPLICATION START NOT OBSERVED');
        if (!activation.bootSelectionVerified || !activation.applicationStarted || !activation.boot.secureBootVerified) process.exitCode = 1;
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
        bootFailureLines: boot.bootFailureLines, bootLines: boot.lines };
    }
    if (args.json) {
      const { comparison: _comparison, ...flashFields } = finalResult;
      process.stdout.write(`${JSON.stringify({ ...flashFields, comparison: result.comparison.kind }, null, 2)}\n`);
    } else {
      process.stdout.write(`FLASH RESULT\n${'─'.repeat(46)}\nFlash verification       ${finalResult.flashVerified ? 'PASSED' : 'NOT VERIFIED'}\nOTA metadata             ${finalResult.otaMetadataVerified ? 'VERIFIED' : 'NOT VERIFIED'}\nProtected partitions     ${finalResult.protectedPartitionsVerified ? 'UNCHANGED' : 'NOT VERIFIED'}\n\nPOST-FLASH BOOT MONITOR\n${'─'.repeat(46)}\nBoot observed            ${finalResult.bootObserved ? 'YES' : 'NOT OBSERVED'}\nExpected OTA slot        ${finalResult.expectedSlotObserved === null ? 'NOT OBSERVED' : finalResult.expectedSlotObserved ? 'YES' : 'NO'}\nExpected firmware        ${finalResult.expectedFirmwareObserved === null ? 'NOT OBSERVED' : finalResult.expectedFirmwareObserved ? 'YES' : 'NO'}\nApplication startup      ${finalResult.applicationStarted ? 'OBSERVED' : 'NOT OBSERVED'}\nApplication health       NOT CHECKED\nBoot failure             ${finalResult.bootFailureObserved ? 'OBSERVED' : 'NOT OBSERVED'}${finalResult.bootVersion ? `\nBoot version             ${finalResult.bootVersion}` : ''}\nBoot monitoring complete. Serial port released.\n`);
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
