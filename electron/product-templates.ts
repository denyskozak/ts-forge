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
const persistenceSource = `import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export function openDatabase(location = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.sqlite')) {
  const existed = location === ':memory:' || existsSync(location);
  if (location !== ':memory:') mkdirSync(path.dirname(path.resolve(location)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(location);
  if (!existed && location !== ':memory:') chmodSync(location, 0o600);
  database.exec(\`PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash BLOB NOT NULL, password_salt BLOB NOT NULL, role TEXT NOT NULL CHECK(role IN ('member','admin')), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS projects_owner_created ON projects(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL CHECK(stock >= 0));
    CREATE TABLE IF NOT EXISTS cart_items (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity >= 0), PRIMARY KEY(user_id, product_id));
    INSERT OR IGNORE INTO products(id, name, price, stock) VALUES ('desk', 'Studio desk', 12900, 8), ('lamp', 'Reading lamp', 3900, 12);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch() * 1000);\`);
  return database;
}
`;
const authSource = `import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Principal } from './domain';
export type AuthenticatedUser = Principal & { email: string };
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function passwordDigest(password: string, salt: Uint8Array) { return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }); }
function issueSession(database: DatabaseSync, userId: string) {
  const token = randomBytes(32).toString('base64url'); const now = Date.now();
  database.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(tokenHash(token), userId, now + SESSION_SECONDS * 1000, now);
  return token;
}
export function register(database: DatabaseSync, emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email) || email.length > 254) throw new Error('Invalid email');
  if (password.length < 12 || password.length > 200) throw new Error('Password must contain 12–200 characters');
  const id = randomUUID(), salt = randomBytes(16), digest = passwordDigest(password, salt), now = Date.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare("INSERT INTO users(id,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?, 'member', ?)").run(id, email, digest, salt, now);
    const token = issueSession(database, id); database.exec('COMMIT');
    return { user: { id, email, role: 'member' as const }, token };
  } catch (error) { database.exec('ROLLBACK'); if (/UNIQUE/.test(String(error))) throw new Error('Account already exists'); throw error; }
}
export function login(database: DatabaseSync, emailInput: string, password: string) {
  if (password.length < 1 || password.length > 200) throw new Error('Invalid email or password');
  const row = database.prepare('SELECT id,email,password_hash,password_salt,role FROM users WHERE email = ?').get(normalizeEmail(emailInput)) as { id:string; email:string; password_hash:Uint8Array; password_salt:Uint8Array; role:'member'|'admin' } | undefined;
  const supplied = row ? passwordDigest(password, row.password_salt) : passwordDigest(password, new Uint8Array(16));
  if (!row || row.password_hash.length !== supplied.length || !timingSafeEqual(row.password_hash, supplied)) throw new Error('Invalid email or password');
  return { user: { id: row.id, email: row.email, role: row.role }, token: issueSession(database, row.id) };
}
export function authenticate(database: DatabaseSync, token?: string): AuthenticatedUser | undefined {
  if (!token || token.length > 200) return undefined;
  const now = Date.now(); database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return database.prepare('SELECT users.id,users.email,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(tokenHash(token), now) as AuthenticatedUser | undefined;
}
export function logout(database: DatabaseSync, token?: string) { if (token) database.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); }
export const sessionCookie = (token: string, clear = false) => \`session=\${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\${clear ? 0 : SESSION_SECONDS}\${process.env.NODE_ENV === 'production' ? '; Secure' : ''}\`;
`;
const repositorySource = `import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Cart, Principal, Product, Project } from './domain';
const productRow = (row: unknown) => row as Product;
export function listProducts(database: DatabaseSync) { return database.prepare('SELECT id,name,price,stock FROM products ORDER BY name').all().map(productRow); }
export function quote(database: DatabaseSync, cart: Cart) {
  let amount = 0;
  for (const [id, quantity] of Object.entries(cart)) { const product = database.prepare('SELECT id,name,price,stock FROM products WHERE id=?').get(id) as Product | undefined; if (!product || !Number.isInteger(quantity) || quantity < 0 || quantity > product.stock) throw new Error('Invalid cart'); amount += product.price * quantity; }
  return amount;
}
export function listProjects(database: DatabaseSync, principal: Principal) { return database.prepare('SELECT id,name,owner_id as ownerId FROM projects WHERE owner_id=? ORDER BY created_at DESC').all(principal.id) as Project[]; }
export function persistProject(database: DatabaseSync, nameInput: string, principal: Principal) { const name=nameInput.trim(); if (!name || name.length>120) throw new Error('Invalid project name'); const project={id:randomUUID(),name,ownerId:principal.id}; database.prepare('INSERT INTO projects(id,owner_id,name,created_at) VALUES(?,?,?,?)').run(project.id,project.ownerId,project.name,Date.now()); return project; }
export function readCart(database: DatabaseSync, principal: Principal): Cart { return Object.fromEntries((database.prepare('SELECT product_id,quantity FROM cart_items WHERE user_id=?').all(principal.id) as {product_id:string;quantity:number}[]).map(row=>[row.product_id,row.quantity])); }
export function setCartItem(database: DatabaseSync, principal: Principal, productId: string, quantity: number) { const product=database.prepare('SELECT stock FROM products WHERE id=?').get(productId) as {stock:number}|undefined; if (!product || !Number.isInteger(quantity) || quantity<0 || quantity>product.stock) throw new Error('Invalid cart item'); if (quantity===0) database.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(principal.id,productId); else database.prepare('INSERT INTO cart_items(user_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity').run(principal.id,productId,quantity); return readCart(database,principal); }
`;
const persistenceTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync, rmSync, statSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { openDatabase } from './persistence'; import { authenticate, login, logout, register } from './auth'; import { listProjects, persistProject, readCart, setCartItem } from './repository';
test('identity, owner data and cart survive reopening without storing raw credentials', () => { const directory=mkdtempSync(path.join(os.tmpdir(),'starter-store-')); const location=path.join(directory,'app.sqlite'); try { let database=openDatabase(location); assert.equal(statSync(location).mode & 0o777,0o600); const created=register(database,'Owner@Example.test','correct horse battery'); assert.equal(authenticate(database,created.token)?.email,'owner@example.test'); const stored=database.prepare('SELECT password_hash FROM users WHERE id=?').get(created.user.id) as {password_hash:Uint8Array}; assert.notEqual(Buffer.from(stored.password_hash).toString(),'correct horse battery'); persistProject(database,'Persistent project',created.user); setCartItem(database,created.user,'lamp',2); database.close(); database=openDatabase(location); const session=login(database,'owner@example.test','correct horse battery'); assert.equal(listProjects(database,session.user)[0].name,'Persistent project'); assert.equal(readCart(database,session.user).lamp,2); assert.throws(()=>login(database,'owner@example.test','wrong password value'),/Invalid/); logout(database,session.token); assert.equal(authenticate(database,session.token),undefined); database.close(); } finally { rmSync(directory,{recursive:true,force:true}); } });
test('owners cannot read each other projects', () => { const database=openDatabase(':memory:'); const first=register(database,'first@example.test','first password value'); const second=register(database,'second@example.test','second password val'); persistProject(database,'Private',first.user); assert.deepEqual(listProjects(database,second.user),[]); database.close(); });
`;
function appSource(recipe: ProductRecipe['id'], apiBase = '') {
  const title =
    recipe === 'storefront'
      ? 'Studio shop'
      : recipe === 'dashboard'
        ? 'Product dashboard'
        : 'My projects';
  const body =
    recipe === 'storefront'
      ? `{products.map(product => <article key={product.id}><h2>{product.name}</h2><p>{money(product.price)}</p><button disabled={!user || (cart[product.id] ?? 0) >= product.stock} onClick={() => void updateCart(product.id, (cart[product.id] ?? 0) + 1)}>Add {product.name}</button></article>)}<aside aria-live="polite">Cart total: {money(products.reduce((sum, product) => sum + product.price * (cart[product.id] ?? 0), 0))}</aside><button onClick={() => setNotice('Checkout requires a configured payment provider. No payment was made.')}>Checkout</button>`
      : recipe === 'dashboard'
        ? `<label>Filter products<input value={query} onChange={event => setQuery(event.target.value)} /></label><table><thead><tr><th>Product</th><th>Stock</th><th>Price</th></tr></thead><tbody>{products.filter(product=>product.name.toLowerCase().includes(query.toLowerCase())).map(product => <tr key={product.id}><td>{product.name}</td><td>{product.stock}</td><td>{money(product.price)}</td></tr>)}</tbody></table>`
        : `<form onSubmit={event => { event.preventDefault(); void createProject(); }}><label>Project name<input required maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></label><button disabled={!user}>Create project</button></form><ul>{projects.map(project => <li key={project.id}>{project.name}</li>)}</ul>`;
  return `'use client';\nimport { useEffect, useState } from 'react';\nimport type { Cart, Product, Project } from './domain';\nconst API=${JSON.stringify(apiBase)}; const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);\nasync function request(path:string, init?:RequestInit) { const response=await fetch(API+path,{...init,credentials:'include',headers:{'content-type':'application/json',...init?.headers}}); const value=await response.json(); if(!response.ok) throw new Error(value.error??'Request failed'); return value; }\nexport default function App() { const [query,setQuery]=useState(''); const [projects,setProjects]=useState<Project[]>([]); const [cart,setCart]=useState<Cart>({}); const [products,setProducts]=useState<Product[]>([]); const [notice, setNotice] = useState(''); const [user,setUser]=useState<{id:string;email:string}|null>(null); const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const load=async()=>{ const session=await request('/api/v1/me').catch(()=>({user:null})); setUser(session.user); ${recipe === 'storefront' ? "setProducts((await request('/api/v1/products')).products); if(session.user) setCart((await request('/api/v1/cart')).cart);" : recipe === 'dashboard' ? "setProducts((await request('/api/v1/products')).products);" : "if(session.user) setProjects((await request('/api/v1/projects')).projects);"} }; useEffect(()=>{void load()},[]); const authenticate=async(mode:'register'|'login')=>{try{await request('/api/v1/auth/'+mode,{method:'POST',body:JSON.stringify({email,password})});setPassword('');await load();}catch(error){setNotice((error as Error).message)}}; const createProject=async()=>{try{await request('/api/v1/projects',{method:'POST',body:JSON.stringify({name:query})});setQuery('');await load()}catch(error){setNotice((error as Error).message)}}; const updateCart=async(productId:string,quantity:number)=>{try{setCart((await request('/api/v1/cart',{method:'PUT',body:JSON.stringify({productId,quantity})})).cart)}catch(error){setNotice((error as Error).message)}}; return <main><header><small>LOCAL-FIRST PRODUCT STARTER</small><h1>${title}</h1><p>SQLite persistence and server-side sessions are active.</p></header>{user?<section><p>Signed in as {user.email}</p><button onClick={()=>void request('/api/v1/auth/logout',{method:'POST'}).then(()=>{setUser(null);setProjects([]);setCart({})})}>Sign out</button></section>:<section aria-label="Account"><label>Email<input type="email" value={email} onChange={event=>setEmail(event.target.value)} /></label><label>Password<input type="password" minLength={12} value={password} onChange={event=>setPassword(event.target.value)} /></label><button onClick={()=>void authenticate('register')}>Create account</button><button onClick={()=>void authenticate('login')}>Sign in</button></section>}${body}<p role="status">{notice}</p><footer>Identity and application data are persisted locally. Configure email verification, recovery, rate limits and deployment secrets for your environment.</footer></main>; }\n`;
}
const style = `:root { font-family: system-ui, sans-serif; color: #182133; background: #f5f7fb; } body { margin: 0; } main { max-width: 880px; margin: 48px auto; padding: 32px; background: white; border-radius: 20px; box-shadow: 0 10px 50px #1821330d; } h1 { font-size: 38px; } header { margin-bottom: 32px; } article { display: inline-block; margin: 0 16px 24px 0; padding: 24px; border: 1px solid #e0e5ef; border-radius: 12px; } button { background: #275de4; color: white; border: 0; border-radius: 8px; padding: 12px 18px; cursor: pointer; } button:disabled { opacity: .5; } input { display: block; font: inherit; padding: 12px; margin: 8px 0 16px; border: 1px solid #a8b4cc; border-radius: 8px; } th, td { padding: 16px; text-align: left; border-bottom: 1px solid #e0e5ef; } aside, footer { margin: 24px 0; } footer, small { color: #657188; } :focus-visible { outline: 3px solid #ffad33; outline-offset: 3px; } @media (max-width: 600px) { main { margin: 12px; padding: 20px; } }`;
const apiSource = `import type { Cart } from './domain';
import { authenticate, login, logout, register, sessionCookie } from './auth';
import { openDatabase } from './persistence';
import { listProducts, quote, listProjects, persistProject, readCart, setCartItem } from './repository';
const cookieToken = (request: Request) => request.headers.get('cookie')?.split(';').map(item=>item.trim()).find(item=>item.startsWith('session='))?.slice(8);
const bearerToken = (request: Request) => request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
export async function handle(request: Request, databasePath?: string): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\\/api(?=\\/)/, '');
  const origin=request.headers.get('origin'), allowedOrigin=process.env.APP_ORIGIN ?? url.origin;
  const cors: Record<string,string> = origin===allowedOrigin ? {'access-control-allow-origin':origin,'access-control-allow-credentials':'true','vary':'Origin'} : {};
  const json=(value:unknown,init:ResponseInit={})=>{const headers=new Headers(init.headers);for(const [key,value] of Object.entries(cors))headers.set(key,value);return Response.json(value,{...init,headers});};
  const input=async()=>{const declared=Number(request.headers.get('content-length')??0);if(declared>64000)throw new Error('Request body too large');const text=await request.text();if(Buffer.byteLength(text)>64000)throw new Error('Request body too large');return JSON.parse(text) as Record<string,unknown>;};
  if(request.method==='OPTIONS') { const headers=new Headers(cors); headers.set('access-control-allow-methods','GET,POST,PUT,OPTIONS'); headers.set('access-control-allow-headers','content-type,authorization,x-auth-transport'); return new Response(null,{status:204,headers}); }
  const database=openDatabase(databasePath); const token=bearerToken(request)??cookieToken(request); const principal=authenticate(database,token);
  const cookieMutation=!!cookieToken(request) && !bearerToken(request) && !['GET','HEAD'].includes(request.method);
  if(cookieMutation && origin!==allowedOrigin){database.close();return json({error:'Invalid request origin'},{status:403});}
  try {
  if (request.method === 'GET' && route === '/health') return json({ ok: true });
  if (request.method === 'GET' && route === '/v1/products') return json({ products:listProducts(database) });
  if (request.method === 'POST' && route === '/v1/auth/register') { try { const body=await input(); const session=register(database,String(body.email??''),String(body.password??'')); const bearer=request.headers.get('x-auth-transport')==='bearer'; return json({user:session.user,...(bearer?{token:session.token}:{})},{status:201,headers:bearer?{}:{'set-cookie':sessionCookie(session.token)}}); } catch(error){return json({error:(error as Error).message},{status:400});} }
  if (request.method === 'POST' && route === '/v1/auth/login') { try { const body=await input(); const session=login(database,String(body.email??''),String(body.password??'')); const bearer=request.headers.get('x-auth-transport')==='bearer'; return json({user:session.user,...(bearer?{token:session.token}:{})},{headers:bearer?{}:{'set-cookie':sessionCookie(session.token)}}); } catch(error){return json({error:(error as Error).message},{status:401});} }
  if (request.method === 'POST' && route === '/v1/auth/logout') { logout(database,token); return json({ok:true},{headers:{'set-cookie':sessionCookie('',true)}}); }
  if (request.method === 'GET' && route === '/v1/me') return principal?json({user:principal}):json({error:'Unauthorized',user:null},{status:401});
  if (route === '/v1/projects') { if(!principal)return json({error:'Unauthorized'},{status:401}); if(request.method==='GET')return json({projects:listProjects(database,principal)}); if(request.method==='POST'){try{const body=await input();return json({project:persistProject(database,String(body.name??''),principal)},{status:201});}catch(error){return json({error:(error as Error).message},{status:400});}} }
  if (route === '/v1/cart') { if(!principal)return json({error:'Unauthorized'},{status:401}); if(request.method==='GET')return json({cart:readCart(database,principal)}); if(request.method==='PUT'){try{const body=await input();return json({cart:setCartItem(database,principal,String(body.productId??''),Number(body.quantity??-1))});}catch(error){return json({error:(error as Error).message},{status:400});}} }
  if (request.method === 'POST' && route === '/v1/quote') {
    try {
      const cart = await input() as Cart;
      if (!cart || Array.isArray(cart) || typeof cart !== 'object') throw new Error();
      return json({ total: quote(database,cart), currency: 'USD' });
    } catch { return json({ error: 'Invalid cart' }, { status: 400 }); }
  }
  if (request.method === 'POST' && route === '/v1/checkout') return json({ error: 'Payment provider not configured' }, { status: 503 });
  return json({ error: 'Not found' }, { status: 404 });
  } finally { database.close(); }
}
`;
const serverSource = `import http from 'node:http';
import { handle } from './api';
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 64000) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
    const method = incoming.method ?? 'GET';
    const request = new Request('http://' + (incoming.headers.host ?? '127.0.0.1') + incoming.url, { method, headers: incoming.headers as Record<string, string>, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks).toString() }) });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
  } catch { outgoing.writeHead(500).end('Internal error'); }
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log('http://127.0.0.1:' + (server.address() as { port: number }).port));
`;
const apiTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync, rmSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { handle } from './api';
test('HTTP contracts persist authenticated owner data and reject cross-origin cookie writes', async () => { const directory=mkdtempSync(path.join(os.tmpdir(),'starter-api-')), database=path.join(directory,'app.sqlite'); try {
  assert.equal((await handle(new Request('http://local/health'),database)).status, 200);
  const registration=await handle(new Request('http://local/v1/auth/register',{method:'POST',headers:{origin:'http://local','content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'correct horse battery'})}),database); assert.equal(registration.status,201); assert.equal((await registration.clone().json()).token,undefined); const cookie=registration.headers.get('set-cookie')!.split(';')[0]; assert.match(registration.headers.get('set-cookie')!,/HttpOnly.*SameSite=Strict/);
  const project=await handle(new Request('http://local/v1/projects',{method:'POST',headers:{origin:'http://local',cookie,'content-type':'application/json'},body:JSON.stringify({name:'Persistent'})}),database); assert.equal(project.status,201);
  const projects=await handle(new Request('http://local/v1/projects',{headers:{cookie}}),database); assert.equal((await projects.json()).projects[0].name,'Persistent');
  assert.equal((await handle(new Request('http://local/v1/projects',{method:'POST',headers:{origin:'http://evil.test',cookie,'content-type':'application/json'},body:JSON.stringify({name:'CSRF'})}),database)).status,403);
  const quoted = await handle(new Request('http://local/v1/quote', { method: 'POST', body: JSON.stringify({ lamp: 2 }) }),database); assert.equal((await quoted.json()).total, 7800);
  assert.equal((await handle(new Request('http://local/v1/checkout', { method: 'POST' }),database)).status,503);
  } finally { rmSync(directory,{recursive:true,force:true}); }
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
      'node_modules/\ndist/\n.next/\ndata/\n.env*\n!.env.example\n.forge/\nplaywright-report/\ntest-results/\n',
    'tsconfig.json': JSON.stringify(
      { compilerOptions: compiler, include: ['src', 'tests'] },
      null,
      2,
    ),
    'src/domain.ts': domain,
    'src/domain.test.ts': domainTest,
    'src/persistence.ts': persistenceSource,
    'src/auth.ts': authSource,
    'src/repository.ts': repositorySource,
    'src/persistence.test.ts': persistenceTest,
    '.env.example':
      'DATABASE_PATH=./data/app.sqlite\nAPP_ORIGIN=http://127.0.0.1:3000\n# Set NODE_ENV=production behind HTTPS to enable Secure session cookies.\n',
    'README.md': `# ${name}\n\nBundled ${recipe} product foundation with TypeScript, pnpm, SQLite migrations, persistent owner-scoped data and server-side password sessions.\n\nRequires Node.js 22.15 or newer. Run: pnpm install --ignore-scripts; pnpm test; pnpm typecheck; pnpm dev.\n\nWeb starters: pnpm exec playwright install chromium; pnpm test:e2e.\n\n## Identity and persistence\nPasswords use Node scrypt with per-user salts. Random session tokens are stored as SHA-256 hashes and sent in HttpOnly, SameSite=Strict cookies. Owner authorization runs beside the database query. DATABASE_PATH selects the SQLite file. Back up the database and test restore before deployment.\n\n## Environment integrations still required\nConfigure HTTPS, deployment secrets, email verification/recovery, abuse and rate limits, audit retention, monitoring and provider-specific payment/webhook handling where applicable. No payment or external account operation is simulated as successful.\n`,
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
          '/v1/auth/register': {
            post: {
              responses: {
                '201': { description: 'Account and session created' },
                '400': { description: 'Invalid or duplicate account' },
              },
            },
          },
          '/v1/projects': {
            get: {
              responses: {
                '200': { description: 'Owner projects' },
                '401': { description: 'Authentication required' },
              },
            },
            post: {
              responses: {
                '201': { description: 'Owner project created' },
                '401': { description: 'Authentication required' },
              },
            },
          },
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
  files['src/App.tsx'] = appSource(webRecipe, recipe === 'monorepo' ? 'http://127.0.0.1:3001' : '');
  files['src/style.css'] = style;
  files['tests/app.spec.ts'] =
    `import { test, expect } from '@playwright/test';\ntest('account, persisted flow and runtime errors', async ({ page }) => { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('/'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); await page.getByLabel('Email').fill('user-'+Date.now()+'@example.test'); await page.getByLabel('Password').fill('correct horse battery'); await page.getByRole('button', { name: 'Create account' }).click(); await expect(page.getByText(/Signed in as/)).toBeVisible(); ${webRecipe === 'storefront' ? "await page.getByRole('button', { name: 'Add Reading lamp' }).click(); await expect(page.getByText('Cart total: $39.00')).toBeVisible(); await page.reload(); await expect(page.getByText('Cart total: $39.00')).toBeVisible();" : webRecipe === 'dashboard' ? "await page.getByLabel('Filter products').fill('lamp'); await expect(page.getByRole('cell', { name: 'Reading lamp' })).toBeVisible(); await expect(page.getByRole('cell', { name: 'Studio desk' })).toHaveCount(0);" : "await page.getByLabel('Project name').fill('New project'); await page.getByRole('button', { name: 'Create project' }).click(); await expect(page.getByRole('listitem')).toHaveText('New project'); await page.reload(); await expect(page.getByRole('listitem')).toHaveText('New project');"} expect(errors).toEqual([]); });\n`;
  const reactDeps = { react: '^19.2.0', 'react-dom': '^19.2.0' };
  const webDev = {
    ...commonDev,
    '@types/react': '^19.2.0',
    '@types/react-dom': '^19.2.0',
    '@playwright/test': '^1.63.0',
  };
  const next = recipe !== 'monorepo';
  files['playwright.config.ts'] =
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { baseURL: 'http://127.0.0.1:' + (process.env.PORT ?? '3000') }, webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:' + (process.env.PORT ?? '3000'), reuseExistingServer: false, env: { DATABASE_PATH: process.env.DATABASE_PATH ?? '.forge/e2e.sqlite', APP_ORIGIN: 'http://127.0.0.1:' + (process.env.PORT ?? '3000') } } });\n`;
  if (next) {
    files['src/api.ts'] = apiSource;
    files['src/app/page.tsx'] = "export { default } from '../App';\n";
    files['src/app/api/[...path]/route.ts'] =
      "import { handle } from '../../../api'; export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'; export const GET=(request:Request)=>handle(request); export const POST=(request:Request)=>handle(request); export const PUT=(request:Request)=>handle(request); export const OPTIONS=(request:Request)=>handle(request);\n";
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
  web['apps/web/playwright.config.ts'] =
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { baseURL: 'http://127.0.0.1:' + (process.env.PORT ?? '3000') }, webServer: [{ command: 'pnpm dev', url: 'http://127.0.0.1:' + (process.env.PORT ?? '3000'), reuseExistingServer: false }, { command: 'pnpm --dir ../api dev', url: 'http://127.0.0.1:3001/health', reuseExistingServer: false, env: { PORT: '3001', DATABASE_PATH: '../../.forge/e2e.sqlite', APP_ORIGIN: 'http://127.0.0.1:' + (process.env.PORT ?? '3000') } }] });\n`;
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
      'SQLite identity and owner data are implemented. Production operations still require HTTPS, email verification/recovery, rate limits, monitoring, backups and provider-specific payment/webhook integration.',
    ],
  };
}
