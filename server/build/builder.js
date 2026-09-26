// Assembles the final MP4 from recorded takes.
//
// 1. Read every session's event log and pick the take to use for each cue.
// 2. Normalize the browser recordings that are needed (constant 30 fps,
//    a keyframe every second) so cutting them is fast and exact. Cached.
// 3. Render each segment with its layout (slide + face, demo + face, face).
//    Segments get exact frame/sample counts so joining them never drifts.
//    Cached by content, so re-exporting after a re-shoot only renders what changed.
// 4. Join the segments and even out the loudness.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSession, chooseTakes, planSegments } from './timeline.js';
import { runFfmpeg, probeMedia, scanDuration, videoEncoderArgs } from './ffmpeg.js';

const BUILD_VERSION = 2;
const W = 1920;
const H = 1080;
const FPS = 30;
const RATE = 48000;
const PIP_WIDTHS = { s: 360, m: 440, l: 540 };
const PIP_MARGIN = 36;
const PIP_RADIUS = 20;

const sec = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
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
    default:
      return `${name}: ${w.type}`;
  }
}

function pipBox(settings) {
  const w = PIP_WIDTHS[settings.pipSize] ?? PIP_WIDTHS.m;
  const h = Math.round((w * 3) / 4 / 2) * 2;
  const corner = settings.pipCorner ?? 'br';
  const x = corner.endsWith('l') ? PIP_MARGIN : W - w - PIP_MARGIN;
  const y = corner.startsWith('t') ? PIP_MARGIN : H - h - PIP_MARGIN;
  return { w, h, x, y };
}

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
    if (meta.v === BUILD_VERSION && meta.srcSize === stat.size && meta.srcMtime === stat.mtimeMs && (await exists(outFile))) {
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
    v: BUILD_VERSION,
    srcSize: stat.size,
    srcMtime: stat.mtimeMs,
    duration: probe.duration,
    hasAudio: probe.hasAudio,
    video: probe.video,
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

function segmentArgs(seg, ctx) {
  const nFrames = Math.max(1, Math.round((seg.duration / 1000) * FPS));
  const exact = nFrames / FPS;
  const samples = Math.round(exact * RATE);
  const span = sec(exact + 1);
  const inputs = [];
  const filters = [];
  let inputCount = 0;
  const addInput = (args) => {
    inputs.push(...args);
    return inputCount++;
  };
  // Video and sound of one file are read as two separate inputs: with a
  // single shared reader, FFmpeg can stall when one of the two ends first.
  const videoOf = (file, at) => addInput(['-ss', sec(at), '-t', span, '-an', '-i', file]);
  const audioOf = (file, at) => addInput(['-ss', sec(at), '-t', span, '-vn', '-i', file]);

  const cam = ctx.norm.get(`${seg.sessionId}/${seg.camera.file}`);
  const camAt = Math.max(0, seg.camera.offset / 1000);
  const needsCamVideo = seg.layout === 'face' || seg.showFace;
  const camVideo = needsCamVideo ? videoOf(cam.path, camAt) : null;

  let bg = null;
  let screen = null;
  let screenAt = 0;
  let screenShift = 0;
  if (seg.layout === 'slide') {
    const slideIdx = seg.slidePath
      ? addInput(['-loop', '1', '-framerate', String(FPS), '-t', span, '-i', seg.slidePath])
      : addInput(['-f', 'lavfi', '-t', span, '-i', `color=c=black:s=${W}x${H}:r=${FPS}`]);
    filters.push(`[${slideIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[bg]`);
    bg = 'bg';
  } else if (seg.layout === 'screen') {
    screen = ctx.norm.get(`${seg.sessionId}/${seg.screen.file}`);
    const off = seg.screen.offset / 1000;
    screenAt = Math.max(0, off);
    screenShift = off < 0 ? -off : 0;
    const screenVideo = videoOf(screen.path, screenAt);
    let chain = `[${screenVideo}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
    if (screenShift > 0) chain += `,tpad=start_mode=add:start_duration=${sec(screenShift)}:color=black`;
    filters.push(`${chain}[bg]`);
    bg = 'bg';
  }

  let video;
  if (seg.layout === 'face') {
    filters.push(`[${camVideo}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[v0]`);
    video = 'v0';
  } else if (seg.showFace) {
    const { w, h, x, y } = ctx.pip;
    const maskIdx = addInput(['-loop', '1', '-framerate', String(FPS), '-t', span, '-i', ctx.maskPath]);
    filters.push(`[${camVideo}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuva420p[f0]`);
    filters.push(`[${maskIdx}:v]format=gray,scale=${w}:${h}[m]`);
    filters.push('[f0][m]alphamerge[face]');
    filters.push(`[${bg}][face]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[v0]`);
    video = 'v0';
  } else {
    video = bg;
  }
  filters.push(`[${video}]fps=${FPS},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${nFrames},setpts=PTS-STARTPTS,format=yuv420p[v]`);

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

/**
 * @param {{store: import('../store.js').Store, pid: string, ffmpeg: object,
 *   onProgress?: (p: {step: string, progress?: number}) => void}} opts
 */
export async function buildProject({ store, pid, ffmpeg: ff, onProgress = () => {} }) {
  const report = (step, progress) => onProgress({ step, progress });
  const project = await store.getProject(pid);
  const settings = project.settings ?? {};
  const pdir = store.projectDir(pid);
  const bdir = path.join(pdir, 'build');
  const normDir = path.join(bdir, 'norm');
  const segDir = path.join(bdir, 'seg');
  const exportDir = path.join(pdir, 'exports');
  await Promise.all([normDir, segDir, exportDir].map((d) => fsp.mkdir(d, { recursive: true })));

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
    const base = 0.03 + (0.5 * n) / needed.size;
    const label = `녹화 파일 준비 중 (${n + 1}/${needed.size})`;
    report(label, base);
    const meta = await normalizeTrack(ff, {
      ...item,
      onProgress: (p) => report(label, base + (0.5 * p) / needed.size),
    });
    norm.set(key, { ...meta, path: item.outFile });
    n += 1;
  }

  // 3. Segments
  const pip = pipBox(settings);
  const maskPath = path.join(bdir, `mask-${pip.w}x${pip.h}-r${PIP_RADIUS}.png`);
  await makeMask(ff, maskPath, pip.w, pip.h, PIP_RADIUS);
  const ctx = { ff, norm, pip, maskPath };

  const rendered = [];
  let totalSec = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    report(`장면 합성 중 (${i + 1}/${segments.length})`, 0.55 + (0.35 * i) / segments.length);
    if (seg.layout === 'slide') {
      const slide = store.slidePath(pid, seg.page);
      if (seg.page <= (project.slides?.count ?? 0) && (await exists(slide))) {
        seg.slidePath = slide;
      } else {
        seg.slidePath = null;
        warnings.push({ type: 'missing-slide', cueId: seg.cueId, index: seg.cueIndex });
      }
    }
    const stamps = [];
    if (seg.slidePath) stamps.push((await fsp.stat(seg.slidePath)).mtimeMs);
    for (const ref of [seg.camera, seg.screen]) {
      if (ref) stamps.push(norm.get(`${seg.sessionId}/${ref.file}`).srcMtime);
    }
    const key = hash({
      v: BUILD_VERSION,
      enc: ff.h264,
      layout: seg.layout,
      page: seg.page,
      showFace: seg.showFace,
      slide: !!seg.slidePath,
      session: seg.sessionId,
      camera: seg.camera,
      screen: seg.screen,
      duration: seg.duration,
      pip: seg.layout === 'face' || !seg.showFace ? null : pip,
      stamps,
    });
    const out = path.join(segDir, `${key}.mkv`);
    const { args, exact } = segmentArgs(seg, ctx);
    if (!(await exists(out))) {
      const tmp = `${out}.tmp.mkv`;
      await runFfmpeg(ff, [...args, tmp]);
      await fsp.rename(tmp, out);
    }
    rendered.push(out);
    totalSec += exact;
  }

  // 4. Join + loudness
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

  // Segments not used by this export won't be needed again.
  const keep = new Set(rendered.map((f) => path.basename(f)));
  for (const f of await fsp.readdir(segDir)) {
    if (!keep.has(f)) await fsp.rm(path.join(segDir, f), { force: true });
  }

  const messages = warnings.map((w) => describeWarning(w, project.cues));
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
    JSON.stringify({ ...result, segments: segments.map(({ slidePath, ...s }) => s) }, null, 2),
  );
  report('완료', 1);
  return result;
}

