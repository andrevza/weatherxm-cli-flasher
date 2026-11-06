#!/usr/bin/env node
import { backupInactiveOta, checkExitCode, checkFirmware, checkFirmwareSecurity, flashDevice, inspectDevice, readDeviceSecurity, serializeFirmwareCheckResult, stageOnlyFirmware, summarizeInspection } from './device.js';
import { catalogRows, DEFAULT_MANIFEST_URL, fetchCatalog } from './catalog.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import packageMetadata from '../package.json';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { analyzeBootLogs } from './upstream/flasher/serialLog.js';
import { monitorSerial, type MonitorLevel, writeMonitorOutput } from './monitor.js';
import { formatCheckOutput, formatDryRunOutput, formatStatusOutput, standalonePresentationFixture } from './presentation.js';
import { redactOutput, standaloneRedactionFixture } from './redaction.js';

declare const __BUILD_METADATA__: { packageVersion: string; builtAt: string; sourceSha256: string; gitCommit: string | null; gitTag: string | null; gitDirty: boolean } | undefined;

type Args = { command: string; subcommand?: string; target?: string; helpTarget?: string; port?: string; baud: number; manifest: string; json: boolean; redact: boolean; yes: boolean; recover: boolean; force: boolean; dryRun: boolean; stageOnly: boolean; backupManifest?: string; traceSerial: boolean; monitor: boolean; boot: boolean; timestamp: boolean; level?: MonitorLevel; outputFile?: string; raw: boolean; noColor: boolean; bootLogSeconds: number; };
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
  const out: Args = { command: '', baud: 115200, manifest: DEFAULT_MANIFEST_URL, json: false, redact: false, yes: false, recover: false, force: false, dryRun: false, stageOnly: false, traceSerial: false, monitor: false, boot: false, timestamp: false, raw: false, noColor: false, bootLogSeconds: 15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = argv[++i];
    else if (arg === '--baud') out.baud = Number(argv[++i]);
    else if (arg === '--manifest') { out.manifest = argv[++i]; manifestProvided = true; }
    else if (arg === '--json') out.json = true;
    else if (arg === '--redact') out.redact = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--recover') out.recover = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--stage-only') out.stageOnly = true;
    else if (arg === '--backup-manifest') out.backupManifest = argv[++i];
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
  out.target = positional[2];
  if (!Number.isInteger(out.baud) || out.baud < 1200 || out.baud > 2000000) throw new Error('Baud rate must be an integer from 1200 to 2000000');
  if (!helpRequested) {
    if (out.force && out.command !== 'flash') throw new Error('--force is supported only by flash');
    if (out.dryRun && out.command !== 'flash') throw new Error('--dry-run is supported only by flash');
    if (out.stageOnly && out.command !== 'flash') throw new Error('--stage-only is supported only by flash');
    if (out.backupManifest && out.command !== 'flash') throw new Error('--backup-manifest is supported only by flash --stage-only');
    if ((out.yes || out.recover) && out.command !== 'flash') throw new Error('--yes and --recover are supported only by flash');
    if (manifestProvided && !['firmware', 'check', 'flash', 'security'].includes(out.command)) throw new Error('--manifest is supported only by firmware list, check, flash, and security check');
    if (out.traceSerial && !['info', 'verify', 'status', 'check', 'flash', 'security'].includes(out.command)) throw new Error('--trace-serial requires a device command');
    if (out.monitor && !['info', 'verify', 'status', 'check', 'flash'].includes(out.command)) throw new Error('--monitor requires a device operation');
    if (out.boot && out.command !== 'monitor') throw new Error('--boot is supported only by monitor');
    if ((out.timestamp || out.level || out.outputFile || out.raw || out.noColor) && out.command !== 'monitor' && out.command !== 'backup' && !out.monitor) throw new Error('Monitor formatting options require monitor or --monitor');
    if (out.level && !['error', 'warn', 'info', 'debug', 'verbose'].includes(out.level)) throw new Error('--level must be error, warn, info, debug, or verbose');
    if (!Number.isInteger(out.bootLogSeconds) || out.bootLogSeconds < 0 || out.bootLogSeconds > 3600) throw new Error('--boot-log-seconds must be an integer from 0 to 3600');
    if (bootLogProvided && out.command !== 'flash') throw new Error('--boot-log-seconds is supported only by flash');
    if (out.stageOnly && (!out.backupManifest || out.subcommand !== 'weatherxm' || out.yes || out.force || out.recover || out.dryRun || out.monitor)) {
      throw new Error('--stage-only requires flash weatherxm --backup-manifest <path> and interactive confirmation; --yes, --force, --recover, --dry-run, and --monitor are not permitted');
    }
    if (out.stageOnly && manifestProvided && out.manifest !== DEFAULT_MANIFEST_URL) throw new Error('--stage-only accepts only the pinned official WeatherXM firmware manifest');
    if (out.backupManifest && !out.stageOnly) throw new Error('--backup-manifest requires --stage-only');
    if (out.command === 'backup' && (out.subcommand !== 'inactive' || !out.outputFile || out.yes || out.force || out.recover || out.dryRun || out.stageOnly || out.monitor || out.timestamp || out.level || out.raw || out.noColor)) {
      throw new Error('backup requires `backup inactive --port <path> --output <file>`; it never overwrites existing files');
    }
    if (out.outputFile && out.command !== 'backup' && out.command !== 'monitor' && !out.monitor) throw new Error('--output is supported by backup or monitor');
    if (out.command === 'monitor' && out.json) throw new Error('--json is not supported by the continuous monitor command');
  }
  return out;
}

