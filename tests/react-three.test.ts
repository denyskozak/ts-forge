import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describeSource, analyzeProject, renderMap } from '../electron/project-map';
import { inspectScene } from '../electron/react-three';
import { buildMentalModel, selectUnderstandingFiles } from '../electron/mental-model';
import { recoverReadOnlyToolCall } from '../electron/tool-recovery';
import { Store } from '../electron/store';
import { SKILLS, type ProjectEntry } from '../shared/types';
const source = `import { Canvas as View, useFrame as frame } from '@react-three/fiber';
import * as Drei from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/rapier';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
export function Player() {
  const model = Drei.useGLTF('/player.glb');
  frame((state, delta) => { setPosition(delta); const direction = new THREE.Vector3(); });
  return <RigidBody><primitive object={model.scene} onClick={select} /></RigidBody>;
}
export const World = () => <div><View frameloop="demand"><Physics><Player /></Physics><Drei.OrbitControls /><EffectComposer><Bloom /></EffectComposer></View></div>;
`;
function entry(filename: string, content: string): ProjectEntry {
  return {
    path: filename,
    hash: 'fixture',
    bytes: content.length,
    lines: content.split('\n').length,
    ...describeSource(filename, content),
  };
}
test('scene evidence resolves aliases and namespaces, records owners, hierarchy, assets and review hints', () => {
  const report = inspectScene([entry('World.tsx', source)]);
  const rows = report.evidence;
  assert.ok(
    rows.some(
      (row) =>
        row.kind === 'canvas' &&
        row.name === 'Canvas' &&
        row.owner === 'World' &&
        row.detail.includes('demand'),
    ),
  );
  assert.ok(rows.some((row) => row.name === 'Player' && row.parent === 'Physics'));
  assert.ok(
    rows.some(
      (row) => row.kind === 'asset' && row.owner === 'Player' && row.detail === "'/player.glb'",
    ),
  );
  assert.ok(rows.some((row) => row.kind === 'frame' && row.line === 8));
  assert.ok(rows.some((row) => row.kind === 'physics' && row.name === 'RigidBody'));
  assert.ok(rows.some((row) => row.kind === 'effect' && row.name === 'Bloom'));
  assert.ok(rows.some((row) => row.kind === 'interaction' && row.name === 'onClick'));
  assert.deepEqual(
    rows.filter((row) => row.kind === 'review').map((row) => row.name),
    ['frame-state-call', 'frame-allocation'],
  );
  assert.equal(report.completeness.runtimeGraphComplete, false);
});
test('ordinary DOM, comments, strings and unrelated same-name APIs are not R3F evidence', () => {
  const content = `import { Canvas, useFrame } from 'unrelated';
  // import { useFrame } from '@react-three/fiber';
  const text = "<mesh onClick={oops} />";
  export const UI = () => <div><Canvas /><button onClick={save}>Save</button></div>;
  useFrame(() => { setCount(3); });`;
  assert.deepEqual(entry('UI.tsx', content).scene?.evidence, []);
});
test('native Canvas, external frame callbacks and asset preload are reported without assuming browser runtime', () => {
  const rows = entry(
    'Native.tsx',
    `import * as R3F from '@react-three/fiber/native';
import { useGLTF as model } from '@react-three/drei';
model.preload('/scene.glb');
function Scene() { R3F.useFrame(tick, 1); return <R3F.Canvas />; }`,
  ).scene!.evidence;
  assert.ok(rows.some((row) => row.name === 'useGLTF.preload'));
  assert.ok(rows.some((row) => row.name === 'frame-callback' && row.detail.includes('tick')));
  assert.ok(rows.some((row) => row.kind === 'frame' && row.detail.includes('1')));
  assert.ok(rows.some((row) => row.kind === 'canvas'));
});
test('scene reports paginate and expose file caps and partial scans', () => {
  const entries = [
    entry('Many.tsx', `export const Scene = () => <group>${'<mesh />'.repeat(180)}</group>`),
  ];
  const report = inspectScene(entries, '', 0, 2, false);
  assert.equal(report.evidence.length, 2);
  assert.equal(report.nextOffset, 2);
  assert.equal(report.completeness.projectScanComplete, false);
  assert.equal(report.completeness.sourceEvidenceTruncated, true);
  assert.equal(report.completeness.selectionComplete, false);
  assert.equal(inspectScene(entries, 'nothing-found').total, 0);
  assert.notDeepEqual(inspectScene(entries, '', 2, 2).evidence, report.evidence);
});
test('mental model and compact map expose scene roots and prioritize source evidence', () => {
  const entries = [entry('main.tsx', 'export const main = true;'), entry('World.tsx', source)];
  const mentalModel = buildMentalModel(
    entries,
    entries.map((item) => item.path),
    {
      dependencies: {
        '@react-three/fiber': '^9.0.0',
        three: '^0.180.0',
        '@react-three/drei': '^10.0.0',
      },
    },
  );
  assert.ok(mentalModel.frameworks.some((item) => item.name === 'React Three Fiber'));
  assert.deepEqual(mentalModel.scene?.canvases, ['World.tsx']);
  assert.ok(
    selectUnderstandingFiles(mentalModel, entries, 'разберись в игре').includes('World.tsx'),
  );
  assert.match(
    renderMap({ entries, mentalModel, complete: true, files: 2, format: 'compact', warnings: [] }),
    /Scene roots: World.tsx/,
  );
  assert.equal(
    recoverReadOnlyToolCall('{"name":"inspect_scene","parameters":{}}')?.call.function.name,
    'inspect_scene',
  );
  assert.match(
    SKILLS.find((skill) => skill.id === 'react-three')!.instructions,
    /do not mix stable and next-version/,
  );
});
test('project analysis upgrades cached entries and refreshes scene evidence after edits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-r3f-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const store = new Store(path.join(root, 'state'));
  await store.load();
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  store.value.settings.mapFormat = 'compact';
  store.value.settings.skills.push('react-three');
  await store.save();
  await fs.writeFile(path.join(project, 'World.tsx'), source);
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ dependencies: { '@react-three/fiber': '^9.0.0' } }),
  );
  const first = await analyzeProject(project, store, store.value.settings);
  first.entries.forEach((item) => {
    delete item.scene;
  });
  store.cache(`map:${project}`, first);
  const upgraded = await analyzeProject(project, store, store.value.settings);
  assert.ok(upgraded.entries.find((item) => item.path === 'World.tsx')?.scene?.evidence.length);
  await fs.writeFile(
    path.join(project, 'World.tsx'),
    'export const World = () => <main>Removed scene</main>;',
  );
  const changed = await analyzeProject(project, store, store.value.settings);
  assert.deepEqual(changed.mentalModel.scene?.canvases, []);
  assert.equal(inspectScene(changed.entries).total, 0);
});

