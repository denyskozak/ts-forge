# Какие инструменты нужны TypeScript-агенту

TypeScript-агенту недостаточно читать файлы и запускать `tsc`. Надёжный рабочий цикл состоит из нескольких разных уровней анализа.

## Готово в Forge

### Структура проекта

При открытии или переключении workspace Forge автоматически строит индекс: entrypoints, exports, symbols, роли файлов и связи по относительным импортам. Отдельный `typescript_project_analysis` сообщает:

- версию TypeScript и найденные `tsconfig`;
- `strict`, `noEmit`, `allowJs`, `checkJs`, `skipLibCheck`, `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`;
- JSX, module и module resolution;
- path aliases и project references;
- количество TypeScript sources, declarations и tests;
- найденные test runners, linters и formatters.

### Языковой сервис

`typescript_query` поддерживает diagnostics, definition, references и quick info. Эти запросы работают в отдельном worker с ограничением памяти и времени. Быстрый анализ использует индексированные исходники и безопасные compiler defaults; полный проектный `tsconfig` проверяет отдельный `typecheck`.

### Изменения

Перед редактированием агент читает текущую версию файла. `replace_text` меняет только уникальный подтверждённый фрагмент, проверяет hash и показывает diff до записи. Полная замена требует полного чтения файла.

## Найдено в проекте, но пока не исполняется агентом

Forge распознаёт Vitest, Jest, Playwright, Cypress, ESLint, Biome, Prettier и соответствующие scripts. В интерфейсе они отмечены как `detected`. Произвольный запуск package scripts пока не открыт, потому что lifecycle hooks и сами scripts могут выполнять любой код с правами пользователя.

## Следующие инструменты

1. **Restricted package-script runner.** Белый список выбранных пользователем `test`, `lint` и `format:check`, без сети, с чистым environment, timeout и ограничением вывода.
2. **Config-aware language service.** Разрешение extends, project references и package types внутри выбранного workspace без доступа за его пределы.
3. **Rename preview.** TypeScript rename locations с обязательным multi-file diff и одной общей транзакцией.
4. **Import and dependency diagnostics.** Неиспользуемые exports, циклы, нарушенные boundaries и package-to-source ownership.
5. **Incremental watcher.** Обновление затронутой части индекса по filesystem events вместо полного прохода перед каждой задачей.
6. **Test selection.** Связь изменённых symbols с ближайшими tests и объяснение, почему выбран каждый test target.

Статус `ready` означает, что harness уже может выполнить операцию. `detected` означает, что соответствующий инструмент найден в репозитории, но его безопасный runner ещё не реализован. `missing` означает, что Forge не нашёл ни готовой возможности, ни проектной конфигурации.
