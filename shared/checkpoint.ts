import { z } from 'zod';
import { TOOL_GROUP_NAMES } from './tool-policy';
export const checkpointSchema = z.object({
  prompt: z.string(),
  step: z.number().int().min(0),
  phase: z.enum(['analysis', 'changes', 'checks', 'preview', 'delivery']),
  groups: z.array(z.enum(TOOL_GROUP_NAMES)),
  planned: z.boolean().default(false),
  resumable: z.boolean(),
  reason: z.string(),
  summary: z.string().max(12000),
  updatedAt: z.number(),
});
export type TaskCheckpoint = z.infer<typeof checkpointSchema>;
export function phaseForTool(name: string): TaskCheckpoint['phase'] {
  if (/^(browser_|check_local_http|inspect_local_preview)/.test(name)) return 'preview';
  if (/validation|typecheck|audit|database_migrate|run_seed/.test(name)) return 'checks';
  if (/changeset|write_file|replace_text|scaffold|package_dependencies|refactor_symbol/.test(name))
    return 'changes';
  if (/^git_(commit|push)/.test(name)) return 'delivery';
  return 'analysis';
}
