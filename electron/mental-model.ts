import path from 'node:path';
import type { ProjectEntry, ProjectFileRole, ProjectMentalModel } from '../shared/types';

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

export function classifyProjectFile(
  filename: string,
  source: string,
  symbols: ProjectEntry['symbols'],
): ProjectFileRole[] {
  const normalized = filename.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  const roles = new Set<ProjectFileRole>();
  if (
    /^(index|main|App)\.[cm]?[jt]sx?$/.test(basename) ||
    /\/(_layout|layout)\.[jt]sx?$/.test(normalized)
  )
    roles.add('entrypoint');
  if (
    /(^|\/)app\/(?:.*\/)?(?:page|route)\.[jt]sx?$/.test(normalized) ||
    /(^|\/)pages\/[^/]+(?:\/[^/]+)*\.[jt]sx?$/.test(normalized)
  )
    roles.add('route');
  if (/(^|\/)(screens?|views?)\//i.test(normalized) || /Screen\.[jt]sx?$/.test(basename))
    roles.add('screen');
  if (
    /(^|\/)(components?|ui)\//i.test(normalized) ||
    symbols.some((item) => /^[A-Z]/.test(item.name))
  )
    roles.add('component');
  if (/(^|\/)hooks?\//i.test(normalized) || symbols.some((item) => /^use[A-Z0-9]/.test(item.name)))
    roles.add('hook');
  if (
    /(^|\/)(store|stores|state|contexts?|providers?)\//i.test(normalized) ||
    /createContext\s*\(|configureStore\s*\(|createSlice\s*\(|create\s*\(/.test(source)
  )
    roles.add('state');
  if (
    /(^|\/)(api|services?|clients?|repositories)\//i.test(normalized) ||
    /\b(fetch|axios|graphql|useQuery)\b/.test(source)
  )
    roles.add('api');
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) || /(^|\/)__tests__\//.test(normalized))
    roles.add('test');
  if (
    /^(package|tsconfig|app|metro|babel|vite|next|jest|vitest|eslint).*\.(json|[cm]?[jt]s)$/.test(
      basename,
    )
  )
    roles.add('config');
  return [...roles];
}

function dependencyVersion(packages: Record<string, string>, name: string) {
  return packages[name]?.replace(/^[~^]/, '');
}

function resolveImport(from: string, specifier: string, files: Set<string>) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const extension of SOURCE_EXTENSIONS) {
    const direct = base + extension;
    if (files.has(direct)) return direct;
    const index = path.posix.join(base, `index${extension}`);
    if (files.has(index)) return index;
  }
  return undefined;
}

function fileRoute(filename: string, router: 'next-app' | 'next-pages' | 'expo-router') {
  let route = filename.replaceAll('\\', '/');
  if (router === 'next-app')
    route = route.replace(/^.*?app\//, '').replace(/\/(page|route)\.[jt]sx?$/, '');
  if (router === 'next-pages') route = route.replace(/^.*?pages\//, '').replace(/\.[jt]sx?$/, '');
  if (router === 'expo-router') route = route.replace(/^.*?app\//, '').replace(/\.[jt]sx?$/, '');
  route = route
    .replace(/(^|\/)index$/, '$1')
    .replace(/\/(page|route)$/, '')
    .replace(/\([^/)]+\)\//g, '/');
  return '/' + route.replace(/^\/+|\/+$/g, '');
}

export function buildMentalModel(
  entries: ProjectEntry[],
  allFiles: string[],
  packageJson: unknown,
): ProjectMentalModel {
  const manifest = (packageJson && typeof packageJson === 'object' ? packageJson : {}) as {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    main?: string;
  };
  const packages = { ...manifest.dependencies, ...manifest.devDependencies };
  const frameworks: ProjectMentalModel['frameworks'] = [];
  const addFramework = (name: string, packageName: string, evidence: string[] = []) => {
    const version = dependencyVersion(packages, packageName);
    if (version) frameworks.push({ name, version, evidence: [packageName, ...evidence] });
  };
  addFramework('React', 'react');
  addFramework('React Native', 'react-native', ['ios/android or native runtime']);
  addFramework('Expo', 'expo', ['app.json/app.config']);
  addFramework('Expo Router', 'expo-router', ['app/ file routes']);
  addFramework('Next.js', 'next', ['app/ or pages/ routes']);
  addFramework('Vite', 'vite');

  const packageManager = allFiles.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : allFiles.includes('yarn.lock')
      ? 'yarn'
      : allFiles.includes('bun.lockb') || allFiles.includes('bun.lock')
        ? 'bun'
        : allFiles.includes('package-lock.json')
          ? 'npm'
          : undefined;
  const files = new Set(entries.map((entry) => entry.path));
  const entrypoints = entries
    .filter((entry) => entry.roles?.includes('entrypoint') || entry.path === manifest.main)
    .map((entry) => entry.path)
    .slice(0, 30);

  const routes: ProjectMentalModel['routes'] = [];
  const expoRouter = Boolean(packages['expo-router']);
  for (const entry of entries) {
    const filename = entry.path.replaceAll('\\', '/');
    if (
      /(^|\/)app\/.*\/(page|route)\.[jt]sx?$/.test(filename) ||
      /(^|\/)app\/(page|route)\.[jt]sx?$/.test(filename)
    )
      routes.push({
        route: fileRoute(filename, 'next-app'),
        file: filename,
        kind: 'Next App Router',
      });
    else if (
      /(^|\/)pages\/[^/]+(?:\/[^/]+)*\.[jt]sx?$/.test(filename) &&
      !/(_app|_document)\.[jt]sx?$/.test(filename)
    )
      routes.push({
        route: fileRoute(filename, 'next-pages'),
        file: filename,
        kind: 'Next Pages Router',
      });
    else if (
      expoRouter &&
      /(^|\/)app\/.*\.[jt]sx?$/.test(filename) &&
      !/_layout\.[jt]sx?$/.test(filename)
    )
      routes.push({
        route: fileRoute(filename, 'expo-router'),
        file: filename,
        kind: 'Expo Router',
      });
  }

  const collect = (role: ProjectFileRole, limit = 40) =>
    entries
      .filter((entry) => entry.roles?.includes(role))
      .map((entry) => entry.path)
      .slice(0, limit);
  const layerSpecs: [string, string, ProjectFileRole][] = [
    ['Routes & screens', 'User-visible routes, screens and navigation destinations', 'route'],
    ['Components', 'Reusable UI and feature components', 'component'],
    ['Hooks', 'Reusable behavior and lifecycle logic', 'hook'],
    ['State', 'Shared state, contexts and providers', 'state'],
    ['Data & services', 'Network, persistence and external service boundaries', 'api'],
    ['Tests', 'Behavior and regression checks', 'test'],
  ];
  const layers = layerSpecs
    .map(([name, purpose, role]) => ({ name, purpose, files: collect(role) }))
    .filter((layer) => layer.files.length);
  const evidenceFor = (names: string[]) =>
    entries
      .filter((entry) =>
        entry.imports.some(
          (item) => names.includes(item) || names.some((name) => item.startsWith(name + '/')),
        ),
      )
      .map((entry) => entry.path)
      .slice(0, 20);
  const state = [
    ['Redux Toolkit', ['@reduxjs/toolkit', 'react-redux']],
    ['Zustand', ['zustand']],
    ['MobX', ['mobx', 'mobx-react-lite']],
    ['XState', ['xstate', '@xstate/react']],
    ['React Context', ['react']],
  ]
    .map(([name, names]) => ({
      name: name as string,
      evidence: name === 'React Context' ? collect('state', 20) : evidenceFor(names as string[]),
    }))
    .filter((item) => item.evidence.length);
  const navigation = [
    ['Expo Router', ['expo-router']],
    [
      'React Navigation',
      ['@react-navigation/native', '@react-navigation/stack', '@react-navigation/native-stack'],
    ],
    ['React Router', ['react-router', 'react-router-dom']],
    ['Next Router', ['next/navigation', 'next/router']],
  ]
    .map(([name, names]) => ({ name: name as string, evidence: evidenceFor(names as string[]) }))
    .filter((item) => item.evidence.length);
  const data = [
    ['TanStack Query', ['@tanstack/react-query']],
    ['Apollo GraphQL', ['@apollo/client']],
    ['Axios', ['axios']],
    ['Firebase', ['firebase', '@react-native-firebase/app']],
    ['Supabase', ['@supabase/supabase-js']],
  ]
    .map(([name, names]) => ({ name: name as string, evidence: evidenceFor(names as string[]) }))
    .filter((item) => item.evidence.length);
  const relationships = entries
    .flatMap((entry) =>
      entry.imports
        .map((specifier) => {
          const target = resolveImport(entry.path, specifier, files);
          return target ? { from: entry.path, to: target } : undefined;
        })
        .filter((item): item is { from: string; to: string } => Boolean(item)),
    )
    .slice(0, 300);
  const platforms = [
    allFiles.some((file) => /(^|\/)ios\//.test(file)) || Boolean(packages['react-native'])
      ? 'iOS'
      : '',
    allFiles.some((file) => /(^|\/)android\//.test(file)) || Boolean(packages['react-native'])
      ? 'Android'
      : '',
    Boolean(packages.react || packages.next) ? 'Web' : '',
  ].filter(Boolean);
  const notes = [
    routes.length
      ? `${routes.length} file-based routes detected.`
      : 'No file-based routes detected; inspect navigator/router setup.',
    relationships.length >= 300
      ? 'Import relationships are capped at 300.'
      : `${relationships.length} internal import relationships detected.`,
    'This is a structural hypothesis. Confirm runtime behavior by reading entrypoints and feature files.',
  ];
  return {
    frameworks,
    packageManager,
    scripts: Object.keys(manifest.scripts ?? {}).slice(0, 40),
    platforms,
    entrypoints,
    routes: routes.slice(0, 100),
    layers,
    state,
    navigation,
    data,
    relationships,
    notes,
  };
}

export function summarizeMentalModel(model: ProjectMentalModel) {
  return {
    frameworks: model.frameworks,
    packageManager: model.packageManager,
    scripts: model.scripts,
    platforms: model.platforms,
    entrypoints: model.entrypoints,
    routes: model.routes.slice(0, 40),
    layers: model.layers.map((layer) => ({ ...layer, files: layer.files.slice(0, 20) })),
    state: model.state,
    navigation: model.navigation,
    data: model.data,
    relationshipCount: model.relationships.length,
    notes: model.notes,
  };
}

export function inspectMentalModel(
  model: ProjectMentalModel,
  entries: ProjectEntry[],
  query: string,
  projectScanComplete: boolean,
) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const ranked = entries
    .map((entry) => ({
      entry,
      score: words.reduce(
        (score, word) =>
          score +
          (entry.path.toLowerCase().includes(word) ? 6 : 0) +
          (entry.symbols.some((symbol) => symbol.name.toLowerCase().includes(word)) ? 4 : 0) +
          (entry.imports.some((item) => item.toLowerCase().includes(word)) ? 2 : 0),
        0,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, 30);
  const direct = new Set(ranked.map(({ entry }) => entry.path));
  const neighbors = new Set(
    model.relationships.flatMap((edge) =>
      direct.has(edge.from) ? [edge.to] : direct.has(edge.to) ? [edge.from] : [],
    ),
  );
  const selected = new Set([...direct, ...neighbors]);
  const files = [
    ...ranked.map(({ entry, score }) => ({
      path: entry.path,
      score,
      relation: 'direct match',
      roles: entry.roles ?? [],
      symbols: entry.symbols.slice(0, 12),
      imports: entry.imports.slice(0, 10),
    })),
    ...entries
      .filter((entry) => neighbors.has(entry.path) && !direct.has(entry.path))
      .slice(0, 20)
      .map((entry) => ({
        path: entry.path,
        score: 1,
        relation: 'one import hop',
        roles: entry.roles ?? [],
        symbols: entry.symbols.slice(0, 12),
        imports: entry.imports.slice(0, 10),
      })),
  ];
  return {
    query,
    files,
    relationships: model.relationships
      .filter((edge) => selected.has(edge.from) || selected.has(edge.to))
      .slice(0, 80),
    routes: model.routes
      .filter(
        (route) =>
          selected.has(route.file) ||
          words.some((word) => route.route.toLowerCase().includes(word)),
      )
      .slice(0, 30),
    completeness: { projectScanComplete, selectionComplete: ranked.length < 30 },
    next: 'Read the most relevant entrypoint/route and follow its internal imports. Use find_symbol or search_code when the feature name differs from filenames.',
  };
}

export function selectUnderstandingFiles(
  model: ProjectMentalModel,
  entries: ProjectEntry[],
  query: string,
  limit = 8,
) {
  const known = new Set(entries.map((entry) => entry.path));
  const selected: string[] = [];
  const add = (filename: string) => {
    if (known.has(filename) && !selected.includes(filename) && selected.length < limit)
      selected.push(filename);
  };
  model.entrypoints.forEach(add);
  // Start with the real boot path so the evidence is ordered like runtime execution.
  for (let cursor = 0; cursor < selected.length && selected.length < limit; cursor++)
    model.relationships
      .filter((edge) => edge.from === selected[cursor])
      .forEach((edge) => add(edge.to));
  const feature = inspectMentalModel(model, entries, query, true);
  feature.files.filter((file) => file.score > 1).forEach((file) => add(file.path));
  model.routes.forEach((route) => add(route.file));
  for (const layerName of ['Routes & screens', 'State', 'Data & services'])
    model.layers.find((layer) => layer.name === layerName)?.files.forEach(add);
  // Follow feature-specific imports added after the first traversal.
  for (let cursor = 0; cursor < selected.length && selected.length < limit; cursor++)
    model.relationships
      .filter((edge) => edge.from === selected[cursor])
      .forEach((edge) => add(edge.to));
  return selected;
}
