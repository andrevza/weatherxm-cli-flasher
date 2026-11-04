import type { AppDescriptor } from './appDescriptor.js';
import { WG1200_CONSTANTS } from './constants.js';

export type FirmwareComparisonKind = 'identical' | 'newer' | 'older' | 'same-version-different-build' | 'different-type' | 'ambiguous';
export interface FirmwareComparison {
  kind: FirmwareComparisonKind;
  installed: { type: string; version: string; build: string };
  selected: { type: string; version: string; build: string };
  message: string;
}
export interface FirmwareInstallPolicy {
  alreadyInstalled: boolean;
  downgradeBlocked: boolean;
  approvalRequired: boolean;
  flashingPermitted: boolean;
}

/** `force` changes only the identical-build skip; it grants no other authority. */
export function firmwareInstallPolicy(comparison: FirmwareComparison, force = false): FirmwareInstallPolicy {
  const identical = comparison.kind === 'identical';
  const approvalRequired = comparison.kind === 'different-type' || comparison.kind === 'ambiguous' || comparison.kind === 'same-version-different-build';
  const downgradeBlocked = comparison.kind === 'older';
  return {
    alreadyInstalled: identical && !force,
    downgradeBlocked,
    approvalRequired,
    flashingPermitted: !downgradeBlocked && !approvalRequired && (comparison.kind === 'newer' || (identical && force)),
  };
}

function metadata(desc: AppDescriptor | null | undefined, label: string) {
  if (!desc || desc.magic !== WG1200_CONSTANTS.APP_DESC_MAGIC || desc.firmwareType === 'unknown' || !desc.version.trim() ||
      !/^[a-f0-9]{64}$/i.test(desc.appElfSha256) || /^0+$/.test(desc.appElfSha256)) {
    throw new Error(`${label} firmware descriptor is missing a validated type, version, or embedded build identifier`);
  }
  return { type: desc.firmwareType, version: desc.version.trim(), build: desc.appElfSha256.toLowerCase() };
}

type ParsedVersion = { major: number; minor: number; patch: number; prerelease?: string };
function parseVersion(input: string): ParsedVersion | null {
  const match = input.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  // Standard SemVer prereleases alpha/beta/rc have an ordering. Vendor/git
  // suffixes (g<hash>, dirty) do not: treating them lexically would guess.
  const known = (value: string) => /^(?:alpha|beta|rc)(?:[.-]?\d+)?$/i.test(value);
  if (!known(a.prerelease) || !known(b.prerelease)) return 0;
  const ar = a.prerelease.match(/^(alpha|beta|rc)[.-]?(\d+)?$/i)!;
  const br = b.prerelease.match(/^(alpha|beta|rc)[.-]?(\d+)?$/i)!;
  const rank = { alpha: 0, beta: 1, rc: 2 } as const;
  if (rank[ar[1].toLowerCase() as keyof typeof rank] !== rank[br[1].toLowerCase() as keyof typeof rank]) {
    return rank[ar[1].toLowerCase() as keyof typeof rank] > rank[br[1].toLowerCase() as keyof typeof rank] ? 1 : -1;
  }
  const an = Number(ar[2] ?? 0), bn = Number(br[2] ?? 0);
  return an === bn ? 0 : an > bn ? 1 : -1;
}

function sameCore(a: ParsedVersion, b: ParsedVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}
function hasRecognizedPrerelease(version: ParsedVersion): boolean {
  return version.prerelease === undefined || /^(?:alpha|beta|rc)(?:[.-]?\d+)?$/i.test(version.prerelease);
}

export function compareFirmware(installedDescriptor: AppDescriptor | null | undefined, selectedDescriptor: AppDescriptor | null | undefined): FirmwareComparison {
  const installed = metadata(installedDescriptor, 'Installed');
  const selected = metadata(selectedDescriptor, 'Selected');
  const base = { installed, selected };
  if (installed.type === selected.type && installed.version === selected.version && installed.build === selected.build) {
    return { ...base, kind: 'identical', message: `Already installed: ${selected.type} ${selected.version} (build ${selected.build.slice(0, 12)}).` };
  }
  if (installed.type !== selected.type) {
    return { ...base, kind: 'different-type', message: `Firmware type changes from ${installed.type} to ${selected.type}.` };
  }
  const activeVersion = parseVersion(installed.version);
  const targetVersion = parseVersion(selected.version);
  if (!activeVersion || !targetVersion) {
    return { ...base, kind: 'ambiguous', message: `Cannot reliably order '${installed.version}' and '${selected.version}'.` };
  }
  if (sameCore(activeVersion, targetVersion) && activeVersion.prerelease !== targetVersion.prerelease &&
      (!hasRecognizedPrerelease(activeVersion) || !hasRecognizedPrerelease(targetVersion))) {
    return { ...base, kind: 'ambiguous', message: `Cannot reliably order vendor build suffixes in '${installed.version}' and '${selected.version}'.` };
  }
  const order = compareVersions(targetVersion, activeVersion);
  if (order < 0) return { ...base, kind: 'older', message: `Selected ${selected.version} is older than installed ${installed.version}; downgrades are blocked.` };
  if (order > 0) return { ...base, kind: 'newer', message: `Selected ${selected.version} is newer than installed ${installed.version}.` };
  if (installed.version === selected.version) {
    return { ...base, kind: 'same-version-different-build', message: `Version ${selected.version} is installed with a different embedded build identifier.` };
  }
  return { ...base, kind: 'ambiguous', message: `Cannot reliably order '${installed.version}' and '${selected.version}'.` };
}
