import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession, chooseTakes, planSegments } from '../server/build/timeline.js';

let seq = 0;
const ev = (type, t, extra = {}) => ({ seq: seq++, type, t, ...extra });

function sampleSession(id = 's20260101-100000-aaaa') {
  seq = 0;
  return {
    id,
    events: [
      ev('session-start', 0, { wall: 1_000_000 }),
      ev('track-start', 40, { track: 'camera', file: 'camera.webm' }),
      ev('track-start', 60, { track: 'screen', file: 'screen-1.webm' }),
      ev('take-start', 3000, { cueId: 'c1' }),
      ev('take-end', 10000, { cueId: 'c1', reason: 'next' }),
      ev('take-start', 10000, { cueId: 'c2' }),
      ev('take-end', 12000, { cueId: 'c2', reason: 'retake' }),
      ev('take-start', 15000, { cueId: 'c2' }),
      ev('pause', 20000),
      ev('resume', 23000),
      ev('take-end', 30000, { cueId: 'c2', reason: 'next' }),
      ev('take-start', 30000, { cueId: 'c3' }),
      ev('take-end', 30300, { cueId: 'c3', reason: 'next' }),
      ev('take-end', 30300, { cueId: 'c3', reason: 'stop' }),
      ev('track-end', 31000, { file: 'screen-1.webm' }),
      ev('session-end', 31000),
    ],
  };
}

test('parseSession splits takes, parts and NG takes', () => {
  const s = parseSession(sampleSession());
  assert.equal(s.ended, true);
  assert.equal(s.wall, 1_000_000);
  assert.equal(s.takes.length, 4);
  const [c1, c2ng, c2, c3] = s.takes;
  assert.deepEqual(c1.parts, [{ start: 3000, end: 10000 }]);
  assert.equal(c1.ng, false);
  assert.equal(c2ng.ng, true);
  assert.deepEqual(c2.parts, [{ start: 15000, end: 20000 }, { start: 23000, end: 30000 }]);
  assert.equal(c2.duration, 12000);
  assert.equal(c3.tooShort, true);
  assert.equal(s.tracks[0].start, 40);
  assert.equal(s.tracks[1].end, 31000);
});

test('the latest usable take wins, across sessions', () => {
  const a = parseSession(sampleSession('s20260101-100000-aaaa'));
  seq = 0;
  const b = parseSession({
    id: 's20260101-110000-bbbb',
    events: [
      ev('session-start', 0, { wall: 2_000_000 }),
      ev('track-start', 10, { track: 'camera', file: 'camera.webm' }),
      ev('take-start', 2000, { cueId: 'c1' }),
      ev('take-end', 6000, { cueId: 'c1', reason: 'next' }),
      ev('session-end', 7000),
    ],
  });
  const { chosen, byCue } = chooseTakes([a, b]);
  assert.equal(chosen.get('c1').takeId, 's20260101-110000-bbbb:0');
  assert.equal(chosen.get('c2').takeId, 's20260101-100000-aaaa:2');
  assert.equal(chosen.has('c3'), false);
  assert.equal(byCue.get('c1').length, 2);

  const excluded = new Set(['s20260101-110000-bbbb:0']);
  assert.equal(chooseTakes([a, b], excluded).chosen.get('c1').takeId, 's20260101-100000-aaaa:0');
});

test('a take left open by a crash is closed at the end of the recording', () => {
  seq = 0;
  const raw = {
    id: 's20260101-120000-cccc',
    events: [
      ev('session-start', 0, { wall: 1 }),
      ev('track-start', 20, { track: 'camera', file: 'camera.webm' }),
      ev('take-start', 1000, { cueId: 'c1' }),
    ],
  };
  const withoutHint = parseSession(raw);
  assert.equal(withoutHint.takes[0].tooShort, true);
  const s = parseSession(raw, { endHint: 90_020 });
  assert.equal(s.takes[0].incomplete, true);
  assert.deepEqual(s.takes[0].parts, [{ start: 1000, end: 90_020 }]);
  assert.equal(s.tracks[0].end, 90_020);
});

test('planSegments lays out cues in order with track offsets', () => {
  const s = parseSession(sampleSession());
  const cues = [
    { id: 'c1', type: 'slide', page: 1 },
    { id: 'c2', type: 'demo' },
    { id: 'c3', type: 'face' },
    { id: 'c4', type: 'video' },
  ];
  const { chosen } = chooseTakes([s]);
  const { segments, warnings } = planSegments({ cues, sessionsById: new Map([[s.id, s]]), chosen });
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((x) => x.layout), ['slide', 'screen', 'screen']);
  assert.equal(segments[0].camera.offset, 3000 - 40);
  assert.equal(segments[1].screen.offset, 15000 - 60);
  assert.equal(segments[2].start, 23000);
  assert.equal(segments[1].showFace, true);
  assert.deepEqual(warnings.map((w) => [w.type, w.cueId]), [['no-take', 'c3'], ['no-take', 'c4']]);
});

test('a demo take without a screen recording falls back to the face layout', () => {
  seq = 0;
  const s = parseSession({
    id: 's20260101-130000-dddd',
    events: [
      ev('session-start', 0, { wall: 1 }),
      ev('track-start', 5, { track: 'camera', file: 'camera.webm' }),
      ev('take-start', 1000, { cueId: 'd' }),
      ev('take-end', 5000, { cueId: 'd', reason: 'next' }),
      ev('session-end', 5000),
    ],
  });
  const { chosen } = chooseTakes([s]);
  const { segments, warnings } = planSegments({
    cues: [{ id: 'd', type: 'demo' }],
    sessionsById: new Map([[s.id, s]]),
    chosen,
  });
  assert.equal(segments[0].layout, 'face');
  assert.equal(warnings[0].type, 'no-screen');
});
