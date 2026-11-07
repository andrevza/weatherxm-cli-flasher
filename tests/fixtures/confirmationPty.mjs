import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import { OutputCoordinator, ProgressReporter } from '../../src/progress.ts';
import { confirmWithSuspendedProgress } from '../../src/operatorConfirmation.ts';

const expected = 'ACTIVATE ota_0 SEQUENCE 5';
const statePath = process.env.WG_CONFIRM_STATE_PATH;
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
const tty = Boolean(process.stderr.isTTY);
const coordinator = new OutputCoordinator({ write: (text) => process.stderr.write(text), tty });
const progress = new ProgressReporter({ coordinator, tty, intervalMs: 25 });
let writes = 0;
progress.stage('Preparing transaction', 100);
let ticks = 0;
const activity = setInterval(() => progress.status(`background progress ${++ticks}`), 25);
setTimeout(() => writeFileSync(statePath, writes === 0 ? 'still-waiting\n' : 'accepted-early\n'), 250);

try {
  const accepted = await confirmWithSuspendedProgress({ phrase: expected, progress,
    askPhrase: async (attempt, phrase) => {
      if (attempt > 1) progress.log(`Required confirmation: ${phrase}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question('Waiting for confirmation: type the exact phrase and press Enter (or type CANCEL): ', { signal: controller.signal }); }
      finally { rl.close(); }
    },
    askRetry: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question('1) Retry  2) Cancel [1]: ', { signal: controller.signal })).trim() === '1' ? 'retry' : 'cancel'; }
      finally { rl.close(); }
    },
    onMismatch: (attempt, maximum) => progress.log(`Confirmation mismatch (${attempt}/${maximum}); no write has started.`),
  });
  if (accepted) {
    progress.stage('Revalidating metadata after confirmation');
    writes++;
    process.stdout.write('WRITER_STARTED\n');
    progress.stage('Writing OTA metadata sector at 0x13000', 4096);
  } else process.stdout.write('CONFIRMATION_CANCELLED_NO_WRITE\n');
} catch (error) {
  process.stdout.write(`CONFIRMATION_ABORTED_NO_WRITE ${error?.name ?? 'Error'}\n`);
} finally {
  clearInterval(activity);
  progress.close();
  writeFileSync(`${statePath}.writes`, `${writes}\n`);
}
