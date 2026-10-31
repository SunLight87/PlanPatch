import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRun } from './src/coordinator.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_IDS = ['community-update', 'community-no-change'];
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const MAX_BODY = 32_768;

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('JSON_REQUIRED'), { status: 415 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
}
async function sample(id) {
  if (!SAMPLE_IDS.includes(id)) throw Object.assign(new Error('SAMPLE_NOT_FOUND'), { status: 404 });
  return JSON.parse(await readFile(path.join(ROOT, 'samples', id + '.json'), 'utf8'));
}

export function createAppServer({ dataDirectory = path.join(ROOT, 'var', 'runs') } = {}) {
  let current = null;
  let creating = false;
  let pending = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = req.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return reply(res, 403, { error: { code: 'HOST_REJECTED' } });
      const url = new URL(req.url, `http://${host}`);
      if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, { error: { code: 'METHOD_REJECTED' } });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
          return reply(res, 403, { error: { code: 'ORIGIN_REJECTED' } });
        }
      }
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        const body = await readFile(path.join(ROOT, 'public', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const samples = await Promise.all(SAMPLE_IDS.map(sample));
        return reply(res, 200, { mode: 'MOCK', liveEnabled: false, budgetStatus: 'PENDING_USER_RESPONSE', sampleIds: samples.map(({ id, title }) => ({ id, title })), limits: { bodyBytes: MAX_BODY, logicalInvocations: 8, concurrentAgents: 3 } });
      }
      if (req.method === 'GET' && url.pathname === '/api/sample') return reply(res, 200, await sample(url.searchParams.get('id') || SAMPLE_IDS[0]));
      if (req.method === 'GET' && url.pathname === '/api/run') return reply(res, 200, current ? current.snapshot() : { status: 'IDLE', mode: 'MOCK' });
      if (req.method === 'GET' && url.pathname === '/api/health') return reply(res, 200, { ok: true, liveEnabled: false });
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        if (creating || pending) return reply(res, 409, { error: { code: 'RUN_ACTIVE' } });
        creating = true;
        try {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['sampleId', 'input'].includes(k))) {
            return reply(res, 400, { error: { code: 'RUN_OPTIONS_REJECTED' } });
          }
          const input = body.input ?? await sample(body.sampleId || SAMPLE_IDS[0]);
          await mkdir(dataDirectory, { recursive: true });
          const runDirectory = path.join(dataDirectory, randomUUID());
          const next = await createRun({ input, mode: 'MOCK', runDirectory });
          current = next;
          pending = next.start().catch(() => null).finally(() => { pending = null; });
          return reply(res, 201, next.snapshot());
        } finally { creating = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        await jsonBody(req);
        if (!current) return reply(res, 409, { error: { code: 'NO_RUN' } });
        await current.stop();
        return reply(res, 200, current.snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/freeze') {
        await jsonBody(req);
        if (!current) return reply(res, 409, { error: { code: 'NO_RUN' } });
        return reply(res, 200, await current.freeze());
      }
      return reply(res, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code) ? error.code :
        /^[A-Z][A-Z0-9_]{2,64}$/.test(error.message || '') ? error.message : 'REQUEST_FAILED';
      if (!res.headersSent) reply(res, error.status || (code === 'REQUEST_FAILED' ? 500 : 400), { error: { code } });
      else res.end();
    }
  });
  server.planpatchStop = async () => { if (current) await current.stop(); if (pending) await pending; };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = process.argv.find(x => x.startsWith('--port='));
  const port = arg ? Number(arg.split('=')[1]) : 4317;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
  const server = createAppServer();
  server.on('error', error => { console.error(`PlanPatch: ${error.code || 'SERVER_ERROR'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`PlanPatch MOCK: http://127.0.0.1:${port} — live generation disabled`));
  const shutdown = async () => { await server.planpatchStop(); server.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
