const internalReceipt = (paragraph: string) => {
  const trimmed = paragraph.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  if (
    trimmed.startsWith('{') &&
    /"(?:name|tool)"\s*:\s*"[a-z0-9_]+"/i.test(trimmed) &&
    /"(?:parameters|arguments)"\s*:/i.test(trimmed)
  )
    return true;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    const taskReceipt =
      value !== null &&
      ('runId' in value || 'appliedChanges' in value) &&
      ('outcome' in value || 'requiredChecks' in value);
    const toolEnvelope =
      value !== null &&
      ('name' in value || 'tool' in value) &&
      ('parameters' in value || 'arguments' in value);
    return taskReceipt || toolEnvelope;
  } catch {
    return false;
  }
};

export function presentAssistantText(content: string) {
  let removedCode = false;
  const withoutCode = content.replace(/```[\s\S]*?```/g, () => {
    removedCode = true;
    return '';
  });
  const visible = withoutCode
    .split(/\n\s*\n/)
    .filter((paragraph) => {
      if (!internalReceipt(paragraph)) return true;
      return false;
    })
    .join('\n\n')
    .replace(/(?:Окончательный ответ|Final answer)\s*:\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return visible || (removedCode ? 'Implementation written directly to the project.' : '');
}
