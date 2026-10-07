import type { ToolCall } from './provider';
import type { ZodType } from 'zod';

const SAFE_TEXT_RECOVERY_TOOLS = new Set([
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
  'search_local_knowledge',
  'discover_validation_plan',
  'inspect_native_project',
  'product_architecture',
  'api_contracts',
  'check_local_http',
  'product_recipes',
  'ssh_profiles',
  'project_templates',
  'package_scripts',
  'list_package_processes',
  'browser_snapshot',
  'git_status',
  'git_diff',
  'git_log',
  'plan_task',
  'enable_tool_group',
  'skill_instructions',
]);
const AUTO_INVOKE_READ_ONLY_TOOLS = new Set(
  [...SAFE_TEXT_RECOVERY_TOOLS].filter(
    (name) => !['plan_task', 'enable_tool_group', 'skill_instructions'].includes(name),
  ),
);

export function isAutoInvokableReadOnlyTool(name: string) {
  return AUTO_INVOKE_READ_ONLY_TOOLS.has(name);
}

/**
 * Some small local models print a safe tool envelope as their final text
 * instead of using the provider tool_calls field. Recover only the last JSON
 * object, only for read-only/session-planning tools. Mutations still require
 * native calls and their normal review boundary.
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
    !SAFE_TEXT_RECOVERY_TOOLS.has(name) ||
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

/** Parses the schema-constrained fallback used when a small local model ignores native tools. */
export function recoverForcedToolCall(
  content: string,
  allowedNames: ReadonlySet<string>,
): ToolCall | undefined {
  const trimmed = content.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  try {
    const value = JSON.parse(candidate) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.name !== 'string' ||
      !allowedNames.has(record.name) ||
      !record.arguments ||
      typeof record.arguments !== 'object' ||
      Array.isArray(record.arguments)
    )
      return undefined;
    return {
      function: {
        name: record.name,
        arguments: record.arguments as Record<string, unknown>,
      },
    };
  } catch {
    return undefined;
  }
}

function decodeJsonContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJsonContainers);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeJsonContainers(child)]),
    );
  if (typeof value !== 'string' || value.length > 20_000) return value;
  const text = value.trim();
  if (!(
    (text.startsWith('[') && text.endsWith(']')) ||
    (text.startsWith('{') && text.endsWith('}'))
  ))
    return value;
  try {
    return decodeJsonContainers(JSON.parse(text));
  } catch {
    return value;
  }
}

/**
 * Ollama-compatible local models occasionally JSON-encode arrays a second time,
 * wrap string items as objects, use common argument aliases or invent an absolute
 * prefix. Accept a repair only when the complete result passes the advertised schema.
 */
export function normalizeToolArguments(
  name: string,
  args: Record<string, unknown>,
  schema: ZodType,
  knownPaths: string[] = [],
): { arguments: Record<string, unknown>; repaired: boolean } {
  const original = schema.safeParse(args);
  const decoded = decodeJsonContainers(args);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    return original.success
      ? { arguments: original.data as Record<string, unknown>, repaired: false }
      : { arguments: args, repaired: false };
  const repaired = { ...(decoded as Record<string, unknown>) };
  if (
    ['read_file', 'write_file', 'replace_text'].includes(name) &&
    typeof repaired.path !== 'string' &&
    typeof repaired.filePath === 'string'
  ) {
    const requested = repaired.filePath.replaceAll('\\', '/');
    const match = knownPaths.find(
      (filename) => requested === filename || requested.endsWith('/' + filename),
    );
    repaired.path = match ?? repaired.filePath;
    delete repaired.filePath;
  }
  if (
    ['read_file', 'write_file', 'replace_text'].includes(name) &&
    typeof repaired.path === 'string'
  ) {
    const requested = repaired.path.replaceAll('\\', '/');
    const match = knownPaths.find(
      (filename) => requested === filename || requested.endsWith('/' + filename),
    );
    if (match) repaired.path = match;
  }
  if (
    name === 'read_files' &&
    !Array.isArray(repaired.paths) &&
    Array.isArray(repaired.filePaths)
  ) {
    repaired.paths = repaired.filePaths.map((value) => {
      if (typeof value !== 'string') return value;
      const requested = value.replaceAll('\\', '/');
      return (
        knownPaths.find(
          (filename) => requested === filename || requested.endsWith('/' + filename),
        ) ?? value
      );
    });
    delete repaired.filePaths;
  }
  if (name === 'replace_text') {
    if (typeof repaired.oldText !== 'string')
      repaired.oldText = repaired.old_text ?? repaired.search ?? repaired.text;
    if (typeof repaired.newText !== 'string')
      repaired.newText = repaired.new_text ?? repaired.replacement ?? repaired.replacementText;
    for (const key of ['old_text', 'search', 'text', 'new_text', 'replacement', 'replacementText'])
      delete repaired[key];
  }
  if (
    ['typecheck', 'run_validation'].includes(name) &&
    typeof repaired.project !== 'string' &&
    typeof repaired.tsconfigPath === 'string'
  ) {
    repaired.project = repaired.tsconfigPath;
    delete repaired.tsconfigPath;
  }
  if (name === 'plan_task') {
    for (const key of ['constraints', 'outOfScope', 'criteria']) {
      const values = repaired[key];
      if (Array.isArray(values))
        repaired[key] = values.map((value) => {
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).description === 'string'
          )
            return (value as Record<string, unknown>).description;
          return value;
        });
    }
  }
  if (name === 'ask_user_question' && Array.isArray(repaired.options)) {
    const options: unknown[] = repaired.options.slice(0, 3);
    if (options.length === 2)
      options.push({
        label: 'Let Forge choose',
        description: 'Use the safest reversible default supported by the project.',
      });
    repaired.options = options;
  }
  const result = schema.safeParse(repaired);
  const changed = JSON.stringify(repaired) !== JSON.stringify(args);
  if (result.success && (!original.success || changed))
    return { arguments: result.data as Record<string, unknown>, repaired: true };
  return original.success
    ? { arguments: original.data as Record<string, unknown>, repaired: false }
    : { arguments: args, repaired: false };
}
