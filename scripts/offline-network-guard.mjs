// Process-local test guard. Loopback HTTP remains available for the local server tests.
// This is validation instrumentation, not a production network security boundary.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const state = { externalAttempts: 0, loopbackRequests: 0 };
function allow(input, options = {}) {
  let hostname;
  try {
    if (typeof input === 'string' || input instanceof URL) hostname = new URL(input).hostname;
    else if (input instanceof Request) hostname = new URL(input.url).hostname;
    else hostname = input?.hostname ?? input?.host ?? options.hostname ?? options.host ?? 'localhost';
    // Node's host option may include a port, while URL.hostname may retain IPv6 brackets.
    hostname = String(hostname).replace(/^\[::1\](?::\d+)?$/, '::1').replace(/^(localhost|127\.0\.0\.1):\d+$/, '$1');
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) { state.loopbackRequests++; return; }
  } catch { /* Unknown targets fail closed. */ }
  state.externalAttempts++;
  throw new Error('OFFLINE_EXTERNAL_NETWORK_REJECTED');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, options) { allow(input, options); return originalFetch(input, options); };
for (const client of [http, https]) {
  const originalRequest = client.request;
  client.request = function(input, options, callback) { allow(input, options); return originalRequest.call(this, input, options, callback); };
  client.get = function(...args) { const request = client.request(...args); request.end(); return request; };
}
syncBuiltinESMExports();
export const networkGuardSnapshot = () => ({ ...state, scope: 'Current process global fetch and node:http/https; not an OS firewall' });
