import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createAppServer } from '../server.mjs';

async function app(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'planpatch-http-'));
  const server = createAppServer({ dataDirectory: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await server.planpatchStop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}

test('HTTP entry stays MOCK-only and rejects cross-origin, invalid host and unknown run options', async t => {
  const { base, post } = await app(t);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.liveEnabled, false);
  assert.equal(config.sampleIds.length, 2);
  assert.equal((await post('/api/runs', { mode: 'LIVE' })).status, 400);
  assert.equal((await post('/api/runs', {}, { origin: 'https://example.org' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/config', { headers: { host: 'evil.example:80' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await post('/api/live', {})).status, 404);
  assert.equal((await fetch(base + '/api/sample?id=../../work/amd-mozaik-private.env')).status, 404);
});

test('HTTP completes synthetic revision, refuses overlapping run, freezes and stops', async t => {
  const { base, post } = await app(t);
  assert.equal((await post('/api/freeze', {})).status, 409);
  assert.equal((await post('/api/runs', { sampleId: 'community-update' })).status, 201);
  assert.equal((await post('/api/runs', { sampleId: 'community-update' })).status, 409);
  let snapshot;
  for (let i = 0; i < 200; i++) {
    snapshot = await (await fetch(base + '/api/run')).json();
    if (snapshot.status !== 'RUNNING' && snapshot.status !== 'CREATED') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(snapshot.status, 'FINISHED');
  assert.equal(snapshot.mode, 'MOCK');
  assert.equal(snapshot.counters.generationPosts, 0);
  assert.equal(snapshot.proposal.capacity, 24);
  assert.equal(snapshot.proposal.waitlist, 12);
  const frozen = await post('/api/freeze', {});
  assert.equal(frozen.status, 200);
  const bundle = await frozen.json();
  assert.equal(bundle.snapshot.artifactStatus, 'FROZEN');
  assert.equal(bundle.mode, 'MOCK');
  assert.equal((await post('/api/runs', { sampleId: 'community-no-change' })).status, 201);
  const stopped = await (await post('/api/stop', {})).json();
  assert.equal(stopped.status, 'STOPPED');
});
