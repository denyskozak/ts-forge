import { readText, scanFiles } from './workspace';
import { capture, gitInspect } from './development-tools';
import { resolveExecutable } from './executor';
import { taskOutcome, type TaskRecord } from '../shared/task';

export async function maintenanceAudit(root: string, signal: AbortSignal) {
  const scan = await scanFiles(root, 10_000, signal);
  const findings: { path: string; line: number; kind: string; detail: string }[] = [];
  let checked = 0;
  const rules = [
    {
      expression: /dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\s*\(/,
      kind: 'untrusted-content',
      detail: 'Trace input trust and sanitization before executing or rendering content.',
    },
    {
      expression: /\b(?:fetch|axios\.(?:get|post))\s*\(/,
      kind: 'network-resilience',
      detail: 'Check timeout, cancellation, response validation and failure behavior.',
    },
    {
      expression: /(?:findMany\(|SELECT\s+\*)/i,
      kind: 'data-scale',
      detail: 'Inspect pagination, indexes, authorization and expected result size.',
    },
    {
      expression: /(?:setInterval|addEventListener)\s*\(/,
      kind: 'resource-lifecycle',
      detail: 'Verify cleanup, duplicate registration and component lifecycle.',
    },
    {
      expression: /process\.env\.(?:NEXT_PUBLIC_|VITE_).*(?:TOKEN|SECRET|PASSWORD|KEY)/i,
      kind: 'client-secret-risk',
      detail: 'Verify that public environment variables contain no credentials.',
    },
  ];
  for (const file of scan.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).slice(0, 1500)) {
    signal.throwIfAborted();
    let text: string;
    try {
      text = await readText(root, file);
    } catch {
      continue;
    }
    checked++;
    text.split('\n').forEach((line, index) => {
      for (const rule of rules)
        if (rule.expression.test(line) && findings.length < 100)
          findings.push({ path: file, line: index + 1, kind: rule.kind, detail: rule.detail });
    });
  }
  return {
    complete:
      scan.complete && checked >= scan.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).length,
    checked,
    findings,
    warnings: scan.warnings,
    note: 'Static triage hypotheses only. Read each cited source and test the boundary; this is not a security or performance certification.',
  };
}
export async function dependencyReport(
  root: string,
  kind: 'audit' | 'outdated',
  signal: AbortSignal,
) {
  await readText(root, 'package.json');
  const result = await capture(
    await resolveExecutable('pnpm'),
    [kind, '--json'],
    root,
    signal,
    60_000,
  );
  let report: unknown;
  try {
    report = JSON.parse(result.output);
  } catch {
    report = { output: result.output };
  }
  return {
    kind,
    report,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    note: 'Read-only registry request. No dependency changes were made. Nonzero audit/outdated status may indicate findings.',
  };
}
export async function releaseReadiness(root: string, task: TaskRecord, signal: AbortSignal) {
  signal.throwIfAborted();
  const manifest = JSON.parse(await readText(root, 'package.json'));
  const git = await gitInspect(root, 'status').catch((error) => ({
    output: (error as Error).message,
  }));
  return {
    outcome: taskOutcome(task),
    checks: task.requiredChecks,
    receipts: task.validations.map(({ output: _output, ...receipt }) => receipt),
    scripts: manifest.scripts ?? {},
    git: git.output,
    checklist: [
      'Production build on final source fingerprint',
      'Runtime/browser smoke',
      'Secret environment names and server-side authorization',
      'Disposable migration rehearsal with representative data',
      'Deployment health checks, rollback and data restore instructions',
    ],
    note: 'Checklist and local receipts only. No deployment or remote health claim.',
  };
}
