// End-to-end export test with synthetic recordings: a camera track, a screen
// track that starts late, slide images, retakes and a pause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { findFfmpeg, runFfmpeg, probeMedia } from '../server/build/ffmpeg.js';
import { buildProject } from '../server/build/builder.js';

const ff = await findFfmpeg();

async function synth(args, out) {
  await runFfmpeg(ff, ['-hide_banner', '-y', ...args, out]);
}

test('builds an MP4 from takes', { skip: !ff && 'FFmpeg not found', timeout: 300_000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-build-'));
  const store = new Store(dir);
  await store.init();
  const project = await store.createProject({ title: '테스트 강의' });
  const pid = project.id;

  // Two slides: one 16:9, one 4:3 (letterboxed in the output).
  await store.beginSlides(pid);
  const staging = store.stagingDir(pid);
  await synth(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:d=1', '-frames:v', '1'], path.join(staging, 'p001.png'));
  await synth(['-f', 'lavfi', '-i', 'smptebars=s=1024x768:d=1', '-frames:v', '1'], path.join(staging, 'p002.png'));
  await store.commitSlides(pid, 2);

  await store.saveProject(pid, {
    settings: { look: { style: 'pip' } },
    cues: [
      { id: 'cue1', type: 'slide', page: 1, script: '첫 슬라이드' },
      { id: 'cue2', type: 'demo', title: '데모' },
      { id: 'cue3', type: 'face', title: '마무리' },
      { id: 'cue4', type: 'slide', page: 2 },
      { id: 'cue5', type: 'video', title: '안 찍은 영상' },
    ],
  });

  const { id: sid } = await store.createSession(pid);
  const sdir = store.sessionDir(pid, sid);
  // Camera: 20 s, 1280x720, mono tone. Screen: 12 s, starts 5 s into the session.
  await synth([
    '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=20',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=20',
    '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-ac', '1', '-f', 'webm',
  ], path.join(sdir, 'camera.webm'));
  await synth([
    '-f', 'lavfi', '-i', 'mandelbrot=s=1600x1000:r=30',
    '-f', 'lavfi', '-i', 'sine=f=880:r=48000',
    '-t', '12', '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-f', 'webm',
  ], path.join(sdir, 'screen-1.webm'));

  const events = [
    { type: 'session-start', t: 0, wall: Date.now() },
    { type: 'track-start', t: 0, track: 'camera', file: 'camera.webm' },
    { type: 'take-start', t: 1000, cueId: 'cue1' },
    { type: 'take-end', t: 2500, cueId: 'cue1', reason: 'retake' },
    { type: 'take-start', t: 3000, cueId: 'cue1' },
    { type: 'take-end', t: 6000, cueId: 'cue1', reason: 'next' },
    { type: 'track-start', t: 5000, track: 'screen', file: 'screen-1.webm' },
    { type: 'take-start', t: 6000, cueId: 'cue2' },
    { type: 'pause', t: 8000 },
    { type: 'resume', t: 9000 },
    { type: 'take-end', t: 12000, cueId: 'cue2', reason: 'next' },
    { type: 'take-start', t: 12000, cueId: 'cue3' },
    { type: 'take-end', t: 15000, cueId: 'cue3', reason: 'next' },
    { type: 'take-start', t: 15000, cueId: 'cue4' },
    { type: 'take-end', t: 18000, cueId: 'cue4', reason: 'stop' },
    { type: 'track-end', t: 17000, file: 'screen-1.webm' },
    { type: 'session-end', t: 18000 },
  ];
  let seq = 0;
  for (const e of events) await store.appendEvent(pid, sid, seq++, Buffer.from(JSON.stringify(e)));

  const steps = [];
  const result = await buildProject({ store, pid, ffmpeg: ff, onProgress: (p) => steps.push(p) });

  // cue1 3 s + cue2 2 s + 3 s + cue3 3 s + cue4 3 s = 14 s
  assert.ok(Math.abs(result.duration - 14) < 0.1, `duration ${result.duration}`);
  assert.equal(result.cueCount, 4);
  assert.equal(result.segmentCount, 5);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /5번 장면/);

  const probe = await probeMedia(ff, result.file);
  assert.equal(probe.hasAudio, true);
  assert.deepEqual(probe.video, { width: 1920, height: 1080 });
  assert.ok(Math.abs(probe.duration - 14) < 0.15, `probed ${probe.duration}`);
  assert.equal(steps.at(-1).step, '완료');

  // A second export reuses every cached intermediate file.
  const again = await buildProject({ store, pid, ffmpeg: ff });
  assert.ok(Math.abs(again.duration - result.duration) < 0.001);

  await fsp.rm(dir, { recursive: true, force: true });
});

