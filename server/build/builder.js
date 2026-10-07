// Assembles the final MP4 from recorded takes.
//
// 1. Read every session's event log and pick the take to use for each cue.
// 2. Normalize the browser recordings that are needed (constant 30 fps,
//    a keyframe every second) so cutting them is fast and exact. Cached.
// 3. Work out each scene's composition (public/js/look.js): where the
//    presenter stands, what is behind them, the name caption. For the
//    cut-out style, cut the presenter out of the camera picture (AI matte per
//    scene, or a green-screen key). Cached.
// 4. Render each segment. Segments get exact frame/sample counts so joining
//    them never drifts. Cached by content, so re-exporting after a re-shoot
//    only renders what changed.
// 5. Join the segments and even out the loudness.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSession, chooseTakes, planSegments } from './timeline.js';
import { runFfmpeg, probeMedia, scanDuration, videoEncoderArgs } from './ffmpeg.js';
import { analyzeSlides, personStats, pngSize } from './scene.js';
import { MattingPool, mattingAvailable, MATTE_VERSION } from '../matting/index.js';
import {
  OUT_W as W, OUT_H as H, PIP_RADIUS, DEFAULT_PERSON, cleanLook, sceneLayout, sideFor, captionWindow,
} from '../../public/js/look.js';

const NORM_VERSION = 2;
const SEG_VERSION = 3;
const FPS = 30;
const RATE = 48000;
const CONTENT_RADIUS = 16;

