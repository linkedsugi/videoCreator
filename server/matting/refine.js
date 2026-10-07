// Image math for turning the segmentation model's coarse person mask into a
// clean alpha matte. Pure functions on typed arrays, no I/O.
//
// Sizes: the camera picture is processed at a small "work" size (288 lines
// high). The model sees a 256×256 squeeze of it; its answer is put on a grid of
// a quarter of the work size, steadied over time there, and its edges are then pulled
// onto the real edges of the picture with a fast color guided filter (He & Sun,
// "Fast Guided Filter", 2015), giving an alpha at the full work size.

export const MODEL_SIZE = 256;
export const WORK_HEIGHT = 288;

/** Work size for a camera picture, keeping its shape (even numbers). */
export function workSize(width, height) {
  const h = WORK_HEIGHT;
  const w = Math.max(2, Math.round((h * (width || 16)) / (height || 9) / 2) * 2);
  return { w, h };
}

/** Precomputed bilinear sampling from one plane size to another. */
export class Resizer {
  constructor(sw, sh, dw, dh) {
    Object.assign(this, { sw, sh, dw, dh });
    const axis = (s, d) => {
      const i0 = new Int32Array(d);
      const i1 = new Int32Array(d);
      const w = new Float32Array(d);
      const scale = s / d;
      for (let k = 0; k < d; k++) {
        const f = Math.max(0, (k + 0.5) * scale - 0.5);
        const a = Math.min(s - 1, Math.floor(f));
        i0[k] = a;
        i1[k] = Math.min(s - 1, a + 1);
        w[k] = f - a;
      }
      return { i0, i1, w };
    };
    this.x = axis(sw, dw);
    this.y = axis(sh, dh);
  }

  /** Resizes one plane (any typed array) into a Float32Array. */
  plane(src, out = new Float32Array(this.dw * this.dh)) {
    const { sw, dw, dh, x, y } = this;
    for (let j = 0; j < dh; j++) {
      const r0 = y.i0[j] * sw;
      const r1 = y.i1[j] * sw;
      const wy = y.w[j];
      const o = j * dw;
      for (let i = 0; i < dw; i++) {
        const x0 = x.i0[i];
        const x1 = x.i1[i];
        const wx = x.w[i];
        const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * wx;
        const bottom = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * wx;
        out[o + i] = top + (bottom - top) * wy;
      }
    }
    return out;
  }

  /** Resizes interleaved 8-bit RGB into an interleaved float RGB tensor (0–1). */
  rgbToTensor(src, out = new Float32Array(this.dw * this.dh * 3)) {
    const { sw, dw, dh, x, y } = this;
    for (let j = 0; j < dh; j++) {
      const r0 = y.i0[j] * sw;
      const r1 = y.i1[j] * sw;
      const wy = y.w[j];
      for (let i = 0; i < dw; i++) {
        const a = (r0 + x.i0[i]) * 3;
        const b = (r0 + x.i1[i]) * 3;
        const c = (r1 + x.i0[i]) * 3;
        const d = (r1 + x.i1[i]) * 3;
        const wx = x.w[i];
        const o = (j * dw + i) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const top = src[a + ch] + (src[b + ch] - src[a + ch]) * wx;
          const bottom = src[c + ch] + (src[d + ch] - src[c + ch]) * wx;
          out[o + ch] = (top + (bottom - top) * wy) / 255;
        }
      }
    }
    return out;
  }
}

/** 1 / (number of pixels in each clipped window), for `boxMean`. */
export function boxNorm(w, h, r) {
  const inv = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < w; x++) {
      const cx = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
      inv[y * w + x] = 1 / (cx * cy);
    }
  }
  return inv;
}

/**
 * Mean over a (2r+1)² window, shrinking at the borders. `inv` comes from
 * `boxNorm`; `tmp` (w·h) and `col` (Float64Array of w) are scratch space.
 */
export function boxMean(src, w, h, r, out, { inv, tmp, col }) {
  const xEnd = Math.min(r, w - 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= xEnd; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) sum += src[row + add];
      if (sub >= 0) sum -= src[row + sub];
    }
  }
  col.fill(0);
  for (let y = 0; y <= Math.min(r, h - 1); y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) col[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = col[x] * inv[row + x];
    const add = y + r + 1;
    const sub = y - r;
    if (add < h) {
      const ar = add * w;
      for (let x = 0; x < w; x++) col[x] += tmp[ar + x];
    }
    if (sub >= 0) {
      const sr = sub * w;
      for (let x = 0; x < w; x++) col[x] -= tmp[sr + x];
    }
  }
  return out;
}

