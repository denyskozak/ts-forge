import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema, diskSchema } from '../electron/schema';
import { REQUIRED_MCP_SKILLS } from '../shared/mcp-skills';
import { DEFAULT_SETTINGS, SKILLS } from '../shared/types';

test('mandatory MCP skills survive old settings, omission and duplicate entries', () => {
  for (const skills of [[], ['typescript'], ['mcp-workflow', 'mcp-workflow']]) {
    const settings = settingsSchema.parse({ ...DEFAULT_SETTINGS, skills });
    for (const id of REQUIRED_MCP_SKILLS)
      assert.equal(settings.skills.filter((skill) => skill === id).length, 1);
    if (skills.includes('typescript')) assert.ok(settings.skills.includes('typescript'));
  }
  const legacy = diskSchema.parse({ settings: { ...DEFAULT_SETTINGS, skills: ['react'] } });
  assert.deepEqual(legacy.settings.skills, ['react', ...REQUIRED_MCP_SKILLS]);
});

test('defaults, UI metadata and mandatory policy identifiers remain consistent', () => {
  assert.deepEqual(
    SKILLS.filter((skill) => skill.required).map((skill) => skill.id),
    [...REQUIRED_MCP_SKILLS],
  );
  for (const id of REQUIRED_MCP_SKILLS) assert.ok(DEFAULT_SETTINGS.skills.includes(id));
});
