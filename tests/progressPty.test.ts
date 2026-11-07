import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('interactive progress under a pseudo-terminal', () => {
  it.skipIf(process.platform !== 'linux')('keeps progress in-place on stderr even when stdout is JSON', () => {
    const command = `${process.execPath} --import tsx src/cli.ts firmware download weatherxm --manifest http://127.0.0.1:1/manifest.json --json`;
    const result = spawnSync('script', ['-qec', command, '/dev/null'], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, TERM: 'xterm-256color' } });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('\u001b[2K');
    expect(result.stdout).toContain('Retrieving firmware catalog');
    expect(result.stdout).toContain('"outcome": "FIRMWARE DOWNLOAD FAILED"');
    expect(result.stdout).not.toContain('Retrieving firmware catalog\nRetrieving firmware catalog\n');
  });
});
