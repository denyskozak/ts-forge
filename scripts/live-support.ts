import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { compilerDirectory } from '../electron/compiler';
import { executeResult } from '../electron/executor';
import { localEndpoint, models, verifyLocalModel } from '../electron/provider';
export async function livePreflight(
  endpoint = 'http://127.0.0.1:11434',
  requestedModel?: string,
  dependencies = { models, verifyLocalModel },
) {
  const local = localEndpoint(endpoint);
  let installed;
  try {
    installed = await dependencies.models(local);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED')
      return { ready: false as const, reason: 'Local Ollama is not running.' };
    throw error;
  }
  const candidates = installed.filter((model) => model.supportsTools !== false);
  const chosen = requestedModel
    ? candidates.find((model) => model.name === requestedModel)
    : candidates.sort((a, b) => b.size - a.size)[0];
  if (!chosen)
    throw new Error(
      requestedModel
        ? `Installed tool model not found: ${requestedModel}`
        : 'Ollama is running but no local tool model is installed.',
    );
  await dependencies.verifyLocalModel(local, chosen.name);
  return { ready: true as const, endpoint: local, model: chosen };
}

/** Test-owned assertions are outside the agent-editable project and execute in the sandbox. */
export async function checkSumFixture(project: string, output: string) {
  await fs.mkdir(output);
  const compiler = await executeResult(
    process.execPath,
    [
      path.join(compilerDirectory(), 'bin/tsc'),
      path.join(project, 'task.ts'),
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--outDir',
      output,
    ],
    output,
    AbortSignal.timeout(30000),
    [project, output, compilerDirectory()],
    [output],
  );
  assert.equal(compiler.exitCode, 0, compiler.output);
  const marker = `FORGE_BEHAVIOR_${randomUUID()}`;
  await fs.writeFile(
    path.join(output, 'assertions.cjs'),
    `const assert = require('node:assert/strict'); const {sum} = require('./task.js'); for (const [input,expected] of [[[],0],[[2,3,-1],4],[[-2,-4],-6],[[0.5,1.25],1.75]]) assert.equal(sum(input),expected); console.log(${JSON.stringify(marker)});`,
  );
  const result = await executeResult(
    process.execPath,
    [path.join(output, 'assertions.cjs')],
    output,
    AbortSignal.timeout(10000),
    [output],
    [],
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(result.output.includes(marker), 'Behavior assertions did not reach completion');
  return result;
}
