import ts from 'typescript';
import type { ProjectEntry, TypeScriptProjectAnalysis } from '../shared/types';

type Manifest = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const optionName = (value: unknown, names: Record<number, string>) =>
  typeof value === 'number' ? names[value] : typeof value === 'string' ? value : undefined;

export function analyzeTypeScriptProject(
  entries: ProjectEntry[],
  allFiles: string[],
  manifest: Manifest,
  configs: Record<string, string>,
): TypeScriptProjectAnalysis {
  const packages = { ...manifest.dependencies, ...manifest.devDependencies };
  const configFiles = Object.keys(configs).sort();
  const primary =
    configs['tsconfig.json'] ??
    configs[configFiles.find((file) => /tsconfig.*\.json$/.test(file)) ?? ''];
  let raw: Record<string, unknown> = {};
  if (primary) {
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', primary);
    if (!parsed.error && parsed.config && typeof parsed.config === 'object') raw = parsed.config;
  }
  const compilerOptions =
    raw.compilerOptions && typeof raw.compilerOptions === 'object'
      ? (raw.compilerOptions as Record<string, unknown>)
      : {};
  const references = Array.isArray(raw.references)
    ? raw.references
        .map((item) =>
          item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string'
            ? (item as { path: string }).path
            : '',
        )
        .filter(Boolean)
    : [];
  const scripts = Object.keys(manifest.scripts ?? {});
  const testRunners = [
    packages.vitest ? 'Vitest' : '',
    packages.jest ? 'Jest' : '',
    packages['@playwright/test'] ? 'Playwright' : '',
    packages.cypress ? 'Cypress' : '',
  ].filter(Boolean);
  const qualityTools = [
    packages.eslint ? 'ESLint' : '',
    packages.prettier ? 'Prettier' : '',
    packages.biome || packages['@biomejs/biome'] ? 'Biome' : '',
    packages['typescript-eslint'] || packages['@typescript-eslint/parser']
      ? 'typescript-eslint'
      : '',
  ].filter(Boolean);
  const indexedFiles = entries.map((entry) => entry.path);
  const sourceFiles = indexedFiles.filter(
    (file) => /\.[cm]?tsx?$/.test(file) && !/\.d\.ts$/.test(file),
  );
  const declarationFiles = indexedFiles.filter((file) => /\.d\.ts$/.test(file));
  const testFiles = allFiles.filter((file) =>
    /(?:^|\/)(?:__tests__\/|.*\.(?:test|spec)\.)/.test(file),
  );
  const detected = Boolean(packages.typescript || configFiles.length || sourceFiles.length);
  const strict = typeof compilerOptions.strict === 'boolean' ? compilerOptions.strict : undefined;
  const findings: TypeScriptProjectAnalysis['findings'] = [];
  if (!configFiles.length)
    findings.push({
      severity: 'warning',
      title: 'No tsconfig found',
      detail:
        'Language queries use safe defaults, but project-specific compiler behavior is unknown.',
    });
  else if (strict === true)
    findings.push({
      severity: 'good',
      title: 'Strict mode enabled',
      detail: 'The primary tsconfig explicitly enables strict type checking.',
    });
  else
    findings.push({
      severity: 'warning',
      title: 'Strict mode is not explicit',
      detail: 'Confirm inherited configs before relying on strict null and function checks.',
    });
  if (!testRunners.length)
    findings.push({
      severity: 'info',
      title: 'No test runner detected',
      detail: 'No Vitest, Jest, Playwright or Cypress dependency was found.',
    });
  if (!qualityTools.length)
    findings.push({
      severity: 'info',
      title: 'No TypeScript quality tool detected',
      detail: 'No ESLint, Biome or Prettier dependency was found.',
    });
  return {
    detected,
    version: packages.typescript?.replace(/^[~^]/, ''),
    configFiles,
    sourceFiles: sourceFiles.length,
    declarationFiles: declarationFiles.length,
    testFiles: testFiles.length,
    compiler: {
      strict,
      noEmit: compilerOptions.noEmit as boolean | undefined,
      allowJs: compilerOptions.allowJs as boolean | undefined,
      checkJs: compilerOptions.checkJs as boolean | undefined,
      skipLibCheck: compilerOptions.skipLibCheck as boolean | undefined,
      noUncheckedIndexedAccess: compilerOptions.noUncheckedIndexedAccess as boolean | undefined,
      exactOptionalPropertyTypes: compilerOptions.exactOptionalPropertyTypes as boolean | undefined,
      module: optionName(
        compilerOptions.module,
        ts.ModuleKind as unknown as Record<number, string>,
      ),
      moduleResolution: optionName(
        compilerOptions.moduleResolution,
        ts.ModuleResolutionKind as unknown as Record<number, string>,
      ),
      jsx: optionName(compilerOptions.jsx, ts.JsxEmit as unknown as Record<number, string>),
    },
    pathAliases:
      compilerOptions.paths && typeof compilerOptions.paths === 'object'
        ? Object.keys(compilerOptions.paths)
        : [],
    projectReferences: references,
    testRunners,
    qualityTools,
    findings,
    recommendedTools: [
      {
        name: 'Project structure analysis',
        status: 'ready',
        purpose: 'Entrypoints, roles, exports and internal import graph.',
      },
      {
        name: 'TypeScript quick info',
        status: detected ? 'ready' : 'missing',
        purpose: 'Resolved type and documentation at a source position.',
      },
      {
        name: 'Definitions and references',
        status: detected ? 'ready' : 'missing',
        purpose: 'Navigate symbols before editing or refactoring.',
      },
      {
        name: 'Full compiler check',
        status: configFiles.length > 0 ? 'ready' : 'missing',
        purpose: 'Validate the actual project config in the restricted runner.',
      },
      {
        name: 'Project tests',
        status:
          testRunners.length > 0 || scripts.some((script) => /test/i.test(script))
            ? 'detected'
            : 'missing',
        purpose: 'A restricted package-script runner is still needed to execute project tests.',
      },
      {
        name: 'Lint and format checks',
        status:
          qualityTools.length > 0 || scripts.some((script) => /lint|format/i.test(script))
            ? 'detected'
            : 'missing',
        purpose: 'A restricted package-script runner is still needed for repository-owned checks.',
      },
    ],
  };
}
