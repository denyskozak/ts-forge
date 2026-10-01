import { REQUIRED_MCP_SKILLS } from '../shared/mcp-skills';
import { z } from 'zod';
import { taskSchema, changeSetSchema } from '../shared/task';
import { DEFAULT_SETTINGS } from '../shared/types';
import { localEndpoint } from './provider';
export const settingsSchema = z.object({
  endpoint: z.string().transform(localEndpoint),
  model: z.string().max(200),
  skills: z
    .array(
      z.enum([
        'typescript',
        'react',
        'react-native',
        'next',
        'react-three',
        'git',
        'git-review',
        'contributing',
        'mcp-workflow',
        'mcp-security',
      ]),
    )
    .transform((skills) => [...new Set([...skills, ...REQUIRED_MCP_SKILLS])]),
  temperature: z.number().min(0).max(1),
  maxSteps: z.number().int().min(1).max(30),
  contextTokens: z.number().int().min(4096).max(65536).default(16384),
  mapFormat: z.enum(['auto', 'compact', 'json', 'markdown']).default('auto'),
  speechLanguage: z.enum(['auto', 'ru-RU', 'en-US']).default('auto'),
});
const call = z.object({
  function: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
});
const message = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  time: z.number(),
  toolCalls: z.array(call).optional(),
  runId: z.string().optional(),
});
export const changeSchema = z.object({
  id: z.string(),
  path: z.string(),
  before: z.string(),
  after: z.string(),
  status: z.enum([
    'pending',
    'applying',
    'applied',
    'rejected',
    'failed',
    'undoing',
    'undone',
    'conflict',
  ]),
  workspace: z.string().optional(),
  sessionId: z.string().optional(),
  existed: z.boolean().optional(),
  changeSetId: z.string().optional(),
  createdAt: z.number().optional(),
});
const session = z.object({
  id: z.string(),
  title: z.string(),
  workspace: z.string(),
  messages: z.array(message),
  updatedAt: z.number(),
  changes: z.array(changeSchema).optional(),
  changeSets: z.array(changeSetSchema).optional(),
  task: taskSchema.optional(),
});
const example = z.object({
  id: z.string(),
  prompt: z.string(),
  response: z.string(),
  createdAt: z.number(),
  group: z.string().optional(),
  reviewed: z.boolean().optional(),
  source: z
    .object({
      sessionId: z.string(),
      workspace: z.string(),
      model: z.string(),
      context: z.string(),
    })
    .optional(),
});
const approval = z.object({
  id: z.string(),
  kind: z.enum(['write', 'typecheck', 'changeset', 'validation']),
  title: z.string(),
  change: changeSchema.optional(),
  changeSet: changeSetSchema.optional(),
});
const clarification = z.object({
  id: z.string(),
  question: z.string(),
  reason: z.string(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .max(4),
});
const run = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspace: z.string(),
  status: z.enum(['running', 'waiting', 'completed', 'stopped', 'failed', 'interrupted']),
  label: z.string(),
  approval: approval.optional(),
  clarification: clarification.optional(),
  stream: z.string().optional(),
});
const job = z.object({
  id: z.string(),
  path: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'interrupted']),
  message: z.string().optional(),
});
export const diskSchema = z.object({
  version: z.literal(2).default(2),
  settings: settingsSchema.default(DEFAULT_SETTINGS),
  workspacePath: z.string().nullable().default(null),
  workspacePaths: z.array(z.string()).default([]),
  sessions: z.array(session).default([]),
  examples: z.array(example).default([]),
  activeRun: run.optional(),
  jobs: z.array(job).default([]),
});