test('agent automatically includes R3F guidance and executes inspect_scene with source evidence', async (t) => {
  const { createServer } = await import('node:http');
  const { Agent } = await import('../electron/agent');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-r3f-agent-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'World.tsx'), source);
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ dependencies: { '@react-three/fiber': '^9.0.0' } }),
  );
  const requests: {
    messages?: { role: string; content: string; name?: string }[];
    tools?: { function: { name: string } }[];
  }[] = [];
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
                content: 'I called inspect_scene and found the Canvas.',
              }
            : { content: 'Canvas is declared in World.tsx. Visual verification remains pending.' },
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
  await new Agent(store, () => {}).run(
    'Call inspect_scene and report the current scene. Read-only task.',
  );
  const system = requests[0].messages!.find((message) => message.role === 'system')!.content;
  assert.match(system, /call inspect_scene before editing/);
  assert.match(system, /Canvas context/);
  assert.ok(requests[0].tools!.some((tool) => tool.function.name === 'inspect_scene'));
  const result = store.value.sessions[0].messages.find(
    (message) => message.name === 'inspect_scene',
  );
  assert.ok(result);
  const report = JSON.parse(result.content);
  assert.ok(
    report.evidence.some(
      (item: { path: string; kind: string }) => item.path === 'World.tsx' && item.kind === 'canvas',
    ),
  );
  assert.equal(report.completeness.runtimeGraphComplete, false);
  assert.deepEqual(store.value.settings.skills, ['typescript']);
});
