import path from 'node:path';
import ts from 'typescript';
import { compilerDirectory } from './compiler';
export interface AnalysisRequest {
  files: { path: string; source: string }[];
  query: {
    kind: 'diagnostics' | 'references' | 'definition' | 'quick_info';
    path: string;
    line: number;
    character: number;
  };
}
export function languageQuery(request: AnalysisRequest) {
  const sources = new Map(
    request.files.map((f) => [path.resolve('/forge-project', f.path), f.source]),
  );
  const libDir = path.join(compilerDirectory(), 'lib');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    allowJs: true,
  };
  const trustedRead = (file: string) => {
    const normalized = path.resolve(file);
    return (
      sources.get(normalized) ??
      (normalized.startsWith(libDir + path.sep) ? ts.sys.readFile(normalized) : undefined)
    );
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...sources.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      const text = trustedRead(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => '/forge-project',
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => path.join(libDir, 'lib.es2022.full.d.ts'),
    fileExists: (file) => trustedRead(file) !== undefined,
    readFile: trustedRead,
    directoryExists: (directory) =>
      directory.startsWith(libDir) ||
      [...sources.keys()].some((file) => file.startsWith(directory + path.sep)),
  };
  const service = ts.createLanguageService(host),
    target = path.resolve('/forge-project', request.query.path);
  try {
    const file = service.getProgram()?.getSourceFile(target);
    if (!file) throw new Error('Source file not indexed.');
    if (request.query.kind === 'diagnostics')
      return {
        scope:
          'Indexed sources with bundled TypeScript; external packages and tsconfig overrides are not loaded. Use typecheck for full project validation.',
        diagnostics: [
          ...service.getSyntacticDiagnostics(target),
          ...service.getSemanticDiagnostics(target),
        ]
          .slice(0, 80)
          .map((d) => ({
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
            line:
              d.file && d.start !== undefined
                ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
                : undefined,
          })),
      };
    const line = request.query.line - 1,
      character = request.query.character - 1;
    if (line < 0 || line >= file.getLineStarts().length)
      throw new Error('Line is outside the source file.');
    const position = file.getPositionOfLineAndCharacter(line, character);
    if (request.query.kind === 'quick_info') {
      const info = service.getQuickInfoAtPosition(target, position);
      return info
        ? {
            kind: info.kind,
            display: ts.displayPartsToString(info.displayParts),
            documentation: ts.displayPartsToString(info.documentation),
            tags: info.tags?.map((tag) => ({
              name: tag.name,
              text: typeof tag.text === 'string' ? tag.text : ts.displayPartsToString(tag.text),
            })),
          }
        : { display: '', documentation: '', kind: 'unknown' };
    }
    const entries =
      request.query.kind === 'definition'
        ? service.getDefinitionAtPosition(target, position)
        : service.getReferencesAtPosition(target, position);
    return {
      matches: (entries ?? [])
        .slice(0, 80)
        .filter((e) => sources.has(e.fileName))
        .map((e) => {
          const source = service.getProgram()!.getSourceFile(e.fileName)!;
          const pos = source.getLineAndCharacterOfPosition(e.textSpan.start);
          return {
            path: path.relative('/forge-project', e.fileName),
            line: pos.line + 1,
            character: pos.character + 1,
            length: e.textSpan.length,
          };
        }),
    };
  } finally {
    service.dispose();
  }
}
