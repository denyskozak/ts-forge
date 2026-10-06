import type { TaskCheckpoint } from '../../shared/checkpoint';
const phases = ['analysis', 'changes', 'checks', 'preview', 'delivery'] as const;
export function TaskTimeline({
  checkpoint,
  toolCount,
  busy,
  onResume,
}: {
  checkpoint?: TaskCheckpoint;
  toolCount?: number;
  busy: boolean;
  onResume: () => void;
}) {
  if (!checkpoint) return null;
  return (
    <section className="task-timeline" aria-label="Task progress">
      <ol>
        {phases.map((phase) => (
          <li key={phase} aria-current={checkpoint.phase === phase ? 'step' : undefined}>
            {phase}
          </li>
        ))}
      </ol>
      <div>
        <span>
          Pass {checkpoint.step}
          {toolCount !== undefined ? ` · ${toolCount} tools loaded` : ''}
        </span>
        <details>
          <summary>Capabilities</summary>
          <span>{checkpoint.groups.join(' · ')}</span>
          <p>{checkpoint.reason}</p>
        </details>
        {!busy && checkpoint.resumable && (
          <button className="button" onClick={onResume}>
            Resume task
          </button>
        )}
      </div>
    </section>
  );
}
