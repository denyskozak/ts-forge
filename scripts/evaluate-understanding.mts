import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../electron/agent';
import { models } from '../electron/provider';
import { Store } from '../electron/store';

const endpoint = process.env.FORGE_EVAL_ENDPOINT ?? 'http://127.0.0.1:11434';
const model = process.env.FORGE_EVAL_MODEL ?? 'qwen2.5:1.5b';
const output = path.resolve(
  process.env.FORGE_EVAL_REPORT ?? 'docs/project-understanding-evaluation.json',
);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-understanding-'));
const project = path.join(temp, 'project');

const fixture: Record<string, string> = {
  'package.json': JSON.stringify({
    scripts: { ios: 'expo run:ios', android: 'expo run:android', test: 'jest' },
    dependencies: {
      react: '19.0.0',
      'react-native': '0.81.0',
      expo: '54.0.0',
      '@react-navigation/native': '7.0.0',
      zustand: '5.0.0',
      axios: '1.0.0',
    },
  }),
  'App.tsx': `import { RootNavigator } from './src/navigation/RootNavigator';\nexport function App(){ return <RootNavigator/>; }`,
  'src/navigation/RootNavigator.tsx': `import { GameScreen } from '../screens/GameScreen';\nexport function RootNavigator(){ return <GameScreen/>; }`,
  'src/screens/GameScreen.tsx': `import { useGameStore } from '../store/gameStore';\nimport { loadLevel } from '../services/gameApi';\nexport function GameScreen(){ const level=useGameStore(s=>s.level); return <Button title={'Play '+level} onPress={()=>loadLevel(level)}/>; }`,
  'src/store/gameStore.ts': `import { create } from 'zustand';\nexport const useGameStore=create<{level:number}>(()=>({level:1}));`,
  'src/services/gameApi.ts': `import axios from 'axios';\nexport async function loadLevel(level:number){ return axios.get('/levels/'+level); }`,
};
for (const [filename, source] of Object.entries(fixture)) {
  await fs.mkdir(path.dirname(path.join(project, filename)), { recursive: true });
  await fs.writeFile(path.join(project, filename), source);
}

try {
  const installed = (await models(endpoint)).find((item) => item.name === model);
  if (!installed) throw new Error(`Model ${model} is not installed.`);
  const store = new Store(path.join(temp, 'state'));
  await store.load();
  store.value.workspacePath = project;
  store.value.settings = {
    ...store.value.settings,
    endpoint,
    model,
    mapFormat: 'compact',
    temperature: 0,
    maxSteps: 10,
    contextTokens: 8192,
  };
  const statuses: string[] = [];
  const agent = new Agent(store, (event) => {
    if (event.type === 'status') statuses.push(event.status);
    if (event.type === 'approval') agent.approve(event.approval.id, false);
  });
  const startedAt = Date.now();
  await agent.run(
    'Разберись в проекте и объясни ментальную модель игрового потока: от запуска приложения до экрана, состояния и API. Приведи конкретные пути файлов. Ничего не изменяй.',
  );
  const session = store.value.sessions[0];
  const toolMessages = session.messages.filter((message) => message.role === 'tool');
  const answer =
    [...session.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content)?.content ?? '';
  const report = {
    createdAt: new Date().toISOString(),
    model,
    modelDigest: installed.digest,
    durationMs: Date.now() - startedAt,
    prompt: session.messages[0].content,
    criteria: {
      usedArchitectureTool: toolMessages.some((message) =>
        ['project_mental_model', 'inspect_feature'].includes(message.name ?? ''),
      ),
      inspectedSource:
        statuses.includes('Reading architecture evidence') ||
        toolMessages.some((message) => ['read_file', 'read_files'].includes(message.name ?? '')),
      citedEntrypoint: /App\.tsx/.test(answer),
      citedScreen: /GameScreen/.test(answer),
      citedState: /gameStore|useGameStore/.test(answer),
      citedDataBoundary: /gameApi|loadLevel|axios/i.test(answer),
      toolErrors: toolMessages.filter((message) => message.content.startsWith('Tool error:'))
        .length,
      architectureEvidenceLoaded: statuses.includes('Reading architecture evidence'),
      avoidsRunawayRepetition: answer.length < 6000,
      avoidsInventedStateUpdate:
        !/(state|состояни)[^.!\n]{0,80}(server|сервер|обновл|установлен)/iu.test(answer),
    },
    tools: toolMessages.map((message) => ({ name: message.name, content: message.content })),
    answer,
    statuses,
    scope:
      'Synthetic React Native fixture. This measures one model/harness run, not general project understanding.',
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await store.close();
  console.log(JSON.stringify(report.criteria, null, 2));
  console.log(output);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
