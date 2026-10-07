import { z } from 'zod';
import { TOOL_GROUP_NAMES } from './tool-policy';
export const taskPhaseSchema = z.enum(['analysis', 'changes', 'checks', 'preview', 'delivery']);
export const taskKindSchema = z.enum(['development', 'change', 'improvement', 'analysis']);
export type TaskKind = z.infer<typeof taskKindSchema>;
export const DEFAULT_TASK_PIPELINE = taskPhaseSchema.options;
export const checkpointSchema = z.object({
  prompt: z.string(),
  step: z.number().int().min(0),
  phase: taskPhaseSchema,
  kind: taskKindSchema.default('change'),
  pipeline: z.array(taskPhaseSchema).min(2).max(5).default(DEFAULT_TASK_PIPELINE),
  groups: z.array(z.enum(TOOL_GROUP_NAMES)),
  planned: z.boolean().default(false),
  resumable: z.boolean(),
  reason: z.string(),
  summary: z.string().max(12000),
  updatedAt: z.number(),
});
export type TaskCheckpoint = z.infer<typeof checkpointSchema>;

export const taskPipelineForPrompt = (
  prompt: string,
): { kind: TaskKind; phases: TaskCheckpoint['pipeline']; instructions: string } => {
  if (
    /\b(analy[sz]e|explain|understand|review|inspect|explore)\b|проанализ|разбер|объясн|изуч|проверь\s+структур/iu.test(
      prompt,
    ) &&
    !/\b(fix|change|modify|implement|add|remove|refactor|create|build)\b|исправ|измени|поменя|добав|удали|реализ|сдела|созда|собер|улучш/iu.test(
      prompt,
    )
  )
    return {
      kind: 'analysis',
      phases: ['analysis', 'delivery'],
      instructions:
        'Read the relevant architecture and source evidence, trace the confirmed runtime flow, separate facts from unknowns, and deliver a concise cited analysis without changing files.',
    };
  if (
    /\b(improve|refactor|optimi[sz]e|upgrade|harden)\b|улучш|рефактор|оптимиз|ускор|укреп/iu.test(
      prompt,
    )
  )
    return {
      kind: 'improvement',
      phases: ['analysis', 'changes', 'checks', 'preview', 'delivery'],
      instructions:
        'Establish the current behavior or baseline, identify the limiting cause, preserve public behavior unless requested otherwise, apply the focused improvement, and compare evidence after validation.',
    };
  if (
    /\b(create|build|develop|scaffold|new project|new app)\b|созда|собер|разработ|забилд|нов(?:ый|ое)\s+(?:проект|прилож)/iu.test(
      prompt,
    )
  )
    return {
      kind: 'development',
      phases: DEFAULT_TASK_PIPELINE,
      instructions:
        'Define runnable behavior, establish or scaffold the project, implement complete source and meaningful tests, install only required dependencies, run checks, then start and exercise the real application.',
    };
  return {
    kind: 'change',
    phases: ['analysis', 'changes', 'checks', 'preview', 'delivery'],
    instructions:
      'Inspect the existing behavior and affected callers, make the smallest coherent change, add a regression test for the requested behavior, run the relevant checks, and exercise the affected flow.',
  };
};

export function phaseForTool(name: string): TaskCheckpoint['phase'] {
  if (/^(browser_|check_local_http|inspect_local_preview)/.test(name)) return 'preview';
  if (/validation|typecheck|audit|database_migrate|run_seed/.test(name)) return 'checks';
  if (/changeset|write_file|replace_text|scaffold|package_dependencies|refactor_symbol/.test(name))
    return 'changes';
  if (/^git_(commit|push)/.test(name)) return 'delivery';
  return 'analysis';
}
