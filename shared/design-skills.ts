export const DESIGN_SKILLS = [
  {
    id: 'product-ui-design',
    name: 'Product UI Design',
    description: 'Design each screen around a clear user goal and complete states.',
    tags: ['UX', 'Flows', 'States'],
    instructions:
      'Start UI work from the user goal, primary action and information needed to decide. Keep one clear visual priority per screen and remove controls or copy without a concrete job. Reuse established product patterns. Model loading, empty, error, offline, permission, destructive and success states where they can occur. Prefer a safe reversible default for low-impact choices; ask only when a missing product decision materially changes the result. Verify the complete critical journey in the running interface before delivery.',
  },
  {
    id: 'visual-hierarchy',
    name: 'Visual Hierarchy',
    description: 'Make importance, grouping and reading order immediately clear.',
    tags: ['Layout', 'Typography', 'Density'],
    instructions:
      'Create an obvious reading order through placement, type scale, weight, spacing and contrast. Group related content and separate unrelated regions. Limit competing accents and keep secondary metadata quieter than actions and primary content. Prefer alignment and whitespace over extra borders, panels and explanatory copy. Avoid oversized headings, dense walls of text and repeated status information. Review the interface at its real viewport and simplify anything whose purpose is not clear within a few seconds.',
  },
  {
    id: 'design-system',
    name: 'Design System Discipline',
    description: 'Use consistent tokens, components and interaction states.',
    tags: ['Tokens', 'Components', 'Consistency'],
    instructions:
      'Inspect the existing component library, CSS variables and visual conventions before styling. Reuse semantic tokens for color, typography, spacing, radii, elevation and motion; do not introduce near-duplicate arbitrary values. Give shared controls consistent hover, focus, active, disabled, loading and error states. Extract a reusable component only when behavior and semantics repeat, and keep feature-specific composition near its feature. Preserve the current product identity unless the user asks for a redesign.',
  },
  {
    id: 'responsive-design',
    name: 'Responsive Design',
    description: 'Make layouts intentional across desktop, tablet and mobile.',
    tags: ['Mobile', 'Viewports', 'Touch'],
    instructions:
      'Design responsive behavior explicitly instead of shrinking the desktop layout. Define how navigation, columns, dense controls, tables and overlays adapt at narrow widths. Prevent horizontal overflow, clipped content and unreachable actions. Keep touch targets usable, important actions near their context and text readable without zoom. Preserve safe areas and keyboard avoidance in React Native. Validate representative desktop and mobile viewports in the local preview and record any device behavior that was not exercised.',
  },
  {
    id: 'accessibility-design',
    name: 'Accessible Interaction Design',
    description: 'Make structure, focus and feedback work without a mouse or vision assumptions.',
    tags: ['A11y', 'Keyboard', 'Semantics'],
    instructions:
      'Use semantic elements and accessible names before adding ARIA. Ensure every action works by keyboard, focus is visible, focus order follows reading order and dialogs restore focus. Associate labels, instructions and errors with their controls. Do not communicate state by color alone; maintain readable contrast and support reduced motion. Announce asynchronous feedback without stealing focus. Test the critical path with keyboard navigation and inspect the accessibility structure in the running interface.',
  },
  {
    id: 'forms-interaction-design',
    name: 'Forms and Interaction States',
    description: 'Build understandable forms with safe submission and recovery.',
    tags: ['Forms', 'Validation', 'Feedback'],
    instructions:
      'Keep forms short, logically grouped and explicit about required input. Use persistent labels, appropriate input types and helpful examples only when they reduce ambiguity. Validate at the right time, place actionable errors beside the relevant field and preserve valid input after failure. Represent idle, pending, success and failure states; prevent accidental duplicate submission. Confirm destructive actions in proportion to their impact and provide undo when practical. Verify success and denial paths, not only the happy path.',
  },
  {
    id: 'data-interface-design',
    name: 'Data Interface Design',
    description: 'Keep tables, catalogs, search and dashboards useful at realistic scale.',
    tags: ['Tables', 'Search', 'Dashboards'],
    instructions:
      'Prioritize the values and actions users need to compare or decide. Give search and filters clear scope, visible active state and an easy reset. Design empty, no-results, loading, partial and failed states separately. Keep sorting and pagination predictable and preserve useful state across navigation when appropriate. For narrow screens, choose deliberate column priority or an alternate item layout instead of compressing every field. Test with long labels, missing values, large counts and enough records to exercise density.',
  },
  {
    id: 'visual-review',
    name: 'Visual Review',
    description: 'Review the running UI with browser evidence before declaring it complete.',
    tags: ['Browser', 'Screenshots', 'QA'],
    instructions:
      'After UI changes, start the local preview and inspect the rendered result. Use existing browser, screenshot, scenario and visual assertion tools; without a configured vision model, treat screenshots as human-review artifacts and pixel evidence rather than semantic proof. Check hierarchy, alignment, spacing, overflow, content density, focus, interaction states and console failures at representative viewports. Fix confirmed regressions, rerun the critical scenario and report which visual states and sizes were actually inspected.',
  },
] as const;

export type DesignSkillId = (typeof DESIGN_SKILLS)[number]['id'];

export function designSkillsForProject(
  prompt: string,
  frameworks: string[],
  paths: string[],
): DesignSkillId[] {
  const selected = new Set<DesignSkillId>();
  const projectIsUi =
    frameworks.some((item) => /React|Next\.js|Expo/iu.test(item)) ||
    paths.some((item) => /(?:^|\/)(?:app|pages|screens|components|apps\/web)(?:\/|$)/iu.test(item));
  const uiRequest =
    /\bui\b|\bux\b|interface|screen|layout|component|page|form|dashboard|storefront|responsive|accessib|design|style|интерфейс|экран|дизайн|верстк|форм[аы]|адаптив|доступност/iu.test(
      prompt,
    );
  const buildsProduct =
    /build|create|implement|redesign|improve|собер|созд|реализ|передел|улучш/iu.test(prompt);
  if (!uiRequest && !(projectIsUi && buildsProduct)) return [];

  selected.add('product-ui-design');
  selected.add('accessibility-design');

  if (/design|style|layout|hierarchy|visual|дизайн|стил|внешн|иерарх|визуал/iu.test(prompt)) {
    selected.add('visual-hierarchy');
    selected.add('design-system');
  }
  if (/responsive|mobile|tablet|viewport|react.native|expo|адаптив|мобил|планшет/iu.test(prompt)) {
    selected.add('responsive-design');
  }
  if (/form|input|auth|login|register|checkout|settings|форм|пол[ея]|авторизац|регистрац|настройк/iu.test(prompt)) {
    selected.add('forms-interaction-design');
  }
  if (/table|dashboard|catalog|store|search|filter|list|таблиц|дашборд|каталог|магазин|поиск|фильтр|список/iu.test(prompt)) {
    selected.add('data-interface-design');
  }
  if (/review|polish|visual|design|style|дизайн|стил|редизайн|проверь.*интерфейс|улучш.*интерфейс/iu.test(prompt)) {
    selected.add('visual-review');
  }
  return [...selected];
}
