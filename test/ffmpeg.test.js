// The FFmpeg runner's watchdog, with a stand-in FFmpeg that gets stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../server/build/ffmpeg.js';

async function fakeFfmpeg(dir, body) {
  const bin = path.join(dir, 'ffmpeg');
  await fsp.writeFile(bin, `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(path.join(dir, 'runs'))}, 'x');\n${body}\n`);
  await fsp.chmod(bin, 0o755);
  return { bin };
}

const runs = async (dir) => (await fsp.readFile(path.join(dir, 'runs'), 'utf8')).length;

test('a run that keeps reporting the same position is stopped and retried', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-ff-'));
  // Moves for a moment, then repeats the same position forever.
  const ff = await fakeFfmpeg(dir, `let n = 0;
setInterval(() => process.stdout.write('out_time_us=' + Math.min(++n, 3) * 1000 + '\\nprogress=continue\\n'), 100);`);
  await assert.rejects(runFfmpeg(ff, [], { stallMs: 1500, retries: 1 }), /응답하지 않아/);
  assert.equal(await runs(dir), 2);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a run that goes silent is stopped', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-ff-'));
  const ff = await fakeFfmpeg(dir, 'setInterval(() => {}, 1000);');
  await assert.rejects(runFfmpeg(ff, [], { stallMs: 1200, retries: 0 }), /응답하지 않아/);
  assert.equal(await runs(dir), 1);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a run that moves forward is left alone', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-ff-'));
  const ff = await fakeFfmpeg(dir, `let n = 0;
const t = setInterval(() => {
  process.stdout.write('out_time_us=' + (++n * 100000) + '\\nprogress=continue\\n');
  if (n === 30) { clearInterval(t); process.stdout.write('progress=end\\n'); }
}, 100);`);
  const seen = [];
  await runFfmpeg(ff, [], { stallMs: 1500, retries: 0, totalSec: 3, onProgress: (p) => seen.push(p) });
  assert.equal(await runs(dir), 1);
  assert.ok(seen.at(-1) > 0.9);
  await fsp.rm(dir, { recursive: true, force: true });
});
