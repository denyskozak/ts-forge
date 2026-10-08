import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from '../electron/schema';
import { DESIGN_SKILLS, designSkillsForProject } from '../shared/design-skills';
import { DEFAULT_SETTINGS, SKILLS } from '../shared/types';

test('design skills are available without changing existing defaults', () => {
  for (const skill of DESIGN_SKILLS) {
    assert.ok(SKILLS.some((candidate) => candidate.id === skill.id));
  }
  assert.deepEqual(settingsSchema.parse(DEFAULT_SETTINGS).skills, DEFAULT_SETTINGS.skills);
});

test('storefront design work receives hierarchy, system, data and visual review guidance', () => {
  assert.deepEqual(
    designSkillsForProject(
      'Улучши дизайн и визуальную иерархию магазина',
      ['React'],
      ['apps/web/src/App.tsx'],
    ),
    [
      'product-ui-design',
      'accessibility-design',
      'visual-hierarchy',
      'design-system',
      'data-interface-design',
      'visual-review',
    ],
  );
});

test('mobile form work selects responsive and interaction guidance', () => {
  assert.deepEqual(
    designSkillsForProject(
      'Create a responsive login form',
      ['React Native', 'Expo'],
      ['src/screens/Login.tsx'],
    ),
    [
      'product-ui-design',
      'accessibility-design',
      'responsive-design',
      'forms-interaction-design',
    ],
  );
});

test('backend work receives no design instructions', () => {
  assert.deepEqual(
    designSkillsForProject('Refactor database migrations', ['Node.js'], ['apps/api/src/database.ts']),
    [],
  );
});
