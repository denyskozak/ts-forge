import { z } from 'zod';
import type { ConnectionTest, LocalModel } from '../shared/types';
export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Only a local HTTP endpoint is allowed, e.g. http://127.0.0.1:11434.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}
export async function localFetch(endpoint: string, route: string, init: RequestInit = {}) {
  return fetch(`${localEndpoint(endpoint)}${route}`, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(5000),
  });
}
export async function models(endpoint: string): Promise<LocalModel[]> {
  const response = await localFetch(endpoint, '/api/tags');
  if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
  const data = z
    .object({
      models: z
        .array(
          z.object({
            name: z.string(),
            size: z.number().nonnegative().default(0),
            digest: z.string().optional(),
            remote_host: z.string().optional(),
            remote_model: z.string().optional(),
            capabilities: z.array(z.string()).optional(),
            details: z
              .object({
                family: z.string().optional(),
                parameter_size: z.string().optional(),
                quantization_level: z.string().optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .parse(await response.json());
  return data.models
    .filter((m) => !m.remote_host && !m.remote_model && !/cloud/i.test(m.name))
    .map((m) => ({
      name: m.name,
      digest: m.digest,
      size: m.size,
      family: m.details?.family ?? 'unknown',
      parameters: m.details?.parameter_size ?? '',
      quantization: m.details?.quantization_level ?? '',
      supportsTools: m.capabilities ? m.capabilities.includes('tools') : undefined,
    }));
}
export async function verifyLocalModel(endpoint: string, model: string) {
  if (!(await models(endpoint)).some((m) => m.name === model))
    throw new Error('Select an installed local model. Cloud models are disabled.');
  const response = await localFetch(endpoint, '/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) throw new Error('Could not inspect the local model.');
  const data = z
    .object({
      capabilities: z.array(z.string()).optional(),
      remote_model: z.string().optional(),
      remote_host: z.string().optional(),
      modelfile: z.string().optional(),
    })
    .parse(await response.json());
  if (data.capabilities && !data.capabilities.includes('tools'))
    throw new Error(
      'This model does not support tools. Choose a local model with tool-calling support.',
    );
  if (
    data.remote_model ||
    data.remote_host ||
    /^FROM\s+.*(?:https?:|cloud)/im.test(data.modelfile ?? '')
  )
    throw new Error('Remote model execution is disabled.');
}
export interface LLMMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
  thinking?: string;
}
export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}
/** Uses Ollama only through the already validated loopback endpoint. */
export async function embed(
  endpoint: string,
  model: string,
  input: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  if (!model || !input.length) return [];
  if (input.length > 32 || input.some((text) => text.length > 6000))
    throw new Error('Embedding input exceeds the local batch limit.');
  const response = await localFetch(endpoint, '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Local embedding request failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  const result = z
    .object({ embeddings: z.array(z.array(z.number().finite())) })
    .parse(await response.json());
  if (result.embeddings.length !== input.length || result.embeddings.some((row) => !row.length))
    throw new Error('Local embedding runtime returned an invalid vector batch.');
  const dimension = result.embeddings[0].length;
  if (dimension > 4096 || result.embeddings.some((row) => row.length !== dimension))
    throw new Error('Local embedding runtime returned incompatible vector dimensions.');
  return result.embeddings;
}
export async function chat(
  endpoint: string,
  body: object,
  signal: AbortSignal,
  onToken: (text: string) => void,
): Promise<LLMMessage> {
  const response = await localFetch(endpoint, '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Model request failed (${response.status}): ${(await response.text()).slice(0, 600)}`,
    );
  if (!response.body) throw new Error('The model returned no stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  const calls: ToolCall[] = [];
  let done = false;
  let totalBytes = 0;
  const chunkSchema = z.object({
    error: z.string().optional(),
    done: z.boolean().optional(),
    message: z
      .object({
        content: z.string().optional(),
        thinking: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              function: z.object({
                name: z.string().min(1).max(100),
                arguments: z.record(z.string(), z.unknown()),
              }),
            }),
          )
          .optional(),
      })
      .optional(),
  });
  function consume(line: string) {
    if (!line.trim()) return;
    const chunk = chunkSchema.parse(JSON.parse(line));
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.message?.content) {
      content += chunk.message.content;
      onToken(chunk.message.content);
    }
    if (chunk.message?.thinking) thinking += chunk.message.thinking;
    if (chunk.message?.tool_calls) {
      calls.push(...chunk.message.tool_calls);
      if (calls.length > 32) throw new Error('Model returned too many tool calls (maximum 32).');
    }
    if (chunk.done) done = true;
  }
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > 1_000_000) throw new Error('Model output exceeded the response limit.');
      buffer += decoder.decode(part.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (content.length + thinking.length + buffer.length > 1_000_000)
        throw new Error('Model output exceeded the response limit.');
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!done) throw new Error('The model stream ended early.');
    return {
      role: 'assistant',
      content,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(thinking ? { thinking } : {}),
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function testConnection(endpoint: string, model: string): Promise<ConnectionTest> {
  const start = Date.now();
  let local = endpoint;
  try {
    local = localEndpoint(endpoint);
    const installed = await models(local);
    if (!model)
      return {
        ok: true,
        endpoint: local,
        models: installed,
        latencyMs: Date.now() - start,
        message: `Ollama is reachable. ${installed.length} local models found. Select one to test generation.`,
      };
    await verifyLocalModel(local, model);
    const response = await chat(
      local,
      {
        model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        options: { temperature: 0, num_predict: 16, num_ctx: 4096 },
        think: false,
      },
      AbortSignal.timeout(90000),
      () => {},
    );
    if (!response.content.trim())
      throw new Error('Runtime responded, but the model produced no text.');
    return {
      ok: true,
      endpoint: local,
      model,
      models: installed,
      generated: true,
      latencyMs: Date.now() - start,
      message: 'Connection, local model and text generation verified.',
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: local,
      models: [],
      model,
      latencyMs: Date.now() - start,
      message: (error as Error).message,
    };
  }
}
