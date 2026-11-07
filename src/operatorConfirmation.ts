import { retryExactConfirmation } from './verification.js';
import type { ProgressReporter } from './progress.js';

/** Lets readline exclusively own the interactive terminal for the full confirmation exchange. */
export async function confirmWithSuspendedProgress(input: {
  phrase: string;
  progress: ProgressReporter;
  promptIntro?: string;
  askPhrase: (attempt: number, phrase: string) => Promise<string>;
  askRetry: (attempt: number) => Promise<'retry' | 'cancel'>;
  onMismatch?: (attempt: number, maximum: number) => void;
  acceptedMessage?: string;
}): Promise<boolean> {
  input.progress.suspend();
  try {
    if (input.promptIntro) input.progress.log(input.promptIntro);
    const accepted = await retryExactConfirmation({ phrase: input.phrase, askPhrase: input.askPhrase,
      askRetry: input.askRetry, onMismatch: input.onMismatch });
    if (accepted) input.progress.log(input.acceptedMessage ?? 'Confirmation accepted.\nBeginning OTA metadata transaction...');
    return accepted;
  } finally {
    input.progress.resume();
  }
}
