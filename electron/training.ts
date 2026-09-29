import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Example, TrainingConfig, TrainingJob } from '../shared/types';
import { hash } from './workspace';
import { cleanEnvironment, sandboxCommand, terminate } from './executor';
import type { Store } from './store';
export function splitDataset(examples: Example[]) {
  const byPrompt = new Map<string, Example>();
  for (const e of examples.filter((e) => e.reviewed !== false)) {
    const key = e.prompt.trim(),
      old = byPrompt.get(key);
    if (old && old.response.trim() !== e.response.trim())
      throw new Error(
        'Conflicting answers for the same prompt. Resolve the examples before export.',
      );
    byPrompt.set(key, e);
  }
  const unique = [...byPrompt.values()];
  if (unique.length < 5)
    throw new Error(
      'Save at least 5 reviewed examples with distinct prompts before exporting or training.',
    );
  const groups = new Map<string, Example[]>();
  for (const e of unique) {
    const key = e.group || hash(e.prompt.trim());
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    hash('forge-split-v1:' + a).localeCompare(hash('forge-split-v1:' + b)),
  );
  if (keys.length < 3)
    throw new Error(
      'Use at least 3 task families or sessions for separate train, validation and test sets.',
    );
  const holdout = Math.max(1, Math.floor(keys.length * 0.2));
  const get = (ids: string[]) => ids.flatMap((id) => groups.get(id)!);
  const partitions = {
    test: get(keys.slice(0, holdout)),
    valid: get(keys.slice(holdout, holdout * 2)),
    train: get(keys.slice(holdout * 2)),
  };
  const encode = (rows: Example[]) =>
    rows
      .map((e) =>
        JSON.stringify({
          messages: [
            { role: 'user', content: e.prompt },
            { role: 'assistant', content: e.response },
          ],
        }),
      )
      .join('\n') + '\n';
  return {
    train: encode(partitions.train),
    valid: encode(partitions.valid),
    test: encode(partitions.test),
    count: unique.length,
    manifest: {
      version: 1,
      split: 'grouped-sha256-v1',
      groups: keys.length,
      examples: Object.fromEntries(
        Object.entries(partitions).map(([key, rows]) => [
          key,
          rows.map((e) => ({
            id: e.id,
            group: e.group ?? hash(e.prompt.trim()),
            hash: hash(e.prompt + e.response),
          })),
        ]),
      ),
    },
  };
}
export async function exportDataset(examples: Example[], directory: string) {
  const data = splitDataset(examples);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const key of ['train', 'valid', 'test'] as const)
    await fs.writeFile(path.join(directory, key + '.jsonl'), data[key], { mode: 0o600 });
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(data.manifest, null, 2),
    { mode: 0o600 },
  );
  return data.count;
}
export class Trainer {
  private child?: ChildProcess;
  private busy = false;
  private stopped = false;
  get isRunning() {
    return this.busy;
  }
  constructor(
    private directory: string,
    private emit: (event: AgentEvent) => void,
    private store?: Store,
  ) {}
  stop() {
    this.stopped = true;
    if (this.child) terminate(this.child);
  }
  async run(config: TrainingConfig, examples: Example[]) {
    if (this.busy) throw new Error('A training job is already running.');
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('MLX training requires Apple Silicon macOS.');
    this.busy = true;
    this.stopped = false;
    let record: TrainingJob | undefined;
    try {
      if (!path.isAbsolute(config.executable) || !path.isAbsolute(config.modelPath))
        throw new Error('Choose absolute paths to the local MLX executable and model.');
      await fs.access(config.executable, fs.constants.X_OK);
      JSON.parse(await fs.readFile(path.join(config.modelPath, 'config.json'), 'utf8'));
      const job = path.join(this.directory, 'training', `run-${randomUUID()}`);
      await exportDataset(examples, path.join(job, 'data'));
      const available = await fs.statfs(job);
      if (available.bavail * available.bsize < 1024 ** 3)
        throw new Error('Less than 1 GB free for training artifacts.');
      const args = [
        '--model',
        config.modelPath,
        '--train',
        '--data',
        path.join(job, 'data'),
        '--adapter-path',
        path.join(job, 'adapters'),
        '--iters',
        String(config.iterations),
        '--learning-rate',
        String(config.learningRate),
        '--batch-size',
        String(config.batchSize),
        '--mask-prompt',
      ];
      await fs.writeFile(
        path.join(job, 'run.json'),
        JSON.stringify(
          {
            ...config,
            args,
            datasetHash: hash(await fs.readFile(path.join(job, 'data/manifest.json'), 'utf8')),
            createdAt: new Date().toISOString(),
            status: 'starting',
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      const command = await sandboxCommand(
        config.executable,
        args,
        [config.modelPath, path.resolve(path.dirname(config.executable), '..'), job],
        [job],
      );
      if (this.stopped) throw new Error('Training cancelled before launch.');
      record = { id: randomUUID(), path: job, startedAt: Date.now(), status: 'running' };
      this.store?.value.jobs.unshift(record);
      await this.store?.save();
      const log = createWriteStream(path.join(job, 'output.log'), { mode: 0o600 });
      let logged = 0;
      log.on('error', (error) =>
        this.emit({ type: 'training', text: `\nLog error: ${error.message}`, running: this.busy }),
      );
      const child = spawn(command.executable, command.args, {
        cwd: job,
        detached: true,
        env: cleanEnvironment({
          HOME: job,
          TMPDIR: job,
          HF_HUB_OFFLINE: '1',
          HF_DATASETS_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          WANDB_MODE: 'disabled',
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        }),
      });
      this.child = child;
      const append = (chunk: Buffer) => {
        if (logged < 10_000_000) {
          const selected = chunk.subarray(0, 10_000_000 - logged);
          log.write(selected);
          logged += selected.length;
        }
        this.emit({ type: 'training', text: chunk.toString().slice(-16000), running: true });
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => {
        append(Buffer.from(`Failed to start: ${error.message}\n`));
      });
      child.on('close', (code, signal) => {
        void (async () => {
          let artifacts = false;
          try {
            artifacts = (await fs.stat(path.join(job, 'adapters/adapters.safetensors'))).size > 0;
          } catch {}
          record!.status = this.stopped
            ? 'stopped'
            : code === 0 && artifacts
              ? 'completed'
              : 'failed';
          record!.endedAt = Date.now();
          record!.message = this.stopped
            ? 'Stopped by user'
            : code === 0 && artifacts
              ? 'Adapter saved. Quality evaluation is still required.'
              : `Exit ${code}, signal ${signal ?? 'none'}. ${code === 0 ? 'Expected adapter file is missing.' : ''}`;
          await fs.writeFile(path.join(job, 'result.json'), JSON.stringify(record, null, 2), {
            mode: 0o600,
          });
          await this.store?.save();
          const message = `\n${record!.message}\nArtifacts: ${job}`;
          log.end(message);
          this.emit({ type: 'training', text: message, running: false });
        })()
          .catch((error) => {
            log.end();
            this.emit({
              type: 'training',
              text: `\nCould not persist job result: ${(error as Error).message}`,
              running: false,
            });
          })
          .finally(() => {
            this.child = undefined;
            this.busy = false;
          });
      });
      this.emit({
        type: 'training',
        text: `Starting isolated local MLX training. Network denied.\nArtifacts: ${job}\n`,
        running: true,
      });
      return job;
    } catch (error) {
      this.busy = false;
      if (record) {
        record.status = 'failed';
        record.message = String(error);
        await this.store?.save();
      }
      throw error;
    }
  }
}
