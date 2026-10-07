// The look of the finished video: where the presenter stands in each scene,
// what is behind them in face scenes, and the name caption. Pure functions,
// shared by the export (server) and the look editor's preview (browser) so
// that what you see in the preview is what the export draws.

export const OUT_W = 1920;
export const OUT_H = 1080;

const STYLES = ['cutout', 'pip'];
const KEYERS = ['ai', 'green'];
const PLACEMENTS = ['auto', 'right', 'left'];
export const SIDES = ['right', 'left', 'shrink'];
const FACE_BGS = ['original', 'blur', 'image'];
const CAPTION_SHOWS = ['first', 'all', 'off'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const CAPTION_COLORS = ['#c8102e', '#1f3a93', '#0f766e', '#111827', '#b45309'];

/** Presenter size (camera picture height ÷ video height) for demo scenes. */
const DEMO_SIZE = 0.5;
const EDGE = 24;
const PIP_WIDTHS = { s: 360, m: 440, l: 540 };
const PIP_MARGIN = 36;
export const PIP_RADIUS = 20;

/** The rounded face window of the 'pip' style, from the project settings. */
export function pipBox(settings = {}) {
  const w = PIP_WIDTHS[settings.pipSize] ?? PIP_WIDTHS.m;
  const h = Math.round((w * 3) / 4 / 2) * 2;
  const corner = settings.pipCorner ?? 'br';
  const x = corner.endsWith('l') ? PIP_MARGIN : OUT_W - w - PIP_MARGIN;
  const y = corner.startsWith('t') ? PIP_MARGIN : OUT_H - h - PIP_MARGIN;
  return { w, h, x, y };
}

export function defaultLook() {
  return {
    style: 'cutout',
    keyer: 'ai',
    placement: 'auto',
    size: 0.8,
    x: 0.8,
    faceBg: 'original',
    caption: { name: '', org: '', color: CAPTION_COLORS[0], show: 'first' },
  };
}

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : '');

export function cleanLook(raw = {}) {
  const d = defaultLook();
  const c = raw.caption && typeof raw.caption === 'object' ? raw.caption : {};
  return {
    style: pick(raw.style, STYLES, d.style),
    keyer: pick(raw.keyer, KEYERS, d.keyer),
    placement: pick(raw.placement, PLACEMENTS, d.placement),
    size: Math.round(clamp(raw.size, 0.5, 1.3, d.size) * 1000) / 1000,
    x: Math.round(clamp(raw.x, 0.5, 0.98, d.x) * 1000) / 1000,
    faceBg: pick(raw.faceBg, FACE_BGS, d.faceBg),
    caption: {
      name: str(c.name, 60),
      org: str(c.org, 80),
      color: COLOR_RE.test(c.color) ? c.color.toLowerCase() : d.caption.color,
      show: pick(c.show, CAPTION_SHOWS, d.caption.show),
    },
  };
}

/** Where the presenter sits in the camera picture when we don't know yet. */
export const DEFAULT_PERSON = { cx: 0.5, top: 0.15, bottom: 1, left: 0.27, right: 0.73 };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Rectangle to draw the camera picture in, so that the presenter's middle is
 * at `x` (share of the video width), the picture is `size` × video height
 * tall and stands on the bottom edge. Nudged so the presenter stays in frame.
 */
export function placeCamera({ aspect, person = DEFAULT_PERSON, size, x }) {
  const h = even(size * OUT_H);
  const w = even(h * aspect);
  let left = Math.round(x * OUT_W - person.cx * w);
  const right = left + person.right * w;
  if (right > OUT_W - EDGE) left -= Math.round(right - (OUT_W - EDGE));
  const leftEdge = left + person.left * w;
  if (leftEdge < EDGE) left += Math.round(EDGE - leftEdge);
  return { x: left, y: OUT_H - h, w, h };
}

/**
 * Which side the presenter takes on a slide when placement is automatic: the
 * side with less on it, or a smaller slide beside the presenter when both
 * sides are full. `d` is the share of busy pixels in each side's area.
 */
export function autoSide(d) {
  if (!d) return 'right';
  if (d.right <= 0.05) return 'right';
  if (d.left <= 0.05) return 'left';
  if (d.left > 0.1 && d.right > 0.1) return 'shrink';
  return d.left < d.right ? 'left' : 'right';
}

/** The side for one scene: the scene's own choice, else the project's, else automatic. */
export function sideFor(cue, look, density) {
  if (SIDES.includes(cue.side)) return cue.side;
  if (look.placement === 'left' || look.placement === 'right') return look.placement;
  return cue.type === 'slide' ? autoSide(density) : 'right';
}

/** The slide or demo picture's box when it is made smaller to sit beside the presenter. */
export function shrunkBox() {
  const w = 1240;
  const h = 698;
  return { x: 56, y: Math.round((OUT_H - h) / 2), w, h };
}

