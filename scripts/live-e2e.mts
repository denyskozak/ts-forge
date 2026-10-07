/** Real Electron → IPC → harness → local Ollama. Never auto-approves edits to the working repository. */
import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { livePreflight, checkSumFixture } from './live-support';
import type { AppState, Session, LocalModel, Approval } from '../shared/types';

interface CaseResult {
  id: string;
  passed: boolean;
  prompt?: string;
  startedAt?: number;
  durationMs?: number;
  approvals?: { kind: Approval['kind']; allow: boolean; paths: string[] }[];
  messages?: Session['messages'];
  task?: Session['task'];
  state?: AppState | null;
  error?: string;
  behavior?: Awaited<ReturnType<typeof checkSumFixture>>;
  undoRestored?: boolean;
}
interface LiveReport {
  startedAt: string;
  finishedAt?: string;
  status: string;
  cases: CaseResult[];
  reason?: string;
  error?: string;
  model?: LocalModel;
  endpoint?: string;
  settings?: {
    contextTokens: number;
    scenarioTimeout: number;
    maxSteps: number;
    temperature: number;
  };
  revision?: string;
  workingTreeDirty?: boolean;
}

const repository = process.cwd();
const selectedCases = process.env.FORGE_E2E_CASES?.split(',').map((id) => id.trim());
const caseNames = ['forge-understanding', 'r3f-scene-tool', 'edit-validate-undo'];
if (selectedCases?.some((id) => !caseNames.includes(id)))
  throw new Error('Unknown FORGE_E2E_CASES scenario.');
const contextTokens = Number(process.env.FORGE_E2E_CONTEXT_TOKENS ?? 32768);
const scenarioTimeout = Number(process.env.FORGE_E2E_TIMEOUT_MS ?? 240000);
if (!Number.isInteger(contextTokens) || contextTokens < 4096 || contextTokens > 65536)
  throw new Error('FORGE_E2E_CONTEXT_TOKENS must be an integer from 4096 to 65536.');
if (!Number.isInteger(scenarioTimeout) || scenarioTimeout < 1000 || scenarioTimeout > 1800000)
  throw new Error('FORGE_E2E_TIMEOUT_MS must be an integer from 1000 to 1800000.');