/** A frame of a video (or a picture) as 192×108 RGB. */
async function tiny(file, at) {
  const { execFile } = await import('node:child_process');
  const args = ['-v', 'error', ...(at != null ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1',
    '-vf', 'scale=192:108:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  return new Promise((resolve, reject) => {
    execFile(ff.bin, args, { encoding: 'buffer', maxBuffer: 1e7 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** Mean color difference of two tiny frames inside a box (shares of the frame). */
function diff(a, b, [x0, x1], [y0, y1]) {
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * 108); y < Math.floor(y1 * 108); y++) {
    for (let x = Math.floor(x0 * 192); x < Math.floor(x1 * 192); x++) {
      for (let c = 0; c < 3; c++) sum += Math.abs(a[(y * 192 + x) * 3 + c] - b[(y * 192 + x) * 3 + c]);
      n += 3;
    }
  }
  return sum / n;
}

test('builds the cut-out look: presenter on slides, backgrounds, name caption', { skip: !ff && 'FFmpeg not found', timeout: 600_000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vc-cutout-'));
  const store = new Store(dir);
  await store.init();
  const { id: pid } = await store.createProject({ title: '컷아웃' });
  const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'presenter.jpg');

  await store.beginSlides(pid);
  const staging = store.stagingDir(pid);
  await synth(['-f', 'lavfi', '-i', 'color=c=0xf4f1ea:s=1920x1080', '-vf',
    'drawbox=x=120:y=160:w=760:h=110:color=0x7b1e1e:t=fill,drawbox=x=120:y=360:w=820:h=40:color=0x333333:t=fill,drawbox=x=120:y=440:w=700:h=40:color=0x333333:t=fill',
    '-frames:v', '1'], path.join(staging, 'p001.png'));
  await synth(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1'], path.join(staging, 'p002.png'));
  await store.commitSlides(pid, 2);
  await store.saveProject(pid, {
    settings: { look: { style: 'cutout', keyer: 'ai', placement: 'auto', faceBg: 'image', caption: { name: '황승환 교수', org: '경북전문대학교', show: 'first' } } },
    cues: [
      { id: 'face1', type: 'face', title: '인사' },
      { id: 'slide1', type: 'slide', page: 1 },
      { id: 'slide2', type: 'slide', page: 2, side: 'shrink' },
      { id: 'quiz', type: 'slide', page: 1, showFace: false },
    ],
  });
  const assets = dir;
  await synth(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1'], path.join(assets, 'bg.jpg'));
  await store.putAsset(pid, 'background', await fsp.readFile(path.join(assets, 'bg.jpg')));
  await synth(['-f', 'lavfi', '-i', 'color=c=0xc8102e:s=520x90,format=rgba', '-vf', 'pad=1920:1080:96:830:color=0x00000000', '-frames:v', '1'], path.join(assets, 'cap.png'));
  await store.putAsset(pid, 'caption', await fsp.readFile(path.join(assets, 'cap.png')));

  // Camera: the portrait in a plain room, swaying a little, 12 s.
  const { id: sid } = await store.createSession(pid);
  await synth([
    '-f', 'lavfi', '-i', 'color=c=0x9c8f7a:s=1280x720:r=30:d=12',
    '-loop', '1', '-framerate', '30', '-t', '12', '-i', fixture,
    '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=12',
    '-filter_complex', "[1:v]scale=720:720[p];[0:v][p]overlay=x='280+30*sin(t)':y=0[v]",
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', '-f', 'webm',
  ], path.join(store.sessionDir(pid, sid), 'camera.webm'));
  const events = [
    { type: 'session-start', t: 0, wall: Date.now() },
    { type: 'track-start', t: 0, track: 'camera', file: 'camera.webm' },
    { type: 'take-start', t: 500, cueId: 'face1' }, { type: 'take-end', t: 3500, cueId: 'face1', reason: 'next' },
    { type: 'take-start', t: 3500, cueId: 'slide1' }, { type: 'take-end', t: 6500, cueId: 'slide1', reason: 'next' },
    { type: 'take-start', t: 6500, cueId: 'slide2' }, { type: 'take-end', t: 9000, cueId: 'slide2', reason: 'next' },
    { type: 'take-start', t: 9000, cueId: 'quiz' }, { type: 'take-end', t: 11000, cueId: 'quiz', reason: 'stop' },
    { type: 'session-end', t: 11000 },
  ];
  let seq = 0;
  for (const e of events) await store.appendEvent(pid, sid, seq++, Buffer.from(JSON.stringify(e)));

  const result = await buildProject({ store, pid, ffmpeg: ff });
  assert.deepEqual(result.warnings, []);
  assert.ok(Math.abs(result.duration - 10.5) < 0.1, `duration ${result.duration}`);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, pid, 'exports', `.${result.name}.json`), 'utf8'));
  const [face, slide, shrunk, quiz] = meta.segments;
  assert.equal(face.spec.backdrop, 'image');
  assert.ok(face.caption, 'caption on the first face scene');
  assert.equal(slide.side, 'right');
  assert.equal(shrunk.spec.backdrop, 'content-blur');
  assert.equal(quiz.spec.camera, null);
  assert.ok(Math.abs(slide.person.cx - 0.5) < 0.15, `presenter found near the middle (${slide.person.cx})`);

  // Face scene: the room is replaced by the background picture.
  const bg = await tiny(store.assetPath(pid, 'background'));
  const faceFrame = await tiny(result.file, 1.5);
  assert.ok(diff(faceFrame, bg, [0, 0.15], [0, 0.3]) < 12, 'background picture behind the presenter');
  // Slide scene: the slide is untouched on the left, the presenter stands on the right.
  const slideImg = await tiny(store.slidePath(pid, 1));
  const slideFrame = await tiny(result.file, 4.5);
  assert.ok(diff(slideFrame, slideImg, [0, 0.45], [0, 1]) < 6, 'slide visible on the left');
  assert.ok(diff(slideFrame, slideImg, [0.72, 0.92], [0.4, 1]) > 25, 'presenter on the right');
  // Quiz scene: just the slide.
  assert.ok(diff(await tiny(result.file, 10), slideImg, [0, 1], [0, 1]) < 6, 'no presenter on the quiz slide');

  await fsp.rm(dir, { recursive: true, force: true });
});
