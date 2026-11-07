import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const phrase = 'ACTIVATE ota_0 SEQUENCE 5';
const fixture = join(process.cwd(), 'tests/fixtures/confirmationPty.mjs');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function runPty(statePath: string, input: string, stderrPath?: string) {
  const program = `${process.execPath} --import tsx ${fixture}${stderrPath ? ` 2>${stderrPath}` : ''}`;
  const command = `{ ${input}; } | script -qec ${shellQuote(program)} /dev/null`;
  return spawnSync('bash', ['-lc', command], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    env: { ...process.env, TERM: 'xterm-256color', WG_CONFIRM_STATE_PATH: statePath } });
}

describe('interactive OTA confirmation under a real pseudo-terminal', () => {
  it.skipIf(process.platform !== 'linux')('keeps the prompt visible and does not enter the writer until Enter submits the exact phrase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-confirm-'));
    try {
      const state = join(dir, 'state');
      const result = runPty(state, `sleep 0.15; printf '%s' '${phrase}'; sleep 0.55; printf '\\n'`);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const transcript = result.stdout;
      const promptAt = transcript.indexOf('Waiting for confirmation');
      const phraseAt = transcript.indexOf(phrase, promptAt);
      const acceptedAt = transcript.indexOf('Confirmation accepted.');
      const writerAt = transcript.indexOf('WRITER_STARTED');
      const progressAt = transcript.indexOf('Writing OTA metadata sector');
      expect(await readFile(state, 'utf8')).toBe('still-waiting\n');
      expect(await readFile(`${state}.writes`, 'utf8')).toBe('1\n');
      expect(promptAt).toBeGreaterThanOrEqual(0);
      expect(phraseAt).toBeGreaterThan(promptAt);
      expect(acceptedAt).toBeGreaterThan(phraseAt);
      expect(transcript.indexOf('Beginning OTA metadata transaction...', acceptedAt)).toBeGreaterThan(acceptedAt);
      expect(writerAt).toBeGreaterThan(acceptedAt);
      expect(progressAt).toBeGreaterThan(acceptedAt);
      expect(progressAt).toBeGreaterThan(writerAt);
      expect(transcript).not.toContain('background progress');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('rejects an incorrect phrase, retries, and starts only after the valid line is submitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-confirm-retry-'));
    try {
      const state = join(dir, 'state');
      const result = runPty(state, `sleep 0.15; printf '%s\\n' 'WRONG PHRASE'; sleep 0.15; printf '1\\n'; sleep 0.15; printf '%s\\n' '${phrase}'`);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('Confirmation mismatch');
      expect(result.stdout).toContain('no write has started');
      expect(result.stdout).toContain('WRITER_STARTED');
      expect(await readFile(`${state}.writes`, 'utf8')).toBe('1\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('cancels on Ctrl+C before Enter with zero writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-confirm-cancel-'));
    try {
      const state = join(dir, 'state');
      const result = runPty(state, `sleep 0.15; printf '%s' '${phrase}'; sleep 0.5; printf '\\003'`);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('CONFIRMATION_ABORTED_NO_WRITE');
      expect(result.stdout).not.toContain('WRITER_STARTED');
      expect(await readFile(state, 'utf8')).toBe('still-waiting\n');
      expect(await readFile(`${state}.writes`, 'utf8')).toBe('0\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('keeps the stdout prompt usable when stderr is redirected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-confirm-redir-'));
    try {
      const state = join(dir, 'state'); const stderr = join(dir, 'stderr.log');
      const result = runPty(state, `sleep 0.15; printf '%s' '${phrase}'; sleep 0.45; printf '\\n'`, stderr);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('Waiting for confirmation');
      expect(result.stdout).toContain('WRITER_STARTED');
      expect(result.stdout).not.toContain('\u001b[2K');
      expect(result.stdout).not.toContain('Preparing transaction');
      expect(await readFile(`${state}.writes`, 'utf8')).toBe('1\n');
      const diagnosticOutput = await readFile(stderr, 'utf8');
      expect(diagnosticOutput).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
      const acceptedAt = diagnosticOutput.indexOf('Confirmation accepted.');
      expect(acceptedAt).toBeGreaterThanOrEqual(0);
      expect(diagnosticOutput).toContain('Beginning OTA metadata transaction...');
      expect(diagnosticOutput).toContain('Writing OTA metadata sector');
      const backgroundAt = diagnosticOutput.indexOf('background progress');
      if (backgroundAt >= 0) expect(backgroundAt).toBeGreaterThan(acceptedAt);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