/** Presenter next to a shrunk slide: as big as the look says, but no wider than the space left. */
function besideShrunk({ aspect, person = DEFAULT_PERSON, size }) {
  const box = shrunkBox();
  const from = box.x + box.w + 24;
  const room = OUT_W - EDGE - from;
  const personShare = Math.max(0.2, person.right - person.left);
  const fit = room / (personShare * aspect * OUT_H);
  return placeCamera({ aspect, person, size: Math.min(size, fit), x: (from + OUT_W - EDGE) / 2 / OUT_W });
}

/**
 * The whole composition of one scene.
 *
 * kind: 'slide' | 'screen' | 'face'. Returns
 *   content:  box for the slide/demo picture (null for face scenes)
 *   backdrop: 'none' | 'content-blur' | 'camera-blur' | 'image'
 *   camera:   box for the camera picture, or null
 *   cut:      whether the camera picture is cut out (background removed)
 *   rounded:  the 'pip' style's rounded face window (camera picture cropped to the box)
 */
export function sceneLayout({ kind, side = 'right', showFace = true, look, settings, aspect, person = DEFAULT_PERSON }) {
  const full = { x: 0, y: 0, w: OUT_W, h: OUT_H };
  if (kind === 'face') {
    const cover = coverBox(aspect);
    if (look.style === 'pip') return { content: null, backdrop: 'none', camera: cover, cut: false };
    if (look.faceBg === 'image') {
      return { content: null, backdrop: 'image', camera: placeCamera({ aspect, person, size: 1, x: 0.5 }), cut: true };
    }
    return { content: null, backdrop: look.faceBg === 'blur' ? 'camera-blur' : 'none', camera: cover, cut: look.faceBg === 'blur' };
  }
  if (!showFace) return { content: full, backdrop: 'none', camera: null, cut: false };
  if (look.style === 'pip') return { content: full, backdrop: 'none', camera: pipBox(settings), cut: false, rounded: true };
  const right = side !== 'left';
  if (side === 'shrink') {
    return { content: shrunkBox(), backdrop: 'content-blur', camera: besideShrunk({ aspect, person, size: look.size }), cut: true };
  }
  const size = kind === 'screen' ? DEMO_SIZE : look.size;
  const x = kind === 'screen' ? 0.9 : look.x;
  return {
    content: full,
    backdrop: 'none',
    camera: placeCamera({ aspect, person, size, x: right ? x : 1 - x }),
    cut: true,
  };
}

/** Camera picture scaled to fill the whole video (cropping the excess). */
export function coverBox(aspect) {
  if (aspect >= OUT_W / OUT_H) {
    const w = even(OUT_H * aspect);
    return { x: Math.round((OUT_W - w) / 2), y: 0, w, h: OUT_H };
  }
  const h = even(OUT_W / aspect);
  return { x: 0, y: Math.round((OUT_H - h) / 2), w: OUT_W, h };
}

/** When the name caption shows in a face scene (seconds), or null. */
export function captionWindow(look, { firstFace }, durationSec) {
  const c = look.caption;
  if (c.show === 'off' || !c.name.trim()) return null;
  if (c.show === 'first' && !firstFace) return null;
  const start = 0.5;
  const end = Math.min(durationSec - 0.3, 9);
  return end - start >= 1.5 ? { start, end, fade: 0.4 } : null;
}

/**
 * Draws the name caption on a 1920×1080 canvas context (transparent
 * elsewhere). Browser only; the PNG is sent to the server for the export.
 */
export function drawCaption(ctx, caption) {
  ctx.clearRect(0, 0, OUT_W, OUT_H);
  const name = caption.name.trim();
  if (!name) return;
  const org = caption.org.trim();
  const font = '"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';
  const left = 96;
  const bottom = OUT_H - 104;
  const padX = 34;
  ctx.textBaseline = 'middle';
  ctx.font = `700 52px ${font}`;
  const nameW = ctx.measureText(name).width;
  ctx.font = `500 30px ${font}`;
  const orgW = org ? ctx.measureText(org).width : 0;
  const nameH = 88;
  const orgH = org ? 54 : 0;
  const top = bottom - nameH - orgH;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = caption.color;
  ctx.fillRect(left, top, nameW + padX * 2, nameH);
  if (org) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(left, top + nameH, Math.max(orgW + padX * 2, 120), orgH);
  }
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 52px ${font}`;
  ctx.fillText(name, left + padX, top + nameH / 2 + 2);
  if (org) {
    ctx.fillStyle = '#1f2328';
    ctx.font = `500 30px ${font}`;
    ctx.fillText(org, left + padX, top + nameH + orgH / 2 + 1);
  }
}
