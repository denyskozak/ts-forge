import test from 'node:test';
import assert from 'node:assert/strict';
import { diskSchema, settingsSchema } from '../electron/schema';
import { DEFAULT_SETTINGS, SKILLS } from '../shared/types';
import { REQUIRED_ENGINEERING_SKILLS } from '../shared/engineering-skills';

test('engineering principles remain mandatory after legacy load and attempted removal', () => {
  const legacy = diskSchema.parse({ settings: { ...DEFAULT_SETTINGS, skills: ['typescript'] } });
  const removed = settingsSchema.parse({ ...legacy.settings, skills: [] });
  for (const state of [legacy.settings, removed, DEFAULT_SETTINGS]) {
    for (const id of REQUIRED_ENGINEERING_SKILLS) {
      assert.equal(state.skills.filter((skill) => skill === id).length, 1);
      assert.equal(SKILLS.find((skill) => skill.id === id)?.required, true);
    }
  }
  const duplicated = settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    skills: [...REQUIRED_ENGINEERING_SKILLS, ...REQUIRED_ENGINEERING_SKILLS],
  });
  for (const id of REQUIRED_ENGINEERING_SKILLS)
    assert.equal(duplicated.skills.filter((skill) => skill === id).length, 1);
});
