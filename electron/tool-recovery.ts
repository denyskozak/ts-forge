import type { ToolCall } from './provider';

const READ_ONLY_TOOLS = new Set([
  'list_files',
  'read_file',
  'read_files',
  'search_code',
  'find_symbol',
  'project_mental_model',
  'typescript_project_analysis',
  'inspect_feature',
  'inspect_scene',
  'contribution_guide',
  'typescript_query',
]);

/**
 * Some small local models print a read-only tool envelope as their final text
 * instead of using the provider tool_calls field. Recover only the last JSON
 * object, only for known read-only tools. Mutations still require native calls.
 */
export function recoverReadOnlyToolCall(
  content: string,
): { prefix: string; call: ToolCall } | undefined {
  if (!content || content.length > 20_000) return undefined;
  const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/i);
  const start = fenced?.index ?? content.lastIndexOf('\n{');
  const candidate = fenced?.[1] ?? (start >= 0 ? content.slice(start + 1).trim() : content.trim());
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const name = envelope.name ?? envelope.tool;
  const args = envelope.parameters ?? envelope.arguments ?? {};
  if (
    typeof name !== 'string' ||
    !READ_ONLY_TOOLS.has(name) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return undefined;
  const prefix = fenced
    ? content.slice(0, start).trim()
    : start >= 0
      ? content.slice(0, start).trim()
      : '';
  return {
    prefix,
    call: { function: { name, arguments: args as Record<string, unknown> } },
  };
}