const output = path.join(
  repository,
  '.forge-test-results',
  new Date().toISOString().replaceAll(':', '-'),
);
await fs.mkdir(output, { recursive: true });
const report: LiveReport = { startedAt: new Date().toISOString(), status: 'running', cases: [] };
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let temp: string | undefined;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const preflight = await livePreflight(
    process.env.FORGE_E2E_ENDPOINT,
    process.env.FORGE_E2E_MODEL,
  );
  if (!preflight.ready) {
    report.status = 'skipped';
    report.reason = preflight.reason;
    console.log(`SKIP: ${preflight.reason} Set FORGE_E2E_REQUIRED=1 to fail on this condition.`);
    if (process.env.FORGE_E2E_REQUIRED === '1') process.exitCode = 1;
  } else {
    if (process.platform !== 'darwin')
      throw new Error('Live E2E currently requires macOS sandbox support.');
    report.model = preflight.model;
    report.endpoint = preflight.endpoint;
    report.settings = { contextTokens, scenarioTimeout, maxSteps: 8, temperature: 0 };
    report.revision = (
      await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    report.workingTreeDirty = !!(
      await promisify(execFile)('git', ['status', '--porcelain'], { cwd: repository })
    ).stdout.trim();
    console.log(`Live E2E: ${preflight.model.name}; no mock inference. Reports: ${output}`);
    await promisify(execFile)('npm', ['run', 'typecheck:e2e'], {
      cwd: repository,
      timeout: 120000,
    });
    await promisify(execFile)('npm', ['run', 'build'], { cwd: repository, timeout: 120000 });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-live-e2e-'));
    const sourceCopy = path.join(temp, 'forge-copy');
    const scene = path.join(temp, 'scene');
    const edit = path.join(temp, 'edit');
    for (const directory of [sourceCopy, scene, edit]) await fs.mkdir(directory);
    // Copy only known source trees and manifests, never local settings, credentials or dependencies.
    for (const name of ['src', 'electron', 'shared', 'package.json', 'tsconfig.json']) {
      await fs.cp(path.join(repository, name), path.join(sourceCopy, name), {
        recursive: true,
        filter: async (file) => !(await fs.lstat(file)).isSymbolicLink(),
      });
    }
    const original = 'export function sum(values: number[]): number { return values.length; }\n';
    await fs.writeFile(path.join(edit, 'task.ts'), original);
    await fs.writeFile(
      path.join(edit, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', noEmit: true },
        include: ['task.ts'],
      }),
    );
    await fs.writeFile(
      path.join(scene, 'package.json'),
      JSON.stringify({
        dependencies: {
          react: '19.0.0',
          three: '0.180.0',
          '@react-three/fiber': '9.0.0',
          '@react-three/drei': '10.0.0',
        },
      }),
    );
    await fs.writeFile(
      path.join(scene, 'World.tsx'),
      `import { Canvas, useFrame } from '@react-three/fiber';\nimport { useGLTF } from '@react-three/drei';\nfunction Player() { const model = useGLTF('/player.glb'); useFrame((_state, delta) => { model.scene.rotation.y += delta; }); return <primitive object={model.scene} />; }\nexport function World() { return <Canvas frameloop="always"><Player /></Canvas>; }\n`,
    );
    const digest = async (root: string): Promise<string> => {
      const hash = createHash('sha256');
      const walk = async (directory: string) => {
        for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const file = path.join(directory, item.name);
          hash.update(path.relative(root, file));
          if (item.isDirectory()) await walk(file);
          else hash.update(await fs.readFile(file));
        }
      };
      await walk(root);
      return hash.digest('hex');
    };
    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: ['.'],
      env: { ...process.env, NODE_ENV: 'test', FORGE_TEST_DATA: path.join(temp, 'state') },
    });
    await app.context().tracing.start({ screenshots: false, snapshots: true });
    const page = await app.firstWindow({ timeout: 20000 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.getByText('Good ideas deserve').waitFor();
    await page.evaluate(
      async ({ endpoint, model, contextTokens }) => {
        const state = await window.forge!.state();
        await window.forge!.settings({
          ...state.settings,
          endpoint,
          model,
          mapFormat: 'compact',
          temperature: 0,
          maxSteps: 8,
          contextTokens,
        });
      },
      { endpoint: preflight.endpoint, model: preflight.model.name, contextTokens },
    );
    // Exercise the visible connection test with real generation, not just the tags endpoint.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Ollama endpoint').fill(preflight.endpoint);
    await page.getByLabel('Local model', { exact: true }).fill(preflight.model.name);
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page.getByText('Connection verified', { exact: true }).waitFor({ timeout: 100000 });
    report.cases.push({ id: 'live-connection', passed: true });
    await page.getByRole('button', { name: /^Workspace/ }).click();

    const runCase = async (id: string, root: string, prompt: string, writable = false) => {
      console.log(`Running ${id}`);
      const result: CaseResult = {
        id,
        passed: false,
        prompt,
        startedAt: Date.now(),
        approvals: [],
      };
      report.cases.push(result);
      await save();
      const before = await digest(root);
      try {
        await app!.evaluate(({ dialog }, folder) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
        }, root);
        await page.evaluate(() => window.forge!.openWorkspace());
        // Rehydrate the UI after opening through the real IPC boundary (native picker alone is stubbed).
        await page.reload();
        await page.getByRole('textbox', { name: 'Message Forge' }).fill(prompt);
        await page.getByRole('button', { name: 'Send message' }).click();
        const deadline = Date.now() + scenarioTimeout;
        let started = false;
        const handled = new Set<string>();
        for (;;) {
          const state = await page.evaluate(() => window.forge!.state());
          const run = state.activeRun;
          if (
            run?.workspace === root &&
            state.sessions
              .find((session) => session.id === run.sessionId)
              ?.messages.some((message) => message.role === 'user' && message.content === prompt)
          )
            started = true;
          if (started && run && !['running', 'waiting'].includes(run.status)) break;
          if (Date.now() > deadline) throw new Error('Live model scenario timed out.');
          if (run?.clarification)
            throw new Error(
              `Unexpected clarification in fully specified fixture: ${run.clarification.question}`,
            );
          if (run?.approval && !handled.has(run.approval.id)) {
            const approval = run.approval;
            handled.add(approval.id);
            const session = state.sessions.find((item) => item.id === run.sessionId)!;
            const edits = approval.changeSet
              ? (session.changes?.filter((change) =>
                  approval.changeSet!.changeIds.includes(change.id),
                ) ?? [])
              : approval.change
                ? [approval.change]
                : [];
            const allow =
              writable &&
              root === edit &&
              (['typecheck', 'validation'].includes(approval.kind) ||
                (edits.length > 0 &&
                  edits.every((change) => change.path === 'task.ts' && change.workspace === edit)));
            result.approvals!.push({
              kind: approval.kind,
              allow,
              paths: edits.map((change) => change.path),
            });
            // Verify the write gate before clicking the actual approval button.
            if (allow && edits.length)
              for (const change of edits)
                assert.equal(
                  await fs.readFile(path.join(edit, change.path), 'utf8'),
                  change.before,
                );
            if (allow)
              await page
                .getByRole('button', {
                  name:
                    approval.kind === 'changeset'
                      ? 'Apply changeset'
                      : approval.kind === 'write'
                        ? 'Apply change'
                        : 'Run check',
                  exact: true,
                })
                .click();
            else {
              await page.evaluate((id) => window.forge!.approve(id, false), approval.id);
              throw new Error('Unexpected or out-of-scope approval request.');
            }
          }
          await page.waitForTimeout(250);
        }
        const state = await page.evaluate(() => window.forge!.state());
        const session = state.sessions.find((item) => item.id === state.activeRun?.sessionId)!;
        result.messages = session.messages;
        result.task = session.task;
        assert.equal(state.activeRun?.status, 'completed');
        assert.ok(
          session.messages.some(
            (message) => message.role === 'assistant' && message.content.trim(),
          ),
        );
        if (!writable) assert.equal(await digest(root), before, 'Read-only scenario changed files');
        await page.screenshot({ path: path.join(output, `${id}.png`) });
        return { result, session };
      } catch (error) {
        await page.evaluate(() => window.forge!.stop()).catch(() => {});
        await expect
          .poll(
            () =>
              page.evaluate(() => window.forge!.state().then((state) => state.activeRun?.status)),
            { timeout: 15000 },
          )
          .not.toMatch(/^(running|waiting)$/)
          .catch(() => {});
        result.error = String(error);
        result.state = await page.evaluate(() => window.forge!.state()).catch(() => null);
        await page.screenshot({ path: path.join(output, `${id}-failed.png`) }).catch(() => {});
        throw error;
      } finally {
        result.durationMs = Date.now() - result.startedAt!;
        await save();
      }
    };
    // Keep running independent scenarios after failures, and never turn a model failure into a skip.
    const scenario = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        console.error(String(error));
        const last = report.cases.at(-1)!;
        last.passed = false;
        last.error ??= String(error);
      }
      await save();
    };
    if (!selectedCases || selectedCases.includes('forge-understanding'))
      await scenario(async () => {
        const { result, session } = await runCase(
          'forge-understanding',
          sourceCopy,
          'Understand this Electron TypeScript coding-agent project. Explain the renderer → preload → main → agent flow. Cite src/App.tsx, electron/preload.ts, electron/main.ts and electron/agent.ts, distinguish source evidence from unknowns. Read-only task.',
        );
        const answer = session.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content)
          .join('\n');
        for (const filename of [
          'src/App.tsx',
          'electron/preload.ts',
          'electron/main.ts',
          'electron/agent.ts',
        ])
          assert.ok(answer.includes(filename), `Missing citation: ${filename}`);
        assert.equal(session.task?.outcome, 'analysis_only');
        result.passed = true;
      });
    if (!selectedCases || selectedCases.includes('r3f-scene-tool'))
      await scenario(async () => {
        const { result, session } = await runCase(
          'r3f-scene-tool',
          scene,
          'Call inspect_scene with an empty query, then read World.tsx. Report its Canvas, Player frame loop and model asset path with file citations. Only use read tools; keep every file unchanged.',
        );
        const tool = session.messages.find(
          (message) => message.role === 'tool' && message.name === 'inspect_scene',
        );
        assert.ok(tool, 'Model did not call inspect_scene');
        const evidence = JSON.parse(tool.content).evidence;
        for (const kind of ['canvas', 'frame', 'asset'])
          assert.ok(
            evidence.some((item: { kind: string }) => item.kind === kind),
            `Missing ${kind} evidence`,
          );
        assert.ok(
          session.messages.some(
            (message) =>
              message.role === 'tool' &&
              ['read_file', 'read_files'].includes(message.name ?? '') &&
              !message.content.startsWith('Tool error:'),
          ),
          'Model did not read the scene',
        );
        result.passed = true;
      });
    if (!selectedCases || selectedCases.includes('edit-validate-undo'))
      await scenario(async () => {
        const { result, session } = await runCase(
          'edit-validate-undo',
          edit,
          'Fix sum in task.ts to add the numeric values, returning 0 for an empty array. Preserve the exported signature. Change only task.ts. Read it first, apply the edit with review, then run typescript.check for tsconfig.json. No clarification is needed.',
          true,
        );
        assert.notEqual(
          await fs.readFile(path.join(edit, 'task.ts'), 'utf8'),
          original,
          'No change was applied',
        );
        const receipt = session.task?.validations.findLast(
          (check) => check.recipe === 'typescript.check',
        );
        const passed =
          receipt?.status === 'passed' && receipt.fingerprint === session.task?.fingerprint;

        assert.notEqual(
          session.task?.outcome,
          'completed_verified',
          'Model self-certified without human acceptance',
        );
        try {
          result.behavior = await checkSumFixture(edit, path.join(temp!, 'behavior'));
        } finally {
          const sets = session.changeSets?.filter((set) => set.status === 'applied') ?? [];
          assert.ok(sets.length, 'Missing applied changeset');
          await page.reload();
          // Persisted evidence and undo cross the same production IPC boundary after renderer reload.
          const persisted = (await page.evaluate(() => window.forge!.state())).sessions.find(
            (item) => item.id === session.id,
          )!;
          assert.deepEqual(persisted.task?.validations, session.task?.validations);
          for (const set of [...sets].reverse())
            await page.evaluate((id) => window.forge!.undoChangeSet(id), set.id);
          assert.equal(await fs.readFile(path.join(edit, 'task.ts'), 'utf8'), original);
          result.undoRestored = true;
        }
        assert.ok(passed, 'Agent did not obtain a passing real TypeScript validation');
        result.passed = true;
      });
    assert.deepEqual(pageErrors, [], 'Renderer errors');
    report.status = report.cases.every((item) => item.passed) ? 'passed' : 'failed';
    if (report.status === 'failed') process.exitCode = 1;
  }
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app
      .context()
      .tracing.stop({ path: path.join(output, 'trace.zip') })
      .catch(() => {});
    await app.close().catch(() => {});
  }
  if (temp) await fs.rm(temp, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    `${report.status.toUpperCase()}: ${report.cases.filter((item) => item.passed).length}/${report.cases.length} live cases. ${path.join(output, 'report.json')}`,
  );
}
