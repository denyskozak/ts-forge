import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { embed } from './provider';
import { readText, scanFiles } from './workspace';
import type { Store } from './store';
import type { Settings } from '../shared/types';

const INDEX_VERSION = 1;
const PROJECT_SOURCE = /\.(?:[cm]?[jt]sx?|json|mdx?)$/i;
const DOCUMENT_SOURCE = /\.(?:md|mdx|txt|rst|html?|tsx?|jsx?)$/i;
const MAX_CHUNKS = 800;
const MAX_BYTES = 12_000_000;
const CHUNK_CHARS = 1800;
const MAX_VECTOR_VALUES = 1_000_000;

interface KnowledgeChunk {
  id: string;
  source: 'project' | 'documentation';
  root: string;
  path: string;
  start: number;
  end: number;
  content: string;
  hash: string;
  terms: string[];
  embedding?: number[];
}
interface KnowledgeIndex {
  version: number;
  root: string;
  embeddingModel: string;
  chunks: KnowledgeChunk[];
  files: number;
  complete: boolean;
  warnings: string[];
  generatedAt: number;
}
const terms = (text: string) =>
  [
    ...new Set(
      text
        .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
        .replace(/[_$-]+/g, ' ')
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    ),
  ].slice(0, 500);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const cosine = (left?: number[], right?: number[]) => {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0,
    a = 0,
    b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    a += left[index] ** 2;
    b += right[index] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
};

function split(content: string) {
  const result: { start: number; end: number; content: string }[] = [];
  for (let start = 0; start < content.length && result.length < MAX_CHUNKS;) {
    let end = Math.min(content.length, start + CHUNK_CHARS);
    if (end < content.length) {
      const breakAt = Math.max(content.lastIndexOf('\n\n', end), content.lastIndexOf('\n', end));
      if (breakAt > start + 300) end = breakAt;
    }
    const chunk = content.slice(start, end).trim();
    if (chunk) result.push({ start, end, content: chunk });
    start = Math.max(end, start + 1);
  }
  return result;
}

async function buildRoot(
  store: Store,
  root: string,
  source: KnowledgeChunk['source'],
  settings: Settings,
  signal: AbortSignal,
): Promise<KnowledgeIndex> {
  const canonical = await fs.realpath(root);
  const key = `knowledge:${source}:${canonical}:${settings.rag.embeddingModel || 'lexical'}`;
  const cached = store.cached<KnowledgeIndex>(key);
  const old = new Map(
    cached?.chunks.map((chunk) => [`${chunk.path}:${chunk.start}:${chunk.hash}`, chunk]),
  );
  const scan = await scanFiles(canonical, 4000, signal);
  const warnings = [...scan.warnings];
  const chunks: KnowledgeChunk[] = [];
  let bytes = 0;
  for (const filename of scan.files) {
    signal.throwIfAborted();
    if (!(source === 'project' ? PROJECT_SOURCE : DOCUMENT_SOURCE).test(filename)) continue;
    if (chunks.length >= MAX_CHUNKS || bytes >= MAX_BYTES) {
      warnings.push('Knowledge index budget reached; use a narrower query or split documentation.');
      break;
    }
    try {
      const content = await readText(canonical, filename);
      bytes += Buffer.byteLength(content);
      for (const part of split(content)) {
        if (chunks.length >= MAX_CHUNKS || bytes >= MAX_BYTES) break;
        const hash = digest(part.content);
        const prior = old.get(`${filename}:${part.start}:${hash}`);
        chunks.push({
          id: `${source}:${filename}:${part.start}:${hash.slice(0, 12)}`,
          source,
          root: canonical,
          path: filename,
          start: part.start,
          end: part.end,
          content: part.content,
          hash,
          terms: prior?.terms ?? terms(part.content),
          ...(prior?.embedding ? { embedding: prior.embedding } : {}),
        });
      }
    } catch (error) {
      warnings.push(`${filename}: ${(error as Error).message}`);
    }
  }
  if (settings.rag.embeddingModel) {
    const missing = chunks.filter((chunk) => !chunk.embedding);
    try {
      for (let offset = 0; offset < missing.length; offset += 16) {
        signal.throwIfAborted();
        const batch = missing.slice(offset, offset + 16);
        const vectors = await embed(
          settings.endpoint,
          settings.rag.embeddingModel,
          batch.map((chunk) => chunk.content),
          signal,
        );
        batch.forEach((chunk, index) => {
          chunk.embedding = vectors[index];
        });
        const dimensions = vectors[0]?.length ?? 0;
        if (dimensions && chunks.length * dimensions > MAX_VECTOR_VALUES) {
          warnings.push(
            'Embedding index is too large for the local cache; using lexical ranking for this source.',
          );
          chunks.forEach((chunk) => delete chunk.embedding);
          break;
        }
      }
    } catch (error) {
      warnings.push(
        `Local embeddings unavailable: ${(error as Error).message}. Using lexical ranking.`,
      );
      chunks.forEach((chunk) => delete chunk.embedding);
    }
  }
  const index: KnowledgeIndex = {
    version: INDEX_VERSION,
    root: canonical,
    embeddingModel: settings.rag.embeddingModel,
    chunks,
    files: scan.files.length,
    complete: scan.complete && !warnings.some((warning) => warning.includes('budget reached')),
    warnings,
    generatedAt: Date.now(),
  };
  store.cache(key, index);
  return index;
}

