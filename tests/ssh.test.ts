import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settingsSchema } from '../electron/schema';
import { sshProfileSchema, testSsh, uploadSsh } from '../electron/ssh';
import { DEFAULT_SETTINGS } from '../shared/types';

test('SSH profiles accept system and key credentials but reject argument injection', () => {
  const base = { id: crypto.randomUUID(), name: 'Production', port: 22, user: 'deploy' };
  assert.equal(
    sshProfileSchema.parse({ ...base, host: 'server.example.com', auth: 'system' }).auth,
    'system',
  );
  assert.equal(
    sshProfileSchema.parse({ ...base, host: '10.0.0.8', auth: 'key', keyPath: '/tmp/key' }).auth,
    'key',
  );
  assert.equal(
    sshProfileSchema.parse({ ...base, host: 'production_api', auth: 'system' }).host,
    'production_api',
  );
  assert.throws(() =>
    sshProfileSchema.parse({ ...base, host: '-oProxyCommand=bad', auth: 'system' }),
  );
  assert.throws(() =>
    sshProfileSchema.parse({ ...base, host: 'server; touch /tmp/pwned', auth: 'system' }),
  );
  assert.throws(() =>
    sshProfileSchema.parse({ ...base, host: 'server', user: 'root -o ProxyCommand=x', auth: 'system' }),
  );
});

test('old settings gain an empty SSH profile list', () => {
  const parsed = settingsSchema.parse({ ...DEFAULT_SETTINGS, sshProfiles: undefined });
  assert.deepEqual(parsed.sshProfiles, []);
});

test('SSH key and upload paths fail closed before connecting', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-ssh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missingKey = {
    id: crypto.randomUUID(),
    name: 'Test',
    host: 'localhost',
    port: 22,
    user: 'deploy',
    auth: 'key' as const,
    keyPath: path.join(root, 'missing-key'),
  };
  await assert.rejects(testSsh(missingKey, AbortSignal.timeout(1000)), /ENOENT/);
  const keyPath = path.join(root, 'key');
  await fs.writeFile(keyPath, 'not-a-real-key', { mode: 0o600 });
  await fs.writeFile(path.join(root, '.env'), 'SECRET=never-upload');
  await assert.rejects(
    uploadSsh(root, { ...missingKey, keyPath }, ['.env'], '/srv/app', AbortSignal.timeout(1000)),
    /private|protected|excluded|ignored|denied/i,
  );
  await assert.rejects(
    uploadSsh(root, { ...missingKey, keyPath }, ['../outside'], '/srv/app', AbortSignal.timeout(1000)),
    /escapes|outside|path/i,
  );
});
