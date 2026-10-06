/** Credentials belong to server configuration, never tool arguments or model-visible reviews. */
export function validateMcpArguments(args: Record<string, unknown>) {
  const json = JSON.stringify(args);
  if (json.length > 8000) throw new Error('MCP arguments exceed the reviewable 8 KB limit.');
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:authorization|password|api[_-]?key|access[_-]?token|client[_-]?secret)$/i.test(key))
        throw new Error(
          'Configure credentials through environment references in MCP Settings, not tool arguments.',
        );
      visit(child);
    }
  };
  visit(args);
  return args;
}