export async function searchKnowledge(
  store: Store,
  workspace: string,
  settings: Settings,
  input: { query: string; sources: ('project' | 'documentation')[]; limit: number },
  signal: AbortSignal,
) {
  if (!settings.rag.enabled) throw new Error('Local RAG is disabled in Settings.');
  const roots: { root: string; source: KnowledgeChunk['source'] }[] = [];
  if (input.sources.includes('project')) roots.push({ root: workspace, source: 'project' });
  if (input.sources.includes('documentation'))
    settings.rag.documentationPaths.forEach((root) =>
      roots.push({ root, source: 'documentation' }),
    );
  if (!roots.length) throw new Error('No local knowledge sources are enabled.');
  const indexes = await Promise.all(
    roots.map(async ({ root, source }) => {
      try {
        return await buildRoot(store, root, source, settings, signal);
      } catch (error) {
        return { error: `${root}: ${(error as Error).message}` };
      }
    }),
  );
  const queryTerms = terms(input.query);
  let queryEmbedding: number[] | undefined;
  if (settings.rag.embeddingModel) {
    try {
      [queryEmbedding] = await embed(
        settings.endpoint,
        settings.rag.embeddingModel,
        [input.query],
        signal,
      );
    } catch {
      // Per-index warnings below already make the fallback visible.
    }
  }
  const chunks = indexes.flatMap((index) => ('chunks' in index ? index.chunks : []));
  const results = chunks
    .map((chunk) => {
      const lexical =
        queryTerms.filter((term) => chunk.terms.includes(term)).length /
        Math.max(1, queryTerms.length);
      const semantic = cosine(queryEmbedding, chunk.embedding);
      return { chunk, score: semantic ? semantic * 0.75 + lexical * 0.25 : lexical };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path),
    )
    .slice(0, input.limit)
    .map(({ chunk, score }) => ({
      source: chunk.source,
      root: chunk.root,
      path: chunk.path,
      start: chunk.start,
      end: chunk.end,
      score: Number(score.toFixed(4)),
      content: chunk.content,
    }));
  return {
    query: input.query,
    results,
    sources: indexes.map((index) =>
      'chunks' in index
        ? {
            source: index.chunks[0]?.source ?? 'documentation',
            root: index.root,
            files: index.files,
            chunks: index.chunks.length,
            complete: index.complete,
            warnings: index.warnings,
            embeddingModel: index.embeddingModel || null,
          }
        : index,
    ),
    mode:
      queryEmbedding && chunks.some((chunk) => chunk.embedding)
        ? 'hybrid-local-embedding'
        : 'local-lexical',
    note: 'All retrieved content comes from local workspace or user-selected documentation directories. Results are bounded excerpts; read the original file before making a change.',
  };
}
