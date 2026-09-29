/** Real local-model baseline. Auto-approval is confined to generated temporary fixtures. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { Store } from '../electron/store';
import { Agent } from '../electron/agent';
import { execute } from '../electron/executor';
import { models } from '../electron/provider';
const endpoint = process.env.FORGE_EVAL_ENDPOINT ?? 'http://127.0.0.1:11434';
const model = process.env.FORGE_EVAL_MODEL ?? 'qwen2.5:1.5b';
const cases = [
  {
    id: 'sum-array',
    source: 'export function sum(values: number[]): number { return values.length; }\n',
    prompt:
      'Fix sum in task.ts: return the sum of the numbers, including zero for an empty array. Preserve the function signature. Apply the change.',
    checks: 'assert.equal(sum([]),0);assert.equal(sum([2,3,-1]),4);assert.equal(sum([-2,-4]),-6);',
  },
  {
    id: 'nullable-label',
    source: 'export function label(value: string | null): string { return value.trim(); }\n',
    prompt:
      'Fix label in task.ts: null returns an empty string, strings are trimmed. Preserve the function signature. Apply the change.',
    checks:
      'assert.equal(label(null),"");assert.equal(label(" a "),"a");assert.equal(label(""),"");',
  },
];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-eval-'));
const results: object[] = [];
try {
  const info = (await models(endpoint)).find((item) => item.name === model);
  assert.ok(info, 'Install the chosen model before evaluation.');
  for (const fixture of cases) {
    const directory = path.join(temp, fixture.id),
      project = path.join(directory, 'project'),
      output = path.join(directory, 'check');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(output);
    await fs.writeFile(path.join(project, 'task.ts'), fixture.source);
    const store = new Store(path.join(directory, 'state'));
    await store.load();
    store.value.workspacePath = project;
    store.value.settings = {
      ...store.value.settings,
      endpoint,
      model,
      mapFormat: 'compact',
      temperature: 0,
      maxSteps: 8,
      contextTokens: 8192,
    };
    let approvals = 0;
    const errors: string[] = [];
    const start = Date.now();
    const agent = new Agent(store, (event) => {
      if (event.type === 'approval') {
        approvals++;
        agent.approve(event.approval.id, event.approval.kind === 'write');
      }
      if (event.type === 'error') errors.push(event.error);
    });
    const timeout = setTimeout(() => agent.stop(), 180000);
    await agent.run(fixture.prompt);
    clearTimeout(timeout);
    let passed = false,
      validation = '';
    try {
      const source = await fs.readFile(path.join(project, 'task.ts'), 'utf8');
      assert.notEqual(source, fixture.source, 'No edit applied');
      const code = ts.transpile(source, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      });
      const check = path.join(output, 'assertions.cjs');
      await fs.writeFile(
        check,
        code +
          '\nconst assert=require("node:assert/strict");\n' +
          fixture.checks +
          '\nconsole.log("FORGE_ASSERTIONS_PASSED");',
      );
      validation = await execute(
        process.execPath,
        [check],
        output,
        AbortSignal.timeout(10000),
        [output, path.dirname(process.execPath)],
        [],
      );
      assert.match(validation, /Exit code: 0/);
      assert.match(validation, /FORGE_ASSERTIONS_PASSED/);
      passed = true;
    } catch (error) {
      validation = String(error);
    }
    results.push({
      id: fixture.id,
      passed,
      durationMs: Date.now() - start,
      approvals,
      errors,
      validation,
      toolCalls: store.value.sessions[0].messages
        .filter((m) => m.role === 'tool')
        .map((m) => ({
          name: m.name,
          error: m.content.startsWith('Tool error:'),
          detail: m.content.startsWith('Tool error:') ? m.content : undefined,
        })),
      transcript: store.value.sessions[0].messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
      })),
    });
    await store.close();
    console.log(`${passed ? 'PASS' : 'FAIL'} ${fixture.id}`);
  }
  const report = {
    modelDigest: info.digest,
    createdAt: new Date().toISOString(),
    harness: '0.2.0',
    model,
    endpoint,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    settings: { temperature: 0, contextTokens: 8192, maxSteps: 8 },
    scope: 'Two temporary TypeScript fixtures; not a React/Next quality benchmark.',
    results,
  };
  const destination = path.resolve(process.env.FORGE_EVAL_REPORT ?? 'docs/local-evaluation.json');
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(destination);
  if (results.some((r) => !(r as { passed: boolean }).passed)) process.exitCode = 1;
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
