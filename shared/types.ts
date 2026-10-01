import type { SceneSource } from './react-three';
import { REACT_THREE_INSTRUCTIONS } from './react-three';
import type { TaskRecord, ChangeSet, ImpactReport } from './task';
export type Page = 'agent' | 'models' | 'skills' | 'training' | 'settings';
export type SkillId = 'typescript' | 'react' | 'react-native' | 'next' | 'react-three';
export interface Settings {
  endpoint: string;
  model: string;
  skills: SkillId[];
  temperature: number;
  maxSteps: number;
  contextTokens: number;
  mapFormat: 'auto' | 'compact' | 'json' | 'markdown';
  speechLanguage: 'auto' | 'ru-RU' | 'en-US';
}
export interface LocalModel {
  name: string;
  digest?: string;
  size: number;
  family: string;
  parameters: string;
  quantization: string;
  supportsTools?: boolean;
}
export interface Workspace {
  path: string;
  name: string;
  files: string[];
  complete?: boolean;
  map?: ProjectMap;
}
export interface WorkspaceSummary {
  path: string;
  name: string;
  active: boolean;
  analyzed: boolean;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  time: number;
  toolCalls?: ToolCallRecord[];
  runId?: string;
}
export interface Session {
  id: string;
  title: string;
  workspace: string;
  messages: Message[];
  updatedAt: number;
  changes?: Change[];
  changeSets?: ChangeSet[];
  task?: TaskRecord;
}
export interface Example {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
  group?: string;
  source?: { sessionId: string; workspace: string; model: string; context: string };
  reviewed?: boolean;
}
export interface Change {
  id: string;
  path: string;
  before: string;
  after: string;
  status:
    'pending' | 'applying' | 'applied' | 'rejected' | 'failed' | 'undoing' | 'undone' | 'conflict';
  workspace?: string;
  sessionId?: string;
  existed?: boolean;
  changeSetId?: string;
  createdAt?: number;
}
export interface Approval {
  id: string;
  kind: 'write' | 'typecheck' | 'changeset' | 'validation';
  title: string;
  change?: Change;
  changeSet?: ChangeSet;
}
export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}
export interface Clarification {
  id: string;
  question: string;
  reason: string;
  options: ClarificationOption[];
}
export interface TrainingConfig {
  executable: string;
  modelPath: string;
  iterations: number;
  learningRate: number;
  batchSize: number;
}
export interface AppState {
  settings: Settings;
  workspace: Workspace | null;
  workspaces: WorkspaceSummary[];
  sessions: Session[];
  examples: Example[];
  platform: string;
  dataPath: string;
  activeRun?: RunState;
  recovery?: string[];
  jobs?: TrainingJob[];
}
export type AgentEvent =
  | { type: 'message'; message: Message }
  | { type: 'token'; text: string }
  | { type: 'status'; status: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'clarification'; clarification: Clarification }
  | { type: 'change'; change: Change }
  | { type: 'done'; session: Session }
  | { type: 'error'; error: string }
  | { type: 'training'; text: string; running: boolean }
  | { type: 'map'; map: ProjectMap }
  | { type: 'task'; task: TaskRecord }
  | { type: 'changeset'; changeSet: ChangeSet };
export interface ForgeAPI {
  state(): Promise<AppState>;
  settings(value: Settings): Promise<Settings>;
  models(): Promise<LocalModel[]>;
  testConnection(endpoint: string, model: string): Promise<ConnectionTest>;
  analyzeProject(): Promise<ProjectMap>;
  undoChange(id: string): Promise<Change>;
  undoChangeSet(id: string): Promise<Session>;
  acceptCriterion(sessionId: string, criterionId: string): Promise<TaskRecord>;
  analyzeImpact(paths: string[]): Promise<ImpactReport>;
  validateTask(sessionId: string, checkIndex: number): Promise<TaskRecord>;
  captureExample(sessionId: string, messageId: string): Promise<Example[]>;
  deleteSession(id: string): Promise<void>;
  openWorkspace(): Promise<Workspace | null>;
  selectWorkspace(path: string): Promise<Workspace>;
  removeWorkspace(path: string): Promise<Workspace | null>;
  readFile(path: string): Promise<string>;
  run(prompt: string, sessionId?: string): Promise<void>;
  stop(): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  answerClarification(id: string, optionId: string): Promise<void>;
  saveExample(prompt: string, response: string): Promise<Example[]>;
  deleteExample(id: string): Promise<Example[]>;
  reviewExample(id: string, reviewed: boolean): Promise<Example[]>;
  exportDataset(): Promise<string | null>;
  train(config: TrainingConfig): Promise<string>;
  stopTraining(): Promise<void>;
  pickPath(kind: 'file' | 'directory'): Promise<string | null>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}
export interface ToolCallRecord {
  function: { name: string; arguments: Record<string, unknown> };
}
export interface RunState {
  id: string;
  sessionId: string;
  workspace: string;
  status: 'running' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  label: string;
  approval?: Approval;
  clarification?: Clarification;
  stream?: string;
}
export interface ProjectEntry {
  path: string;
  hash: string;
  bytes: number;
  lines: number;
  symbols: { name: string; line: number; kind: string }[];
  imports: string[];
  exports?: string[];
  roles?: ProjectFileRole[];
  scene?: SceneSource;
}
export type ProjectFileRole =
  'entrypoint' | 'route' | 'screen' | 'component' | 'hook' | 'state' | 'api' | 'test' | 'config';
