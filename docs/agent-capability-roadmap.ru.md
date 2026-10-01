# Roadmap полезности TS Forge

Дата анализа: 1 октября 2026 года.

## Цель продукта

TS Forge должен надёжно выполнять полный цикл работы с TypeScript-проектом:

1. открыть и безопасно проиндексировать проект;
2. построить проверяемую ментальную модель;
3. понять задачу и критические ограничения;
4. оценить область влияния до изменения;
5. подготовить атомарный набор правок;
6. проверить типы, тесты, архитектурные правила и риски;
7. показать человеку доказательства результата и оставить возможность отката.

Главный продуктовый ориентир — не количество вызванных tools, а доля задач, для которых Forge может доказать: **что он понял, что изменил, почему изменение ограничено нужной областью и чем подтверждена корректность**.

## Реализация первых пяти улучшений

Первые пять направлений реализованы в базовом рабочем объёме: контракт задачи с подтверждаемыми критериями, общий ChangeSet с журналом восстановления, изолированные validation recipes, постоянный TypeScript LanguageService и semantic impact preview. Описание использования и точных ограничений — в [README](../README.md#task-contracts-grouped-changes-and-evidence).

Проверки привязаны к отпечатку исходников; verified требует подтверждения человека. ChangeSet восстанавливается после прерывания, но не обеспечивает одновременную видимость всех файлов для внешних процессов. Анализ project references и runtime-связей остаётся ограниченным; зависимости validators читаются из установленного node_modules. Полная изоляция task worktree, полноценный multi-project service и граф runtime-потоков остаются дальнейшей работой.

Ниже сохранён исходный анализ до реализации: формулировки «сейчас» описывают ту исходную версию.

## Текущее состояние на момент анализа

### Сильная база

- Renderer изолирован от Node.js; IPC ограничен явными методами и проверяет отправителя.
- Workspace policy блокирует выход из проекта, symlink, ignored paths, типовые секреты, бинарные и слишком большие файлы.
- Чтение возвращает hash и явную информацию о частичном диапазоне.
- Запись требует актуально прочитанную версию, review diff и отдельное подтверждение.
- Есть checkpoint и guarded undo.
- Project map определяет TypeScript, React, React Native, Expo и Next.js, entrypoints, routes, layers, state, navigation и data boundaries.
- TypeScript worker умеет diagnostics, definition, references и quick info.
- Критическое уточнение останавливает run и не разрешает sibling tools действовать до ответа.
- Сессии, waiting state, journal и recovery сохраняются локально в SQLite.

### Главные разрывы

| Качество | Что ограничивает Forge сейчас |
| --- | --- |
| Надёжность результата | Завершённый текст модели считается окончанием задачи даже без применённой правки и проверки acceptance criteria. |
| Устойчивость | Полный restart прерывает run; snapshot и IPC events не имеют общего sequence/revision contract. |
| Масштабируемость | Каждый TypeScript query заново сканирует файлы и создаёт LanguageService; SQLite сохраняет весь state одним JSON snapshot. |
| Расширяемость | Tool schemas, handlers, policy и prompt собраны в одном `Agent`; framework skills остаются строками в shared types. |
| Сопровождаемость | `App.tsx` и `agent.ts` стали крупными центрами ответственности; runtime types и Zod persistence schemas дублируются. |
| Безопасность изменения | Правки подтверждаются по одному файлу; нет атомарного multi-file changeset, отдельной task workspace и проверки общего blast radius. |
| Полнота анализа | References ограничены 80 результатами без pagination; semantic snapshot ограничен 500 файлами/8 MB и не сообщает всю полноту. |
| Проверка проекта | Агент может запускать только `tsc`; тесты, lint и framework build не оформлены как безопасные validation recipes. |

## P0 · Сделать результат доказуемым

### 1. Task Contract и Definition of Done

Перед правками harness формирует структурированный контракт:

```ts
interface TaskContract {
  goal: string;
  constraints: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  outOfScope: string[];
  risk: 'low' | 'medium' | 'high';
  requiredValidation: ValidationRecipeId[];
}
```

Контракт строится из запроса, project evidence и ответа на критические вопросы. Пользователь видит короткий plan: затрагиваемые области, критерии готовности и проверки.

Финальный статус должен быть структурированным:

- `completed_verified` — критерии подтверждены;
- `completed_unverified` — изменение сделано, но часть проверок не выполнена;
- `analysis_only` — проект исследован без изменения;
- `needs_input` — нужен ответ человека;
- `blocked` — конкретное внешнее ограничение;
- `failed` или `stopped`.

Модель не должна сама объявлять `completed_verified`. Этот статус вычисляет harness по применённому changeset и результатам validators.

**Эффект:** устойчивость, сопровождаемость, меньше ложных «готово».

**Критерий готовности:** запрос на изменение не может закончиться verified-успехом без применённой правки и требуемых проверок.

### 2. Атомарный ChangeSet

Сейчас несколько файлов меняются как независимые approvals. Для React/Next-фичи нужен общий changeset:

```ts
interface ChangeSet {
  id: string;
  baseFingerprint: string;
  files: Change[];
  rationale: string;
  affectedSymbols: SymbolRef[];
  validations: ValidationPlan[];
}
```

Новый flow:

1. агент читает нужные версии файлов;
2. собирает весь patch;
3. harness повторно проверяет hashes и область доступа;
4. UI показывает общий diff и impact summary;
5. changeset применяется транзакционно;
6. при частичной ошибке откатывается весь набор;
7. validation работает на уже согласованном snapshot.

Лучший следующий уровень — отдельная временная task workspace или Git worktree. Тогда модель и validators не затрагивают рабочую ветку до финального apply.

**Эффект:** безопасность, устойчивость, нормальная поддержка multi-file features.

**Критерий готовности:** crash после любого файла не оставляет проект в частично применённом состоянии.

### 3. Validation Recipes вместо общего shell

Не следует добавлять модели произвольный терминал. Нужен реестр ограниченных рецептов:

- `typescript.check`;
- `tests.related`;
- `tests.project`;
- `lint.files`;
- `format.check`;
- `next.build`;
- `expo.doctor`;
- `package.exports.check`.

Рецепт содержит фиксированный executable, допустимые аргументы, timeout, output limit, read/write roots, network policy и уровень approval. Scripts из `package.json` можно обнаруживать, но запускать только после сопоставления с policy или отдельного подтверждения.

Framework build и test configuration являются исполняемым кодом. Их нужно запускать в task workspace с очищенным environment, resource limits и denied network по умолчанию.

**Эффект:** реальная проверка features без выдачи общего shell.

**Критерий готовности:** Forge показывает отдельные результаты typecheck/test/lint/build и не смешивает «команда запустилась» с «критерий выполнен».

### 4. Durable run protocol

Каждое событие должно получить:

```ts
interface RunEvent {
  runId: string;
  sessionId: string;
  revision: number;
  eventId: string;
  type: RunEventType;
  payload: unknown;
}
```

Renderer сначала подписывается и буферизует события, затем применяет snapshot и события с большей revision. Duplicate и события старого run игнорируются.

Для полного restart нужен persisted cursor: step, tool calls, завершённые tool results, pending question/approval и idempotency keys. Возобновление должно быть отдельным действием пользователя, а не автоматическим replay.

**Эффект:** устойчивость к reload, crash и задержкам IPC.

**Критерий готовности:** property-based тест перестановок snapshot/events не оживляет завершённый run и не теряет waiting state.

## P1 · Сделать ментальную модель глубже и дешевле

### 5. Incremental Workspace Intelligence

Нужен долгоживущий analysis service на workspace:

- file watcher с debounce и versioned snapshots;
- один TypeScript ProjectService/LanguageService на проект;
- поддержка реальных `tsconfig`, aliases и project references;
- инкрементальное обновление изменённых файлов;
- bounded memory и явное закрытие worker при удалении workspace;
- pagination и completeness envelope для каждого semantic result.

TypeScript project references специально предназначены для разделения больших кодовых баз и ускорения сборки. Официальный `--build` и incremental API можно использовать как основу для monorepo-aware analysis, а не пересобирать весь in-memory service на каждый query.

**Эффект:** масштабируемость и более точные definitions/references.

**Критерий готовности:** повторный semantic query после изменения одного файла не перечитывает весь workspace; результат сообщает indexed/skipped/truncated/nextCursor.

### 6. Semantic Impact Graph

Текущую structural map нужно дополнить связями:

- import/export resolution;
- symbol definition → references;
- function/component caller → callee;
- component → props/hooks/context/store;
- route/screen → loader/action/API;
- source → related tests;
- public export → package consumer boundary;
- config → affected build target.

Перед изменением Forge показывает **blast radius**:

- какие symbols и files могут измениться;
- какие public APIs затронуты;
- какие tests ближе всего к изменению;
- где данные переходят через trust boundary;
- какие части графа неизвестны из-за неполного индекса.

Это полезнее embeddings как первый шаг: TypeScript уже содержит точные semantic связи. Локальный embedding search можно добавить позже для prose, docs и нечётких продуктовых понятий.

**Эффект:** безопасность изменения, масштабируемость, объяснимый context selection.

### 7. Feature Capsules

Для часто затрагиваемых flows хранить компактную, проверяемую капсулу:

```ts
interface FeatureCapsule {
  name: string;
  entrypoints: FileRef[];
  runtimeFlow: EvidenceEdge[];
  stateOwners: SymbolRef[];
  dataBoundaries: SymbolRef[];
  tests: FileRef[];
  risks: RiskFinding[];
  sourceFingerprint: string;
}
```

Капсула инвалидируется, если изменился её source fingerprint. Каждое утверждение хранит evidence path/line, поэтому модель получает небольшую mental model без доверия к устаревшему summary.

**Эффект:** экономия токенов и более быстрый вход в большую feature area.

### 8. Project Memory и Architecture Rules

Нужны два разных слоя:

1. **Detected facts** — пересчитываются из кода.
2. **Reviewed project rules** — подтверждаются человеком.

Примеры rules:

- UI не импортирует persistence напрямую;
- API responses валидируются на boundary;
- shared package не зависит от application packages;
- React hooks не выполняют navigation;
- новые public exports требуют test и changelog.

Forge проверяет rules до review changeset и показывает нарушения как architecture fitness findings. Память не должна бесконтрольно пополняться ответами модели.

**Эффект:** расширяемость и сопровождаемость проекта со временем.

## P1 · Безопасность как отдельный слой

### 9. Workspace Capability Manifest

Для каждого workspace хранить явную policy:

```yaml
read:
  allow: ["src/**", "tests/**", "package.json", "tsconfig*.json"]
  deny: ["**/*.pem", ".env*", "fixtures/private/**"]
write:
  allow: ["src/**", "tests/**"]
commands:
  allow: ["typescript.check", "tests.related"]
network: deny
```

Policy применяется harness, а не моделью. UI объясняет, почему конкретный путь или validator запрещён.

### 10. Security Review Pass для каждого ChangeSet

Детерминированные checks и модельный review работают вместе:

- новые network/file/process capabilities;
- auth и permission checks;
- unsafe HTML/URL/navigation sinks;
- parsing данных без runtime validation;
- секреты и credentials в patch;
- dependency и lockfile changes;
- Electron preload/IPC/CSP changes;
- dangerous React Native deep links и native bridges;
- Next.js server/client boundary и secret exposure.

Модель объясняет контекст, но блокирующие правила должны быть кодом.

### 11. Electron release hardening

Текущий код уже включает sandbox, context isolation, sender validation, CSP, запрет новых окон и navigation. Следующие шаги:

- Electron fuses для отключения неиспользуемых возможностей;
- подпись и notarization;
- dependency update cadence для Electron/Chromium;
- clean-install и update tests;
- audit разрешений packaged app;
- проверка production CSP без dev-only sources.

Официальный Electron checklist отдельно рекомендует sandbox, context isolation, строгий CSP, sender validation, current Electron и настройку fuses.

Node Permission Model можно исследовать как дополнительный ограничитель trusted child tools. Документация Node прямо называет его «seat belt» и не считает защитой от злонамеренного кода, поэтому он не заменяет OS sandbox/task workspace.

## P2 · Полезные продуктовые функции

### 12. Interactive Mental Model

Вкладка Project model:

- граф entrypoint → route/screen → component → state → API;
- переключатели structural/semantic/data-flow/test layers;
- клик по edge показывает source evidence;
- partial areas выделены отдельно;
- поиск feature строит временный subgraph;
- кнопка «Use this flow as task context» закрепляет capsule.

### 13. Impact Preview

До diff пользователь видит:

- предполагаемые файлы;
- affected symbols;
- public API risk;
- related tests;
- security boundaries;
- validation plan;
- неизвестные области.

Это превращает вопрос «можно ли доверять правке?» в проверяемую карточку.

### 14. Guided Debugging Loop

Отдельный режим для ошибки:

1. принять diagnostic, stack trace или failing test;
2. нормализовать и связать paths/lines/symbols;
3. построить минимальный causal slice;
4. сформулировать 1–3 гипотезы с evidence;
5. проверить самую дешёвую гипотезу;
6. подготовить changeset;
7. перезапустить только релевантную validation recipe.

Нужен budget на попытки, чтобы агент не повторял одну и ту же правку.

### 15. Local Git Awareness

Безопасные read-only инструменты:

- status и current branch;
- diff staged/unstaged;
- log по файлу;
- blame диапазона;
- changed files относительно base;
- обнаружение незакоммиченных пользовательских изменений.

Write-операции Git лучше начинать с task worktree и checkpoint commits. Push, reset, rebase и удаление веток не нужны базовому агенту.

### 16. Context Inspector

Показывать для текущего шага:

- почему выбран каждый файл;
- сколько символов/примерных tokens он занимает;
- какой источник добавил его: map, semantic edge, user pin, tool result;
- какие файлы отброшены budget;
- насколько свежий snapshot;
- можно ли закрепить или исключить файл.

## P2 · Расширяемая архитектура Forge

### 17. Tool Registry

Разделить текущий `Agent` на независимые компоненты:

```ts
interface ToolDefinition<I, O> {
  schema: ZodSchema<I>;
  describe: string;
  risk: 'read' | 'write' | 'execute';
  policy(input: I, context: ToolContext): Promise<PolicyDecision>;
  execute(input: I, context: ToolContext): Promise<ToolResult<O>>;
  render?: ToolRendererId;
}
```

Registry автоматически строит JSON schema для модели, IPC-safe result, audit record и UI renderer. Это уменьшит `agent.ts` и позволит тестировать каждый tool contract отдельно.

### 18. Framework Packs

React, Next и React Native специализации должны стать пакетами из:

- detectors;
- roles и graph extractors;
- prompt guidance;
- security rules;
- validation recipes;
- fixture/evaluation suite;
- UI labels для mental model.

Добавление нового framework pack не должно менять основной agent loop.

### 19. Provider Adapter

Выделить контракт локального inference provider:

- capabilities discovery;
- tool-call format;
- structured output;
- tokenizer/count estimate;
- cancellation;
- model identity/digest;
- context and output limits.

Так можно добавить llama.cpp или локальный MLX server без условий Ollama внутри harness.

### 20. Нормализованное хранение и observability

Разнести sessions, messages, runs, events, tool calls, changesets и validation results по таблицам SQLite. Большие payload хранить отдельно и загружать лениво.

Каждый run получает локальный trace:

- duration и outcome каждого step/tool;
- context composition;
- model/token estimates;
- retries и structured errors;
- approvals/answers;
- change и validation evidence.

Trace нужен для отладки harness и evals. Он остаётся локальным и экспортируется только вручную.

## Что пока не добавлять

- **Произвольный shell.** Он резко расширит threat surface и ухудшит воспроизводимость.
- **Автоматическую установку dependencies.** Сначала нужны task workspace, lockfile review и network policy.
- **Embeddings как замену TypeScript graph.** Для кода точные compiler relations полезнее и объяснимее.
- **Много агентов одновременно.** Без Task Contract, idempotency и evaluator несколько агентов умножат ошибки и конфликты.
- **Автоматическое обучение на чатах.** Сначала нужны reviewed outcomes и надёжная оценка качества.
- **Автоматическое выполнение всех package scripts.** Конфиги и scripts являются исполняемым кодом проекта.

## Рекомендуемый порядок реализации

### Этап 1 · Trustworthy task loop

1. Structured tool errors и общий `ToolResult` envelope.
2. Task Contract и outcome state machine.
3. Validation result model.
4. Исправленный evaluator: настоящий `tsc`, tests, API invariants, защита от ложного success marker.

### Этап 2 · Safe changes

1. ChangeSet и общий diff review.
2. Transactional apply/rollback.
3. Task workspace или Git worktree.
4. Workspace capability manifest.

### Этап 3 · Semantic scale

1. Persistent workspace analysis worker.
2. Real tsconfig/project references.
3. Paginated semantic results с completeness.
4. Impact graph и related-tests selection.

### Этап 4 · Resilience

1. Versioned RunEvent protocol.
2. Snapshot/event reconciliation.
3. Persisted run cursor и explicit resume.
4. Crash-injection tests на каждом state transition.

### Этап 5 · Product UX

1. Plan/Task Contract panel.
2. Impact Preview.
3. Interactive Mental Model.
4. Context Inspector.
5. Guided Debugging.

### Этап 6 · Extensibility

1. Tool Registry.
2. Framework Packs.
3. Provider adapters.
4. Normalized SQLite и local traces.

## Метрики

| Область | Метрика |
| --- | --- |
| Понимание проекта | Доля утверждений с source evidence; полнота найденных entrypoints/routes/boundaries на fixtures. |
| Изменение feature | Compile/test pass, сохранение public API, число лишних файлов, regression rate. |
| Безопасность | Записи вне scope, stale writes, несанкционированные capabilities и повтор после отказа должны быть равны нулю. |
| Устойчивость | Recovery после crash в каждой точке state machine; отсутствие lost/duplicate events. |
| Масштаб | p50/p95 initial index и incremental update на 1k/10k/100k files; память worker; размер DB. |
| Сопровождаемость | Contract tests tools/providers/packs; migration tests; размер и связность центральных модулей. |
| Модель | Success rate по digest модели и версии harness; tool errors/retries; verified против unverified outcomes. |

Минимальная fixture matrix должна включать Vite React, Next App Router, Expo/React Native, TypeScript monorepo с project references, проект с большим количеством references, stale editor change, secret/symlink policy, failing/flaky tests и multi-file feature.

## Первые пять задач

1. Ввести `ToolResult`, structured error codes и completeness во все read/semantic tools.
2. Добавить `TaskContract`, `ValidationResult` и вычисляемый `RunOutcome`.
3. Реализовать безопасные recipes `typescript.check` и `tests.related` в task workspace.
4. Собрать multi-file `ChangeSet` с единым review и rollback.
5. Перевести TypeScript analysis на persistent worker и построить первый Impact Preview.

Эти пять задач дадут Forge основной продуктовый цикл. После них visual graph, project memory, новые framework packs и локальное обучение будут опираться на проверяемые данные, а не на свободный текст модели.

## Официальные технические ориентиры

- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references)
- [TypeScript incremental program APIs](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-6.html#apis-to-support---build-and---incremental)
- [Node.js Permission Model](https://nodejs.org/api/permissions.html)
