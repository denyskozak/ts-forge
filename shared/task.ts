import { z } from 'zod';
export const recipeSchema = z.enum([
  'typescript.check',
  'tests.related',
  'tests.project',
  'lint.files',
  'format.check',
  'next.build',
  'expo.doctor',
  'package.exports.check',
]);
export type RecipeId = z.infer<typeof recipeSchema>;
export const checkSchema = z.object({
  recipe: recipeSchema,
  project: z.string().min(1).max(500).default('tsconfig.json'),
  files: z.array(z.string().min(1).max(500)).max(80).default([]),
});
export type ValidationCheck = z.infer<typeof checkSchema>;
export const contractInputSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  constraints: z.array(z.string().max(500)).max(12).default([]),
  outOfScope: z.array(z.string().max(500)).max(12).default([]),
  criteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  requiredChecks: z.array(checkSchema).min(1).max(12),
});
export const validationSchema = checkSchema.extend({
  id: z.string(),
  fingerprint: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  status: z.enum(['passed', 'failed', 'cancelled', 'unavailable', 'declined', 'stale']),
  exitCode: z.number().nullable(),
  output: z.string(),
});
export type ValidationResult = z.infer<typeof validationSchema>;
export const taskSchema = z.object({
  runId: z.string(),
  goal: z.string(),
  constraints: z.array(z.string()),
  outOfScope: z.array(z.string()),
  criteria: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      acceptedFingerprint: z.string().optional(),
    }),
  ),
  requiredChecks: z.array(checkSchema),
  validations: z.array(validationSchema),
  fingerprint: z.string(),
  appliedChanges: z.number(),
  outcome: z.enum([
    'in_progress',
    'completed_verified',
    'completed_unverified',
    'analysis_only',
    'failed',
    'stopped',
  ]),
});
export type TaskRecord = z.infer<typeof taskSchema>;
export const impactSchema = z.object({
  changed: z.array(z.string()),
  affected: z.array(z.string()),
  tests: z.array(z.string()),
  exports: z.array(z.object({ path: z.string(), name: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), line: z.number() })),
  boundaries: z.array(z.object({ path: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
  complete: z.boolean(),
  indexedFiles: z.number(),
  fingerprint: z.string(),
});
export type ImpactReport = z.infer<typeof impactSchema>;
export const changeSetSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  workspace: z.string(),
  rationale: z.string(),
  changeIds: z.array(z.string()),
  status: z.enum([
    'pending',
    'applying',
    'applied',
    'rolling_back',
    'rolled_back',
    'conflict',
    'rejected',
  ]),
  impact: impactSchema.optional(),
  createdAt: z.number(),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;
export function checkKey(check: ValidationCheck) {
  return JSON.stringify([check.recipe, check.project, [...check.files].sort()]);
}
/** Only receipts from the exact current snapshot and explicit human acceptance count. */
export function taskOutcome(task: TaskRecord): TaskRecord['outcome'] {
  if (!task.appliedChanges) return 'completed_unverified';
  const passed =
    task.requiredChecks.length > 0 &&
    task.requiredChecks.every((check) => {
      const latest = task.validations.findLast((result) => checkKey(result) === checkKey(check));
      return latest?.status === 'passed' && latest.fingerprint === task.fingerprint;
    });
  return passed &&
    task.criteria.length > 0 &&
    task.criteria.every((c) => c.acceptedFingerprint === task.fingerprint)
    ? 'completed_verified'
    : 'completed_unverified';
}
