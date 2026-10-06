import path from 'node:path';
import ts from 'typescript';
import { compilerDirectory } from './compiler';
import { createHash } from 'node:crypto';
import type { ImpactReport } from '../shared/task';
export interface AnalysisRequest {
  files: { path: string; source: string }[];
  query: {
    kind: 'diagnostics' | 'references' | 'definition' | 'quick_info' | 'impact' | 'rename';
    path: string;
    line: number;
    character: number;
    offset?: number;
    limit?: number;
    paths?: string[];
    newName?: string;
  };
  complete?: boolean;
  skipped?: number;
}
const virtualRoot = '/forge-project';
const resolve = (p: string) => path.resolve(virtualRoot, p);
export function createAnalysisEngine() {
  const sources = new Map<string, string>(),
    versions = new Map<string, number>();
  const libDir = path.join(compilerDirectory(), 'lib');
  let options: ts.CompilerOptions = {},
    roots: string[] = [],
    generation = 0;
  const read = (file: string) =>
    sources.get(path.resolve(file)) ??
    (path.resolve(file).startsWith(libDir + path.sep) ? ts.sys.readFile(file) : undefined);
  const exists = (file: string) => read(file) !== undefined;
  const directories = (dir: string) =>
    [...sources.keys()].some((file) => file.startsWith(dir + '/')) || dir.startsWith(libDir);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => roots,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getProjectVersion: () => String(generation),
    getScriptSnapshot: (file) => {
      const text = read(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => virtualRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => path.join(libDir, 'lib.es2022.full.d.ts'),
    fileExists: exists,
    readFile: read,
    directoryExists: directories,
    readDirectory: (dir, extensions) =>
      [...sources.keys()].filter(
        (f) => f.startsWith(dir + '/') && (!extensions || extensions.some((e) => f.endsWith(e))),
      ),
  };
  const service = ts.createLanguageService(host);
  function query(request: AnalysisRequest) {
    let updatedFiles = 0;
    const incoming = new Set(request.files.map((f) => resolve(f.path)));
    for (const file of sources.keys())
      if (!incoming.has(file)) {
        sources.delete(file);
        versions.set(file, (versions.get(file) ?? 0) + 1);
        updatedFiles++;
      }
    for (const file of request.files) {
      const absolute = resolve(file.path);
      if (sources.get(absolute) !== file.source) {
        sources.set(absolute, file.source);
        versions.set(absolute, (versions.get(absolute) ?? 0) + 1);
        updatedFiles++;
      }
    }
    const target = resolve(request.query.path);
    const configs = [...sources.keys()].filter((f) => /\/tsconfig(?:\.[^/]+)?\.json$/.test(f));
    const config = configs
      .filter((f) => target.startsWith(path.dirname(f) + '/'))
      .sort((a, b) => path.dirname(b).length - path.dirname(a).length || a.localeCompare(b))[0];
    const warnings: string[] = [
      'External dependency declarations are not indexed; use the isolated compiler recipe for full validation.',
    ];
    let nextOptions: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      allowJs: true,
    };
    if (config) {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        config,
        { noEmit: true },
        {
          useCaseSensitiveFileNames: true,
          getCurrentDirectory: () => virtualRoot,
          readFile: read,
          fileExists: exists,
          readDirectory: host.readDirectory!,
          onUnRecoverableConfigFileDiagnostic: (d) =>
            warnings.push(ts.flattenDiagnosticMessageText(d.messageText, '\n')),
        },
      );
      if (parsed) {
        nextOptions = { ...parsed.options, noEmit: true };
        warnings.push(
          ...parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
        );
        for (const ref of parsed.projectReferences ?? []) {
          if (!sources.has(path.join(ref.path, 'tsconfig.json')) && !sources.has(ref.path))
            warnings.push(
              `Referenced project not indexed: ${path.relative(virtualRoot, ref.path)}`,
            );
        }
      }
    }
    const sourceNames = [...sources.keys()].filter((f) => /\.[cm]?[jt]sx?$/.test(f));
    if (updatedFiles || JSON.stringify(nextOptions) !== JSON.stringify(options)) generation++;
    options = nextOptions;
    roots = sourceNames;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([...sources].sort()))
      .digest('hex');
    const meta = {
      indexedFiles: sourceNames.length,
      skippedFiles: request.skipped ?? 0,
      snapshotComplete: request.complete ?? true,
      updatedFiles,
      generation,
      fingerprint,
      config: config ? path.relative(virtualRoot, config) : null,
      scope:
        'Indexed source graph with selected tsconfig. Project references are indexed as source; external package declarations are excluded.',
      warnings,
    };
    const program = service.getProgram();
    if (!program) throw new Error('No TypeScript program available.');
    const checker = program.getTypeChecker();
    if (request.query.kind === 'impact') {
      const changed = [...new Set(request.query.paths ?? [request.query.path])];
      const edges: ImpactReport['edges'] = [],
        exported: ImpactReport['exports'] = [],
        boundaries: ImpactReport['boundaries'] = [];
      for (const source of program.getSourceFiles()) {
        if (!sources.has(source.fileName)) continue;
        const relative = path.relative(virtualRoot, source.fileName);
        for (const statement of source.statements) {
          if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
            const declaration = symbol?.declarations?.find(ts.isSourceFile);
            const resolution =
              declaration?.fileName ??
              ts.resolveModuleName(statement.moduleSpecifier.text, source.fileName, options, {
                fileExists: exists,
                readFile: read,
                directoryExists: directories,
              }).resolvedModule?.resolvedFileName;
            if (resolution && sources.has(resolution))
              edges.push({
                from: relative,
                to: path.relative(virtualRoot, resolution),
                line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1,
              });
          }
        }
        if (changed.includes(relative)) {
          const symbol = checker.getSymbolAtLocation(source);
          if (symbol)
            for (const exp of checker.getExportsOfModule(symbol))
              exported.push({ path: relative, name: exp.name });
        }
        const text = source.text;
        if (/['"]use (client|server)['"]/.test(text))
          boundaries.push({ path: relative, reason: 'Next.js client/server boundary' });
        if (/\b(fetch|axios|ipcRenderer|ipcMain|NativeModules|exec|spawn)\b/.test(text))
          boundaries.push({
            path: relative,
            reason: 'Potential network, IPC, native or process boundary; inspect source',
          });
      }
      const affected = new Set(changed);
      let grew = true;
      while (grew) {
        grew = false;
        for (const edge of edges)
          if (affected.has(edge.to) && !affected.has(edge.from)) {
            affected.add(edge.from);
            grew = true;
          }
      }
      const relevantEdges = edges.filter(
        (edge) => affected.has(edge.from) && affected.has(edge.to),
      );
      const result: ImpactReport = {
        changed,
        affected: [...affected].sort(),
        tests: [...affected].filter((f) =>
          /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/.test(f),
        ),
        exports: exported.slice(0, 200),
        edges: relevantEdges.slice(0, 500),
        boundaries: boundaries.filter((b) => affected.has(b.path)),
        warnings: [
          ...warnings,
          'Impact follows resolved static imports and re-exports. Dynamic imports, runtime calls and external consumers may be missing.',
        ],
        complete: false,
        indexedFiles: sourceNames.length,
        fingerprint,
      };
      if (!meta.snapshotComplete) result.warnings.push('Source snapshot is partial.');
      if (exported.length > 200 || relevantEdges.length > 500)
        result.warnings.push('Graph display limit reached.');
      return result;
    }
    const file = program.getSourceFile(target);
    if (!file) throw new Error('Source file not indexed.');
    const offset = request.query.offset ?? 0,
      limit = request.query.limit ?? 80;
    const page = <T>(items: T[]) => ({
      items: items.slice(offset, offset + limit),
      total: items.length,
      returned: Math.max(0, Math.min(limit, items.length - offset)),
      truncated: offset + limit < items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null,
    });
    if (request.query.kind === 'diagnostics') {
      const p = page(
        [...service.getSyntacticDiagnostics(target), ...service.getSemanticDiagnostics(target)].map(
          (d) => ({
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
            line:
              d.file && d.start !== undefined
                ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
                : undefined,
          }),
        ),
      );
      return { ...meta, ...p, diagnostics: p.items };
    }
    const line = request.query.line - 1,
      character = request.query.character - 1;
    if (line < 0 || line >= file.getLineStarts().length || character < 0)
      throw new Error('Position is outside the source file.');
    const position = file.getPositionOfLineAndCharacter(line, character);
    if (request.query.kind === 'rename') {
      const newName = request.query.newName ?? '';
      if (!/^[A-Za-z_$][\w$]*$/.test(newName))
        throw new Error('Use a valid TypeScript identifier.');
      const info = service.getRenameInfo(target, position);
      if (!info.canRename) throw new Error(info.localizedErrorMessage);
      const locations = service.findRenameLocations(target, position, false, false, true) ?? [];
      if (locations.some((item) => !sources.has(item.fileName)))
        throw new Error('Rename crosses the indexed project boundary.');
      const grouped = new Map<string, typeof locations>();
      for (const location of locations)
        grouped.set(location.fileName, [...(grouped.get(location.fileName) ?? []), location]);
      const edits = [...grouped].map(([filename, locations]) => {
        const before = sources.get(filename)!;
        let content = before;
        for (const location of [...locations].sort((a, b) => b.textSpan.start - a.textSpan.start)) {
          content =
            content.slice(0, location.textSpan.start) +
            (location.prefixText ?? '') +
            newName +
            (location.suffixText ?? '') +
            content.slice(location.textSpan.start + location.textSpan.length);
        }
        return {
          path: path.relative(virtualRoot, filename),
          content,
          hash: createHash('sha256').update(before).digest('hex'),
        };
      });
      if (!request.complete || edits.length > 40 || JSON.stringify(edits).length > 80_000)
        throw new Error(
          'Rename needs a complete, bounded source index. Narrow the workspace or rename manually.',
        );
      return {
        ...meta,
        edits,
        applied: false,
        note: 'Proposal only. Review public API compatibility, then submit edits with apply_changeset.',
      };
    }
    if (request.query.kind === 'quick_info') {
      const info = service.getQuickInfoAtPosition(target, position);
      return {
        ...meta,
        kind: info?.kind ?? 'unknown',
        display: ts.displayPartsToString(info?.displayParts),
        documentation: ts.displayPartsToString(info?.documentation),
      };
    }
    const entries =
      request.query.kind === 'definition'
        ? service.getDefinitionAtPosition(target, position)
        : service.getReferencesAtPosition(target, position);
    const p = page(
      (entries ?? [])
        .filter((e) => sources.has(e.fileName))
        .map((e) => {
          const pos = program
            .getSourceFile(e.fileName)!
            .getLineAndCharacterOfPosition(e.textSpan.start);
          return {
            path: path.relative(virtualRoot, e.fileName),
            line: pos.line + 1,
            character: pos.character + 1,
            length: e.textSpan.length,
          };
        }),
    );
    return { ...meta, ...p, matches: p.items };
  }
  return { query, dispose: () => service.dispose() };
}
export function languageQuery(request: AnalysisRequest) {
  const engine = createAnalysisEngine();
  try {
    return engine.query(request);
  } finally {
    engine.dispose();
  }
}