function help(command?: string, plain = false) {
  const tty = !plain && Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code: string, value: string) => tty ? `\u001b[${code}m${value}\u001b[0m` : value;
  const heading = (value: string) => paint('1;36', value);
  const commandRow = (name: string, description: string) => stdout.columns && stdout.columns < 58
    ? `  ${paint('1', name)}\n      ${description}\n`
    : `  ${paint('1', name.padEnd(22))}${description}\n`;
  const name = 'wg1200';
  if (command) {
    const details: Record<string, string> = {
      info: `USAGE\n  ${name} info --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nShows device identity, chip, flash layout and firmware descriptors. Enters ROM loader and resets the gateway. --monitor reopens a passive serial reader after inspection.`,
      verify: `USAGE\n  ${name} verify --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nValidates WG1200 identity, exact partition layout, partition-table MD5, credentials and OTA metadata. Read-only; resets the gateway.`,
      status: `USAGE\n  ${name} status --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial] [--monitor]\n\nShows active firmware and OTA boot state. Read-only; resets the gateway.`,
      check: `USAGE\n  ${name} check <weatherxm|meshtastic> --port <path> [--baud <rate>] [--manifest <url>] [--json] [--redact] [--trace-serial] [--monitor]\n\nDownloads and validates the selected image, then compares its descriptor with the installed firmware. Never writes flash. All check outcomes exit 0; operational failures exit nonzero.`,
      monitor: `USAGE\n  ${name} monitor --port <path> [--baud <rate>] [--boot] [--redact] [--timestamp] [--level <severity>] [--output <file>] [--raw] [--no-color]\n\nWithout --boot, receives serial output in receive-only mode without toggling DTR/RTS. --boot installs the receive handler, then uses RTS to pulse EN while DTR keeps GPIO0 released for normal application boot. The serial connection remains open. Ctrl+C closes it.`,
      backup: `USAGE\n  ${name} backup inactive --port <path> --output <file> [--baud <rate>] [--json] [--redact]\n\nStreams the exact inactive OTA partition to a new file and writes <file>.manifest.json. Existing files are never overwritten. Reads no credential partitions. A backup is not a proven restore path.`,
      firmware: `USAGE\n  ${name} firmware list [--manifest <url>] [--json] [--redact]\n\nLists validated firmware releases from the official HTTPS manifest.`,
      security: `USAGE\n  ${name} security --port <path> [--baud <rate>] [--json] [--redact] [--trace-serial]\n  ${name} security check <firmware> --port <path> [--baud <rate>] [--manifest <url>] [--json] [--redact] [--trace-serial]\n\nReads ESP32-S3 Secure Boot V2 eFuse state, or verifies a candidate image and compares it with readable device trust state. Read-only; enters the ROM loader and resets the gateway. Anti-rollback enforcement and app health are reported separately.`,
      flash: `USAGE\n  ${name} flash <firmware> --port <path> [--stage-only --backup-manifest <path>] [other guarded options]\n\nNormal firmware installation remains blocked. The dedicated --stage-only path supports only official WeatherXM 0.8.34 into ota_0 while ota_1 is live, requires a verified inactive-slot backup manifest and an interactive confirmation, then verifies hardware MD5, streamed SHA-256, protected regions and unchanged OTA metadata. It never activates the staged image. --yes, --force, --recover, --dry-run and --monitor cannot be combined with --stage-only.`,
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
  output += commandRow('check <firmware>', 'Check available firmware; read-only');
  output += commandRow('monitor', 'Passively stream serial console output');
  output += commandRow('backup inactive', 'Stream and verify the complete inactive OTA partition');
  output += commandRow('security', 'Read Secure Boot V2 and firmware trust evidence');
  output += `\n${heading('FIRMWARE COMMANDS')}\n`;
  output += commandRow('firmware list', 'List available firmware releases');
  output += commandRow('flash <firmware>', 'Install to the inactive OTA slot');
  output += `\n${heading('MONITOR OPTIONS (monitor or --monitor)')}\n  --monitor           Continue passive monitoring after an operation\n  --boot              Reset via RTS/EN and capture startup from boot\n  --timestamp         Prefix received messages with host time\n  --level <severity>  Filter: error, warn, info, debug, verbose\n  --output <file>     Append received messages to a file\n  --raw               Print sanitized received lines without decoration\n  --no-color          Disable monitor colors\n\n`;
  output += `\n${heading('DEVICE OPTIONS (info, verify, status, check, flash, security)')}\n  --port <path>       Serial device path\n  --baud <rate>       Baud rate (default: 115200)\n  --trace-serial      Enable redacted serial diagnostics\n\n${heading('OUTPUT AND CATALOG OPTIONS')}\n  --json              Machine-readable output where supported\n  --manifest <url>    HTTPS manifest (list, check, flash, security check)\n  -h, --help          Show help\n\n${heading('FLASH OPTIONS')}\n  --dry-run           Validate and compare without writing\n  --force             Reinstall only an identical firmware build\n  --recover           Authorize targeted ambiguous-OTA recovery\n  --yes               Confirm the reviewed write (not version exceptions)\n  --boot-log-seconds  Boot capture duration (default: 15; 0 disables)\n\n${heading('EXAMPLES')}\n  ${name} info --port /dev/cu.usbserial-13210\n  ${name} monitor --port /dev/cu.usbserial-13210\n  ${name} check weatherxm --port /dev/cu.usbserial-13210 --monitor\n  ${name} security --port /dev/cu.usbserial-13210 --json\n  ${name} security check weatherxm --port /dev/cu.usbserial-13210\n  ${name} flash weatherxm --port /dev/cu.usbserial-13210 --dry-run\n\n${heading('SAFETY')}\n  Normal OTA installation is blocked; stage-only has fixed target and preflight.\n  Security commands read device eFuses and never program them.\n  Device inspection enters the ROM loader and resets the gateway.\n\nRun '${name} <command> --help' for command details.\n`;
  output = output.replace('  -h, --help          Show help', '  -v, --version       Show application version; add --verbose for build details\n  -h, --help          Show help');
  output = output.replace('  --manifest <url>', '  --redact            Mask device and certificate identifiers in output\n  --manifest <url>');
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
  if (args.command === 'backup') {
    if (!args.port) throw new Error('backup requires --port, for example --port /dev/ttyUSB0');
    if (!args.outputFile) throw new Error('backup inactive requires --output <file>');
    try {
      const result = await backupInactiveOta({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial, outputPath: args.outputFile });
      const report = { outcome: 'BACKUP VERIFIED', backupFile: args.outputFile, manifestFile: result.manifestPath,
        partition: result.manifest.partition, bytes: result.manifest.bytes, sha256: result.manifest.sha256,
        independentReadbackVerified: result.manifest.independentReadbackVerified,
        firmwareVersion: result.manifest.firmwareVersion, signatureVerification: result.manifest.signatureVerification,
        restorationProven: false };
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`BACKUP VERIFIED\nFile: ${report.backupFile}\nManifest: ${report.manifestFile}\nPartition: ${report.partition.label} @ 0x${report.partition.offset.toString(16)} (${report.bytes} bytes)\nSHA-256: ${report.sha256}\nIndependent readback: ${report.independentReadbackVerified ? 'MATCH' : 'FAILED'}\nFirmware: ${report.firmwareVersion ?? 'UNKNOWN'}\nSignature: ${report.signatureVerification.status} — ${report.signatureVerification.explanation}\nRestore capability: NOT ESTABLISHED\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) process.stdout.write(`${JSON.stringify({ outcome: 'BACKUP FAILED', error: message, successfulBackup: false }, null, 2)}\n`);
      else process.stderr.write(`BACKUP FAILED: ${message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.command === 'firmware' && args.subcommand === 'list') {
    const manifest = await fetchCatalog(args.manifest);
    const rows = catalogRows(manifest);
    if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const fw of rows) process.stdout.write(`${fw.key.padEnd(20)} ${fw.label}  ${fw.bytes} bytes  sha256:${fw.sha256}\n`);
    return;
  }
  if (args.command === 'security') {
    if (!args.port) throw new Error('security requires --port, for example --port /dev/ttyUSB0');
    if (args.subcommand !== undefined && args.subcommand !== 'check') throw new Error('security supports only the optional `check <firmware>` subcommand');
    if (args.subcommand === 'check' && !args.target) throw new Error('security check requires a firmware key: weatherxm or meshtastic');
    if (args.subcommand !== 'check' && args.target) throw new Error('Unexpected extra argument after security command');
    if (args.subcommand === 'check') {
      const result = await checkFirmwareSecurity({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial,
        firmwareKey: args.target!, manifestUrl: args.manifest });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatSecurityResult(result.device, result));
    } else {
      const result = await readDeviceSecurity({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatSecurityResult(result));
    }
    return;
  }
  if (args.command === 'check') {
    if (!args.subcommand) throw new Error('check requires a firmware key: weatherxm or meshtastic');
    if (!args.port) throw new Error('check requires --port, for example --port /dev/ttyUSB0');
    const result = await checkFirmware({ portPath: args.port, baudRate: args.baud, firmwareKey: args.subcommand, manifestUrl: args.manifest, traceSerial: args.traceSerial });
    if (args.json) process.stdout.write(serializeFirmwareCheckResult(result));
    else process.stdout.write(formatCheckOutput(result));
    process.exitCode = checkExitCode(result);
    if (args.monitor) await runMonitor(args);
    return;
  }
  if (args.command === 'flash') {
    if (!args.subcommand) throw new Error('flash requires a firmware key; run `wg1200 firmware list`');
    if (!args.port) throw new Error('flash requires --port, for example --port /dev/ttyUSB0');
    if (args.stageOnly) {
      const confirmStage = async (summary: Parameters<Parameters<typeof stageOnlyFirmware>[0]['confirm']>[0]) => {
        const reviewedDevice = args.redact ? '[REDACTED DEVICE ID]' : summary.deviceName;
        const phrase = `STAGE ${reviewedDevice} ota_0 WeatherXM 0.8.34 ${summary.firmwareSha256}`;
        process.stderr.write(`\nSTAGE-ONLY WRITE PLAN\nDevice: ${summary.deviceModel} ${summary.deviceName} via ${args.port}\nActive partition: ${summary.activeSlot}; firmware ${summary.activeFirmware ?? 'UNKNOWN'} (preserved)\nInactive partition: ${summary.targetSlot}; existing firmware ${summary.backupFirmwareVersion ?? 'UNKNOWN'} (will be overwritten)\nPartition bound: [0x${summary.targetOffset.toString(16)}, 0x${(summary.targetOffset + summary.targetLength).toString(16)})\nCandidate: WeatherXM ${summary.firmwareVersion}, ${summary.imageBytes} bytes\nCandidate SHA-256: ${summary.firmwareSha256}\nBackup: ${summary.backupFile}\nBackup SHA-256: ${summary.backupSha256}\nBackup image/signature: ${summary.backupFirmwareVersion ?? 'UNKNOWN'} / ${summary.backupSignatureStatus}; restore is not proven\nErase range: [0x${summary.eraseStart.toString(16)}, 0x${summary.eraseEnd.toString(16)})\nFlash encryption enabled: ${summary.flashEncryption}\nPreserved: active ota_1, bootloader, partition table, factory, credentials, NVS, calibration, SPIFFS\nOTA metadata: WILL NOT CHANGE\nAutomatic activation: WILL NOT OCCUR\nRisk: power loss or interrupted transfer may leave ota_0 partially erased or written; no recovery guarantee is implied.\nType exactly: ${phrase}\n`);
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('STAGING BLOCKED — OPERATOR CONFIRMATION REQUIRED: use an interactive terminal; --yes is not allowed');
        const rl = createInterface({ input: stdin, output: stdout });
        try { return (await rl.question('Confirm stage-only write: ')) === phrase; }
        finally { rl.close(); }
      };
      try {
        const result = await stageOnlyFirmware({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial,
          backupManifestPath: args.backupManifest!, confirm: confirmStage });
        if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`${result.outcome}\nSecure Boot V2 signature: VERIFIED\nDevice digest slot 0: TRUSTED\nHardware MD5: VERIFIED (${result.expectedMd5})\nExpected SHA-256: ${result.firmwareSha256}\nReadback SHA-256: ${result.actualSha256}\nBytes verified: ${result.bytesRead}\nTarget range: [0x${result.targetRange.start.toString(16)}, 0x${result.targetRange.end.toString(16)})\nErase range: [0x${result.eraseRange.start.toString(16)}, 0x${result.eraseRange.end.toString(16)})\nOTA metadata unchanged: YES\nActive ota_1 unchanged: YES\nProtected regions unchanged: YES\nAutomatic activation: NO\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = message.startsWith('STAGING FAILED — PROTECTED') ? 'STAGING FAILED — PROTECTED REGION CHANGED'
          : message.startsWith('STAGING FAILED — VERIFICATION') ? 'STAGING FAILED — VERIFICATION MISMATCH'
          : message.startsWith('STAGING FAILED — TARGET') ? 'STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN'
          : message.startsWith('STAGING BLOCKED — BACKUP') ? 'STAGING BLOCKED — BACKUP INVALID'
          : message.startsWith('STAGING BLOCKED') ? 'STAGING BLOCKED — PREFLIGHT FAILED'
          : 'STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN';
        if (args.json) process.stdout.write(`${JSON.stringify({ outcome, error: message, otaMetadataModified: false }, null, 2)}\n`);
        else process.stderr.write(`${outcome}: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    const confirm = async (summary: Parameters<Parameters<typeof flashDevice>[0]['confirm']>[0]) => {
      const endOffset = summary.targetOffset + summary.bytes;
      process.stderr.write(`\n${args.dryRun ? 'Firmware dry-run review' : 'Firmware write review'}${summary.recovery ? ' (RECOVERY MODE)' : ''}\nDevice: ${summary.deviceName}\nActive slot: ${summary.activeSlot}\nFirmware: ${summary.firmwareLabel} (${summary.firmwareKey})\nImage descriptor: ${summary.comparison.selected.type} ${summary.comparison.selected.version}; build ${summary.comparison.selected.build}\nInstalled descriptor: ${summary.comparison.installed.type} ${summary.comparison.installed.version}; build ${summary.comparison.installed.build}\nComparison: ${summary.comparison.kind} — ${summary.comparison.message}\nSize: ${summary.bytes} bytes\nSHA-256: ${summary.sha256}\nTarget: ${summary.targetSlot}, byte range [0x${summary.targetOffset.toString(16)}, 0x${endOffset.toString(16)})\nFactory firmware, active slot, credentials, NVS, calibration, and other protected partitions are outside the write range.\n`);
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
        process.stderr.write(`${comparison.message}\n`);
        return (await rl.question(`This change needs separate approval. Type ${phrase} to continue: `)) === phrase;
      } finally { rl.close(); }
    };
    const result = await flashDevice({ portPath: args.port, baudRate: args.baud, firmwareKey: args.subcommand, manifestUrl: args.manifest, recovery: args.recover, force: args.force, dryRun: args.dryRun, traceSerial: args.traceSerial, confirm, approveComparisonException, bootLogSeconds: args.monitor ? 0 : args.bootLogSeconds, onBootLine: (line) => process.stderr.write(`[boot] ${line}\n`) });
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
  const inspection = await inspectDevice({ portPath: args.port, baudRate: args.baud, traceSerial: args.traceSerial });
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
  process.stderr.write(`wg1200: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
