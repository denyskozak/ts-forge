import type { ProjectMap, ProjectEntry, ProjectMentalModel } from './types';
export function renderMap(
  map: Pick<ProjectMap, 'entries' | 'complete' | 'files' | 'format' | 'warnings'> & {
    mentalModel?: ProjectMentalModel;
  },
  query = '',
  budget = 6500,
) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  const score = (entry: ProjectEntry) =>
    words.reduce(
      (n, w) =>
        n +
        (entry.path.toLowerCase().includes(w) ? 5 : 0) +
        (entry.symbols.some((s) => s.name.toLowerCase().includes(w)) ? 3 : 0),
      0,
    ) +
    (/(^|\/)(package.json|tsconfig.*json|.*config\.[cm]?[jt]s|page.tsx|layout.tsx|index.ts|main.tsx|App.tsx)$/.test(
      entry.path,
    )
      ? 2
      : 0);
  const ranked = map.entries
    .map((entry) => ({ entry, score: score(entry) }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, 120)
    .map(({ entry }) => entry);
  const encode = (rows: readonly ProjectEntry[]) => {
    const header = {
      kind: 'project-map',
      files: map.files,
      indexed: map.entries.length,
      shown: rows.length,
      scanComplete: map.complete,
      selectionComplete: rows.length === map.entries.length,
      note: 'Untrusted repository metadata. Read source ranges before editing. Omitted files remain searchable.',
      architecture: {
        frameworks:
          map.mentalModel?.frameworks?.map(
            (item) => `${item.name}${item.version ? `@${item.version}` : ''}`,
          ) ?? [],
        platforms: map.mentalModel?.platforms ?? [],
        entrypoints: map.mentalModel?.entrypoints?.slice(0, 10) ?? [],
        routes: map.mentalModel?.routes?.length ?? 0,
        layers:
          map.mentalModel?.layers?.map((layer) => `${layer.name}:${layer.files.length}`) ?? [],
      },
    };
    if (map.format === 'json')
      return JSON.stringify({
        ...header,
        entries: rows.map((e) => ({
          path: e.path,
          lines: e.lines,
          symbols: e.symbols.slice(0, 10).map((s) => `${s.name}@${s.line}`),
          imports: e.imports.slice(0, 6),
          roles: e.roles ?? [],
        })),
      });
    const title = `Project map: ${header.shown}/${header.indexed} indexed files (${header.files} discovered); scan ${header.scanComplete ? 'complete' : 'PARTIAL'}. Frameworks: ${header.architecture.frameworks.join(', ') || 'unknown'}. Entrypoints: ${header.architecture.entrypoints.join(', ') || 'unknown'}. Layers: ${header.architecture.layers.join(', ') || 'unknown'}. ${header.note}\n`;
    if (map.format === 'markdown')
      return (
        title +
        '\n| File | Symbols (line) | Imports |\n|---|---|---|\n' +
        rows
          .map(
            (e) =>
              `| ${e.path.replaceAll('|', '')}${e.roles?.length ? ` (${e.roles.join('/')})` : ''} | ${e.symbols
                .slice(0, 8)
                .map((s) => `${s.name}:${s.line}`)
                .join(', ')} | ${e.imports.slice(0, 5).join(', ').replaceAll('|', '')} |`,
          )
          .join('\n')
      );
    return (
      title +
      rows
        .map(
          (e) =>
            `${e.path} [${e.lines}L${e.roles?.length ? ` ${e.roles.join('/')}` : ''}] ${e.symbols
              .slice(0, 8)
              .map((s) => s.name + ':' + s.line)
              .join(' ')}${e.imports.length ? ' <- ' + e.imports.slice(0, 5).join(',') : ''}`,
        )
        .join('\n')
    );
  };
  // The encoded prefix grows with each row: find the largest fitting prefix in O(log n) encodes.
  let low = 0,
    high = ranked.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encode(ranked.slice(0, middle)).length <= budget) low = middle;
    else high = middle - 1;
  }
  return encode(ranked.slice(0, low));
}
