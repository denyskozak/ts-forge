import type { LLMMessage } from './provider';

const SOURCE_RESULTS = new Set(['read_file', 'read_files']);

/** Keep rich receipts in the journal/UI, but send the model only the evidence it needs next. */
export function compactToolResultForModel(toolName: string | undefined, content: string) {
  if (!toolName || SOURCE_RESULTS.has(toolName)) return content;

  try {
    const value = JSON.parse(content) as unknown;
    if (toolName === 'scaffold_project' && value && typeof value === 'object') {
      const receipt = value as {
        template?: string;
        name?: string;
        workspace?: string;
        commands?: { args?: string[]; exitCode?: number; cancelled?: boolean }[];
      };
      return JSON.stringify({
        template: receipt.template,
        name: receipt.name,
        workspace: receipt.workspace,
        commands: receipt.commands?.map((command) => ({
          args: command.args,
          exitCode: command.exitCode,
          cancelled: command.cancelled,
        })),
        next: 'Inspect the generated files, then write the requested feature files.',
      });
    }

    if (content.length > 6000) {
      const trim = (item: unknown, key = ''): unknown => {
        if (typeof item === 'string') {
          const limit = /^(?:output|stdout|stderr|log)$/i.test(key) ? 1200 : 2400;
          return item.length <= limit
            ? item
            : `${item.slice(0, limit)}\n… ${item.length - limit} characters omitted from model context; full receipt remains in the UI.`;
        }
        if (Array.isArray(item)) return item.slice(0, 80).map((entry) => trim(entry));
        if (item && typeof item === 'object')
          return Object.fromEntries(
            Object.entries(item as Record<string, unknown>).map(([name, entry]) => [
              name,
              trim(entry, name),
            ]),
          );
        return item;
      };
      return JSON.stringify(trim(value));
    }
  } catch {
    // Non-JSON command output is handled below.
  }

  if (content.length <= 6000) return content;
  return `${content.slice(0, 6000)}\n… ${content.length - 6000} characters omitted from model context; full receipt remains in the UI.`;
}

/** Retain tool call/result groups together. Never silently truncate source text. */
export function budgetMessages(messages: LLMMessage[], tokens: number, toolSchemaCharacters = 0) {
  // Ollama's context limit is token based. Three characters per token is a conservative
  // mixed English/JSON estimate while still reserving about 3K tokens for generation.
  const budget = (tokens - 3072) * 3 - toolSchemaCharacters;
  const system = messages[0],
    rest = messages.slice(1);
  const groups: LLMMessage[][] = [];
  for (const message of rest) {
    if (message.role === 'tool') {
      if (groups.at(-1)?.[0].tool_calls) groups.at(-1)!.push(message);
    } else groups.push([message]);
  }
  let interrupted = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const calls = groups[i][0].tool_calls;
    if (calls && calls.length !== groups[i].length - 1) {
      groups.splice(i, 1);
      interrupted++;
    }
  }
  const lastUser = groups.findLastIndex((group) => group[0].role === 'user');
  const kept = groups.map((group, index) => ({ group, index }));
  const size = () => JSON.stringify([system, ...kept.flatMap((item) => item.group)]).length;
  while (size() > budget) {
    const index = kept.findIndex(
      (item) => item.index !== lastUser && item.index !== groups.length - 1,
    );
    if (index < 0)
      throw new Error(
        'Context budget reached. Start a focused session or increase context size in Settings. No file content was silently truncated.',
      );
    kept.splice(index, 1);
  }
  const removed = groups.length - kept.length + interrupted;
  return [
    {
      ...system,
      content:
        system.content +
        (removed
          ? `\n${removed} older or interrupted message groups were omitted. Re-read source as needed; do not assume omitted details.`
          : ''),
    },
    ...kept.flatMap((item) => item.group),
  ];
}
