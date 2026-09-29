import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const temp = await mkdtemp(path.join(os.tmpdir(), 'forge-icon-'));
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  env: { ...process.env, NODE_ENV: 'test', FORGE_TEST_DATA: temp },
});
try {
  const page = await app.firstWindow();
  await page.setContent(
    `<style>body{margin:0;background:transparent}</style>${await readFile('build/icon.svg', 'utf8')}`,
  );
  await page.locator('svg').screenshot({ path: 'build/icon.png', omitBackground: true });
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
