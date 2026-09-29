import type { LLMMessage } from './provider';
/** Retain tool call/result groups together. Never silently truncate source text. */
export function budgetMessages(messages: LLMMessage[], tokens: number) {
  const budget = (tokens - 2048) * 2;
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
