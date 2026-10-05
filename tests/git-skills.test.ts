import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gitSkillsForPrompt } from '../shared/git-skills';
import { SKILLS, DEFAULT_SETTINGS } from '../shared/types';
import { settingsSchema } from '../electron/schema';
import { contributionGuide } from '../electron/contribution-guide';
import { Store } from '../electron/store';
import { Agent } from '../electron/agent';

test('Git intent selects focused skills in Russian and English without changing defaults', () => {
  assert.deepEqual(gitSkillsForPrompt('Закоммить и запушь в нашей ветке'), ['git']);
  assert.deepEqual(gitSkillsForPrompt('Prepare a pull request contribution'), [
    'git',
    'contributing',
  ]);
  assert.deepEqual(gitSkillsForPrompt('Сделай ревью PR и разбери конфликты'), [
    'git',
    'git-review',
    'contributing',
  ]);
  assert.deepEqual(gitSkillsForPrompt('Add a spinning mesh to the scene'), []);
  assert.deepEqual(gitSkillsForPrompt('Fix array.push and merge objects'), []);
  assert.deepEqual(gitSkillsForPrompt('Push changes to origin'), ['git']);
  const saved = settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    skills: ['git', 'git-review', 'contributing'],
  });
  assert.ok(saved.skills.includes('git'));
  assert.ok(saved.skills.includes('mcp-workflow'));
  assert.ok(saved.skills.includes('mcp-security'));
  for (const id of saved.skills) assert.ok(SKILLS.find((skill) => skill.id === id));
  assert.ok(!DEFAULT_SETTINGS.skills.includes('git'));
});

test('contribution discovery reads nested rules and templates, paginates and preserves file policy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-contribution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [filename, content] of Object.entries({
    'CONTRIBUTING.md': 'Follow the project workflow.\n'.repeat(200),
    '.github/PULL_REQUEST_TEMPLATE.md': '## Validation\n- [ ] Tests passed',
    '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Describe the bug.',
    'packages/mobile/CONTRIBUTING.md': 'Run native checks.',
    '.github/CODEOWNERS': '* @reviewer',
    '.forgeignore': 'private/\n',
    'private/CONTRIBUTING.md': 'should not be returned',
    '.git/CONTRIBUTING.md': 'metadata must remain protected',
  })) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), content);
  }
  await fs.symlink(path.join(root, 'CONTRIBUTING.md'), path.join(root, 'CONTRIBUTING.link'));
  const first = await contributionGuide(root, 0, 1);
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.completeness.selectionComplete, false);
  const file = first.files[0];
  assert.equal(file.path, 'CONTRIBUTING.md');
  assert.ok('truncated' in file && file.truncated && file.nextOffset === 3000);
  const rest = await contributionGuide(root, 1, 8);
  assert.equal(rest.nextOffset, null);
  assert.equal(rest.files.length, 4);
  assert.ok(rest.files.some((file) => file.path === 'packages/mobile/CONTRIBUTING.md'));
  assert.equal(first.capabilities.commit, true);
  assert.equal(first.capabilities.push, true);
  assert.equal(first.capabilities.gitStatus, true);
  assert.equal(first.capabilities.fetch, false);
  assert.equal(first.capabilities.publishPullRequest, false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(contributionGuide(root, 0, 1, aborted.signal));
});

test('Git request injects capability limits and returns real contribution rules through the agent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-git-agent-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'CONTRIBUTING.md'), 'Use focused commits. Run npm test.');
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"local","size":1}]}');
    if (req.url === '/api/show') return res.end('{"capabilities":["tools"]}');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.end(
      JSON.stringify({
        message:
          requests.length === 1
            ? {
                content: '',
                tool_calls: [{ function: { name: 'contribution_guide', arguments: {} } }],
              }
            : { content: 'Proposed manual commit workflow; no Git command was executed.' },
        done: true,
      }) + '\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = new Store(path.join(root, 'state'));
  await store.load();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'local',
    mapFormat: 'compact',
    skills: ['typescript'],
  };
  await new Agent(store, () => {}).run('Prepare a Git commit and pull request plan.');
  const system = requests[0].messages.find((message) => message.role === 'system')!.content;
  assert.match(system, /git_status, git_diff and git_log/);
  assert.match(system, /git_stage_files/);
  assert.match(system, /git_push with a confirmed remote and branch/);
  assert.match(system, /Mandatory MCP workflow/);
  assert.match(system, /Mandatory problem understanding/);
  assert.match(system, /Mandatory complete delivery/);
  assert.match(system, /Mandatory sustainable design/);
  assert.match(system, /Mandatory evidence-driven testing/);
  assert.match(system, /Mandatory MCP trust boundaries/);
  assert.match(system, /has no MCP client/);
  assert.match(system, /plain Git commit includes the whole index/);
  assert.match(system, /ready-to-use PR text/);
  const result = store.value.sessions[0].messages.find(
    (message) => message.name === 'contribution_guide',
  );
  assert.ok(result);
  const guide = JSON.parse(result.content);
  assert.equal(guide.files[0].content, 'Use focused commits. Run npm test.');
  assert.equal(guide.capabilities.push, true);
  assert.equal(guide.capabilities.publishPullRequest, false);
  assert.deepEqual(store.value.settings.skills, ['typescript']);
  assert.equal(store.value.sessions[0].changes?.length, 0);
});
