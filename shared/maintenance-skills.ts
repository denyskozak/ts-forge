export const MAINTENANCE_SKILLS = [
  {
    id: 'debugging',
    name: 'Debug and regressions',
    description: 'Reproduce a failure, trace its cause and verify a regression test.',
    tags: ['Debugging', 'Tests'],
    instructions:
      'For a bug: reproduce observable failure, read the failing path and callers, record expected behavior, add a regression test that fails before the fix, repair the cause, then run affected checks. Use browser diagnostics for UI and maintenance_audit for an initial inventory. Never silence an error or weaken a test as a fix.',
  },
  {
    id: 'safe-refactoring',
    name: 'Compatible refactoring',
    description: 'Preserve public behavior and review every affected consumer.',
    tags: ['TypeScript', 'Compatibility'],
    instructions:
      'For refactoring: establish existing behavior and public API, inspect TypeScript references and analyze_impact. Use refactor_symbol for semantic rename proposals, review edits together through apply_changeset, preserve contracts and runtime behavior, and run compiler plus affected tests. Inspect dynamic consumers separately; semantic references cannot prove compatibility for external clients.',
  },
  {
    id: 'dependency-maintenance',
    name: 'Dependency maintenance',
    description: 'Inspect upgrades, advisories and compatibility before changing packages.',
    tags: ['Dependencies', 'Security'],
    instructions:
      'For upgrades: inspect dependency_outdated and dependency_audit only after network approval, read breaking changes through approved docs, change explicit packages with package_dependencies, inspect lockfile changes and run compiler, integration and browser checks. Registry audit is evidence about known advisories, not proof of security. Do not upgrade unrelated packages or use forced fixes.',
  },
  {
    id: 'security-review',
    name: 'Security boundaries',
    description: 'Review authorization, inputs, secrets and failure paths.',
    tags: ['Security', 'API'],
    instructions:
      'For security: identify assets, untrusted entrypoints and trust boundaries, trace authentication and server-side authorization, validate inputs and output exposure, verify secret storage, dependency advisories and resource bounds. Use maintenance_audit findings as hypotheses, read cited sources, add denial/error-path tests. Never report regex scans as a complete security audit; do not include secret values in model context.',
  },
  {
    id: 'release-recovery',
    name: 'Release and recovery',
    description: 'Verify delivery, migrations and rollback requirements.',
    tags: ['Release', 'Recovery'],
    instructions:
      'For release: use release_readiness, inspect Git and exact validation receipts, verify production build and runtime health, review data migrations separately with database_migrate on a disposable target. Document prerequisites, environment names, deployment steps, smoke checks and rollback/restore steps. Require explicit user authorization for remote delivery. A passed local check does not prove remote deployment.',
  },
] as const;
export type MaintenanceSkillId = (typeof MAINTENANCE_SKILLS)[number]['id'];
export function maintenanceSkillsForPrompt(prompt: string): MaintenanceSkillId[] {
  const selected: MaintenanceSkillId[] = [];
  if (/debug|bug|fix|ошиб|баг|исправ/iu.test(prompt)) selected.push('debugging');
  if (/refactor|rename|рефактор|переимен/iu.test(prompt)) selected.push('safe-refactoring');
  if (/upgrade|dependency|зависим|обнов/iu.test(prompt)) selected.push('dependency-maintenance');
  if (/security|auth|безопас|авториза/iu.test(prompt)) selected.push('security-review');
  if (/deploy|release|rollback|выпуск|релиз|деплой/iu.test(prompt))
    selected.push('release-recovery');
  return selected;
}
