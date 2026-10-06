import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProductRecipe } from '../shared/types';

const domain = `export type Product = { id: string; name: string; price: number; stock: number };
export const products: Product[] = [{ id: 'desk', name: 'Studio desk', price: 12900, stock: 8 }, { id: 'lamp', name: 'Reading lamp', price: 3900, stock: 12 }];
export type Cart = Record<string, number>;
export function addToCart(cart: Cart, id: string): Cart {
  const product = products.find(item => item.id === id);
  if (!product) throw new Error('Unknown product');
  if ((cart[id] ?? 0) >= product.stock) throw new Error('Out of stock');
  return { ...cart, [id]: (cart[id] ?? 0) + 1 };
}
export function total(cart: Cart) {
  return Object.entries(cart).reduce((sum, [id, quantity]) => {
    const product = products.find(item => item.id === id);
    if (!product || !Number.isInteger(quantity) || quantity < 0 || quantity > product.stock) throw new Error('Invalid cart');
    return sum + product.price * quantity;
  }, 0);
}
export type Principal = { id: string; role: 'member' | 'admin' };
export function requireAdmin(principal?: Principal) {
  if (!principal || principal.role !== 'admin') throw new Error('Forbidden');
}
export function filterProducts(query: string) { return products.filter(item => item.name.toLowerCase().includes(query.toLowerCase())); }
export type Project = { id: string; name: string; ownerId: string };
export function visibleProjects(projects: Project[], principal?: Principal) { return principal ? projects.filter(project => project.ownerId === principal.id) : []; }
export function createProject(name: string, principal?: Principal): Project {
  if (!principal) throw new Error('Unauthorized');
  if (!name.trim() || name.length > 120) throw new Error('Invalid project name');
  return { id: crypto.randomUUID(), name: name.trim(), ownerId: principal.id };
}
`;
const domainTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { addToCart, total, requireAdmin, filterProducts, createProject, visibleProjects } from './domain';
test('cart totals use integer cents and respect stock', () => {
  assert.equal(total(addToCart({}, 'lamp')), 3900);
  assert.throws(() => addToCart({ lamp: 12 }, 'lamp'), /stock/);
  assert.throws(() => total({ lamp: -1 }), /Invalid/);
  assert.throws(() => total({ unknown: 1 }), /Invalid/);
});
test('authorization denies anonymous/member admin operations', () => {
  assert.throws(() => requireAdmin(), /Forbidden/);
  assert.throws(() => requireAdmin({ id: 'alice', role: 'member' }), /Forbidden/);
  assert.doesNotThrow(() => requireAdmin({ id: 'alice', role: 'admin' }));
});
test('project boundaries deny anonymous writes and isolate owners', () => {
  assert.throws(() => createProject('Demo'), /Unauthorized/);
  assert.throws(() => createProject('', { id: 'alice', role: 'member' }), /Invalid/);
  const project = createProject('Demo', { id: 'alice', role: 'member' });
  assert.deepEqual(visibleProjects([project], { id: 'bob', role: 'member' }), []);
  assert.equal(visibleProjects([project], { id: 'alice', role: 'member' }).length, 1);
});
test('catalog search is case insensitive', () => assert.equal(filterProducts('LAMP').length, 1));
`;
function appSource(recipe: ProductRecipe['id']) {
  const title =
    recipe === 'storefront'
      ? 'Studio shop'
      : recipe === 'dashboard'
        ? 'Product dashboard'
        : 'My projects';
  const body =
    recipe === 'storefront'
      ? `{products.map(product => <article key={product.id}><h2>{product.name}</h2><p>{money(product.price)}</p><button disabled={(cart[product.id] ?? 0) >= product.stock} onClick={() => setCart(addToCart(cart, product.id))}>Add {product.name}</button></article>)}<aside aria-live="polite">Cart total: {money(total(cart))}</aside><button onClick={() => setNotice('Checkout requires a configured payment provider. No payment was made.')}>Checkout</button>`
      : recipe === 'dashboard'
        ? `<label>Filter products<input value={query} onChange={event => setQuery(event.target.value)} /></label><table><thead><tr><th>Product</th><th>Stock</th><th>Price</th></tr></thead><tbody>{filterProducts(query).map(product => <tr key={product.id}><td>{product.name}</td><td>{product.stock}</td><td>{money(product.price)}</td></tr>)}</tbody></table>`
        : `<form onSubmit={event => { event.preventDefault(); try { setProjects([...projects, createProject(query, { id: 'local-demo', role: 'member' })]); setQuery(''); } catch (error) { setNotice((error as Error).message); } }}><label>Project name<input required maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></label><button>Create project</button></form><ul>{projects.map(project => <li key={project.id}>{project.name}</li>)}</ul>`;
  const imports =
    recipe === 'storefront'
      ? 'products, addToCart, total, type Cart'
      : recipe === 'dashboard'
        ? 'filterProducts'
        : 'createProject, type Project';
  const state =
    recipe === 'storefront'
      ? 'const [cart, setCart] = useState<Cart>({});'
      : recipe === 'dashboard'
        ? "const [query, setQuery] = useState('');"
        : "const [query, setQuery] = useState(''); const [projects, setProjects] = useState<Project[]>([]);";
  return `'use client';\nimport { useState } from 'react';\nimport { ${imports} } from './domain';\nconst money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);\nexport default function App() { ${state} const [notice, setNotice] = useState(''); return <main><header><small>LOCAL DEVELOPMENT STARTER</small><h1>${title}</h1><p>A tested foundation for your next feature.</p></header>${body}<p role="status">{notice}</p><footer>Demo data in memory. Configure persistence and identity before deployment.</footer></main>; }\n`;
}
const style = `:root { font-family: system-ui, sans-serif; color: #182133; background: #f5f7fb; } body { margin: 0; } main { max-width: 880px; margin: 48px auto; padding: 32px; background: white; border-radius: 20px; box-shadow: 0 10px 50px #1821330d; } h1 { font-size: 38px; } header { margin-bottom: 32px; } article { display: inline-block; margin: 0 16px 24px 0; padding: 24px; border: 1px solid #e0e5ef; border-radius: 12px; } button { background: #275de4; color: white; border: 0; border-radius: 8px; padding: 12px 18px; cursor: pointer; } button:disabled { opacity: .5; } input { display: block; font: inherit; padding: 12px; margin: 8px 0 16px; border: 1px solid #a8b4cc; border-radius: 8px; } th, td { padding: 16px; text-align: left; border-bottom: 1px solid #e0e5ef; } aside, footer { margin: 24px 0; } footer, small { color: #657188; } :focus-visible { outline: 3px solid #ffad33; outline-offset: 3px; } @media (max-width: 600px) { main { margin: 12px; padding: 20px; } }`;
const apiSource = `import { products, total, type Cart } from './domain';
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
  if (request.method === 'GET' && url.pathname === '/v1/products') return Response.json(products);
  if (request.method === 'POST' && url.pathname === '/v1/quote') {
    try {
      const cart = await request.json() as Cart;
      if (!cart || Array.isArray(cart) || typeof cart !== 'object') throw new Error();
      return Response.json({ total: total(cart), currency: 'USD' });
    } catch { return Response.json({ error: 'Invalid cart' }, { status: 400 }); }
  }
  if (request.method === 'POST' && url.pathname === '/v1/checkout') return Response.json({ error: 'Payment provider not configured' }, { status: 503 });
  return Response.json({ error: 'Not found' }, { status: 404 });
}
`;
const serverSource = `import http from 'node:http';
import { handle } from './api';
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 64000) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
    const method = incoming.method ?? 'GET';
    const request = new Request('http://127.0.0.1' + incoming.url, { method, headers: incoming.headers as Record<string, string>, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks).toString() }) });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
  } catch { outgoing.writeHead(500).end('Internal error'); }
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log('http://127.0.0.1:' + (server.address() as { port: number }).port));
`;
const apiTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import { handle } from './api';
test('HTTP contracts: health, valid quote, invalid input and unavailable checkout', async () => {
  assert.equal((await handle(new Request('http://local/health'))).status, 200);
  const quote = await handle(new Request('http://local/v1/quote', { method: 'POST', body: JSON.stringify({ lamp: 2 }) }));
  assert.equal((await quote.json()).total, 7800);
  assert.equal((await handle(new Request('http://local/v1/quote', { method: 'POST', body: '{' }))).status, 400);
  assert.equal((await handle(new Request('http://local/v1/checkout', { method: 'POST' }))).status, 503);
  assert.equal((await handle(new Request('http://local/missing'))).status, 404);
});`;

/** Bundled, reviewable source templates. No generator execution or registry request until installation. */
export function productFiles(recipe: ProductRecipe['id'], name: string): Record<string, string> {
  const commonDev = { typescript: '5.9.3', tsx: '^4.21.0', '@types/node': '^22.19.0' };
  const compiler = {
    target: 'ES2022',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    strict: true,
    noEmit: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
    esModuleInterop: true,
    skipLibCheck: true,
  };
  const files: Record<string, string> = {
    '.gitignore':
      'node_modules/\ndist/\n.next/\n.env*\n!.env.example\n.forge/\nplaywright-report/\ntest-results/\n',
    'tsconfig.json': JSON.stringify(
      { compilerOptions: compiler, include: ['src', 'tests'] },
      null,
      2,
    ),
    'src/domain.ts': domain,
    'src/domain.test.ts': domainTest,
    'README.md': `# ${name}\n\nBundled ${recipe} development starter. TypeScript, pnpm, tests and explicit failure boundaries.\n\nRun: pnpm install --ignore-scripts; pnpm test; pnpm typecheck; pnpm dev.\n\nWeb starters: pnpm exec playwright install chromium; pnpm test:e2e.\n\n## Before production\nDemo identity and data are in memory. Add real server-side authentication, persistence, authorization tests, payment integration (storefront), secrets management and deployment recovery. No payment or external account operation is simulated as successful.\n`,
  };
  if (recipe === 'api') {
    files['src/api.ts'] = apiSource;
    files['src/server.ts'] = serverSource;
    files['src/api.test.ts'] = apiTest;
    files['openapi.json'] = JSON.stringify(
      {
        openapi: '3.1.0',
        info: { title: name, version: '1.0.0' },
        paths: {
          '/health': { get: { responses: { '200': { description: 'Healthy' } } } },
          '/v1/products': { get: { responses: { '200': { description: 'Catalog' } } } },
          '/v1/quote': {
            post: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      additionalProperties: { type: 'integer', minimum: 0 },
                    },
                  },
                },
              },
              responses: {
                '200': { description: 'Quote' },
                '400': { description: 'Invalid cart' },
              },
            },
          },
        },
      },
      null,
      2,
    );
    files['package.json'] = JSON.stringify(
      {
        name,
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.15.1',
        scripts: {
          dev: 'tsx watch src/server.ts',
          start: 'tsx src/server.ts',
          test: 'tsx --test src/*.test.ts',
          typecheck: 'tsc --noEmit',
          build: 'tsc --noEmit',
        },
        devDependencies: commonDev,
      },
      null,
      2,
    );
    return files;
  }
  const webRecipe = recipe === 'monorepo' ? 'dashboard' : recipe;
  files['src/App.tsx'] = appSource(webRecipe);
  files['src/style.css'] = style;
  files['tests/app.spec.ts'] =
    `import { test, expect } from '@playwright/test';\ntest('main flow and runtime errors', async ({ page }) => { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('/'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); ${webRecipe === 'storefront' ? "await page.getByRole('button', { name: 'Add Reading lamp' }).click(); await expect(page.getByText('Cart total: $39.00')).toBeVisible();" : webRecipe === 'dashboard' ? "await page.getByLabel('Filter products').fill('lamp'); await expect(page.getByRole('cell', { name: 'Reading lamp' })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Studio desk' })).toHaveCount(0);" : "await page.getByLabel('Project name').fill('New project'); await page.getByRole('button', { name: 'Create project' }).click(); await expect(page.getByRole('listitem')).toHaveText('New project');"} expect(errors).toEqual([]); });\n`;
  const reactDeps = { react: '^19.2.0', 'react-dom': '^19.2.0' };
  const webDev = {
    ...commonDev,
    '@types/react': '^19.2.0',
    '@types/react-dom': '^19.2.0',
    '@playwright/test': '^1.63.0',
  };
  const next = recipe !== 'monorepo';
  files['playwright.config.ts'] =
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { baseURL: 'http://127.0.0.1:' + (process.env.PORT ?? '3000') }, webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:' + (process.env.PORT ?? '3000'), reuseExistingServer: false } });\n`;
  if (next) {
    files['src/app/page.tsx'] = "export { default } from '../App';\n";
    files['src/app/layout.tsx'] =
      "import '../style.css'; import type { ReactNode } from 'react'; export default function Layout({ children }: { children: ReactNode }) { return <html lang=\"en\"><body>{children}</body></html>; }\n";
    files['next-env.d.ts'] =
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n';
    files['tsconfig.json'] = JSON.stringify(
      {
        compilerOptions: { ...compiler, jsx: 'preserve', plugins: [{ name: 'next' }] },
        include: ['next-env.d.ts', 'src', 'tests', '.next/types/**/*.ts'],
      },
      null,
      2,
    );
    files['package.json'] = JSON.stringify(
      {
        name,
        private: true,
        packageManager: 'pnpm@11.15.1',
        scripts: {
          dev: 'next dev --hostname 127.0.0.1',
          test: 'tsx --test src/*.test.ts',
          typecheck: 'tsc --noEmit',
          build: 'next build',
          'test:e2e': 'playwright test',
        },
        dependencies: { ...reactDeps, next: '^16.3.8' },
        devDependencies: webDev,
      },
      null,
      2,
    );
    return files;
  }
  files['src/main.tsx'] =
    "import { createRoot } from 'react-dom/client'; import App from './App'; import './style.css'; createRoot(document.getElementById('root')!).render(<App />);\n";
  files['vite.config.ts'] =
    "import { defineConfig } from 'vite'; export default defineConfig({ server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 3000), strictPort: true } });\n";
  files['index.html'] =
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Product workspace</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
  files['package.json'] = JSON.stringify(
    {
      name: '@forge/web',
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        test: 'tsx --test src/*.test.ts',
        typecheck: 'tsc --noEmit',
        build: 'tsc --noEmit && vite build',
        'test:e2e': 'playwright test',
      },
      dependencies: { ...reactDeps, '@forge/contracts': 'workspace:*' },
      devDependencies: { ...webDev, vite: '^8.3.1' },
    },
    null,
    2,
  );
  const web = Object.fromEntries(
    Object.entries(files)
      .filter(([file]) => file !== 'README.md' && file !== '.gitignore')
      .map(([file, source]) => [`apps/web/${file}`, source]),
  );
  const api = productFiles('api', '@forge/api');
  for (const [file, source] of Object.entries(api))
    if (file !== '.gitignore') web[`apps/api/${file}`] = source;
  const apiManifest = JSON.parse(web['apps/api/package.json']);
  apiManifest.dependencies = { '@forge/contracts': 'workspace:*' };
  web['apps/api/package.json'] = JSON.stringify(apiManifest, null, 2);
  web['apps/api/src/server.ts'] = serverSource.replace('3000', '3001');
  web['packages/contracts/package.json'] = JSON.stringify(
    {
      name: '@forge/contracts',
      private: true,
      type: 'module',
      exports: './src/index.ts',
      scripts: { test: 'tsx --test src/*.test.ts', typecheck: 'tsc --noEmit' },
      devDependencies: commonDev,
    },
    null,
    2,
  );
  web['packages/contracts/src/index.ts'] =
    'export type Health = { ok: boolean };\nexport const API_VERSION = "v1" as const;\n';
  web['packages/contracts/src/index.test.ts'] =
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { API_VERSION } from './index'; test('shared API version', () => assert.equal(API_VERSION, 'v1'));\n";
  web['packages/contracts/tsconfig.json'] = JSON.stringify(
    { compilerOptions: compiler, include: ['src'] },
    null,
    2,
  );
  web['apps/web/src/App.tsx'] =
    "import { API_VERSION } from '@forge/contracts';\n" +
    web['apps/web/src/App.tsx'].replace('Product dashboard', 'Product dashboard {API_VERSION}');
  web['apps/api/src/api.ts'] =
    "import { API_VERSION } from '@forge/contracts';\n" +
    apiSource.replace('{ ok: true }', '{ ok: true, version: API_VERSION }');
  web['pnpm-workspace.yaml'] = 'packages:\n  - apps/*\n  - packages/*\n';
  web['package.json'] = JSON.stringify(
    {
      name,
      private: true,
      packageManager: 'pnpm@11.15.1',
      scripts: {
        dev: 'pnpm --parallel --filter @forge/web --filter @forge/api dev',
        test: 'pnpm -r test',
        typecheck: 'pnpm -r typecheck',
        build: 'pnpm -r --if-present build',
        'test:e2e': 'pnpm --filter @forge/web test:e2e',
      },
      devDependencies: { ...commonDev, '@types/react': '^19.2.0', '@types/react-dom': '^19.2.0' },
    },
    null,
    2,
  );
  web['tsconfig.json'] = JSON.stringify(
    {
      compilerOptions: {
        ...compiler,
        baseUrl: '.',
        paths: { '@forge/contracts': ['packages/contracts/src/index.ts'] },
      },
      include: ['apps/*/src', 'packages/*/src'],
    },
    null,
    2,
  );
  web['.gitignore'] = files['.gitignore'];
  web['README.md'] = files['README.md'];
  return web;
}
export async function scaffoldProduct(
  root: string,
  recipe: ProductRecipe['id'],
  name: string,
  signal: AbortSignal,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Use a lowercase project name.');
  const entries = (await fs.readdir(root)).filter(
    (entry) => !['.git', '.DS_Store'].includes(entry),
  );
  if (entries.length) throw new Error('Product scaffolding requires an empty workspace.');
  const files = productFiles(recipe, name);
  const written: string[] = [];
  try {
    for (const [file, source] of Object.entries(files)) {
      signal.throwIfAborted();
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source + (source.endsWith('\n') ? '' : '\n'), {
        flag: 'wx',
        mode: 0o644,
      });
      written.push(file);
    }
  } catch (error) {
    for (const file of written) await fs.unlink(path.join(root, file)).catch(() => {});
    throw error;
  }
  return {
    recipe,
    name,
    files: written,
    installed: false,
    next: [
      'install_pnpm_dependencies',
      'package_scripts',
      'run_validation',
      'start_package_process',
      'browser_open',
    ],
    limitations: [
      'Demo identity and in-memory data; production authentication, persistence and payment provider must be implemented and verified.',
    ],
  };
}