export interface ProjectMentalModel {
  scene?: {
    files: string[];
    canvases: string[];
    frameFiles: string[];
    assetFiles: string[];
    reviewHints: number;
  };
  frameworks: { name: string; version?: string; evidence: string[] }[];
  packageManager?: string;
  scripts: string[];
  platforms: string[];
  entrypoints: string[];
  routes: { route: string; file: string; kind: string }[];
  layers: { name: string; purpose: string; files: string[] }[];
  state: { name: string; evidence: string[] }[];
  navigation: { name: string; evidence: string[] }[];
  data: { name: string; evidence: string[] }[];
  relationships: { from: string; to: string }[];
  notes: string[];
}
export interface TypeScriptProjectAnalysis {
  detected: boolean;
  version?: string;
  configFiles: string[];
  sourceFiles: number;
  declarationFiles: number;
  testFiles: number;
  compiler: {
    strict?: boolean;
    noEmit?: boolean;
    allowJs?: boolean;
    checkJs?: boolean;
    skipLibCheck?: boolean;
    noUncheckedIndexedAccess?: boolean;
    exactOptionalPropertyTypes?: boolean;
    module?: string;
    moduleResolution?: string;
    jsx?: string;
  };
  pathAliases: string[];
  projectReferences: string[];
  testRunners: string[];
  qualityTools: string[];
  findings: { severity: 'good' | 'info' | 'warning'; title: string; detail: string }[];
  recommendedTools: {
    name: string;
    status: 'ready' | 'detected' | 'missing';
    purpose: string;
  }[];
}
export interface ProjectMap {
  workspace: string;
  fingerprint: string;
  generatedAt: number;
  complete: boolean;
  files: number;
  indexed: number;
  sourceBytes: number;
  format: 'compact' | 'json' | 'markdown';
  formatSource: string;
  content: string;
  estimatedTokens: number;
  entries: ProjectEntry[];
  mentalModel: ProjectMentalModel;
  typescript: TypeScriptProjectAnalysis;
  warnings: string[];
}
export interface ConnectionTest {
  ok: boolean;
  endpoint: string;
  latencyMs: number;
  models: LocalModel[];
  model?: string;
  generated?: boolean;
  message: string;
}
export interface TrainingJob {
  id: string;
  path: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  message?: string;
}
export const DEFAULT_SETTINGS: Settings = {
  endpoint: 'http://127.0.0.1:11434',
  model: '',
  skills: ['typescript', 'react', 'react-native'],
  temperature: 0.2,
  maxSteps: 12,
  contextTokens: 16384,
  mapFormat: 'auto',
  speechLanguage: 'auto',
};
export const SKILLS: {
  id: SkillId;
  name: string;
  description: string;
  instructions: string;
  tags: string[];
}[] = [
  {
    id: 'typescript',
    name: 'TypeScript',
    description: 'Types that carry their weight. Strict by default.',
    tags: ['Strict types', 'Diagnostics', 'Refactoring'],
    instructions:
      'Specialize in TypeScript. Inspect tsconfig.json and package.json first. Respect existing conventions. Prefer unknown over any, discriminated unions over assertions, and narrow types at system boundaries. Do not silence compiler errors. Make the smallest coherent change. Read a file before editing it. Verify changes with typecheck if available, and report what was and was not verified.',
  },
  {
    id: 'react',
    name: 'React',
    description: 'Thoughtful components. Predictable state.',
    tags: ['Components', 'Hooks', 'Accessibility'],
    instructions:
      'For React: use functional components, obey Rules of Hooks, avoid effects for derived state, keep state close to its owner, clean up subscriptions, and preserve keyboard accessibility. Check the installed React version before using version-specific APIs. Prefer semantic HTML and existing design tokens. Never add dependencies without asking.',
  },
  {
    id: 'react-native',
    name: 'React Native',
    description: 'Screens, navigation and native boundaries.',
    tags: ['Expo', 'Navigation', 'Native modules'],
    instructions:
      'For React Native: first inspect the project mental model, app entry, navigation tree, screen folders, state providers, API clients and platform-specific files. Detect Expo, Expo Router, React Navigation and bare React Native from installed dependencies and config; never assume one. Trace a user flow from navigator or file route to screen, hooks/state, services and native capabilities. Preserve platform behavior, safe areas, permissions, accessibility labels, list performance and cleanup of listeners. Check iOS/Android variants and never add a native dependency without explaining the native build impact.',
  },
  {
    id: 'react-three',
    name: 'React Three Fiber',
    description: 'Scenes, frame loops, assets and physics with source evidence.',
    tags: ['Three.js', 'Drei', 'Rapier'],
    instructions: REACT_THREE_INSTRUCTIONS,
  },
  {
    id: 'next',
    name: 'Next.js',
    description: 'From server boundaries to the last route.',
    tags: ['App Router', 'Server components', 'Routing'],
    instructions:
      'For Next.js: inspect the router and installed version. Default App Router components to server components; add use client only for browser APIs or interactivity. Keep secrets server-side. Respect async request APIs of the installed version. Do not assume caching defaults. Preserve metadata, loading and error boundaries. Avoid importing server code into client bundles.',
  },
];
