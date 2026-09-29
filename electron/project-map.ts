import { renderMap } from '../shared/project-map';
export { renderMap } from '../shared/project-map';
import path from 'node:path';
import ts from 'typescript';
import type { ProjectMap, ProjectEntry, Settings } from '../shared/types';
import type { Store } from './store';
import { hash, readText, scanFiles } from './workspace';
import { chat, verifyLocalModel } from './provider';
import { buildMentalModel, classifyProjectFile } from './mental-model';
import { analyzeTypeScriptProject } from './typescript-project-analysis';
export function describeSource(
  filename: string,
  source: string,
): Pick<ProjectEntry, 'symbols' | 'imports' | 'exports' | 'roles'> {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true),
    symbols: ProjectEntry['symbols'] = [],
    imports: string[] = [],
    exports: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      symbols.length < 80
    ) {
      symbols.push({
        name: node.name.text,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        kind: ts.SyntaxKind[node.kind],
      });
      if (
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        exports.push(node.name.text);
    }
    if (ts.isExportAssignment(node)) exports.push('default');
    ts.forEachChild(node, visit);
  }
  visit(file);
  return {
    symbols,
    imports: [...new Set(imports)].slice(0, 40),
    exports: [...new Set(exports)].slice(0, 80),
    roles: classifyProjectFile(filename, source, symbols),
  };
}
async function preferredFormat(
  store: Store,
  settings: Settings,
  signal?: AbortSignal,
): Promise<{ format: ProjectMap['format']; source: string }> {
  if (settings.mapFormat !== 'auto')
    return { format: settings.mapFormat, source: 'Selected in settings' };
  if (!settings.model)
    return {
      format: 'compact',
      source: 'Compact fallback: select a model for automatic format choice',
    };
  const key = `map-format:${settings.endpoint}:${settings.model}`;
  const cached = store.cached<{ format: ProjectMap['format']; source: string }>(key);
  if (cached) return cached;
  try {
    await verifyLocalModel(settings.endpoint, settings.model);
    const result = await chat(
      settings.endpoint,
      {
        model: settings.model,
        format: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['compact', 'json', 'markdown'] } },
          required: ['format'],
        },
        think: false,
        options: { temperature: 0, num_predict: 64, num_ctx: 4096 },
        messages: [
          {
            role: 'user',
            content:
              'Choose the project-map representation you can navigate most reliably with minimal tokens: compact (path [lines] symbol:line <- imports), json (structured entries), or markdown (table). Reply only with JSON {"format":"compact|json|markdown"}. This preference is cached; no project code is sent for this choice.',
          },
        ],
      },
      AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]),
      () => {},
    );
    const selected = JSON.parse(result.content).format;
    if (!['compact', 'json', 'markdown'].includes(selected))
      throw new Error('Invalid format preference');
    const preference = {
      format: selected as ProjectMap['format'],
      source: `Chosen by ${settings.model}`,
    };
    store.cache(key, preference);
    return preference;
  } catch (error) {
    signal?.throwIfAborted();
    return {
      format: 'compact',
      source: `Compact fallback: ${(error as Error).message.slice(0, 150)}`,
    };
  }
}
export async function analyzeProject(
  root: string,
  store: Store,
  settings: Settings,
  signal?: AbortSignal,
): Promise<ProjectMap> {
  const scan = await scanFiles(root, 10000, signal),
    previous = store.cached<ProjectMap>(`map:${root}`),
    old = new Map(previous?.entries.map((e) => [e.path, e]));
  const entries: ProjectEntry[] = [],
    warnings = [...scan.warnings];
  const packageManifest: {
    scripts: Record<string, unknown>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    main?: string;
  } = { scripts: {}, dependencies: {}, devDependencies: {} };
  const configSources: Record<string, string> = {};
  const mergePackageManifest = (source: string) => {
    const json = JSON.parse(source) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      main?: string;
    };
    Object.assign(packageManifest.scripts, json.scripts);
    Object.assign(packageManifest.dependencies, json.dependencies);
    Object.assign(packageManifest.devDependencies, json.devDependencies);
    packageManifest.main ??= json.main;
    return json;
  };
  let sourceBytes = 0,
    complete = scan.complete;
  const candidates = scan.files.filter((f) => /\.(?:[cm]?[jt]sx?|json)$/.test(f));
  for (const filename of candidates) {
    signal?.throwIfAborted();
    if (entries.length >= 2000 || sourceBytes > 16_000_000) {
      complete = false;
      warnings.push('Index budget reached. Use search_code/list_files for omitted files.');
      break;
    }
    try {
      const source = await readText(root, filename),
        digest = hash(source);
      sourceBytes += Buffer.byteLength(source);
      let packageJson:
        | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        | undefined;
      if (path.basename(filename) === 'package.json') packageJson = mergePackageManifest(source);
      if (/^(?:.*\/)?tsconfig(?:\.[^/]+)?\.json$/.test(filename)) configSources[filename] = source;
      if (old.get(filename)?.hash === digest) {
        const cached = old.get(filename)!;
        entries.push({
          ...cached,
          exports: cached.exports ?? [],
          roles: cached.roles ?? classifyProjectFile(filename, source, cached.symbols),
        });
        continue;
      }
      const parsed = /\.[cm]?[jt]sx?$/.test(filename)
        ? describeSource(filename, source)
        : {
            symbols: [],
            imports: [],
            exports: [],
            roles: classifyProjectFile(filename, source, []),
          };
      if (path.basename(filename) === 'package.json') {
        try {
          parsed.imports = Object.entries({
            ...packageJson?.dependencies,
            ...packageJson?.devDependencies,
          })
            .filter(([key]) =>
              [
                'typescript',
                'react',
                'react-native',
                'expo',
                'expo-router',
                'next',
                'vite',
                'vitest',
                'jest',
                '@react-navigation/native',
                '@reduxjs/toolkit',
                'zustand',
              ].includes(key),
            )
            .map(([key, version]) => `${key}@${version}`);
        } catch {}
      }
      entries.push({
        path: filename,
        hash: digest,
        bytes: Buffer.byteLength(source),
        lines: source.split('\n').length,
        ...parsed,
      });
      if (entries.length % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (error) {
      warnings.push(`${filename}: ${(error as Error).message}`);
      complete = false;
    }
  }
  const pref = await preferredFormat(store, settings, signal);
  const mentalModel = buildMentalModel(entries, scan.files, packageManifest);
  const typescript = analyzeTypeScriptProject(entries, scan.files, packageManifest, configSources);
  const map: ProjectMap = {
    workspace: root,
    fingerprint: hash(
      JSON.stringify(entries.map((e) => [e.path, e.hash])) + JSON.stringify(scan.files),
    ),
    generatedAt: Date.now(),
    complete,
    files: scan.files.length,
    indexed: entries.length,
    sourceBytes,
    format: pref.format,
    formatSource: pref.source,
    content: '',
    estimatedTokens: 0,
    entries,
    mentalModel,
    typescript,
    warnings,
  };
  map.content = renderMap(map);
  map.estimatedTokens = Math.ceil(map.content.length / 3);
  store.cache(`map:${root}`, map);
  return map;
}
