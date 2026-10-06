/** Tool schemas cost local context. Load capabilities explicitly instead of advertising everything. */
export const TOOL_GROUPS = {
  core: [
    'plan_task',
    'apply_changeset',
    'analyze_impact',
    'run_validation',
    'list_files',
    'read_file',
    'read_files',
    'search_code',
    'find_symbol',
    'project_mental_model',
    'typescript_project_analysis',
    'inspect_feature',
    'ask_user_question',
    'write_file',
    'replace_text',
    'typescript_query',
    'typecheck',
    'discover_validation_plan',
    'enable_tool_group',
    'skill_instructions',
  ],
  development: [
    'project_templates',
    'scaffold_project',
    'product_recipes',
    'scaffold_product',
    'install_pnpm_dependencies',
    'package_scripts',
    'package_dependencies',
    'start_package_process',
    'list_package_processes',
    'stop_package_process',
  ],
  browser: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_fill',
    'browser_press',
    'browser_screenshot',
    'browser_wait',
    'browser_assert',
    'browser_select',
    'browser_scroll',
    'browser_viewport',
    'check_local_http',
    'inspect_local_preview',
    'start_local_preview',
    'run_ui_scenario',
  ],
  data: [
    'product_architecture',
    'api_contracts',
    'create_disposable_sqlite',
    'start_disposable_postgres',
    'stop_disposable_postgres',
    'run_seed_workflow',
    'database_migrate',
    'database_status',
  ],
  git: [
    'git_status',
    'git_diff',
    'git_log',
    'git_create_branch',
    'git_stage_files',
    'git_commit',
    'git_push',
    'contribution_guide',
  ],
  knowledge: ['search_local_knowledge', 'web_search'],
  native: ['inspect_native_project'],
  scene: ['inspect_scene'],
  ssh: ['ssh_profiles', 'ssh_test_connection', 'ssh_list_directory', 'ssh_upload_files'],
  maintenance: [
    'maintenance_audit',
    'dependency_audit',
    'dependency_outdated',
    'refactor_symbol',
    'release_readiness',
  ],
  mcp: ['mcp_servers', 'mcp_connect', 'mcp_tools', 'mcp_call', 'mcp_disconnect'],
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as [ToolGroup, ...ToolGroup[]];

export function selectToolGroups(
  prompt: string,
  frameworks: string[] = [],
  empty = false,
): ToolGroup[] {
  const groups = new Set<ToolGroup>(['core']);
  const includes = (expression: RegExp) => expression.test(prompt);
  if (
    empty ||
    includes(
      /build|create|implement|install|package|pnpm|npm|run|start|собер|созда|реализ|установ|запус|проект.*с\s+нуля/iu,
    )
  )
    groups.add('development');
  if (
    includes(
      /browser|preview|screen|ui\b|e2e|playwright|render|бразуер|браузер|интерфейс|экран|визуал|запус/iu,
    )
  )
    groups.add('browser');
  if (
    includes(
      /database|\bdb\b|prisma|drizzle|trpc|t3|sql|api|migration|seed|баз[ауы]|миграц|магазин|store|saas/iu,
    )
  )
    groups.add('data');
  if (includes(/\bgit\b|commit|push|branch|contribut|коммит|пуш|ветк|репозитор/iu))
    groups.add('git');
  if (includes(/documentation|docs|search|research|документ|найди|поиск|интернет/iu))
    groups.add('knowledge');
  if (
    frameworks.some((name) => /React Native|Expo/.test(name)) ||
    includes(/react.native|expo|mobile|мобильн/iu)
  )
    groups.add('native');
  if (
    frameworks.some((name) => /Three Fiber/.test(name)) ||
    includes(/r3f|three|3d|scene|сцен|змейк/iu)
  )
    groups.add('scene');
  if (includes(/\bssh\b|\bscp\b|deploy|upload|сервер|деплой|залить/iu)) groups.add('ssh');
  if (
    includes(
      /maintenance|refactor|upgrade|audit|security|performance|dependency|bug|debug|fix|сопровож|рефактор|обнов|безопас|производит|зависим|ошиб|баг|исправ/iu,
    )
  )
    groups.add('maintenance');
  if (includes(/\bmcp\b|мсп/iu)) groups.add('mcp');
  return [...groups];
}
export function initialToolGroups(relevant: ToolGroup[]): ToolGroup[] {
  const primary = relevant.find((group) => !['core', 'native', 'scene'].includes(group));
  return [
    'core',
    ...relevant.filter((group) => group === primary || group === 'native' || group === 'scene'),
  ];
}
export function enableToolGroup(groups: Set<ToolGroup>, group: ToolGroup, enabled: boolean) {
  if (group === 'core' && !enabled) throw new Error('Core tools cannot be unloaded.');
  if (enabled) {
    if (!['core', 'native', 'scene'].includes(group))
      for (const loaded of groups)
        if (!['core', 'native', 'scene'].includes(loaded)) groups.delete(loaded);
    groups.add(group);
  } else groups.delete(group);
}
export function allowedToolNames(groups: Iterable<ToolGroup>, webEnabled = false) {
  const names = new Set<string>();
  for (const group of groups) TOOL_GROUPS[group]?.forEach((name) => names.add(name));
  if (!webEnabled) names.delete('web_search');
  return names;
}
export const TOOL_SELECTION_INSTRUCTIONS = `Only currently relevant capabilities are advertised. Use enable_tool_group to load a missing capability for a concrete next action. Available groups: development (scaffold, packages, processes), browser (interactions and assertions), data (contracts, disposable DB, migrations), git, knowledge (local docs and opt-in web), native, scene (R3F), maintenance (debugging, dependency/security audit, semantic refactoring, release checks), ssh, mcp. Tool availability never grants permission to execute an action. Loading a large group replaces the previous optional group; core and small framework inspections remain. Only call tools advertised on this pass. Switch groups as the task moves between implementation, data, preview and delivery.`;