/**
 * Turns frames of the camera picture plus the model's answers into alpha
 * mattes. Keeps state between frames to steady the edges, so use one per
 * continuous shot.
 */
export class Matte {
  /**
   * @param {number} w work width
   * @param {number} h work height
   * @param {{radius?: number, eps?: number, low?: number, high?: number}} [opts]
   */
  constructor(w, h, { sub = 4, radius = 2, eps = 1e-3, low = 0.3, high = 0.72 } = {}) {
    this.w = w;
    this.h = h;
    this.sub = sub;
    this.lw = Math.floor(w / sub);
    this.lh = Math.floor(h / sub);
    Object.assign(this, { radius, eps, low, high });
    const n = this.lw * this.lh;
    const f = () => new Float32Array(n);
    this.lowR = f();
    this.lowG = f();
    this.lowB = f();
    this.gray = f();
    this.prevGray = null;
    this.p = f();
    this.prevP = null;
    this.raw = f();
    this.scratch = { inv: boxNorm(this.lw, this.lh, radius), tmp: f(), col: new Float64Array(this.lw) };
    this.buf = Array.from({ length: 17 }, f);
    this.fromModel = new Resizer(MODEL_SIZE, MODEL_SIZE, this.lw, this.lh);
    this.up = new Resizer(this.lw, this.lh, w, h);
    this.toModel = new Resizer(w, h, MODEL_SIZE, MODEL_SIZE);
    this.modelInput = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3);
  }

  /** The model input for a work-size RGB frame. */
  modelTensor(rgb) {
    return this.toModel.rgbToTensor(rgb, this.modelInput);
  }

  /** Small planes of the frame (block averages), used as the filter guide. */
  #downsample(rgb) {
    const { w, sub, lw, lh, lowR, lowG, lowB, gray } = this;
    const norm = 1 / (sub * sub * 255);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < sub; dy++) {
          let i = ((y * sub + dy) * w + x * sub) * 3;
          for (let dx = 0; dx < sub; dx++, i += 3) {
            r += rgb[i];
            g += rgb[i + 1];
            b += rgb[i + 2];
          }
        }
        const k = y * lw + x;
        lowR[k] = r * norm;
        lowG[k] = g * norm;
        lowB[k] = b * norm;
        gray[k] = 0.299 * lowR[k] + 0.587 * lowG[k] + 0.114 * lowB[k];
      }
    }
  }

  /**
   * @param {Uint8Array} rgb work-size interleaved RGB frame
   * @param {Float32Array} modelOut model answer (256×256, 0–1)
   * @param {Uint8Array} [out] work-size alpha (0–255)
   */
  process(rgb, modelOut, out = new Uint8Array(this.w * this.h)) {
    const { lw, lh, radius: r, eps } = this;
    const n = lw * lh;
    this.#downsample(rgb);
    this.fromModel.plane(modelOut, this.raw);

    // Steady the mask over time where the picture holds still; follow it
    // right away where something moves.
    const { p, raw, gray } = this;
    if (this.prevP) {
      const prevP = this.prevP;
      const prevGray = this.prevGray;
      for (let k = 0; k < n; k++) {
        const motion = Math.abs(gray[k] - prevGray[k]);
        const keep = Math.max(0, 0.55 - motion * 8);
        p[k] = raw[k] * (1 - keep) + prevP[k] * keep;
      }
    } else {
      p.set(raw);
      this.prevP = new Float32Array(n);
      this.prevGray = new Float32Array(n);
    }
    this.prevP.set(p);
    this.prevGray.set(gray);

    // Fast color guided filter on the half-size grid.
    const [mR, mG, mB, mP, pR, pG, pB, rr, rg, rb, gg, gb, bb, aR, aG, aB, bq] = this.buf;
    const { lowR: R, lowG: G, lowB: B, scratch } = this;
    boxMean(R, lw, lh, r, mR, scratch);
    boxMean(G, lw, lh, r, mG, scratch);
    boxMean(B, lw, lh, r, mB, scratch);
    boxMean(p, lw, lh, r, mP, scratch);
    for (let k = 0; k < n; k++) {
      aR[k] = R[k] * p[k];
      aG[k] = G[k] * p[k];
      aB[k] = B[k] * p[k];
    }
    boxMean(aR, lw, lh, r, pR, scratch);
    boxMean(aG, lw, lh, r, pG, scratch);
    boxMean(aB, lw, lh, r, pB, scratch);
    const products = [[R, R, rr], [R, G, rg], [R, B, rb], [G, G, gg], [G, B, gb], [B, B, bb]];
    for (const [x, y, dst] of products) {
      for (let k = 0; k < n; k++) bq[k] = x[k] * y[k];
      boxMean(bq, lw, lh, r, dst, scratch);
    }
    for (let k = 0; k < n; k++) {
      const mr = mR[k];
      const mg = mG[k];
      const mb = mB[k];
      const mp = mP[k];
      const cr = pR[k] - mr * mp;
      const cg = pG[k] - mg * mp;
      const cb = pB[k] - mb * mp;
      const vrr = rr[k] - mr * mr + eps;
      const vrg = rg[k] - mr * mg;
      const vrb = rb[k] - mr * mb;
      const vgg = gg[k] - mg * mg + eps;
      const vgb = gb[k] - mg * mb;
      const vbb = bb[k] - mb * mb + eps;
      const iRR = vgg * vbb - vgb * vgb;
      const iRG = vgb * vrb - vrg * vbb;
      const iRB = vrg * vgb - vgg * vrb;
      const iGG = vrr * vbb - vrb * vrb;
      const iGB = vrb * vrg - vrr * vgb;
      const iBB = vrr * vgg - vrg * vrg;
      const det = vrr * iRR + vrg * iRG + vrb * iRB;
      const ar = (iRR * cr + iRG * cg + iRB * cb) / det;
      const ag = (iRG * cr + iGG * cg + iGB * cb) / det;
      const ab = (iRB * cr + iGB * cg + iBB * cb) / det;
      aR[k] = ar;
      aG[k] = ag;
      aB[k] = ab;
      bq[k] = mp - ar * mr - ag * mg - ab * mb;
    }
    // Reuse the first planes for the averaged coefficients.
    boxMean(aR, lw, lh, r, mR, scratch);
    boxMean(aG, lw, lh, r, mG, scratch);
    boxMean(aB, lw, lh, r, mB, scratch);
    boxMean(bq, lw, lh, r, mP, scratch);

    // Apply them to the full work-size picture (bilinear upsampling of the
    // coefficients, fused with the final sum).
    const lo = this.low;
    const scale = 1 / (this.high - this.low);
    const { w, up } = this;
    const k255 = 1 / 255;
    for (let j = 0; j < this.h; j++) {
      const r0 = up.y.i0[j] * lw;
      const r1 = up.y.i1[j] * lw;
      const wy = up.y.w[j];
      for (let i = 0; i < w; i++) {
        const wx = up.x.w[i];
        const a = r0 + up.x.i0[i];
        const b = r0 + up.x.i1[i];
        const c = r1 + up.x.i0[i];
        const d = r1 + up.x.i1[i];
        const w00 = (1 - wx) * (1 - wy);
        const w01 = wx * (1 - wy);
        const w10 = (1 - wx) * wy;
        const w11 = wx * wy;
        const k = j * w + i;
        const px = k * 3;
        const q = (mR[a] * w00 + mR[b] * w01 + mR[c] * w10 + mR[d] * w11) * rgb[px] * k255
          + (mG[a] * w00 + mG[b] * w01 + mG[c] * w10 + mG[d] * w11) * rgb[px + 1] * k255
          + (mB[a] * w00 + mB[b] * w01 + mB[c] * w10 + mB[d] * w11) * rgb[px + 2] * k255
          + (mP[a] * w00 + mP[b] * w01 + mP[c] * w10 + mP[d] * w11);
        const v = (q - lo) * scale;
        out[k] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
      }
    }
    return out;
  }
}

/** Where the person is in an alpha matte: share of the frame, 0–1. */
export function measure(alpha, w, h) {
  let sum = 0;
  let sx = 0;
  let top = h;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = alpha[row + x];
      if (a < 128) continue;
      sum += 1;
      sx += x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (sum < w * h * 0.01) return null;
  return {
    cx: (sx / sum + 0.5) / w,
    top: top / h,
    bottom: (bottom + 1) / h,
    left: left / w,
    right: (right + 1) / w,
    area: sum / (w * h),
  };
}

/** Median of each field over many measurements (null ones skipped). */
export function summarize(list) {
  const items = list.filter(Boolean);
  if (!items.length) return null;
  const med = (key) => {
    const v = items.map((m) => m[key]).sort((a, b) => a - b);
    return Math.round(v[Math.floor(v.length / 2)] * 1e4) / 1e4;
  };
  return { cx: med('cx'), top: med('top'), bottom: med('bottom'), left: med('left'), right: med('right'), area: med('area'), samples: items.length };
}
