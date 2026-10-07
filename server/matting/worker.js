// Worker thread that cuts the presenter out of camera footage. One job at a
// time: a recorded stretch of a camera track (→ alpha matte video) or a single
// picture (→ transparent PNG for the look editor's preview).

import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matte, Resizer, workSize, measure, summarize } from './refine.js';

const MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models', 'selfie-segmenter.onnx');

let ortModule = null;
let session = null;

async function getSession() {
  if (session) return session;
  ortModule = await import('onnxruntime-web');
  // Each worker runs one inference at a time; parallelism comes from workers.
  ortModule.env.wasm.numThreads = 1;
  ortModule.env.logLevel = 'error';
  session = await ortModule.InferenceSession.create(await fsp.readFile(MODEL), { graphOptimizationLevel: 'all' });
  return session;
}

async function infer(tensor) {
  const s = await getSession();
  const out = await s.run({ [s.inputNames[0]]: new ortModule.Tensor('float32', tensor, [1, 256, 256, 3]) });
  return out[s.outputNames[0]].data;
}

/** Collects a raw video pipe into whole frames. */
async function* frames(stream, frameBytes) {
  let parts = [];
  let have = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    have += chunk.length;
    while (have >= frameBytes) {
      const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
      yield all.subarray(0, frameBytes);
      const rest = all.subarray(frameBytes);
      parts = rest.length ? [Buffer.from(rest)] : [];
      have = rest.length;
    }
  }
}

