import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, revisionManifest, sha256 } from './revision.mjs';
import { verifyFrozenBundle } from '../src/coordinator.mjs';

const latest = JSON.parse(await readFile(path.join(root, 'var', 'latest-demo.json'), 'utf8'));
const bundle = JSON.parse(await readFile(path.join(latest.outputDirectory, 'frozen-bundle.json'), 'utf8'));
const recordedRevision = JSON.parse(await readFile(path.join(latest.outputDirectory, 'product-revision.json'), 'utf8'));
const currentRevision = await revisionManifest();
if (!verifyFrozenBundle(bundle)) throw new Error('FROZEN_BUNDLE_INVALID');
if (recordedRevision.productRevision !== currentRevision.productRevision) throw new Error('PRODUCT_CHANGED_SINCE_DEMO');
if (latest.mode !== 'MOCK' || bundle.mode !== 'MOCK' || bundle.snapshot.counters.generationPosts !== 0) throw new Error('MODE_MISMATCH');
for (const item of bundle.manifest.files) {
  if (!/^[A-Za-z0-9_.-]+$/.test(item.path)) throw new Error('MANIFEST_PATH_REJECTED');
  const bytes = await readFile(path.join(latest.outputDirectory, 'run', 'frozen', item.path));
  if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error('ARTIFACT_HASH_MISMATCH');
}
console.log(JSON.stringify({ status: 'PASS', mode: bundle.mode, runId: bundle.runId, productRevision: currentRevision.productRevision, filesVerified: bundle.manifest.files.length, realGenerationPosts: 0, liveAcceptance: 'NOT_RUN' }, null, 2));
