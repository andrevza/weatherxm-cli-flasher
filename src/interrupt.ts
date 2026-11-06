import type { EventEmitter } from 'node:events';

/** Keep SIGINT inside the operation until its async cleanup has finished. */
export function bindAbortOnSigint(source: Pick<EventEmitter, 'on' | 'removeListener'>, controller: AbortController): () => void {
  const onInterrupt = () => controller.abort();
  source.on('SIGINT', onInterrupt);
  return () => { source.removeListener('SIGINT', onInterrupt); };
}
