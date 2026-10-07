// Facts the look needs before drawing: how full each side of every slide is
// (for automatic presenter placement) and where the presenter sits in a
// session's camera picture.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { slideFileName } from '../store.js';
import { summarize } from '../matting/refine.js';
import { MATTE_VERSION } from '../matting/index.js';

const AW = 192;
const AH = 108;
const ANALYSIS_VERSION = 1;

/** Runs FFmpeg and returns its stdout as one buffer. */
function ffmpegBuffer(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`FFmpeg 오류: ${err.trim()}`))));
  });
}

/** Width and height of a PNG file, read from its header. */
export async function pngSize(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

function busyShare(content, x0, x1, y0, y1) {
  let busy = 0;
  let all = 0;
  for (let y = Math.floor(y0 * AH); y < Math.ceil(y1 * AH); y++) {
    for (let x = Math.floor(x0 * AW); x < Math.ceil(x1 * AW); x++) {
      busy += content[y * AW + x];
      all += 1;
    }
  }
  return all ? Math.round((busy / all) * 1000) / 1000 : 0;
}

/**
 * How busy the left and right parts of each slide are (share of pixels with
 * something on them, 0–1). Pixels that look the same on most slides count as
 * the template's background, not content, so a presenter can stand over a
 * decorated template. Cached next to the slides.
 */
export async function analyzeSlides(ff, slidesDir, { count, version }) {
  const cacheFile = path.join(slidesDir, 'analysis.json');
  try {
    const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (cached.v === ANALYSIS_VERSION && cached.version === version && cached.pages?.length === count) return cached.pages;
  } catch {
    // not analyzed yet
  }
  if (!count) return [];
  const raw = await ffmpegBuffer(ff.bin, [
    '-framerate', '1', '-start_number', '1', '-i', path.join(slidesDir, 'p%03d.png'), '-frames:v', String(count),
    '-vf', `scale=${AW}:${AH}:force_original_aspect_ratio=decrease:flags=area,pad=${AW}:${AH}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ]);
  const size = AW * AH;
  const slides = [];
  for (let i = 0; i < count && (i + 1) * size <= raw.length; i++) slides.push(raw.subarray(i * size, (i + 1) * size));

  // The deck's common background: per-pixel median over all slides.
  let template = null;
  if (slides.length >= 4) {
    template = new Uint8Array(size);
    const column = new Uint8Array(slides.length);
    for (let k = 0; k < size; k++) {
      for (let s = 0; s < slides.length; s++) column[s] = slides[s][k];
      column.sort();
      template[k] = column[column.length >> 1];
    }
  }

  const pages = slides.map((g) => {
    const mark = new Uint8Array(size);
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const k = y * AW + x;
        const edge = Math.abs(g[k] - g[Math.min(AW - 1, x + 1) + y * AW]) + Math.abs(g[k] - g[x + Math.min(AH - 1, y + 1) * AW]);
        const differs = !template || Math.abs(g[k] - template[k]) > 24;
        if (edge > 18 && differs) mark[k] = 1;
      }
    }
    // Thicken strokes so text counts as a block, not thin lines.
    const content = new Uint8Array(size);
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        let on = 0;
        for (let dy = -2; dy <= 2 && !on; dy++) {
          for (let dx = -2; dx <= 2 && !on; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < AH && xx >= 0 && xx < AW && mark[yy * AW + xx]) on = 1;
          }
        }
        content[y * AW + x] = on;
      }
    }
    return { left: busyShare(content, 0, 0.36, 0.22, 1), right: busyShare(content, 0.64, 1, 0.22, 1) };
  });
  await fsp.writeFile(cacheFile, JSON.stringify({ v: ANALYSIS_VERSION, version, pages }));
  return pages;
}

export function slidePathOf(slidesDir, page) {
  return path.join(slidesDir, slideFileName(page));
}

/**
 * Where the presenter sits in a camera recording: cut a few frames out and
 * take the middle values. Cached per recording file.
 * @param {{pool: import('../matting/index.js').MattingPool, ff: object, src: string, srcW: number, srcH: number,
 *   times: number[], keyer: string, cacheFile: string, stamp: object}} opts
 */
export async function personStats({ pool, ff, src, srcW, srcH, times, keyer, cacheFile, stamp }) {
  const cacheKey = JSON.stringify({ v: MATTE_VERSION, keyer, stamp });
  try {
    const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (cached.key === cacheKey) return cached.result;
  } catch {
    // not measured yet
  }
  const found = [];
  const keys = [];
  for (const [i, t] of times.slice(0, 3).entries()) {
    const outPng = `${cacheFile}.${i}.png`;
    try {
      const r = await pool.run({ kind: 'still', ffBin: ff.bin, src, at: t.toFixed(3), srcW, srcH, outPng, height: 360, keyer });
      found.push(r.person);
      if (r.key) keys.push(r.key);
    } finally {
      await fsp.rm(outPng, { force: true });
    }
  }
  const person = summarize(found);
  // The loosest threshold any sample needed, so the whole backdrop goes.
  const key = keys.length ? keys.reduce((a, b) => (b.similarity > a.similarity ? b : a)) : null;
  const result = { person, key };
  await fsp.writeFile(cacheFile, JSON.stringify({ key: cacheKey, result }));
  return result;
}
