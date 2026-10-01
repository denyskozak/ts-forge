import ts from 'typescript';
import type { ProjectEntry } from '../shared/types';
import type { SceneEvidence, SceneSource } from '../shared/react-three';
const scenePackage = (name: string) =>
  name === 'three' || name.startsWith('three/') || name.startsWith('@react-three/');

export function describeScene(file: ts.SourceFile): SceneSource {
  const bindings = new Map<string, { module: string; name: string }>();
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause?.isTypeOnly) continue;
    if (clause?.name) bindings.set(clause.name.text, { module, name: 'default' });
    const imports = clause?.namedBindings;
    if (imports && ts.isNamespaceImport(imports))
      bindings.set(imports.name.text, { module, name: '*' });
    if (imports && ts.isNamedImports(imports))
      for (const item of imports.elements) {
        if (!item.isTypeOnly)
          bindings.set(item.name.text, { module, name: (item.propertyName ?? item.name).text });
      }
  }
  const resolve = (expression: ts.Node): { module: string; name: string } | undefined => {
    if (ts.isIdentifier(expression)) return bindings.get(expression.text);
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = resolve(expression.expression);
      if (parent?.name === '*') return { module: parent.module, name: expression.name.text };
      if (parent && expression.name.text === 'preload')
        return { ...parent, name: parent.name + '.preload' };
    }
    return undefined;
  };
  const evidence: SceneEvidence[] = [];
  let truncated = false;
  const owner = (node: ts.Node): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
      if (
        (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
        ts.isVariableDeclaration(parent.parent) &&
        ts.isIdentifier(parent.parent.name)
      )
        return parent.parent.name.text;
    }
    return '<module>';
  };
  const add = (
    node: ts.Node,
    kind: SceneEvidence['kind'],
    name: string,
    detail: string,
    parent?: string,
  ) => {
    if (evidence.length >= 160) {
      truncated = true;
      return;
    }
    evidence.push({
      kind,
      name,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      owner: owner(node),
      detail: detail.slice(0, 280),
      ...(parent ? { parent } : {}),
    });
  };
  const text = (node: ts.Node) => node.getText(file).slice(0, 160);
  const primitive =
    /^(mesh|group|scene|primitive|instancedMesh|points|lineSegments|sprite|.*Geometry|.*Material|.*Light|.*Camera)$/;
  const visit = (node: ts.Node, parentTag?: string, inFrame = false) => {
    if (ts.isJsxElement(node)) {
      visit(node.openingElement, parentTag, inFrame);
      const tag = node.openingElement.tagName.getText(file);
      const binding = resolve(node.openingElement.tagName);
      const sceneParent =
        parentTag || primitive.test(tag) || (binding && scenePackage(binding.module));
      node.children.forEach((child) => visit(child, sceneParent ? tag : undefined, inFrame));
      return;
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(file),
        binding = resolve(node.tagName);
      const known = binding && scenePackage(binding.module);
      const canvas = binding?.module.startsWith('@react-three/fiber') && binding.name === 'Canvas';
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const kind = canvas
        ? 'canvas'
        : binding?.module === '@react-three/rapier' || binding?.module === '@react-three/cannon'
          ? 'physics'
          : binding?.module === '@react-three/postprocessing'
            ? 'effect'
            : 'object';
      if (known || primitive.test(tag) || parentTag)
        add(node, kind, binding?.name ?? tag, attrs.map(text).join(' '), parentTag);
      for (const attr of attrs) {
        if (
          /^on(Pointer|Click|DoubleClick|Wheel|ContextMenu)/.test(attr.name.getText(file)) &&
          (known || primitive.test(tag) || parentTag)
        )
          add(attr, 'interaction', attr.name.getText(file), text(attr), tag);
      }
    }
    if (ts.isCallExpression(node)) {
      const binding = resolve(node.expression);
      if (binding?.module.startsWith('@react-three/fiber') && binding.name === 'useFrame') {
        add(
          node,
          'frame',
          'useFrame',
          node.arguments[1]
            ? `Ordering/priority: ${text(node.arguments[1])}; verify installed API and render ownership.`
            : 'Default frame subscription.',
        );
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
          visit(callback.body, parentTag, true);
        else if (callback)
          add(
            node,
            'review',
            'frame-callback',
            `Follow callback ${text(callback)}; its body was not inspected here.`,
          );
        return;
      }
      if (
        binding &&
        scenePackage(binding.module) &&
        /^(useGLTF|useFBX|useTexture|useLoader)(\.preload)?$/.test(binding.name)
      ) {
        const argument = node.arguments[binding.name.startsWith('useLoader') ? 1 : 0];
        add(node, 'asset', binding.name, argument ? text(argument) : 'Unresolved asset argument');
      }
      if (inFrame && ts.isIdentifier(node.expression) && /^set[A-Z]/.test(node.expression.text))
        add(
          node,
          'review',
          'frame-state-call',
          `${node.expression.text} in frame callback: inspect whether this triggers React/store renders.`,
        );
    }
    if (inFrame && ts.isNewExpression(node))
      add(
        node,
        'review',
        'frame-allocation',
        `${text(node)} in frame callback: inspect allocation cost and reuse.`,
      );
    ts.forEachChild(node, (child) => visit(child, parentTag, inFrame));
  };
  visit(file);
  // Ordinary DOM JSX is not evidence of a Three scene on its own.
  const relevant =
    [...bindings.values()].some((binding) => scenePackage(binding.module)) ||
    evidence.some((item) => primitive.test(item.name));
  return { version: 1, evidence: relevant ? evidence : [], truncated: relevant && truncated };
}

export function inspectScene(
  entries: ProjectEntry[],
  query = '',
  offset = 0,
  limit = 60,
  projectScanComplete = true,
) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const all = entries.flatMap((entry) =>
    (entry.scene?.evidence ?? []).map((item) => ({ path: entry.path, ...item })),
  );
  const matches = all.filter(
    (item) =>
      !words.length ||
      words.some((word) =>
        `${item.path} ${item.kind} ${item.name} ${item.owner} ${item.detail}`
          .toLowerCase()
          .includes(word),
      ),
  );
  return {
    query,
    evidence: matches.slice(offset, offset + limit),
    total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    completeness: {
      projectScanComplete,
      sourceEvidenceTruncated: entries.some((entry) => entry.scene?.truncated),
      selectionComplete: offset === 0 && matches.length <= limit,
      runtimeGraphComplete: false,
    },
    notes: [
      'Static syntax evidence, not runtime scene instances. JSX parent labels are lexical containment, not resolved component expansion.',
      'Aliases and namespace imports are recognized; local shadowing, re-exports, computed loaders, custom hooks and dynamically assembled scenes require source inspection.',
      'Review hints are not confirmed defects. Read cited files and trace state, assets and physics before editing. No assets or shaders were executed or fetched.',
    ],
  };
}
