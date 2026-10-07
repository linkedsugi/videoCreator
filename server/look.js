// What the look editor needs from the server: the presenter cut out of their
// newest picture (a recording, or the camera snapshot taken in the studio),
// and how full each slide is for automatic placement.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { MattingPool, MATTE_VERSION, mattingAvailable } from './matting/index.js';
import { analyzeSlides } from './build/scene.js';
import { probeMedia } from './build/ffmpeg.js';

const RECORDING_AT = 4;

export class LookService {
  constructor({ store, ffmpeg }) {
    this.store = store;
    this.ff = ffmpeg;
    this.pool = null;
    this.running = new Map();
  }

  async info(pid) {
    const project = await this.store.getProject(pid);
    const count = project.slides?.count ?? 0;
    let densities = [];
    if (this.ff && count) {
      densities = await analyzeSlides(this.ff, path.join(this.store.projectDir(pid), 'slides'), {
        count,
        version: project.slides?.version ?? 0,
      }).catch(() => []);
    }
    return { assets: await this.store.assetUrls(pid), densities, matting: await mattingAvailable() };
  }

  /** The newest picture of the presenter, or null. */
  async #source(pid) {
    const found = [];
    const sample = this.store.assetPath(pid, 'sample');
    const st = await fsp.stat(sample).catch(() => null);
    if (st) found.push({ kind: 'snapshot', src: sample, at: null, mtime: st.mtimeMs });
    const ids = await this.store.listSessionIds(pid);
    for (const sid of ids.reverse()) {
      const cam = path.join(this.store.sessionDir(pid, sid), 'camera.webm');
      const cst = await fsp.stat(cam).catch(() => null);
      // Long enough to hold a frame a few seconds in.
      if (!cst || cst.size < 1_500_000) continue;
      found.push({ kind: 'recording', src: cam, at: RECORDING_AT, mtime: cst.mtimeMs });
      break;
    }
    return found.sort((a, b) => b.mtime - a.mtime)[0] ?? null;
  }

  /**
   * The presenter cut out of their newest picture, for the preview:
   * `{url, frameUrl, width, height, person, source}` or null.
   */
  async cutout(pid) {
    if (this.running.has(pid)) return this.running.get(pid);
    const run = this.#cutout(pid).finally(() => this.running.delete(pid));
    this.running.set(pid, run);
    return run;
  }

  async #cutout(pid) {
    if (!this.ff) return null;
    const project = await this.store.getProject(pid);
    const keyer = project.settings.look.keyer;
    if (keyer === 'ai' && !(await mattingAvailable())) return null;
    const source = await this.#source(pid);
    if (!source) return null;
    const dir = path.join(this.store.projectDir(pid), 'assets');
    const outPng = path.join(dir, 'cutout.png');
    const outJpg = path.join(dir, 'cutout-frame.jpg');
    const metaFile = path.join(dir, 'cutout.json');
    const key = JSON.stringify({ v: MATTE_VERSION, src: path.basename(path.dirname(source.src)) + path.basename(source.src), mtime: source.mtime, keyer });
    try {
      const cached = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      if (cached.key === key) {
        await fsp.access(outPng);
        return cached.result;
      }
    } catch {
      // make it
    }
    await fsp.mkdir(dir, { recursive: true });
    const probe = await probeMedia(this.ff, source.src);
    if (!probe.video) return null;
    this.pool ??= new MattingPool({ size: 1 });
    const r = await this.pool.run({
      kind: 'still',
      ffBin: this.ff.bin,
      src: source.src,
      at: source.at != null ? source.at.toFixed(3) : null,
      srcW: probe.video.width,
      srcH: probe.video.height,
      outPng,
      outJpg,
      height: 540,
      keyer,
    });
    const v = Date.now();
    const result = {
      url: `/data/${pid}/assets/cutout.png?v=${v}`,
      frameUrl: `/data/${pid}/assets/cutout-frame.jpg?v=${v}`,
      width: r.width,
      height: r.height,
      person: r.person,
      source: source.kind,
    };
    await fsp.writeFile(metaFile, JSON.stringify({ key, result }));
    return result;
  }

  async close() {
    await this.pool?.close();
  }
}
