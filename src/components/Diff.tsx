import { memo, useEffect, useState } from 'react';
import type { Change } from 'diff';

export const Diff = memo(function Diff({ before, after }: { before: string; after: string }) {
  const [result, setResult] = useState<{ before: string; after: string; parts: Change[] | null }>();
  const large = before.length + after.length > 80000;
  useEffect(() => {
    if (large) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('../diff.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setResult({ before, after, parts: null });
      return;
    }
    worker.onmessage = (event) => {
      setResult({ before, after, parts: event.data });
      worker.terminate();
    };
    worker.onerror = () => {
      setResult({ before, after, parts: null });
      worker.terminate();
    };
    worker.postMessage({ before, after });
    return () => worker.terminate();
  }, [before, after, large]);
  const current = result?.before === before && result.after === after ? result : undefined;
  if (large || current?.parts === null)
    return (
      <div className="large-diff">
        <p>Review full snapshots below.</p>
        <details>
          <summary>Before ({before.length} characters)</summary>
          <pre>{before}</pre>
        </details>
        <details>
          <summary>After ({after.length} characters)</summary>
          <pre>{after}</pre>
        </details>
      </div>
    );
  if (!current)
    return (
      <p className="muted-text" role="status">
        Preparing diff…
      </p>
    );
  return (
    <div className="diff">
      {current.parts?.map((part, index) => (
        <pre className={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'} key={index}>
          {part.value
            .split('\n')
            .filter((line, i, all) => i < all.length - 1 || line)
            .map((line, i) => (
              <div key={i}>
                <span>{part.added ? '+' : part.removed ? '−' : ' '}</span>
                {line || ' '}
              </div>
            ))}
        </pre>
      ))}
    </div>
  );
});
