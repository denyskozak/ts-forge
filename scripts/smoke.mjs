import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'forge-smoke-')),
  project = path.join(temp, 'fixture'),
  secondProject = path.join(temp, 'second-fixture');
await mkdir(project);
await mkdir(secondProject);
const original = 'export const hello: string = "world";\n';
await writeFile(path.join(project, 'index.ts'), original);
await writeFile(
  path.join(project, 'package.json'),
  JSON.stringify({ name: 'forge-build-fixture', scripts: { dev: 'node server.mjs' } }),
);
await writeFile(
  path.join(project, 'server.mjs'),
  String.raw`import http from 'node:http';
const server = http.createServer((_, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<main><h1>Forge preview ready</h1><label>Name<input id="name"></label><select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select><button id="action" onclick="document.getElementById(\'result\').textContent=\'Clicked\'">Test action</button><p id="result">Ready</p></main>');
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`,
);
await writeFile(
  path.join(project, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { target: 'ES2022', strict: true, noEmit: true },
    include: ['index.ts'],
  }),
);
await writeFile(path.join(secondProject, 'main.ts'), 'export const second = true;\n');
await writeFile(
  path.join(secondProject, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: false, noEmit: true }, include: ['main.ts'] }),
);
let step = 0;
let featureStep = -1;
let browserStep = -1;
let browserUrl = '';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url === '/api/tags')
    return res.end('{"models":[{"name":"fixture:local","size":1024,"capabilities":["tools"]}]}');
  if (req.url === '/api/show') return res.end('{"capabilities":["tools"]}');
  if (!body.tools)
    return res.end(JSON.stringify({ message: { content: 'OK' }, done: true }) + '\n');
  if (browserStep >= 0) {
    const calls = [
      { name: 'browser_open', arguments: { url: browserUrl } },
      { name: 'browser_snapshot', arguments: {} },
      { name: 'browser_fill', arguments: { selector: '#name', value: 'Forge' } },
      { name: 'browser_select', arguments: { selector: '#theme', value: 'dark' } },
      { name: 'browser_wait', arguments: { selector: '#action' } },
      { name: 'browser_click', arguments: { selector: '#action' } },
      {
        name: 'browser_assert',
        arguments: { selector: '#result', condition: 'text', expected: 'Clicked' },
      },
      { name: 'browser_viewport', arguments: { preset: 'phone' } },
      { name: 'browser_screenshot', arguments: {} },
    ];
    const call = calls[browserStep++];
    return res.end(
      JSON.stringify({
        message: call
          ? { content: '', tool_calls: [{ function: call }] }
          : { content: 'Browser checks passed.' },
        done: true,
      }) + '\n',
    );
  }
  if (featureStep >= 0) {
    const calls = [
      {
        name: 'plan_task',
        arguments: {
          goal: 'Extract the greeting into a feature module',
          criteria: ['The greeting comes from the feature module'],
          constraints: ['Preserve the hello export'],
          requiredChecks: [{ recipe: 'typescript.check', project: 'tsconfig.json' }],
        },
      },
      { name: 'read_file', arguments: { path: 'index.ts' } },
      {
        name: 'apply_changeset',
        arguments: {
          rationale: 'Keep the public export and its new implementation together',
          edits: [
            {
              path: 'index.ts',
              content:
                'import { greeting } from "./feature";\nexport const hello: string = greeting;\n',
            },
            { path: 'feature.ts', content: 'export const greeting = "forge";\n' },
          ],
        },
      },
      {
        name: 'run_validation',
        arguments: { recipe: 'typescript.check', project: 'tsconfig.json' },
      },
    ];
    const call = calls[featureStep++];
    return res.end(
      JSON.stringify({
        message: call
          ? { content: '', tool_calls: [{ function: call }] }
          : {
              content:
                'The two-file feature is applied. TypeScript passed; please review acceptance.',
            },
        done: true,
      }) + '\n',
    );
  }
  let message;
  if (step++ === 0)
    message = {
      content: 'I need one decision before changing the public value.',
      tool_calls: [
        {
          function: {
            name: 'ask_user_question',
            arguments: {
              question: 'Which compatibility target should the greeting use?',
              reason: 'This decision changes the exported value expected by downstream code.',
              options: [
                { label: 'Current API', description: 'Update consumers to the new greeting.' },
                { label: 'Legacy API', description: 'Keep compatibility with the old greeting.' },
              ],
            },
          },
        },
      ],
    };
  else if (step === 2) {
    message = {
      content: 'Planning the change.',
      tool_calls: [
        {
          function: {
            name: 'plan_task',
            arguments: {
              goal: 'Change world to forge',
              criteria: ['The greeting is forge and callers stay compatible'],
              requiredChecks: [{ recipe: 'typescript.check', project: 'tsconfig.json' }],
            },
          },
        },
      ],
    };
  } else if (step === 3) {
    message = {
      content: 'Inspecting the source.',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'index.ts' } } }],
    };
  } else if (step === 4) {
    const source = JSON.parse(body.messages.at(-1).content);
    message = {
      content: 'A targeted change is ready for review.',
      tool_calls: [
        {
          function: {
            name: 'replace_text',
            arguments: {
              path: 'index.ts',
              hash: source.hash,
              oldText: '"world"',
              newText: '"forge"',
            },
          },
        },
      ],
    };
  } else if (step === 5)
    message = {
      content: 'Checking symbols.',
      tool_calls: [
        {
          function: {
            name: 'typescript_query',
            arguments: { kind: 'diagnostics', path: 'index.ts' },
          },
        },
      ],
    };
  else if (step === 6)
    message = {
      content: 'Checking the project.',
      tool_calls: [{ function: { name: 'typecheck', arguments: { project: 'tsconfig.json' } } }],
    };
  else message = { content: 'The greeting was updated and checked.' };
  res.end(JSON.stringify({ message, done: true }) + '\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}`;
const app = await electron.launch({
  executablePath: process.env.FORGE_SMOKE_APP || electronPath,
  args: process.env.FORGE_SMOKE_APP
    ? ['--use-fake-device-for-media-stream']
    : ['.', '--use-fake-device-for-media-stream'],
  env: { ...process.env, NODE_ENV: 'test', FORGE_TEST_DATA: path.join(temp, 'state') },
});
app.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
try {
  const page = await app.firstWindow({ timeout: 20000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('Good ideas deserve').waitFor();
  await expect(page.locator('.context-panel')).toHaveCount(0);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    '15px',
  );
  await page.getByRole('button', { name: 'Show context panel', exact: true }).click();
  await expect(page.locator('.context-panel')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hide context panel', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Hide context panel', exact: true }).click();
  await expect(page.locator('.context-panel')).toHaveCount(0);
  assert.equal(await page.evaluate(() => typeof window.forge), 'object');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(
    await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioOnly = stream.getAudioTracks().length > 0 && stream.getVideoTracks().length === 0;
      stream.getTracks().forEach((track) => track.stop());
      return audioOnly;
    }),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((track) => track.stop());
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.evaluate(() => {
    class FakeSpeechRecognition extends EventTarget {
      static async available() {
        return 'available';
      }
      continuous = false;
      interimResults = false;
      lang = '';
      processLocally = false;
      onresult = null;
      onerror = null;
      onend = null;
      start() {
        setTimeout(
          () =>
            this.onresult?.({
              resultIndex: 0,
              results: [{ 0: { transcript: 'voice transcript' }, isFinal: true }],
            }),
          0,
        );
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    Object.defineProperty(globalThis, 'SpeechRecognition', {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => ({ getTracks: () => [{ stop() {} }] }),
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: class {
        createAnalyser() {
          return {
            fftSize: 128,
            smoothingTimeConstant: 0,
            frequencyBinCount: 64,
            getByteFrequencyData(values) {
              values.fill(80);
            },
          };
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        async close() {}
      },
    });
  });
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.getByRole('status', { name: 'Voice input active' }).waitFor();
  await page.screenshot({ path: 'docs/forge-voice.png' });
  await page.getByRole('button', { name: 'Stop voice input' }).click();
  await expect(page.getByRole('textbox', { name: 'Message Forge' })).toHaveValue(
    'voice transcript',
  );
  await page.getByRole('textbox', { name: 'Message Forge' }).fill('');
  await page.screenshot({ path: 'docs/forge-preview.png' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Ollama endpoint').fill(endpoint);
  await page.getByLabel('Local model', { exact: true }).fill('fixture:local');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText('Connection verified', { exact: true }).waitFor();
  assert.notEqual((await page.evaluate(() => window.forge.state())).settings.endpoint, endpoint);
  await page.getByRole('button', { name: 'Add SSH server', exact: true }).click();
  const sshCredentials = page.getByRole('combobox', { name: 'Credentials' });
  await expect(sshCredentials).toHaveValue('system');
  await sshCredentials.selectOption('key');
  await expect(page.getByRole('button', { name: 'Choose key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.screenshot({ path: 'docs/forge-settings.png' });
  await page.getByLabel('Map format').selectOption('compact');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect
    .poll(() => page.evaluate(() => window.forge.state().then((s) => s.settings.endpoint)))
    .toBe(endpoint);
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await page.getByRole('button', { name: 'Your workspace Open a project to begin' }).click();
  await page.getByText('Good ideas deserve').waitFor();
  await page.getByRole('button', { name: 'Show context panel', exact: true }).click();
  await page.getByRole('button', { name: 'View project map' }).waitFor();
  assert.ok(
    (await page.evaluate(() => window.forge.state())).workspace.map.content.includes('hello'),
  );
  const firstWorkspaceState = await page.evaluate(() => window.forge.state());
  assert.equal(firstWorkspaceState.workspaces.length, 1);
  assert.equal(firstWorkspaceState.workspace.map.typescript.compiler.strict, true);
  await page.getByRole('button', { name: 'Build loop', exact: true }).click();
  await page.getByRole('button', { name: /dev\s*node server\.mjs/ }).click();
  await expect(page.getByText('running', { exact: true })).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="Local project preview"]').getByText('Forge preview ready'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Phone', exact: true }).click();
  await expect(page.locator('.preview-stage')).toHaveClass(/phone/);
  const previousPreviewUrl = await page.evaluate(() =>
    window.forge.developmentProcesses().then((items) => items.find((item) => item.running).urls[0]),
  );
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByText('running', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.forge
          .developmentProcesses()
          .then((items) => items.find((item) => item.running)?.urls[0]),
      ),
    )
    .not.toBe(previousPreviewUrl);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.forge
          .developmentProcesses()
          .then((items) => items.some((item) => item.running && item.health === 'ready')),
      ),
    )
    .toBe(true);
  browserUrl = await page.evaluate(() =>
    window.forge.developmentProcesses().then((items) => items.find((item) => item.running).urls[0]),
  );
  browserStep = 0;
  await page.getByRole('button', { name: /^Workspace/ }).click();
  await page
    .getByRole('textbox', { name: 'Message Forge' })
    .fill('Inspect the local browser preview and verify its controls.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('button', { name: 'Stop agent' }).waitFor({ state: 'hidden' });
  const browserState = await page.evaluate(() => window.forge.state());
  const browserMessages = browserState.sessions.find(
    (session) => session.id === browserState.activeRun.sessionId,
  ).messages;
  assert.ok(
    browserMessages.some((message) => message.name === 'browser_assert'),
    JSON.stringify({ run: browserState.activeRun, messages: browserMessages }),
  );
  assert.equal(
    JSON.parse(browserMessages.find((message) => message.name === 'browser_assert').content).passed,
    true,
    JSON.stringify(browserMessages.filter((message) => message.role === 'tool')),
  );
  assert.ok(
    JSON.parse(
      browserMessages.find((message) => message.name === 'browser_snapshot').content,
    ).elements.every((element) => element.selector),
  );
  const capture = JSON.parse(
    browserMessages.find((message) => message.name === 'browser_screenshot').content,
  );
  assert.equal(capture.viewport.width, 390);
  await page.getByRole('button', { name: 'View screenshot', exact: true }).click();
  await expect(page.getByAltText('Captured local preview')).toBeVisible();
  await expect
    .poll(() => page.getByAltText('Captured local preview').evaluate((image) => image.naturalWidth))
    .toBe(390 * capture.viewport.scaleFactor);
  await assert.rejects(
    page.evaluate(() => window.forge.previewImage('/etc/passwd')),
    /preview artifact/,
  );
  browserStep = -1;
  await page.getByRole('button', { name: 'Build loop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText(/exit stopped/)).toBeVisible();
  await page.getByRole('button', { name: /^Workspace/ }).click();
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, secondProject);
  await page.getByRole('button', { name: 'fixture Local project' }).click();
  await page.getByRole('button', { name: 'Open another project' }).click();
  await expect
    .poll(() => page.evaluate(() => window.forge.state().then((s) => s.workspace.name)))
    .toBe('second-fixture');
  assert.equal((await page.evaluate(() => window.forge.state())).workspaces.length, 2);
  await page.getByRole('button', { name: 'second-fixture Local project' }).click();
  await page
    .getByRole('button', { name: 'fixture TypeScript analysis ready', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.forge.state().then((s) => s.workspace.name)))
    .toBe('fixture');
  await page.getByRole('button', { name: 'fixture Local project' }).click();
  await page.screenshot({ path: 'docs/forge-workspaces.png' });
  await page.getByRole('button', { name: 'fixture Local project' }).click();
  await page.getByRole('textbox', { name: 'Message Forge' }).fill('Change world to forge.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page
    .getByRole('group', { name: 'Forge question' })
    .waitFor()
    .catch(async (error) => {
      console.error(JSON.stringify(await page.evaluate(() => window.forge.state())));
      throw error;
    });
  await page.reload();
  await page.getByRole('group', { name: 'Forge question' }).waitFor();
  await page.screenshot({ path: 'docs/forge-clarification.png' });
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled();
  await page
    .getByLabel('Or write your own answer')
    .fill('Current API, keep existing callers compatible.');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.getByRole('button', { name: 'Apply change' }).waitFor();
  await page.locator('.diff .added').filter({ hasText: 'forge' }).first().waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Apply change' }).waitFor();
  await page.getByRole('button', { name: 'Apply change' }).click();
  await page.getByRole('button', { name: 'Run check', exact: true }).click();
  await page.getByRole('button', { name: 'Stop agent' }).waitFor({ state: 'hidden' });
  const checked = await page.evaluate(() => window.forge.state());
  assert.match(
    checked.sessions[0].messages.find((m) => m.name === 'ask_user_question').content,
    /keep existing callers compatible/,
  );
  assert.match(
    checked.sessions[0].messages.find((m) => m.name === 'typecheck').content,
    /Exit code: 0/,
  );
  assert.deepEqual(
    JSON.parse(checked.sessions[0].messages.find((m) => m.name === 'typescript_query').content)
      .diagnostics,
    [],
  );
  assert.match(await readFile(path.join(project, 'index.ts'), 'utf8'), /"forge"/);
  await page.getByRole('button', { name: /^Changes/ }).click();
  await page.getByRole('button', { name: 'Undo change', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.forge.state().then((s) => s.sessions[0].changes[0].status)),
    )
    .toBe('undone');
  assert.equal(await readFile(path.join(project, 'index.ts'), 'utf8'), original);
  await page.evaluate(async () => {
    const state = await window.forge.state();
    await window.forge.settings({ ...state.settings, maxSteps: 3 });
  });
  featureStep = 0;
  await page
    .getByRole('textbox', { name: 'Message Forge' })
    .fill('Extract greeting into a new feature module and preserve hello.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Apply changeset', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Impact preview' }).last().waitFor();
  assert.equal(await readFile(path.join(project, 'index.ts'), 'utf8'), original);
  await page.reload();
  await page.getByRole('button', { name: 'Apply changeset', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/forge-task-review.png' });
  await page.getByRole('button', { name: 'Apply changeset', exact: true }).click();
  await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();
  await expect(page.getByRole('region', { name: 'Task progress' })).toContainText('Pass 3');
  await page.reload();
  await page.getByRole('button', { name: 'Resume task', exact: true }).click();
  await page.getByRole('button', { name: 'Run check', exact: true }).click();
  await page.getByRole('button', { name: 'Stop agent' }).waitFor({ state: 'hidden' });
  const featureState = await page.evaluate(() => window.forge.state());
  assert.equal(featureState.sessions[0].checkpoint.step, 5);
  await page.evaluate(async () => {
    const state = await window.forge.state();
    await window.forge.settings({ ...state.settings, maxSteps: 12 });
  });
  assert.equal(featureState.sessions[0].task.outcome, 'completed_unverified');
  assert.equal(featureState.sessions[0].task.validations.at(-1).status, 'passed');
  assert.match(await readFile(path.join(project, 'index.ts'), 'utf8'), /import/);
  const checkboxes = page.locator('.task-criterion input');
  for (let index = 0; index < (await checkboxes.count()); index++) {
    await checkboxes.nth(index).click();
    await expect(checkboxes.nth(index)).toBeChecked();
  }
  await expect
    .poll(() => page.evaluate(() => window.forge.state().then((s) => s.sessions[0].task.outcome)))
    .toBe('completed_verified');
  await page.screenshot({ path: 'docs/forge-task-verified.png' });
  await page.getByRole('button', { name: /^Changes/ }).click();
  await page.getByRole('button', { name: 'Undo changeset', exact: true }).click();
  await expect.poll(() => readFile(path.join(project, 'index.ts'), 'utf8')).toBe(original);
  await assert.rejects(readFile(path.join(project, 'feature.ts'), 'utf8'));
  assert.equal(
    (await page.evaluate(() => window.forge.state())).sessions[0].task.outcome,
    'completed_unverified',
  );
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  for (const name of [
    'Problem Understanding',
    'Complete Delivery',
    'Sustainable Design',
    'Evidence-driven Testing',
    'MCP Workflow',
    'MCP Security',
  ]) {
    const toggle = page.getByRole('button', { name: `Toggle ${name}`, exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
  const normalized = await page.evaluate(async () => {
    const state = await window.forge.state();
    return window.forge.settings({
      ...state.settings,
      skills: state.settings.skills.filter((id) => !id.startsWith('mcp-')),
    });
  });
  assert.ok(normalized.skills.includes('mcp-workflow'));
  assert.ok(normalized.skills.includes('mcp-security'));
  await page.getByRole('button', { name: 'Toggle React Three Fiber' }).click();
  assert.ok(
    (await page.evaluate(() => window.forge.state())).settings.skills.includes('react-three'),
  );
  for (const [name, id] of [
    ['Git Workflow', 'git'],
    ['Git Review', 'git-review'],
    ['Contributing', 'contributing'],
  ]) {
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (skillId) =>
            window.forge.state().then((state) => state.settings.skills.includes(skillId)),
          id,
        ),
      )
      .toBe(true);
  }
  await page.getByRole('button', { name: 'Toggle Next.js' }).click();
  assert.ok((await page.evaluate(() => window.forge.state())).settings.skills.includes('next'));
  await page.getByRole('button', { name: 'Training lab LAB' }).click();
  await page.getByRole('heading', { name: 'Teach it your way.' }).waitFor();
  await page.screenshot({ path: 'docs/forge-training.png' });
  await page.getByRole('button', { name: 'Add example', exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('Explain a discriminated union.');
  await page
    .getByLabel('Ideal response')
    .fill('Use a shared literal property to narrow each union member.');
  await page.getByRole('button', { name: 'Save reviewed example' }).click();
  await page.getByText('Explain a discriminated union.', { exact: true }).first().waitFor();
  assert.equal((await page.evaluate(() => window.forge.state())).examples.length, 1);
  if (process.env.FORGE_LIVE_SMOKE === '1') {
    const state = await page.evaluate(() => window.forge.state());
    await page.evaluate((settings) => window.forge.settings(settings), {
      ...state.settings,
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:1.5b',
    });
    const result = await page.evaluate(() =>
      window.forge.testConnection('http://127.0.0.1:11434', 'qwen2.5:1.5b'),
    );
    assert.equal(result.ok, true);
    assert.equal(result.generated, true);
    console.log('PASS: live local model connection and generation');
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: on-device voice draft UI, desktop model and SSH settings, multiple workspaces, automatic TypeScript analysis, project map, reload during clarification and approval, targeted edit, persisted checkpoint, undo, skills, dataset',
  );
} finally {
  await app.close();
  server.close();
  server.closeAllConnections();
  await rm(temp, { recursive: true, force: true });
}