function spawnFfmpeg(bin, args) {
  const child = spawn(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg 오류 (코드 ${code}): ${stderr.trim()}`))));
  });
  done.catch(() => {});
  return { child, done };
}

function encoderArgs(encoder) {
  return encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-g', '30', '-pix_fmt', 'gray']
    : ['-c:v', 'ffv1', '-pix_fmt', 'gray'];
}

/**
 * Green screen: the backdrop color is the median along the picture's top and
 * sides. Alpha follows FFmpeg's chromakey (distance in U/V), with the
 * threshold set just above how much the backdrop itself varies, so dark
 * clothes and hair stay solid. Used for the preview and to find where the
 * presenter sits; the export keys with FFmpeg using `keyColor`/`similarity`.
 */
const KEY_BLEND = 0.05;
function chromaAlpha(rgb, w, h) {
  const uv = (r, g, b) => [128 - 0.148 * r - 0.291 * g + 0.439 * b, 128 + 0.439 * r - 0.368 * g - 0.071 * b];
  const border = [];
  const pick = (x, y) => border.push((y * w + x) * 3);
  for (let x = 0; x < w; x += 4) for (let y = 0; y < 6; y++) pick(x, y);
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < 6; x++) {
      pick(x, y);
      pick(w - 1 - x, y);
    }
  }
  const med = (list) => list.sort((a, b) => a - b)[list.length >> 1];
  const key = [0, 1, 2].map((c) => med(border.map((i) => rgb[i + c])));
  const [ku, kv] = uv(...key);
  const dist = (i) => {
    const [u, v] = uv(rgb[i], rgb[i + 1], rgb[i + 2]);
    return Math.sqrt(((u - ku) ** 2 + (v - kv) ** 2) / (255 * 255 * 2));
  };
  const spread = border.map(dist).sort((a, b) => a - b);
  const similarity = Math.min(0.2, Math.max(0.06, spread[Math.floor(spread.length * 0.95)] + 0.025));
  const alpha = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const a = (dist(k * 3) - similarity) / KEY_BLEND;
    alpha[k] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }
  const keyColor = `0x${key.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { alpha, keyColor, similarity: Math.round(similarity * 1000) / 1000 };
}

async function segmentJob(job, report) {
  const { w, h } = workSize(job.srcW, job.srcH);
  const dec = spawnFfmpeg(job.ffBin, [
    '-ss', job.at, '-t', job.span, '-an', '-i', job.src,
    ...(job.maxFrames ? ['-frames:v', String(job.maxFrames)] : []),
    '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  dec.child.stdin.end();
  const tmp = `${job.outFile}.tmp.mkv`;
  const enc = spawnFfmpeg(job.ffBin, [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0',
    ...encoderArgs(job.encoder), tmp,
  ]);
  enc.child.stdin.on('error', () => {});
  const matte = new Matte(w, h);
  const alpha = new Uint8Array(w * h);
  const stats = [];
  let count = 0;
  try {
    for await (const rgb of frames(dec.child.stdout, w * h * 3)) {
      const mask = await infer(matte.modelTensor(rgb));
      matte.process(rgb, mask, alpha);
      if (count % 15 === 0) stats.push(measure(alpha, w, h));
      if (!enc.child.stdin.write(Buffer.from(alpha))) await once(enc.child.stdin, 'drain');
      count += 1;
      if (count % 30 === 0) report({ frames: count });
    }
    await dec.done;
    enc.child.stdin.end();
    await enc.done;
  } catch (err) {
    dec.child.kill('SIGKILL');
    enc.child.kill('SIGKILL');
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (!count) {
    await fsp.rm(tmp, { force: true });
    throw new Error('카메라 영상에서 화면을 읽지 못했습니다.');
  }
  await fsp.rename(tmp, job.outFile);
  return { frames: count, width: w, height: h, person: summarize(stats) };
}

/** One picture → transparent PNG of the presenter (plus where they sit). */
async function stillJob(job) {
  const outH = job.height ?? 540;
  const outW = Math.round((outH * job.srcW) / job.srcH / 2) * 2;
  const input = job.at != null ? ['-ss', job.at, '-an', '-i', job.src, '-frames:v', '1'] : ['-i', job.src, '-frames:v', '1'];
  const dec = spawnFfmpeg(job.ffBin, [
    ...input, '-vf', `scale=${outW}:${outH}:flags=area,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  dec.child.stdin.end();
  let big = null;
  for await (const f of frames(dec.child.stdout, outW * outH * 3)) {
    if (!big) big = Buffer.from(f);
  }
  await dec.done;
  if (!big) throw new Error('사진을 읽지 못했습니다.');

  const { w, h } = workSize(outW, outH);
  const small = new Uint8Array(w * h * 3);
  const shrink = new Resizer(outW, outH, w, h).rgbToTensor(big);
  for (let i = 0; i < small.length; i++) small[i] = Math.round(shrink[i] * 255);
  let alpha;
  let key = null;
  if (job.keyer === 'green') {
    let keyColor;
    let similarity;
    ({ alpha, keyColor, similarity } = chromaAlpha(small, w, h));
    key = { color: keyColor, similarity, blend: KEY_BLEND };
  } else {
    const matte = new Matte(w, h);
    alpha = matte.process(small, await infer(matte.modelTensor(small)));
  }
  const person = measure(alpha, w, h);
  const upAlpha = new Resizer(w, h, outW, outH).plane(alpha);
  const rgba = Buffer.alloc(outW * outH * 4);
  for (let k = 0; k < outW * outH; k++) {
    rgba[k * 4] = big[k * 3];
    rgba[k * 4 + 1] = big[k * 3 + 1];
    rgba[k * 4 + 2] = big[k * 3 + 2];
    rgba[k * 4 + 3] = Math.max(0, Math.min(255, Math.round(upAlpha[k])));
  }
  const tmp = `${job.outPng}.tmp.png`;
  const enc = spawnFfmpeg(job.ffBin, [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${outW}x${outH}`, '-i', 'pipe:0', '-frames:v', '1', tmp,
  ]);
  enc.child.stdin.on('error', () => {});
  enc.child.stdin.end(rgba);
  await enc.done;
  await fsp.rename(tmp, job.outPng);
  if (job.outJpg) {
    // The untouched picture too, for previews of scenes that keep the real background.
    const tmpJpg = `${job.outJpg}.tmp.jpg`;
    const jpg = spawnFfmpeg(job.ffBin, [
      '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${outW}x${outH}`, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', tmpJpg,
    ]);
    jpg.child.stdin.on('error', () => {});
    jpg.child.stdin.end(big);
    await jpg.done;
    await fsp.rename(tmpJpg, job.outJpg);
  }
  return { width: outW, height: outH, person, key };
}

parentPort.on('message', async ({ id, job }) => {
  const report = (data) => parentPort.postMessage({ id, type: 'progress', ...data });
  try {
    const result = job.kind === 'still' ? await stillJob(job) : await segmentJob(job, report);
    parentPort.postMessage({ id, type: 'done', result });
  } catch (err) {
    parentPort.postMessage({ id, type: 'error', message: err.message });
  }
});
