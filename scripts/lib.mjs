// Tiny helpers shared by the scripts. Node 20+, no dependencies.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const p = join(ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return {
    url: (process.env.N8N_URL ?? 'http://localhost:5678').replace(/\/$/, ''),
    apiKey: process.env.N8N_API_KEY,
    approvalToken: process.env.APPROVAL_TOKEN,
  };
}

export async function api(env, method, path, body) {
  const res = await fetch(`${env.url}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': env.apiKey ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

export const localStatePath = join(ROOT, '.n8n-local.json');
export const readLocal = () => (existsSync(localStatePath) ? JSON.parse(readFileSync(localStatePath, 'utf8')) : {});
export const writeLocal = (s) => writeFileSync(localStatePath, JSON.stringify(s, null, 2) + '\n');

export const fixtures = () => JSON.parse(readFileSync(join(ROOT, 'fixtures/emails.json'), 'utf8')).emails;
