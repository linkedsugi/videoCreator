// Cutting the presenter out: the image math, and the worker on a real photo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxMean, boxNorm, measure, summarize, workSize } from '../server/matting/refine.js';
import { MattingPool, mattingAvailable } from '../server/matting/index.js';
import { findFfmpeg, runFfmpeg, probeMedia } from '../server/build/ffmpeg.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'presenter.jpg');
const ff = await findFfmpeg();
const canMatte = await mattingAvailable();

test('box mean matches a direct average, borders included', () => {
  const w = 13;
  const h = 7;
  const r = 2;
  const src = Float32Array.from({ length: w * h }, (_, i) => (i * 37) % 11);
  const out = new Float32Array(w * h);
  boxMean(src, w, h, r, out, { inv: boxNorm(w, h, r), tmp: new Float32Array(w * h), col: new Float64Array(w) });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          sum += src[yy * w + xx];
          n += 1;
        }
      }
      assert.ok(Math.abs(out[y * w + x] - sum / n) < 1e-4, `at ${x},${y}`);
    }
  }
});

test('work size keeps the picture shape', () => {
  assert.deepEqual(workSize(1920, 1080), { w: 512, h: 288 });
  assert.deepEqual(workSize(1440, 1080), { w: 384, h: 288 });
});

test('measure finds where the person is', () => {
  const w = 100;
  const h = 50;
  const alpha = new Uint8Array(w * h);
  for (let y = 10; y < 50; y++) for (let x = 60; x < 90; x++) alpha[y * w + x] = 255;
  const m = measure(alpha, w, h);
  assert.equal(m.top, 0.2);
  assert.equal(m.left, 0.6);
  assert.equal(m.right, 0.9);
  assert.ok(Math.abs(m.cx - 0.75) < 0.01);
  assert.equal(measure(new Uint8Array(w * h), w, h), null);
  assert.equal(summarize([m, null, { ...m, cx: 0.7 }, { ...m, cx: 0.8 }]).cx, 0.75);
});

test('cuts the presenter out of a photo and a clip', { skip: (!ff && 'FFmpeg not found') || (!canMatte && 'matting not installed'), timeout: 180_000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-matte-'));
  const pool = new MattingPool({ size: 1 });
  try {
    // The photo sits in the middle of a wider, plain-colored "room".
    const frame = path.join(dir, 'frame.png');
    await runFfmpeg(ff, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x9c8f7a:s=1280x720', '-i', FIXTURE,
      '-filter_complex', '[1:v]scale=720:720[p];[0:v][p]overlay=x=360:y=0', '-frames:v', '1', frame,
    ]);
    const still = await pool.run({
      kind: 'still', ffBin: ff.bin, src: frame, at: null, srcW: 1280, srcH: 720,
      outPng: path.join(dir, 'cut.png'), outJpg: path.join(dir, 'frame.jpg'), height: 360, keyer: 'ai',
    });
    assert.deepEqual([still.width, still.height], [640, 360]);
    assert.ok(still.person, 'person found');
    assert.ok(Math.abs(still.person.cx - 0.5) < 0.12, `centered (${still.person.cx})`);
    // The plain room left and right of the photo (x < 0.28 and x > 0.84) is gone,
    // and so is most of the photo's own background.
    assert.ok(still.person.left >= 0.27 && still.person.right <= 0.85, `box ${still.person.left}–${still.person.right}`);
    assert.ok(still.person.area > 0.15 && still.person.area < 0.45, `area ${still.person.area}`);
    assert.ok((await fsp.stat(path.join(dir, 'cut.png'))).size > 1000);

    // A two-second clip: one matte frame per picture frame.
    const clip = path.join(dir, 'clip.mkv');
    await runFfmpeg(ff, ['-hide_banner', '-y', '-loop', '1', '-framerate', '30', '-t', '2', '-i', frame, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const matte = path.join(dir, 'matte.mkv');
    const seg = await pool.run({
      kind: 'segment', ffBin: ff.bin, src: clip, at: '0.500', span: '2.000', maxFrames: 30,
      srcW: 1280, srcH: 720, outFile: matte, encoder: ff.libx264 ? 'libx264' : 'ffv1',
    });
    assert.equal(seg.frames, 30);
    assert.ok(seg.person && Math.abs(seg.person.cx - 0.5) < 0.12);
    const probe = await probeMedia(ff, matte);
    assert.deepEqual(probe.video, { width: 512, height: 288 });
    assert.ok(Math.abs(probe.duration - 1) < 0.1, `duration ${probe.duration}`);
  } finally {
    await pool.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
