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
