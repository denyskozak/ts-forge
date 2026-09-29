import { diffLines } from 'diff';
self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  const { before, after } = event.data;
  // Bound pathological comparisons; fall back to complete snapshots rather than a partial diff.
  self.postMessage(diffLines(before, after, { timeout: 100, maxEditLength: 2000 }) ?? null);
};
