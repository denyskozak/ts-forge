export const QUALITY_SKILLS = [
  {
    id: 'code-readability',
    name: 'Readable TypeScript',
    description: 'Keep source easy to review, navigate and change.',
    tags: ['Readability', 'Formatting', 'Naming'],
    instructions:
      'Write readable TypeScript for humans. Never compress modules, tests or control flow onto one line. Format the final files with the project formatter. Use descriptive domain names, small focused functions, early returns and explicit error paths. Remove duplication when it represents the same rule, but do not hide simple behavior behind generic abstractions. Keep exported APIs small and document only decisions that code cannot express. Before delivery, read every changed file as a reviewer and split dense code until its responsibilities and execution order are obvious.',
  },
  {
    id: 'modular-design',
    name: 'Modular Architecture',
    description: 'Separate domain, application, infrastructure and UI responsibilities.',
    tags: ['Modules', 'Boundaries', 'Maintainability'],
    instructions:
      'Design cohesive modules with one reason to change. Keep domain rules independent from HTTP, persistence and framework code. Put orchestration in application services, adapters at system boundaries and shared contracts in explicit contract modules. Dependencies point inward toward domain behavior. Avoid circular imports, catch-all utility files, god components and repositories that also validate requests. Refactor by observable behavior, preserve public contracts and add tests at each important boundary.',
  },
  {
    id: 'backend-security',
    name: 'Backend Security',
    description: 'Secure API boundaries, authorization, sessions and resource usage.',
    tags: ['API', 'Auth', 'Security'],
    instructions:
      'Treat every backend entrypoint as untrusted. Parse and validate method, path, headers, cookies, query values and JSON bodies before domain code. Authenticate sessions securely and authorize every resource access server-side. Use generic external auth errors, safe internal error mapping, HttpOnly Secure SameSite cookies where applicable, explicit CORS origins, security headers, request size limits and bounded pagination. Keep secrets and password material out of logs and responses. Add denial-path tests for anonymous access, cross-user access, invalid input, CSRF/CORS and unavailable dependencies. Do not claim security from headers or validation alone; review data access and failure behavior together.',
  },
  {
    id: 'orm-data-access',
    name: 'ORM Data Access',
    description: 'Use typed schemas, migrations and repository boundaries instead of scattered SQL.',
    tags: ['ORM', 'Database', 'Migrations'],
    instructions:
      'For application persistence, prefer an installed typed ORM and its query builder over handwritten SQL. For new SQLite TypeScript services use Drizzle ORM with an explicit schema and versioned migrations unless project evidence supports another ORM. Keep ORM models and database setup in infrastructure, map records to domain types in repositories and expose intent-based repository methods. Never interpolate SQL. Raw SQL is limited to reviewed migrations or a measured query that the ORM cannot express, with a short reason and tests. Add indexes and constraints for actual access patterns, use transactions for multi-write invariants, and test migrations plus persistence across reopen. Do not leak ORM row shapes into HTTP or UI contracts.',
  },
  {
    id: 'frontend-architecture',
    name: 'Frontend Architecture',
    description: 'Build accessible feature modules with explicit state and API boundaries.',
    tags: ['React', 'State', 'Accessibility'],
    instructions:
      'Structure React by user-facing features and stable boundaries. Keep page composition thin; move API access into a typed client, server-state coordination into focused hooks, pure domain transformations into testable modules and reusable visual behavior into small components. Model loading, empty, error and success states explicitly. Avoid one component owning authentication, catalog, search and cart behavior at once. Derive state instead of synchronizing it with effects, cancel stale requests, preserve keyboard and screen-reader behavior, and surface actionable failures. Test pure rules, component states and the critical user journey without coupling assertions to internal component structure.',
  },
] as const;

export type QualitySkillId = (typeof QUALITY_SKILLS)[number]['id'];

export function qualitySkillsForProject(
  prompt: string,
  frameworks: string[],
  paths: string[],
): QualitySkillId[] {
  const selected = new Set<QualitySkillId>();
  const implementation =
    /build|create|implement|change|improve|refactor|fix|созд|собер|забилд|рефактор|улучш|измен|исправ/iu.test(
      prompt,
    );
  if (implementation || /readab|quality|читаем|качеств|месив/iu.test(prompt)) {
    selected.add('code-readability');
    selected.add('modular-design');
  }
  const backend =
    /backend|server|api|database|auth|security|бекенд|сервер|безопас|баз[аы]\s+данн/iu.test(prompt) ||
    paths.some((item) => /(?:^|\/)(?:api|server|backend)(?:\/|$)/iu.test(item));
  if (backend) selected.add('backend-security');
  const persistence =
    /\borm\b|drizzle|prisma|database|sqlite|postgres|sql|миграц|баз[аы]\s+данн/iu.test(prompt) ||
    paths.some((item) => /(?:schema|migration|persistence|repository|database|\.sql)/iu.test(item));
  if (backend && persistence) selected.add('orm-data-access');
  const frontend =
    /frontend|react|client|ui|фронтенд|клиент|интерфейс/iu.test(prompt) ||
    frameworks.some((item) => /React|Next\.js/iu.test(item)) ||
    paths.some((item) => /(?:^|\/)apps\/web(?:\/|$)/iu.test(item));
  if (frontend) selected.add('frontend-architecture');
  return [...selected];
}
