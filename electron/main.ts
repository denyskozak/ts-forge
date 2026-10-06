import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session as electronSession,
  protocol,
  net,
} from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { settingsSchema } from './schema';
import { analyzeProject } from './project-map';
import { recoverInterrupted, undoChange } from './changes';
import { Store } from './store';
import { Agent } from './agent';
import { undoChangeSet } from './change-sets';
import { taskOutcome } from '../shared/task';
import { workspaceFingerprint, runValidation } from './validation';
import { analyzeImpact, closeAnalysis, invalidateAnalysis } from './language-tools';
import { Trainer, exportDataset } from './training';
import { models, testConnection } from './provider';
import { sshProfileSchema, testSsh } from './ssh';
import { closeInteractiveBrowser, showInteractiveBrowser, browserOpen } from './project-runtime';
import { mcpConnections, connectMcp, disconnectMcp, closeMcpConnections } from './mcp-client';
import {
  configureProcessRegistry,
  discoverPackageScripts,
  listPackageProcesses,
  restartPackageProcess,
  startPackageProcess,
  stopAllPackageProcesses,
  stopPackageProcess,
} from './development-tools';
import { analyzeProductArchitecture, createDisposableSqlite } from './product-analysis';
import { listFiles, readText } from './workspace';
import type { AgentEvent, ProjectMap, Workspace } from '../shared/types';
let window: BrowserWindow;
let store: Store;
let agent: Agent;
let trainer: Trainer;
protocol.registerSchemesAsPrivileged([
  { scheme: 'forge', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName('Forge');
if (process.env.NODE_ENV === 'test' && process.env.FORGE_TEST_DATA)
  app.setPath('userData', process.env.FORGE_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
let closing = false;
let maintenance = false;
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (maintenance || agent.busy || trainer.isRunning)
    throw new Error('Wait for the active task to finish.');
  maintenance = true;
  try {
    return await work();
  } finally {
    maintenance = false;
  }
}
async function workspace(root: string): Promise<Workspace> {
  const cached = store.cached<ProjectMap>(`map:${root}`);
  return {
    path: root,
    name: path.basename(root),
    files: await listFiles(root, 10000),
    // Cache formats may outlive an app release. Rebuild old maps instead of
    // exposing a partial schema to the renderer.
    map: cached?.mentalModel && cached.typescript ? cached : undefined,
  };
}
function handle(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Untrusted sender.');
    return callback(...args);
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1050,
    minHeight: 700,
    title: 'Forge',
    backgroundColor: '#111214',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.FORGE_DEV_URL === 'http://127.0.0.1:5187' && !app.isPackaged)
    await window.loadURL(process.env.FORGE_DEV_URL);
  else await window.loadURL('forge://app/index.html');
}
app
  .whenReady()
  .then(async () => {
    if (!app.hasSingleInstanceLock()) return;
    store = new Store(app.getPath('userData'));
    await store.load();
    await configureProcessRegistry(store.directory);
    if (
      store.value.workspacePath &&
      !store.value.workspacePaths.includes(store.value.workspacePath)
    ) {
      store.value.workspacePaths.unshift(store.value.workspacePath);
      await store.save();
    }
    await recoverInterrupted(store);
    protocol.handle('forge', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
      const root = path.resolve(__dirname, '../dist');
      let target: string;
      try {
        target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      } catch {
        return new Response('Invalid path', { status: 400 });
      }
      if (target !== root && !target.startsWith(root + path.sep))
        return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).href);
    });
    const emit = (event: AgentEvent) => {
      if (window && !window.isDestroyed()) window.webContents.send('agent-event', event);
    };
    agent = new Agent(store, emit);
    trainer = new Trainer(store.directory, emit, store);
    const trustedRenderer = (contents: Electron.WebContents | null, origin: string) => {
      if (!contents || contents !== window.webContents) return false;
      try {
        const url = new URL(origin);
        return (
          (url.protocol === 'forge:' && url.hostname === 'app') ||
          (!app.isPackaged && url.origin === 'http://127.0.0.1:5187')
        );
      } catch {
        return false;
      }
    };
    electronSession.defaultSession.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        permission === 'media' &&
        details.mediaType === 'audio' &&
        details.isMainFrame &&
        trustedRenderer(contents, origin),
    );
    electronSession.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        const mediaTypes =
          permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined;
        callback(
          permission === 'media' &&
            mediaTypes?.length === 1 &&
            mediaTypes[0] === 'audio' &&
            trustedRenderer(contents, details.requestingUrl),
        );
      },
    );
    electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const localDev =
        !app.isPackaged &&
        ['http:', 'ws:'].includes(url.protocol) &&
        url.hostname === '127.0.0.1' &&
        url.port === '5187';
      const localPreview =
        url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
      callback({
        cancel:
          !['forge:', 'file:', 'data:', 'devtools:'].includes(url.protocol) &&
          !localDev &&
          !localPreview,
      });
    });
    handle('state', async () => ({
      ...store.value,
      workspace: store.value.workspacePath
        ? await workspace(store.value.workspacePath).catch(() => null)
        : null,
      workspaces: store.value.workspacePaths.map((root) => ({
        path: root,
        name: path.basename(root),
        active: root === store.value.workspacePath,
        analyzed: Boolean(store.cached<ProjectMap>(`map:${root}`)?.typescript),
      })),
      platform: `${process.platform}/${process.arch}`,
      dataPath: store.directory,
      recovery: store.recovery,
      processes: store.value.workspacePath ? listPackageProcesses(store.value.workspacePath) : [],
    }));
    handle('settings', async (value) => {
      if (agent.busy) throw new Error('Wait for the active task before changing its settings.');
      await closeMcpConnections();
      store.value.settings = settingsSchema.parse(value);
      await store.save();
      return store.value.settings;
    });
    handle('mcp-connections', () =>
      mcpConnections(store.value.settings.mcpServers, store.value.workspacePath ?? ''),
    );
    handle('connect-mcp', (id) =>
      exclusive(async () => {
        const profile = store.value.settings.mcpServers.find(
          (item) => item.id === z.string().uuid().parse(id),
        );
        if (!profile || !store.value.workspacePath)
          throw new Error('Configure a server and open a workspace first.');
        return connectMcp(profile, store.value.workspacePath, store, AbortSignal.timeout(30000));
      }),
    );
    handle('disconnect-mcp', (id) =>
      exclusive(() => disconnectMcp(z.string().uuid().parse(id), store)),
    );
    handle('show-browser', () => showInteractiveBrowser());
    handle('open-browser', (value) =>
      exclusive(async () => {
        const root = store.value.workspacePath;
        if (!root) throw new Error('Open a workspace first.');
        const url = z.string().url().max(500).parse(value);
        const urls = listPackageProcesses(root)
          .filter((item) => item.running)
          .flatMap((item) => item.urls);
        if (!urls.includes(url))
          throw new Error('Choose a URL from a managed process in this workspace.');
        await browserOpen(url, AbortSignal.timeout(20000), urls);
        showInteractiveBrowser();
      }),
    );
    handle('preview-image', async (filename) => {
      const target = path.resolve(z.string().max(4000).parse(filename));
      const directory = path.join(store.directory, 'previews');
      if (path.dirname(target) !== directory || !/^[a-f0-9-]+\.png$/.test(path.basename(target)))
        throw new Error('Image is not a Forge preview artifact.');
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000)
        throw new Error('Invalid preview image.');
      return 'data:image/png;base64,' + (await fs.readFile(target)).toString('base64');
    });
    handle('models', () => models(store.value.settings.endpoint));
    handle('test-connection', (endpoint, model) => {
      if (agent.busy || trainer.isRunning)
        throw new Error('Wait for the active task before testing another model.');
      return exclusive(() =>
        testConnection(z.string().max(300).parse(endpoint), z.string().max(200).parse(model)),
      );
    });
    handle('test-ssh-profile', (profile) => {
      if (agent.busy || trainer.isRunning)
        throw new Error('Wait for the active task before testing SSH.');
      return exclusive(() => testSsh(sshProfileSchema.parse(profile), AbortSignal.timeout(30000)));
    });
    handle('analyze-project', () =>
      exclusive(async () => {
        const root = store.value.workspacePath;
        if (!root) throw new Error('Open a project first.');
        if (agent.busy || trainer.isRunning) throw new Error('Wait for the current task.');
        const map = await analyzeProject(root, store, store.value.settings);
        emit({ type: 'map', map });
        return map;
      }),
    );
    handle('package-scripts', async () => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return discoverPackageScripts(root);
    });
    handle('development-processes', () => {
      const root = store.value.workspacePath;
      if (!root) return [];
      return listPackageProcesses(root);
    });
    handle('start-development-process', async (script) => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return startPackageProcess(root, z.string().min(1).max(100).parse(script));
    });
    handle('stop-development-process', async (id) => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return stopPackageProcess(root, z.string().uuid().parse(id));
    });
    handle('restart-development-process', async (id) => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return restartPackageProcess(root, z.string().uuid().parse(id));
    });
    handle('product-architecture', async () => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return analyzeProductArchitecture(root, AbortSignal.timeout(30_000));
    });
    handle('create-disposable-sqlite', async () => {
      const root = store.value.workspacePath;
      if (!root) throw new Error('Open a project first.');
      return createDisposableSqlite(root);
    });
    handle('analyze-impact', (paths) =>
      exclusive(async () => {
        const root = store.value.workspacePath;
        if (!root) throw new Error('Open a workspace first.');
        invalidateAnalysis(root);
        return analyzeImpact(
          root,
          z.array(z.string().min(1).max(500)).min(1).max(40).parse(paths),
          AbortSignal.timeout(30000),
        );
      }),
    );
    handle('undo-changeset', (id) =>
      exclusive(async () => {
        const session = await undoChangeSet(store, z.string().uuid().parse(id));
        session.changes?.forEach((change) => emit({ type: 'change', change }));
        session.changeSets?.forEach((changeSet) => emit({ type: 'changeset', changeSet }));
        if (session.task) emit({ type: 'task', task: session.task });
        return session;
      }),
    );
    handle('validate-task', (sessionId, checkIndex) =>
      exclusive(async () => {
        const session = store.value.sessions.find(
          (s) => s.id === z.string().uuid().parse(sessionId),
        );
        const task = session?.task;
        const index = z.number().int().min(0).max(11).parse(checkIndex);
        const check = task?.requiredChecks[index];
        if (!session || !task || !check) throw new Error('Task check not found.');
        const receipt = await runValidation(
          session.workspace,
          store.directory,
          check,
          AbortSignal.timeout(120000),
        );
        task.validations.push(receipt);
        task.fingerprint = await workspaceFingerprint(session.workspace).catch(() => '');
        task.appliedChanges =
          session.changeSets
            ?.filter((set) => set.runId === task.runId && set.status === 'applied')
            .reduce((count, set) => count + set.changeIds.length, 0) ?? 0;
        task.outcome = taskOutcome(task);
        await store.save();
        emit({ type: 'task', task });
        return task;
      }),
    );
    handle('accept-criterion', (sessionId, criterionId) =>
      exclusive(async () => {
        const session = store.value.sessions.find(
          (s) => s.id === z.string().uuid().parse(sessionId),
        );
        const task = session?.task;
        if (!session || !task || ['in_progress', 'failed', 'stopped'].includes(task.outcome))
          throw new Error('Only a completed task can be accepted.');
        const criterion = task.criteria.find((c) => c.id === z.string().uuid().parse(criterionId));
        if (!criterion) throw new Error('Criterion not found.');
        const fingerprint = await workspaceFingerprint(session.workspace);
        if (fingerprint !== task.fingerprint) {
          task.fingerprint = fingerprint;
          task.outcome = 'completed_unverified';
          task.criteria.forEach((c) => {
            delete c.acceptedFingerprint;
          });
          await store.save();
          emit({ type: 'task', task });
          throw new Error('Project changed since verification. Run the checks again.');
        }
        task.appliedChanges =
          session.changeSets
            ?.filter((set) => set.runId === task.runId && set.status === 'applied')
            .reduce((count, set) => count + set.changeIds.length, 0) ?? 0;
        criterion.acceptedFingerprint = fingerprint;
        task.outcome = taskOutcome(task);
        await store.save();
        emit({ type: 'task', task });
        return task;
      }),
    );
    handle('undo-change', async (id) => {
      if (agent.busy) throw new Error('Stop the agent before undo.');
      const change = await undoChange(store, z.string().uuid().parse(id));
      emit({ type: 'change', change });
      const session = store.value.sessions.find((s) => s.changes?.some((c) => c.id === change.id));
      session?.changes?.forEach((item) => emit({ type: 'change', change: item }));
      session?.changeSets?.forEach((changeSet) => emit({ type: 'changeset', changeSet }));
      if (session?.task) emit({ type: 'task', task: session.task });
      return change;
    });
    handle('delete-session', async (id) => {
      if (agent.busy) throw new Error('Stop the agent first.');
      store.value.sessions = store.value.sessions.filter((s) => s.id !== z.string().parse(id));
      await store.save();
    });
    handle('capture-example', async (sessionId, messageId) => {
      const session = store.value.sessions.find((s) => s.id === z.string().parse(sessionId));
      if (!session) throw new Error('Session not found.');
      const index = session.messages.findIndex(
        (m) => m.id === z.string().parse(messageId) && m.role === 'assistant' && m.content.trim(),
      );
      if (index < 0) throw new Error('Response not found.');
      const userIndex = session.messages.slice(0, index).findLastIndex((m) => m.role === 'user');
      if (userIndex < 0) throw new Error('Prompt not found.');
      const context = session.messages
        .slice(userIndex, index)
        .map((m) => `${m.role}${m.name ? ' (' + m.name + ')' : ''}: ${m.content}`)
        .join('\n\n');
      if (context.length > 32000)
        throw new Error('This trajectory is too large. Add a focused reviewed example manually.');
      store.value.examples.push({
        id: randomUUID(),
        prompt: context,
        response: session.messages[index].content,
        createdAt: Date.now(),
        reviewed: false,
        group: session.id,
        source: {
          sessionId: session.id,
          workspace: session.workspace,
          model: store.value.settings.model,
          context,
        },
      });
      await store.save();
      return store.value.examples;
    });
    handle('workspace', () =>
      exclusive(async () => {
        if (agent.busy) throw new Error('Stop the current run before changing workspace.');
        const result = await dialog.showOpenDialog(window, {
          properties: ['openDirectory'],
          title: 'Open a project',
        });
        if (result.canceled) return null;
        const selected = await workspace(result.filePaths[0]);
        store.value.workspacePath = selected.path;
        store.value.workspacePaths = [
          selected.path,
          ...store.value.workspacePaths.filter((root) => root !== selected.path),
        ];
        await store.save();
        selected.map = await analyzeProject(selected.path, store, store.value.settings);
        emit({ type: 'map', map: selected.map });
        return selected;
      }),
    );
    handle('select-workspace', (value) =>
      exclusive(async () => {
        if (agent.busy) throw new Error('Stop the current run before changing workspace.');
        const root = path.resolve(z.string().max(4000).parse(value));
        if (!store.value.workspacePaths.includes(root)) throw new Error('Workspace is not saved.');
        if (!(await fs.stat(root)).isDirectory())
          throw new Error('Workspace is no longer available.');
        store.value.workspacePath = root;
        store.value.workspacePaths = [
          root,
          ...store.value.workspacePaths.filter((item) => item !== root),
        ];
        await store.save();
        const selected = await workspace(root);
        selected.map = await analyzeProject(root, store, store.value.settings);
        emit({ type: 'map', map: selected.map });
        return selected;
      }),
    );
    handle('remove-workspace', (value) =>
      exclusive(async () => {
        if (agent.busy) throw new Error('Stop the current run before changing workspace.');
        const root = path.resolve(z.string().max(4000).parse(value));
        closeAnalysis(root);
        store.value.workspacePaths = store.value.workspacePaths.filter((item) => item !== root);
        if (store.value.workspacePath !== root) {
          await store.save();
          return store.value.workspacePath ? workspace(store.value.workspacePath) : null;
        }
        store.value.workspacePath = store.value.workspacePaths[0] ?? null;
        await store.save();
        if (!store.value.workspacePath) return null;
        const selected = await workspace(store.value.workspacePath);
        selected.map = await analyzeProject(selected.path, store, store.value.settings);
        emit({ type: 'map', map: selected.map });
        return selected;
      }),
    );
    handle('read-file', (file) => {
      if (!store.value.workspacePath) throw new Error('No workspace selected.');
      return readText(store.value.workspacePath, z.string().max(2000).parse(file));
    });
    handle('run', (prompt, id) => {
      if (maintenance || trainer.isRunning)
        throw new Error('Stop training before running inference.');
      return agent.run(
        z.string().trim().min(1).max(16000).parse(prompt),
        z.string().optional().parse(id),
      );
    });
    handle('stop', () => agent.stop());
    handle('resume', (id) => {
      if (maintenance || trainer.isRunning)
        throw new Error('Wait for maintenance or training before resuming.');
      return agent.resume(z.string().uuid().parse(id));
    });
    handle('approve', (id, allow) =>
      agent.approve(z.string().uuid().parse(id), z.boolean().parse(allow)),
    );
    handle('answer-clarification', (id, optionId, text) =>
      agent.answerClarification(
        z.string().uuid().parse(id),
        z.string().min(1).max(200).parse(optionId),
        z.string().trim().min(1).max(2000).optional().parse(text),
      ),
    );
    handle('save-example', async (prompt, response) => {
      const example = {
        id: randomUUID(),
        prompt: z.string().trim().min(1).max(32000).parse(prompt),
        response: z.string().trim().min(1).max(100000).parse(response),
        createdAt: Date.now(),
        reviewed: true,
      };
      if (
        !store.value.examples.some(
          (e) => e.prompt === example.prompt && e.response === example.response,
        )
      )
        store.value.examples.push(example);
      await store.save();
      return store.value.examples;
    });
    handle('review-example', async (id, reviewed) => {
      const example = store.value.examples.find((e) => e.id === z.string().parse(id));
      if (!example) throw new Error('Example not found.');
      example.reviewed = z.boolean().parse(reviewed);
      await store.save();
      return store.value.examples;
    });
    handle('delete-example', async (id) => {
      store.value.examples = store.value.examples.filter((e) => e.id !== z.string().parse(id));
      await store.save();
      return store.value.examples;
    });
    handle('export-dataset', async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose where to export dataset',
      });
      if (result.canceled) return null;
      const target = path.join(result.filePaths[0], `forge-dataset-${Date.now()}`);
      await exportDataset(store.value.examples, target);
      return target;
    });
    handle('train', (config) => {
      if (maintenance || agent.busy) throw new Error('Stop the agent before training.');
      return trainer.run(
        z
          .object({
            executable: z.string().min(1),
            modelPath: z.string().min(1),
            iterations: z.number().int().min(1).max(100000),
            learningRate: z.number().positive().max(0.1),
            batchSize: z.number().int().min(1).max(32),
          })
          .parse(config),
        store.value.examples,
      );
    });
    handle('stop-training', () => trainer.stop());
    handle('pick-path', async (kind) => {
      const result = await dialog.showOpenDialog(window, {
        properties: [
          z.enum(['file', 'directory']).parse(kind) === 'file' ? 'openFile' : 'openDirectory',
        ],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    await createWindow();
    if (store.value.workspacePath) {
      const root = store.value.workspacePath;
      void analyzeProject(root, store, store.value.settings)
        .then((map) => emit({ type: 'map', map }))
        .catch((error) =>
          emit({ type: 'error', error: `Workspace analysis failed: ${error.message}` }),
        );
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error) => {
    console.error('Forge startup failed:', error);
    if (process.env.NODE_ENV !== 'test')
      dialog.showErrorBox('Forge could not start', String(error));
    app.quit();
  });
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  agent?.stop();
  trainer?.stop();
  void (async () => {
    const start = Date.now();
    while ((agent?.busy || trainer?.isRunning) && Date.now() - start < 6000)
      await new Promise((r) => setTimeout(r, 50));
    closeAnalysis();
    await stopAllPackageProcesses();
    await closeInteractiveBrowser();
    await closeMcpConnections();
    await store?.flush();
  })().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
