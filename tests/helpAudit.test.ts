import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentedHelpOptions, helpRouteInventory } from '../src/help.js';

const cliSource = readFileSync('src/cli.ts', 'utf8');
const mainSource = cliSource.slice(cliSource.indexOf('async function main()'));
const parserSource = cliSource.slice(cliSource.indexOf('function parseArgs('), cliSource.indexOf('let activeProgress'));

function commandBlock(command: string): string {
  const start = mainSource.indexOf(`if (args.command === '${command}')`);
  if (start < 0) return '';
  const rest = mainSource.slice(start);
  const next = rest.slice(1).search(/\n  if \(args\.command === /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function subcommandsInBlock(command: string): Set<string> {
  const block = commandBlock(command);
  const result = new Set<string>();
  for (const match of mainSource.matchAll(new RegExp(`args\\.command === '${command}'[^\\n]*args\\.subcommand === '([a-z-]+)'`, 'g'))) result.add(match[1]);
  for (const match of block.matchAll(new RegExp(`args\\.subcommand\\s*(?:===|!==)\\s*'([a-z-]+)'`, 'g'))) result.add(match[1]);
  for (const match of block.matchAll(/\[([^\]]+)\]\.includes\(args\.subcommand/g)) {
    for (const value of match[1].matchAll(/'([a-z-]+)'/g)) result.add(value[1]);
  }
  for (const match of block.matchAll(/args\.subcommand\s+as\s+([^;\n]+)/g)) {
    for (const value of match[1].matchAll(/'([a-z-]+)'/g)) result.add(value[1]);
  }
  if (command === 'ota' && block.includes('activateOtaSlot(')) result.add('activate');
  return result;
}

describe('complete CLI help audit', () => {
  it('discovers top-level dispatcher routes and requires matching help pages', () => {
    const discovered = new Set<string>();
    for (const match of mainSource.matchAll(/args\.command\s*===\s*'([a-z-]+)'/g)) discovered.add(match[1]);
    for (const match of mainSource.matchAll(/\[([^\]]+)\]\.includes\(args\.command/g)) {
      for (const value of match[1].matchAll(/'([a-z-]+)'/g)) discovered.add(value[1]);
    }
    discovered.delete('help');
    const documented = new Set([...helpRouteInventory.groups, ...helpRouteInventory.commands.filter((topic) => !topic.includes(' '))]);
    expect([...discovered].sort()).toEqual([...documented].sort());
  });

  it.each(['ota', 'backup', 'firmware', 'security', 'flash'])('discovers every %s leaf in the implementation and requires a distinct help page', (group) => {
    const discovered = subcommandsInBlock(group);
    if (group === 'backup') { discovered.add('active'); discovered.add('inactive'); }
    if (group === 'flash') {
      // Stage-only is deliberately constrained to the single reviewed firmware target.
      expect(parserSource).toContain("out.subcommand !== 'weatherxm'");
      discovered.add('weatherxm');
    }
    const documented = helpRouteInventory.commands
      .filter((topic) => topic.startsWith(`${group} `))
      .map((topic) => topic.slice(group.length + 1).split(' ')[0]);
    expect([...discovered].sort()).toEqual([...new Set(documented)].sort());
  });

  it('documents every option token accepted by the CLI parser or global help', () => {
    const helpText = readFileSync('src/help.ts', 'utf8');
    const declared = new Set<string>();
    for (const match of parserSource.matchAll(/arg\s*===\s*'(--[a-z0-9-]+)'/g)) declared.add(match[1]);
    for (const match of parserSource.matchAll(/arg\s*===\s*'(-[a-z])'/g)) declared.add(match[1]);
    const optionNames = documentedHelpOptions().flatMap((name) => name.match(/--[a-z0-9-]+|-[a-z]/g) ?? []);
    const documented = new Set([...optionNames, ...helpText.match(/GLOBAL OPTIONS[\s\S]*?EXAMPLES/)?.[0].match(/--[a-z0-9-]+|-[a-z]/g) ?? []]);
    const missing = [...declared].filter((option) => !documented.has(option));
    expect(missing).toEqual([]);
  });

  it('rejects options with no behavior instead of silently ignoring them', () => {
    expect(parserSource).toContain('firmware list reads the catalog directly and does not accept --offline or --cache-dir');
    expect(parserSource).toContain('--manifest is not supported by read-only flash diagnose');
    expect(parserSource).toContain('--manifest is supported only by security check');
    expect(parserSource).toContain('Monitor formatting options require monitor, ota activate, or ota restore');
  });
});
