import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUT_W, OUT_H, defaultLook, cleanLook, placeCamera, autoSide, sideFor, sceneLayout, captionWindow, shrunkBox,
} from '../public/js/look.js';

const person = { cx: 0.5, top: 0.15, bottom: 1, left: 0.3, right: 0.7 };

test('cleanLook keeps known values and drops the rest', () => {
  const look = cleanLook({
    style: 'pip', keyer: 'nope', size: 9, x: -1, faceBg: 'image',
    caption: { name: '황승환\n교수', org: 7, color: '#ABCDEF', show: 'all' },
  });
  assert.equal(look.style, 'pip');
  assert.equal(look.keyer, defaultLook().keyer);
  assert.equal(look.size, 1.3);
  assert.equal(look.x, 0.5);
  assert.equal(look.faceBg, 'image');
  assert.deepEqual(look.caption, { name: '황승환 교수', org: '', color: '#abcdef', show: 'all' });
  assert.deepEqual(cleanLook({}), defaultLook());
});

test('the presenter stands on the bottom edge and stays in frame', () => {
  const cam = placeCamera({ aspect: 16 / 9, person, size: 0.8, x: 0.8 });
  assert.equal(cam.y + cam.h, OUT_H);
  assert.equal(cam.h, 864);
  assert.equal(cam.w, 1536);
  // Middle of the presenter at 80% of the width.
  assert.ok(Math.abs(cam.x + person.cx * cam.w - 0.8 * OUT_W) <= 1);
  // Pushed too far right: nudged back so the shoulder stays visible.
  const far = placeCamera({ aspect: 16 / 9, person, size: 1.2, x: 0.98 });
  assert.ok(far.x + person.right * far.w <= OUT_W - 24 + 1);
  const left = placeCamera({ aspect: 16 / 9, person, size: 0.8, x: 0.02 });
  assert.ok(left.x + person.left * left.w >= 24 - 1);
});

test('automatic placement picks the emptier side, or shrinks the slide', () => {
  assert.equal(autoSide({ left: 0.3, right: 0.01 }), 'right');
  assert.equal(autoSide({ left: 0.02, right: 0.3 }), 'left');
  assert.equal(autoSide({ left: 0.37, right: 0.13 }), 'shrink');
  assert.equal(autoSide({ left: 0.06, right: 0.09 }), 'left');
  assert.equal(autoSide(undefined), 'right');
});

test("a scene's own choice beats the project's, which beats automatic", () => {
  const busyRight = { left: 0, right: 0.4 };
  const auto = { ...defaultLook(), placement: 'auto' };
  assert.equal(sideFor({ type: 'slide' }, auto, busyRight), 'left');
  assert.equal(sideFor({ type: 'slide' }, { ...auto, placement: 'right' }, busyRight), 'right');
  assert.equal(sideFor({ type: 'slide', side: 'shrink' }, { ...auto, placement: 'right' }, busyRight), 'shrink');
  assert.equal(sideFor({ type: 'demo' }, auto, busyRight), 'right');
});

test('scene layouts', () => {
  const look = defaultLook();
  const aspect = 16 / 9;
  const slide = sceneLayout({ kind: 'slide', side: 'right', look, aspect, person });
  assert.deepEqual(slide.content, { x: 0, y: 0, w: OUT_W, h: OUT_H });
  assert.equal(slide.cut, true);

  const shrink = sceneLayout({ kind: 'slide', side: 'shrink', look, aspect, person });
  const box = shrunkBox();
  assert.deepEqual(shrink.content, box);
  assert.equal(shrink.backdrop, 'content-blur');
  // The presenter stands beside the smaller slide, not over it.
  assert.ok(shrink.camera.x + person.left * shrink.camera.w >= box.x + box.w);

  const hidden = sceneLayout({ kind: 'slide', side: 'right', showFace: false, look, aspect, person });
  assert.equal(hidden.camera, null);

  const demo = sceneLayout({ kind: 'screen', side: 'right', look, aspect, person });
  assert.ok(demo.camera.h < slide.camera.h);

  const original = sceneLayout({ kind: 'face', look, aspect, person });
  assert.equal(original.cut, false);
  const blur = sceneLayout({ kind: 'face', look: { ...look, faceBg: 'blur' }, aspect, person });
  assert.equal(blur.backdrop, 'camera-blur');
  assert.equal(blur.cut, true);
  const image = sceneLayout({ kind: 'face', look: { ...look, faceBg: 'image' }, aspect, person });
  assert.equal(image.backdrop, 'image');
  assert.ok(Math.abs(image.camera.x + person.cx * image.camera.w - OUT_W / 2) <= 1);

  const pip = sceneLayout({ kind: 'slide', look: { ...look, style: 'pip' }, settings: { pipCorner: 'tl', pipSize: 's' }, aspect, person });
  assert.equal(pip.rounded, true);
  assert.deepEqual(pip.camera, { w: 360, h: 270, x: 36, y: 36 });
});

test('the name caption shows at the start of face scenes', () => {
  const look = { ...defaultLook(), caption: { ...defaultLook().caption, name: '황승환 교수' } };
  assert.deepEqual(captionWindow(look, { firstFace: true }, 30), { start: 0.5, end: 9, fade: 0.4 });
  assert.equal(captionWindow(look, { firstFace: false }, 30), null);
  assert.ok(captionWindow({ ...look, caption: { ...look.caption, show: 'all' } }, { firstFace: false }, 30));
  assert.equal(captionWindow(look, { firstFace: true }, 1.5), null);
  assert.equal(captionWindow({ ...look, caption: { ...look.caption, name: ' ' } }, { firstFace: true }, 30), null);
});
