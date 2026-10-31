import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRun } from '../src/coordinator.mjs';
import { root, revisionManifest } from './revision.mjs';

const sampleId = process.argv.includes('--no-change') ? 'community-no-change' : 'community-update';
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outputDirectory = path.join(root, 'var', 'demos', `${sampleId}-${stamp}`);
await mkdir(outputDirectory, { recursive: true });
const input = JSON.parse(await readFile(path.join(root, 'samples', `${sampleId}.json`), 'utf8'));
const revision = await revisionManifest();
await writeFile(path.join(outputDirectory, 'product-revision.json'), JSON.stringify(revision, null, 2) + '\n');
const run = await createRun({ input, mode: 'MOCK', runDirectory: path.join(outputDirectory, 'run') });
const result = await run.start();
if (result.status !== 'FINISHED') throw new Error(`DEMO_${result.status}`);
const bundle = await run.freeze();
await writeFile(path.join(outputDirectory, 'frozen-bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
await writeFile(path.join(root, 'var', 'latest-demo.json'), JSON.stringify({ outputDirectory, mode: 'MOCK', runId: bundle.runId, productRevision: revision.productRevision, realGenerationPosts: 0 }, null, 2) + '\n');
console.log(JSON.stringify({ outputDirectory, runId: bundle.runId, mode: bundle.mode, status: result.status, proposal: result.proposal, generationPosts: result.counters.generationPosts, mockInvocations: result.counters.mockInvocations, productRevision: revision.productRevision }, null, 2));
