#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const PAGE_SIZE = 16 * 1024;

function parseElf(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 4).toString('hex') !== '7f454c46' || data[4] !== 2 || data[5] !== 1) {
    throw new Error(`${path}: expected a little-endian ELF64 file`);
  }
  if (data.readUInt16LE(18) !== 183) throw new Error(`${path}: expected AArch64 ELF (e_machine=183)`);
  const phoff = Number(data.readBigUInt64LE(32));
  const phentsize = data.readUInt16LE(54);
  const phnum = data.readUInt16LE(56);
  const headers = [];
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (at + phentsize > data.length || phentsize < 56) throw new Error(`${path}: truncated program header table`);
    headers.push({
      type: data.readUInt32LE(at), flags: data.readUInt32LE(at + 4),
      offset: data.readBigUInt64LE(at + 8), vaddr: data.readBigUInt64LE(at + 16),
      filesz: data.readBigUInt64LE(at + 32), memsz: data.readBigUInt64LE(at + 40),
      align: data.readBigUInt64LE(at + 48),
    });
  }
  const loads = headers.filter((header) => header.type === 1);
  const interpHeader = headers.find((header) => header.type === 3);
  const interpreter = interpHeader
    ? data.subarray(Number(interpHeader.offset), Number(interpHeader.offset + interpHeader.filesz)).toString().replace(/\0+$/, '')
    : null;
  return { loads, interpreter, hasDynamic: headers.some((header) => header.type === 2) };
}

function validate(path, { executable = false } = {}) {
  const elf = parseElf(path);
  const errors = [];
  if (elf.loads.length < 2) errors.push('expected at least two PT_LOAD segments');
  for (const [index, load] of elf.loads.entries()) {
    if (load.align === 0n || (load.align & (load.align - 1n)) !== 0n) {
      errors.push(`PT_LOAD ${index}: invalid p_align ${load.align.toString(16)}`);
    } else if ((load.offset % load.align) !== (load.vaddr % load.align)) {
      errors.push(`PT_LOAD ${index}: p_offset and p_vaddr are not congruent modulo p_align 0x${load.align.toString(16)}`);
    }
    if ((load.offset % BigInt(PAGE_SIZE)) !== (load.vaddr % BigInt(PAGE_SIZE))) {
      errors.push(`PT_LOAD ${index}: p_offset and p_vaddr are not congruent modulo ${PAGE_SIZE} bytes (offset=0x${load.offset.toString(16)}, vaddr=0x${load.vaddr.toString(16)}, align=0x${load.align.toString(16)})`);
    }
  }
  if (executable && (!elf.interpreter || !elf.hasDynamic)) errors.push('expected a dynamically linked executable with PT_INTERP and PT_DYNAMIC');
  if (errors.length) throw new Error(`${path}: 16 KB ELF validation failed:\n  ${errors.join('\n  ')}`);
  process.stdout.write(`${basename(path)}: ${elf.loads.length} PT_LOAD segments compatible with 16 KB pages${elf.interpreter ? `; interpreter ${elf.interpreter}` : ''}\n`);
  for (const [index, load] of elf.loads.entries()) {
    process.stdout.write(`  LOAD ${index}: offset=0x${load.offset.toString(16)} vaddr=0x${load.vaddr.toString(16)} align=0x${load.align.toString(16)}\n`);
  }
}

const [, , executable, addon, baseline] = process.argv;
if (!executable || !addon) {
  process.stderr.write('Usage: node scripts/validate-linux-elf.mjs <linux-arm64-executable> <serialport-addon.node> [pristine-node-executable]\n');
  process.exit(2);
}
try {
  validate(executable, { executable: true });
  validate(addon);
  if (baseline) {
    process.stdout.write('Pristine Node executable before SEA injection:\n');
    validate(baseline, { executable: true });
    process.stdout.write(`SEA injection changed the PT_LOAD count from ${parseElf(baseline).loads.length} to ${parseElf(executable).loads.length}.\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
