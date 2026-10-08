import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from '../electron/schema';
import { qualitySkillsForProject, QUALITY_SKILLS } from '../shared/quality-skills';
import { DEFAULT_SETTINGS, SKILLS } from '../shared/types';

test('quality skills are visible and readability defaults stay enabled', () => {
  for (const skill of QUALITY_SKILLS)
    assert.ok(SKILLS.some((candidate) => candidate.id === skill.id));
  assert.ok(DEFAULT_SETTINGS.skills.includes('code-readability'));
  assert.ok(DEFAULT_SETTINGS.skills.includes('modular-design'));
  const parsed = settingsSchema.parse(DEFAULT_SETTINGS);
  assert.ok(parsed.skills.includes('code-readability'));
  assert.ok(parsed.skills.includes('modular-design'));
});

test('full-stack persistence work selects backend, ORM and frontend guidance', () => {
  assert.deepEqual(
    qualitySkillsForProject(
      'Улучши читаемость и безопасность магазина',
      ['React', 'Node.js'],
      ['apps/api/src/repository.ts', 'apps/web/src/App.tsx'],
    ),
    [
      'code-readability',
      'modular-design',
      'backend-security',
      'orm-data-access',
      'frontend-architecture',
    ],
  );
});

test('frontend-only work does not receive database guidance', () => {
  assert.deepEqual(qualitySkillsForProject('Refactor the React form', ['React'], ['src/Form.tsx']), [
    'code-readability',
    'modular-design',
    'frontend-architecture',
  ]);
});
