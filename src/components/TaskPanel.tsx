import { useState } from 'react';
import { checkKey, type TaskRecord, type ImpactReport, type ChangeSet } from '../../shared/task';
import { api } from '../api';
export function ImpactPreview({
  impact,
  onRead,
}: {
  impact: ImpactReport;
  onRead: (path: string) => void;
}) {
  return (
    <section className="impact-preview" aria-label="Impact preview">
      <strong>Impact preview</strong>
      <p>
        {impact.affected.length} affected files · {impact.tests.length} related tests ·{' '}
        {impact.exports.length} exported symbols
      </p>
      <details>
        <summary>Consumers and tests</summary>
        {impact.affected.map((file) => (
          <button key={file} onClick={() => onRead(file)}>
            {file}
            {impact.tests.includes(file) ? ' · test' : ''}
          </button>
        ))}
      </details>
      {!!impact.exports.length && (
        <details>
          <summary>Changed file exports</summary>
          {impact.exports.map((item) => (
            <p key={`${item.path}:${item.name}`}>
              {item.path} → {item.name}
            </p>
          ))}
        </details>
      )}
      {!!impact.boundaries.length && (
        <details>
          <summary>Boundaries to review</summary>
          {impact.boundaries.map((item) => (
            <p key={`${item.path}:${item.reason}`}>
              {item.path}: {item.reason}
            </p>
          ))}
        </details>
      )}
      <details>
        <summary>Evidence: import edges</summary>
        {impact.edges.map((edge) => (
          <button key={`${edge.from}:${edge.line}:${edge.to}`} onClick={() => onRead(edge.from)}>
            {edge.from}:{edge.line} → {edge.to}
          </button>
        ))}
      </details>
      <small>{impact.warnings.join(' ')}</small>
    </section>
  );
}
export function TaskPanel({
  task,
  sessionId,
  busy,
  onError,
}: {
  task: TaskRecord;
  sessionId?: string;
  busy: boolean;
  onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState(false);
  const action = async (operation: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await operation();
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  };
  const checks = task.requiredChecks.map((check, index) => {
    const result = task.validations.findLast((item) => checkKey(item) === checkKey(check));
    const status = result
      ? result.fingerprint && result.fingerprint !== task.fingerprint
        ? 'stale'
        : result.status
      : 'not run';
    return { check, index, result, status };
  });
  const criteria = task.criteria.reduce<{ description: string; members: TaskRecord['criteria'] }[]>(
    (groups, criterion) => {
      const normalized = criterion.description.trim().toLocaleLowerCase();
      const group = groups.find(({ description }) => {
        const existing = description.trim().toLocaleLowerCase();
        return existing.includes(normalized) || normalized.includes(existing);
      });
      if (!group) groups.push({ description: criterion.description, members: [criterion] });
      else {
        group.members.push(criterion);
        if (criterion.description.length > group.description.length)
          group.description = criterion.description;
      }
      return groups;
    },
    [],
  );
  const passedChecks = checks.filter(({ status }) => status === 'passed').length;
  const acceptedCriteria = criteria.filter(
    ({ members }) =>
      !!task.fingerprint &&
      members.every((criterion) => criterion.acceptedFingerprint === task.fingerprint),
  ).length;
  const status =
    task.outcome === 'in_progress'
      ? 'Working'
      : task.outcome === 'completed_verified'
        ? 'Done'
        : task.outcome === 'completed_unverified'
          ? 'Review'
          : task.outcome === 'analysis_only'
            ? 'Analyzed'
            : task.outcome === 'stopped'
              ? 'Paused'
              : 'Failed';
  return (
    <details className="task-panel">
      <summary className="task-panel-summary">
        <span className="task-panel-copy">
          <strong>Task</strong>
          <span title={task.goal}>{task.goal}</span>
        </span>
        <span className={`task-state task-state-${task.outcome}`}>{status}</span>
      </summary>
      <div className="task-panel-body">
        <div className="task-progress" aria-label="Task progress">
          <span>{task.appliedChanges} changed</span>
          <span>
            {passedChecks}/{checks.length} checks
          </span>
          <span>
            {acceptedCriteria}/{criteria.length} reviewed
          </span>
        </div>

        {!!checks.length && (
          <section className="task-section">
            <header>
              <strong>Checks</strong>
              <span>
                {passedChecks}/{checks.length}
              </span>
            </header>
            {checks.map(({ check, index, result, status: checkStatus }) => (
              <div className="task-check" key={`${checkKey(check)}:${index}`}>
                <div className="task-check-row">
                  <span className="task-check-name" title={`${check.recipe} · ${check.project}`}>
                    {check.recipe}
                  </span>
                  <span className={`task-check-status task-check-status-${checkStatus}`}>
                    {checkStatus}
                  </span>
                  {checkStatus !== 'passed' && (
                    <button
                      disabled={busy || working || !sessionId}
                      onClick={() => void action(() => api.validateTask(sessionId!, index))}
                    >
                      Run
                    </button>
                  )}
                </div>
                {!!check.files.length && <small>{check.files.join(', ')}</small>}
                {result && (
                  <details className="task-check-result">
                    <summary>Output · {result.durationMs} ms</summary>
                    <pre>{result.output}</pre>
                  </details>
                )}
              </div>
            ))}
          </section>
        )}

        {!!criteria.length && (
          <section className="task-section">
            <header>
              <strong>Review</strong>
              <span>
                {acceptedCriteria}/{criteria.length}
              </span>
            </header>
            {criteria.map((criterion) => (
              <label
                key={criterion.members.map(({ id }) => id).join(':')}
                className="task-criterion"
              >
                <input
                  type="checkbox"
                  checked={
                    !!task.fingerprint &&
                    criterion.members.every(
                      (member) => member.acceptedFingerprint === task.fingerprint,
                    )
                  }
                  disabled={
                    busy ||
                    working ||
                    !sessionId ||
                    ['failed', 'stopped', 'in_progress'].includes(task.outcome)
                  }
                  onChange={() =>
                    void action(async () => {
                      for (const member of criterion.members)
                        if (member.acceptedFingerprint !== task.fingerprint)
                          await api.acceptCriterion(sessionId!, member.id);
                    })
                  }
                />
                <span>{criterion.description}</span>
              </label>
            ))}
          </section>
        )}

        {(task.constraints.length > 0 || task.outOfScope.length > 0) && (
          <details className="task-scope">
            <summary>Scope</summary>
            {!!task.constraints.length && <p>{task.constraints.join(' · ')}</p>}
            {!!task.outOfScope.length && <p>Excluded: {task.outOfScope.join(' · ')}</p>}
          </details>
        )}
      </div>
    </details>
  );
}
export function ChangeSetSummary({
  set,
  busy,
  onRead,
  onError,
}: {
  set: ChangeSet;
  busy: boolean;
  onRead: (path: string) => void;
  onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState(false);
  return (
    <section className="changeset-summary">
      <strong>
        {set.changeIds.length} files · {set.status}
      </strong>
      <p>{set.rationale}</p>
      {set.impact && <ImpactPreview impact={set.impact} onRead={onRead} />}
      {set.status === 'applied' && (
        <button
          disabled={busy || working}
          onClick={async () => {
            setWorking(true);
            try {
              await api.undoChangeSet(set.id);
            } catch (error) {
              onError(error);
            } finally {
              setWorking(false);
            }
          }}
        >
          Undo changeset
        </button>
      )}
    </section>
  );
}