const sec = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function mtime(p) {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function hash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFileName(title) {
  const cleaned = String(title || '강의').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || '강의';
}

function cueName(cue, index) {
  const base = cue.type === 'slide' ? `슬라이드 ${cue.page}` : cue.title?.trim() || { demo: '데모', video: '영상', face: '얼굴' }[cue.type];
  return `${index + 1}번 장면(${base})`;
}

export function describeWarning(w, cues) {
  if (w.type === 'no-matting') return '배경 지우기 기능을 쓸 수 없어 얼굴을 작은 창으로 넣었습니다. (npm install을 다시 해 보세요)';
  if (w.type === 'no-background') return '얼굴 장면 배경 이미지가 없어 원래 배경을 그대로 썼습니다.';
  const cue = cues[w.index];
  const name = cue ? cueName(cue, w.index) : '알 수 없는 장면';
  switch (w.type) {
    case 'no-take':
      return `${name}: 사용할 테이크가 없어 빠졌습니다.`;
    case 'no-screen':
      return `${name}: 데모 화면 녹화가 없어 얼굴 화면으로 대신했습니다.`;
    case 'no-camera':
      return `${name}: 카메라 녹화를 찾지 못해 빠졌습니다.`;
    case 'missing-slide':
      return `${name}: 슬라이드 이미지가 없어 검은 화면으로 대신했습니다.`;
    case 'missing-file':
      return `${name}: 녹화 파일이 없어 빠졌습니다.`;
    case 'cut-failed':
      return `${name}: 배경을 지우지 못해 얼굴을 작은 창으로 넣었습니다.`;
    case 'no-person':
      return `${name}: 카메라에서 사람을 찾지 못했습니다. 화면에 상반신이 나오는지 확인해 주세요.`;
    default:
      return `${name}: ${w.type}`;
  }
}

/** A white rounded rectangle on black, used to round off a picture's corners. */
async function makeMask(ff, file, w, h, r) {
  if (await exists(file)) return;
  const w2 = w * 2;
  const h2 = h * 2;
  const r2 = r * 2;
  const expr = `if(lte(hypot(max(abs(X-${(w2 - 1) / 2})-${w2 / 2 - r2},0),max(abs(Y-${(h2 - 1) / 2})-${h2 / 2 - r2},0)),${r2}),255,0)`;
  const tmp = `${file}.tmp.png`;
  await runFfmpeg(ff, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w2}x${h2}:d=1`,
    '-vf', `format=gray,geq=lum='${expr}',scale=${w}:${h}:flags=area`,
    '-frames:v', '1', tmp,
  ]);
  await fsp.rename(tmp, file);
}

/** Re-encodes a browser recording into an edit-friendly file. Cached per source file. */
async function normalizeTrack(ff, { src, kind, outFile, expectedSec, onProgress }) {
  const stat = await fsp.stat(src);
  const metaFile = `${outFile}.json`;
  try {
    const meta = await readJson(metaFile);
    if (meta.v === NORM_VERSION && meta.srcSize === stat.size && meta.srcMtime === stat.mtimeMs && (await exists(outFile))) {
      return meta;
    }
  } catch {
    // no cache yet
  }
  const scale = kind === 'camera'
    ? `scale=w=-2:h='min(${H},ih)'`
    : `scale=w='min(${W},iw)':h='min(${H},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const tmp = `${outFile}.tmp.mkv`;
  await runFfmpeg(ff, [
    '-hide_banner', '-y', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${scale},fps=${FPS},format=yuv420p`,
    ...videoEncoderArgs(ff, 'intermediate'),
    // A dropout in a long recording (e.g. a wireless mic hiccup) leaves a gap in the
    // sound; filling it with silence keeps everything after it in sync with the picture.
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'flac', '-ar', String(RATE), '-ac', '2', tmp,
  ], { totalSec: expectedSec, onProgress });
  await fsp.rename(tmp, outFile);
  const probe = await probeMedia(ff, outFile);
  const meta = {
    v: NORM_VERSION,
    srcSize: stat.size,
    srcMtime: stat.mtimeMs,
    duration: probe.duration,
    hasAudio: probe.hasAudio,
    video: probe.video,
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

/** A source of `sw`×`sh` fitted inside `box`, centered. */
function fitBox(box, sw, sh) {
  const scale = Math.min(box.w / sw, box.h / sh);
  const w = even(sw * scale);
  const h = even(sh * scale);
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h };
}

/** Exact frame count and timing of a segment. */
function segmentTiming(seg) {
  const nFrames = Math.max(1, Math.round((seg.duration / 1000) * FPS));
  const exact = nFrames / FPS;
  return { nFrames, exact, samples: Math.round(exact * RATE), span: sec(exact + 1), camAt: Math.max(0, seg.camera.offset / 1000) };
}

function segmentArgs(seg, ctx) {
  const { nFrames, exact, samples, span, camAt } = segmentTiming(seg);
  const inputs = [];
  const filters = [];
  let inputCount = 0;
  const addInput = (args) => {
    inputs.push(...args);
    return inputCount++;
  };
  const loopImage = (file) => addInput(['-loop', '1', '-framerate', String(FPS), '-t', span, '-i', file]);
  // Video and sound of one file are read as two separate inputs: with a
  // single shared reader, FFmpeg can stall when one of the two ends first.
  const videoOf = (file, at) => addInput(['-ss', sec(at), '-t', span, '-an', '-i', file]);
  const audioOf = (file, at) => addInput(['-ss', sec(at), '-t', span, '-vn', '-i', file]);
  const spec = seg.spec;

  const cam = ctx.norm.get(`${seg.sessionId}/${seg.camera.file}`);
  let camLabel = spec.camera ? `${videoOf(cam.path, camAt)}:v` : null;

  // The slide or demo picture. Each use reads it again rather than splitting
  // one stream: simpler filter graphs keep FFmpeg from stalling.
  let screen = null;
  let screenAt = 0;
  let screenShift = 0;
  if (seg.layout === 'screen') {
    screen = ctx.norm.get(`${seg.sessionId}/${seg.screen.file}`);
    const off = seg.screen.offset / 1000;
    screenAt = Math.max(0, off);
    screenShift = off < 0 ? -off : 0;
  }
  let contentCount = 0;
  const content = () => {
    const label = `ct${contentCount++}`;
    if (seg.layout === 'slide') {
      const idx = seg.slidePath ? loopImage(seg.slidePath) : addInput(['-f', 'lavfi', '-t', span, '-i', `color=c=black:s=${W}x${H}:r=${FPS}`]);
      filters.push(`[${idx}:v]setsar=1,format=yuv420p[${label}]`);
    } else {
      let chain = `[${videoOf(screen.path, screenAt)}:v]setsar=1,format=yuv420p`;
      if (screenShift > 0) chain += `,tpad=start_mode=add:start_duration=${sec(screenShift)}:color=black`;
      filters.push(`${chain}[${label}]`);
    }
    return label;
  };

  // 1. What fills the frame.
  let base;
  if (spec.content && spec.backdrop === 'content-blur') {
    filters.push(`[${content()}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=480:270:flags=area,boxblur=10:2,scale=${W}:${H},eq=brightness=-0.06:saturation=0.85,setsar=1,format=yuv420p[bd]`);
    const fit = fitBox(spec.content, seg.contentSize.width, seg.contentSize.height);
    const maskIdx = loopImage(ctx.roundMask(fit.w, fit.h));
    filters.push(`[${content()}]scale=${fit.w}:${fit.h}:flags=bicubic,setsar=1,format=yuva420p[ctS]`);
    filters.push(`[${maskIdx}:v]format=gray[ctM]`);
    filters.push('[ctS][ctM]alphamerge[ctR]');
    filters.push(`[bd][ctR]overlay=x=${fit.x}:y=${fit.y}:format=auto[base]`);
    base = 'base';
  } else if (spec.content) {
    filters.push(`[${content()}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[base]`);
    base = 'base';
  } else if (spec.backdrop === 'image') {
    filters.push(`[${loopImage(ctx.backgroundPath)}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[base]`);
    base = 'base';
  } else if (spec.backdrop === 'camera-blur') {
    const c = spec.camera;
    filters.push(`[${videoOf(cam.path, camAt)}:v]scale=480:-2:flags=area,boxblur=8:2,scale=${c.w}:${c.h},crop=${W}:${H}:${-c.x}:${-c.y},setsar=1,format=yuv420p[base]`);
    base = 'base';
  } else {
    // Face scene with its own background: the camera picture is the frame.
    filters.push(`[${camLabel}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[base]`);
    camLabel = null;
    base = 'base';
  }

  // 2. The presenter.
  if (camLabel && spec.cut) {
    const c = spec.camera;
    if (ctx.keyer === 'green') {
      const k = seg.key;
      filters.push(`[${camLabel}]scale=${c.w}:${c.h}:flags=bicubic,setsar=1,chromakey=color=${k.color}:similarity=${k.similarity}:blend=${k.blend},format=rgba,despill=type=green:mix=0.5:expand=0[pp]`);
    } else {
      const maskIdx = addInput(['-an', '-i', seg.matte]);
      filters.push(`[${camLabel}]setpts=PTS-STARTPTS,scale=${c.w}:${c.h}:flags=bicubic,setsar=1,format=yuva420p[pc]`);
      filters.push(`[${maskIdx}:v]setpts=PTS-STARTPTS,scale=${c.w}:${c.h}:flags=bicubic,format=gray[pm]`);
      filters.push('[pc][pm]alphamerge[pp]');
    }
    filters.push(`[${base}][pp]overlay=x=${c.x}:y=${c.y}:eof_action=pass:format=auto[vp]`);
    base = 'vp';
  } else if (camLabel) {
    // The 'pip' style's rounded face window.
    const { w, h, x, y } = spec.camera;
    const maskIdx = loopImage(ctx.roundMask(w, h, PIP_RADIUS));
    filters.push(`[${camLabel}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuva420p[f0]`);
    filters.push(`[${maskIdx}:v]format=gray[m]`);
    filters.push('[f0][m]alphamerge[face]');
    filters.push(`[${base}][face]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[vp]`);
    base = 'vp';
  }

  // 3. Name caption.
  if (seg.caption) {
    const { start, end, fade } = seg.caption;
    const capIdx = loopImage(ctx.captionPath);
    filters.push(`[${capIdx}:v]format=rgba,fade=t=in:st=${sec(start)}:d=${fade}:alpha=1,fade=t=out:st=${sec(end - fade)}:d=${fade}:alpha=1[cap]`);
    filters.push(`[${base}][cap]overlay=x=0:y=0:format=auto[vc]`);
    base = 'vc';
  }
  filters.push(`[${base}]fps=${FPS},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${nFrames},setpts=PTS-STARTPTS,format=yuv420p[v]`);

  const audio = [];
  if (cam.hasAudio) {
    const camAudio = audioOf(cam.path, camAt);
    filters.push(`[${camAudio}:a]aformat=sample_rates=${RATE}:channel_layouts=stereo[a0]`);
    audio.push('a0');
  }
  if (screen?.hasAudio) {
    const screenAudio = audioOf(screen.path, screenAt);
    let chain = `[${screenAudio}:a]aformat=sample_rates=${RATE}:channel_layouts=stereo`;
    if (screenShift > 0) chain += `,adelay=${Math.round(screenShift * 1000)}:all=1`;
    filters.push(`${chain}[a1]`);
    audio.push('a1');
  }
  if (!audio.length) {
    const silentIdx = addInput(['-f', 'lavfi', '-t', span, '-i', `anullsrc=r=${RATE}:cl=stereo`]);
    filters.push(`[${silentIdx}:a]anull[am]`);
  } else if (audio.length === 1) {
    filters.push(`[${audio[0]}]anull[am]`);
  } else {
    filters.push(`[${audio[0]}][${audio[1]}]amix=inputs=2:duration=longest:normalize=0[am]`);
  }
  filters.push(`[am]apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a]`);

  return {
    exact,
    args: [
      '-hide_banner', '-y', ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[v]', '-map', '[a]',
      ...videoEncoderArgs(ctx.ff, 'final'), '-r', String(FPS),
      '-c:a', 'pcm_s16le', '-ar', String(RATE), '-ac', '2',
    ],
  };
}

/** Moments (seconds into a camera recording) to look at the presenter. */
function sampleTimes(segs) {
  return segs.slice(0, 3).map((seg) => {
    const { camAt, exact } = segmentTiming(seg);
    return camAt + Math.min(exact / 2, 4);
  });
}

/**
 * @param {{store: import('../store.js').Store, pid: string, ffmpeg: object,
 *   onProgress?: (p: {step: string, progress?: number}) => void,
 *   matting?: MattingPool}} opts
 */
export async function buildProject({ store, pid, ffmpeg: ff, onProgress = () => {}, matting }) {
  const report = (step, progress) => onProgress({ step, progress });
  const project = await store.getProject(pid);
  const settings = project.settings ?? {};
  const pdir = store.projectDir(pid);
  const bdir = path.join(pdir, 'build');
  const normDir = path.join(bdir, 'norm');
  const segDir = path.join(bdir, 'seg');
  const matteDir = path.join(bdir, 'matte');
  const exportDir = path.join(pdir, 'exports');
  await Promise.all([normDir, segDir, matteDir, exportDir].map((d) => fsp.mkdir(d, { recursive: true })));

  // 1. Takes
  report('녹화 기록 읽는 중', 0.01);
  const sessions = [];
  for (const raw of await store.loadSessions(pid)) {
    let parsed = parseSession(raw);
    if (!parsed.ended) {
      // The browser stopped without saying goodbye: find where the recording
      // really ends so the take in progress can still be used.
      const cam = parsed.tracks.find((t) => t.kind === 'camera');
      const file = cam && path.join(raw.dir, cam.file);
      if (file && (await exists(file))) {
        const dur = await scanDuration(ff, file).catch(() => null);
        if (dur) parsed = parseSession(raw, { endHint: cam.start + dur * 1000 });
      }
    }
    parsed.dir = raw.dir;
    sessions.push(parsed);
  }
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const { chosen } = chooseTakes(sessions, new Set(project.excludedTakes ?? []));
  const plan = planSegments({ cues: project.cues, sessionsById, chosen });
  const warnings = [...plan.warnings];

  // Drop segments whose recording file is gone.
  const segments = [];
  for (const seg of plan.segments) {
    const dir = sessionsById.get(seg.sessionId).dir;
    const files = [seg.camera.file, seg.screen?.file].filter(Boolean);
    let ok = true;
    for (const f of files) if (!(await exists(path.join(dir, f)))) ok = false;
    if (ok) segments.push(seg);
    else warnings.push({ type: 'missing-file', cueId: seg.cueId, index: seg.cueIndex });
  }
  if (!segments.length) {
    throw new Error('영상으로 만들 테이크가 없습니다. 먼저 촬영해 주세요.');
  }

  // The look, and whether it can be drawn here.
  let look = cleanLook(settings.look);
  if (look.style === 'cutout' && look.keyer === 'ai' && !(await mattingAvailable())) {
    look = { ...look, style: 'pip' };
    warnings.push({ type: 'no-matting' });
  }
  const backgroundPath = path.join(pdir, 'assets', 'background.jpg');
  const captionPath = path.join(pdir, 'assets', 'caption.png');
  if (look.style === 'cutout' && look.faceBg === 'image' && !(await exists(backgroundPath))) {
    look = { ...look, faceBg: 'original' };
    if (segments.some((s) => s.layout === 'face')) warnings.push({ type: 'no-background' });
  }
  const hasCaption = await exists(captionPath);
  const cutting = look.style === 'cutout';
  const weights = cutting && look.keyer === 'ai' ? { norm: 0.38, matte: 0.22 } : { norm: 0.5, matte: 0.02 };

  // 2. Normalize recordings
  const needed = new Map();
  for (const seg of segments) {
    const s = sessionsById.get(seg.sessionId);
    for (const ref of [seg.camera, seg.screen]) {
      if (!ref) continue;
      const key = `${seg.sessionId}/${ref.file}`;
      if (needed.has(key)) continue;
      const track = s.tracks.find((t) => t.file === ref.file);
      needed.set(key, {
        src: path.join(s.dir, ref.file),
        kind: track?.kind ?? 'camera',
        outFile: path.join(normDir, `${seg.sessionId}__${ref.file.replace(/\.webm$/, '')}.mkv`),
        expectedSec: track && track.end != null ? (track.end - track.start) / 1000 : 0,
      });
    }
  }
  const norm = new Map();
  let n = 0;
  for (const [key, item] of needed) {
    const base = 0.03 + (weights.norm * n) / needed.size;
    const label = `녹화 파일 준비 중 (${n + 1}/${needed.size})`;
    report(label, base);
    const meta = await normalizeTrack(ff, {
      ...item,
      onProgress: (p) => report(label, base + (weights.norm * p) / needed.size),
    });
    norm.set(key, { ...meta, path: item.outFile });
    n += 1;
  }

  // 3. Composition of each scene
  const afterNorm = 0.03 + weights.norm;
  report('장면 구성 정하는 중', afterNorm);
  const slidesDir = path.join(pdir, 'slides');
  const slideCount = project.slides?.count ?? 0;
  let densities = [];
  if (cutting && look.placement === 'auto' && slideCount && segments.some((s) => s.layout === 'slide')) {
    densities = await analyzeSlides(ff, slidesDir, { count: slideCount, version: project.slides?.version ?? 0 }).catch((err) => {
      console.warn('[build] slide analysis failed:', err.message);
      return [];
    });
  }
  let firstFaceSeen = false;
  for (const [i, seg] of segments.entries()) {
    const cue = project.cues[seg.cueIndex];
    const camMeta = norm.get(`${seg.sessionId}/${seg.camera.file}`);
    seg.aspect = camMeta.video ? camMeta.video.width / camMeta.video.height : 16 / 9;
    seg.side = seg.layout === 'face' ? null : sideFor(cue, look, densities[(seg.page ?? 0) - 1]);
    if (seg.layout === 'slide') {
      const slide = store.slidePath(pid, seg.page);
      if (seg.page <= slideCount && (await exists(slide))) {
        seg.slidePath = slide;
        seg.contentSize = await pngSize(slide).catch(() => ({ width: W, height: H }));
      } else {
        seg.slidePath = null;
        seg.contentSize = { width: W, height: H };
        warnings.push({ type: 'missing-slide', cueId: seg.cueId, index: seg.cueIndex });
      }
    } else if (seg.layout === 'screen') {
      const meta = norm.get(`${seg.sessionId}/${seg.screen.file}`);
      seg.contentSize = meta.video ?? { width: W, height: H };
    }
    // The name caption goes on the first part of a face scene (not on a demo
    // shown as a face scene because its screen recording is missing).
    const firstPart = i === 0 || segments[i - 1].cueId !== seg.cueId;
    if (seg.cueType === 'face' && firstPart) {
      if (hasCaption) seg.caption = captionWindow(look, { firstFace: !firstFaceSeen }, segmentTiming(seg).exact);
      firstFaceSeen = true;
    }
    seg.spec = sceneLayout({ kind: seg.layout, side: seg.side, showFace: seg.showFace, look, settings, aspect: seg.aspect });
  }

  // Where the presenter sits in each session's camera picture.
  const pool = cutting ? (matting ?? new MattingPool()) : null;
  const ownPool = pool && !matting;
  try {
    const cutSegs = segments.filter((s) => s.spec.cut);
    const bySession = new Map();
    for (const seg of cutSegs) {
      if (!bySession.has(seg.sessionId)) bySession.set(seg.sessionId, []);
      bySession.get(seg.sessionId).push(seg);
    }
    const people = new Map();
    for (const [sid, segs] of bySession) {
      const camMeta = norm.get(`${sid}/${segs[0].camera.file}`);
      const found = await personStats({
        pool,
        ff,
        src: camMeta.path,
        srcW: camMeta.video?.width ?? 1280,
        srcH: camMeta.video?.height ?? 720,
        times: sampleTimes(segs),
        keyer: look.keyer,
        cacheFile: path.join(matteDir, `${sid}__person.json`),
        stamp: { size: camMeta.srcSize, mtime: camMeta.srcMtime },
      }).catch((err) => {
        console.warn('[build] could not find the presenter:', err.message);
        return { person: null, key: null };
      });
      people.set(sid, found);
      if (!found.person) warnings.push({ type: 'no-person', cueId: segs[0].cueId, index: segs[0].cueIndex });
    }
    for (const seg of cutSegs) {
      const found = people.get(seg.sessionId);
      seg.person = found?.person ?? DEFAULT_PERSON;
      seg.key = found?.key ?? { color: '0x00b140', similarity: 0.1, blend: 0.05 };
      seg.spec = sceneLayout({ kind: seg.layout, side: seg.side, showFace: seg.showFace, look, settings, aspect: seg.aspect, person: seg.person });
    }

    // Cut the presenter out of each scene's stretch of camera footage.
    if (look.keyer === 'ai' && cutSegs.length) {
      const jobs = [];
      for (const seg of cutSegs) {
        const camMeta = norm.get(`${seg.sessionId}/${seg.camera.file}`);
        const { camAt, span, nFrames } = segmentTiming(seg);
        // A couple of spare frames: the scene is cut to exactly nFrames later.
        const maxFrames = nFrames + 2;
        const key = hash({ v: MATTE_VERSION, src: [camMeta.srcSize, camMeta.srcMtime], file: seg.camera.file, at: sec(camAt), maxFrames });
        seg.matte = path.join(matteDir, `${key}.mkv`);
        if (!(await exists(seg.matte))) {
          jobs.push({
            seg,
            frames: maxFrames,
            job: {
              kind: 'segment', ffBin: ff.bin, src: camMeta.path, at: sec(camAt), span, maxFrames,
              srcW: camMeta.video?.width ?? 1280, srcH: camMeta.video?.height ?? 720,
              outFile: seg.matte, encoder: ff.libx264 === false ? 'ffv1' : 'libx264',
            },
          });
        }
      }
      const total = jobs.reduce((sum, j) => sum + j.frames, 0) || 1;
      const done = new Map();
      const tick = () => {
        let sum = 0;
        for (const v of done.values()) sum += v;
        const p = Math.min(1, sum / total);
        report(`배경 지우는 중 ${Math.round(p * 100)}%`, afterNorm + weights.matte * p);
      };
      if (jobs.length) tick();
      await Promise.all(jobs.map(async (j, k) => {
        try {
          await pool.run(j.job, (m) => {
            done.set(k, Math.min(m.frames, j.frames));
            tick();
          });
        } catch (err) {
          console.warn('[build] cut-out failed:', err.message);
          j.seg.cutFailed = true;
          warnings.push({ type: 'cut-failed', cueId: j.seg.cueId, index: j.seg.cueIndex });
        }
        done.set(k, j.frames);
        tick();
      }));
      for (const seg of cutSegs) {
        if (seg.cutFailed) {
          seg.spec = sceneLayout({ kind: seg.layout, side: seg.side, showFace: seg.showFace, look: { ...look, style: 'pip' }, settings, aspect: seg.aspect });
        }
      }
    }
  } finally {
    if (ownPool) await pool.close();
  }

  // 4. Segments
  const masks = new Map();
  const ctx = {
    ff,
    norm,
    keyer: look.keyer,
    backgroundPath,
    captionPath,
    roundMask: (w, h, r = CONTENT_RADIUS) => {
      const file = path.join(bdir, `mask-${w}x${h}-r${r}.png`);
      masks.set(file, { w, h, r });
      return file;
    },
  };
  const assetStamps = { background: await mtime(backgroundPath), caption: await mtime(captionPath) };
  const renderFrom = afterNorm + weights.matte;
  const rendered = [];
  let totalSec = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    report(`장면 합성 중 (${i + 1}/${segments.length})`, renderFrom + ((0.92 - renderFrom) * i) / segments.length);
    const stamps = [];
    if (seg.slidePath) stamps.push((await fsp.stat(seg.slidePath)).mtimeMs);
    for (const ref of [seg.camera, seg.screen]) {
      if (ref) stamps.push(norm.get(`${seg.sessionId}/${ref.file}`).srcMtime);
    }
    const { args, exact } = segmentArgs(seg, ctx);
    for (const [file, m] of masks) await makeMask(ff, file, m.w, m.h, m.r);
    const key = hash({
      v: SEG_VERSION,
      enc: ff.h264,
      layout: seg.layout,
      page: seg.page,
      slide: !!seg.slidePath,
      session: seg.sessionId,
      camera: seg.camera,
      screen: seg.screen,
      duration: seg.duration,
      spec: seg.spec,
      keyer: seg.spec.cut ? look.keyer : null,
      key: seg.spec.cut && look.keyer === 'green' ? seg.key : null,
      matte: seg.spec.cut && look.keyer === 'ai' ? path.basename(seg.matte ?? '') : null,
      background: seg.spec.backdrop === 'image' ? assetStamps.background : null,
      caption: seg.caption ? { ...seg.caption, at: assetStamps.caption } : null,
      stamps,
    });
    const out = path.join(segDir, `${key}.mkv`);
    if (!(await exists(out))) {
      const tmp = `${out}.tmp.mkv`;
      await runFfmpeg(ff, [...args, tmp]);
      await fsp.rename(tmp, out);
    }
    rendered.push(out);
    totalSec += exact;
  }

  // 5. Join + loudness
  report('영상 합치는 중', 0.92);
  const listFile = path.join(bdir, 'concat.txt');
  await fsp.writeFile(listFile, rendered.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const name = `${safeFileName(project.title)}_${stamp()}.mp4`;
  const outFile = path.join(exportDir, name);
  const tmpOut = path.join(exportDir, `.${name}.tmp.mp4`);
  const af = settings.loudnorm === false ? `aresample=${RATE}` : `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE}`;
  await runFfmpeg(ff, [
    '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
    '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE),
    '-movflags', '+faststart', tmpOut,
  ], { totalSec, onProgress: (p) => report('영상 합치는 중', 0.92 + 0.08 * p) });
  await fsp.rename(tmpOut, outFile);

  // Segments and mattes not used by this export won't be needed again.
  const keep = new Set(rendered.map((f) => path.basename(f)));
  for (const f of await fsp.readdir(segDir)) {
    if (!keep.has(f)) await fsp.rm(path.join(segDir, f), { force: true });
  }
  const keepMattes = new Set(segments.filter((s) => s.matte).map((s) => path.basename(s.matte)));
  for (const f of await fsp.readdir(matteDir)) {
    if (f.endsWith('.mkv') && !keepMattes.has(f)) await fsp.rm(path.join(matteDir, f), { force: true });
  }

  const messages = [...new Set(warnings.map((w) => describeWarning(w, project.cues)))];
  const result = {
    file: outFile,
    name,
    url: `/data/${pid}/exports/${encodeURIComponent(name)}`,
    duration: totalSec,
    segmentCount: segments.length,
    cueCount: new Set(segments.map((s) => s.cueId)).size,
    warnings: messages,
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(exportDir, `.${name}.json`),
    JSON.stringify({ ...result, look, segments: segments.map(({ slidePath, ...s }) => s) }, null, 2),
  );
  report('완료', 1);
  return result;
}
