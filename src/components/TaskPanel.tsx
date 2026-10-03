import { useState } from 'react';
import { checkKey, type TaskRecord, type ImpactReport, type ChangeSet } from '../../shared/task';
import { api } from '../api';
import { Button, Checkbox, Disclosure } from './ui';
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
      <Disclosure title="Consumers and tests">
        {impact.affected.map((file) => (
          <Button key={file} onClick={() => onRead(file)}>
            {file}
            {impact.tests.includes(file) ? ' · test' : ''}
          </Button>
        ))}
      </Disclosure>
      {!!impact.exports.length && (
        <Disclosure title="Changed file exports">
          {impact.exports.map((item) => (
            <p key={`${item.path}:${item.name}`}>
              {item.path} → {item.name}
            </p>
          ))}
        </Disclosure>
      )}
      {!!impact.boundaries.length && (
        <Disclosure title="Boundaries to review">
          {impact.boundaries.map((item) => (
            <p key={`${item.path}:${item.reason}`}>
              {item.path}: {item.reason}
            </p>
          ))}
        </Disclosure>
      )}
      <Disclosure title="Evidence: import edges">
        {impact.edges.map((edge) => (
          <Button key={`${edge.from}:${edge.line}:${edge.to}`} onClick={() => onRead(edge.from)}>
            {edge.from}:{edge.line} → {edge.to}
          </Button>
        ))}
      </Disclosure>
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
  const [expanded, setExpanded] = useState(false);
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
  return (
    <Disclosure
      className="task-panel"
      open={task.outcome !== 'in_progress' || expanded}
      onOpenChange={setExpanded}
      title={
      <>
        Task contract <span>{task.outcome.replaceAll('_', ' ')}</span>
      </>
    }>
      <p>{task.goal}</p>
      {!!task.constraints.length && (
        <p>
          <strong>Constraints:</strong> {task.constraints.join(' · ')}
        </p>
      )}
      {!!task.outOfScope.length && (
        <p>
          <strong>Out of scope:</strong> {task.outOfScope.join(' · ')}
        </p>
      )}
      <strong>Acceptance criteria</strong>
      {task.criteria.map((criterion) => (
        <label key={criterion.id} className="task-criterion">
          <Checkbox
            checked={!!task.fingerprint && criterion.acceptedFingerprint === task.fingerprint}
            disabled={
              busy ||
              working ||
              !sessionId ||
              ['failed', 'stopped', 'in_progress'].includes(task.outcome)
            }
            onCheckedChange={() => void action(() => api.acceptCriterion(sessionId!, criterion.id))}
          />
          <span>{criterion.description}</span>
        </label>
      ))}
      <small>
        Confirm these only after reviewing the behavior. Successful checks alone do not prove the
        feature is correct.
      </small>
      <strong className="task-check-title">Required checks</strong>
      {task.requiredChecks.map((check, index) => {
        const result = task.validations.findLast((item) => checkKey(item) === checkKey(check));
        const status = result
          ? result.fingerprint && result.fingerprint !== task.fingerprint
            ? 'stale'
            : result.status
          : 'not run';
        return (
          <div className="task-check" key={`${checkKey(check)}:${index}`}>
            <div>
              <span>
                {check.recipe} · {check.project}
              </span>
              <b>{status}</b>
            </div>
            {!!check.files.length && <small>{check.files.join(', ')}</small>}
            <Button
              disabled={busy || working || !sessionId}
              onClick={() => void action(() => api.validateTask(sessionId!, index))}
            >
              Run isolated check
            </Button>
            {result && (
              <Disclosure title={`Result · ${result.durationMs} ms`}>
                <pre>{result.output}</pre>
              </Disclosure>
            )}
          </div>
        );
      })}
      <small>
        Checks execute installed project tools/config in a temporary copy. Network and original
        workspace writes are denied.
      </small>
    </Disclosure>
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
        <Button
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
        </Button>
      )}
    </section>
  );
}
