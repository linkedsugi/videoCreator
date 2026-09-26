// Turns recording-session event logs into takes, picks the take to use for each
// cue, and plans the segments of the final video. Pure functions: no I/O.
//
// Session time `t` is milliseconds since the session started (performance.now()
// in the browser). Track files start at their own `track-start` time, so a
// moment `t` sits at `t - track.start` inside that file.

export const MIN_TAKE_MS = 500;
export const MIN_PART_MS = 200;

function findLast(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return undefined;
}

/**
 * @param {{id: string, events: object[]}} session
 * @param {{endHint?: number}} [opts] session time at which recording really
 *   stopped. Used to close a take left open when the browser crashed.
 */
export function parseSession(session, { endHint } = {}) {
  const events = [...session.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const tracks = [];
  const takes = [];
  let wall = null;
  let lastT = 0;
  let ended = false;
  let take = null;
  let partStart = null;

  const closePart = (t) => {
    if (take && partStart != null) {
      if (t - partStart >= MIN_PART_MS) take.parts.push({ start: partStart, end: t });
      partStart = null;
    }
  };
  const closeTake = (t, reason, incomplete = false) => {
    if (!take) return;
    closePart(t);
    take.end = t;
    take.endReason = reason;
    take.incomplete = incomplete;
    take.ng = reason === 'retake';
    take.duration = take.parts.reduce((sum, p) => sum + (p.end - p.start), 0);
    take.tooShort = take.duration < MIN_TAKE_MS;
    takes.push(take);
    take = null;
  };

  for (const ev of events) {
    const t = Number(ev.t) || 0;
    if (t > lastT) lastT = t;
    switch (ev.type) {
      case 'session-start':
        wall = typeof ev.wall === 'number' ? ev.wall : null;
        break;
      case 'track-start':
        tracks.push({ file: ev.file, kind: ev.track, start: t, end: null, mime: ev.mime ?? null });
        break;
      case 'track-end': {
        const tr = findLast(tracks, (x) => x.file === ev.file && x.end == null);
        if (tr) tr.end = t;
        break;
      }
      case 'take-start':
        if (take) closeTake(t, 'interrupted');
        take = {
          takeId: `${session.id}:${takes.length}`,
          sessionId: session.id,
          index: takes.length,
          cueId: ev.cueId,
          start: t,
          parts: [],
        };
        partStart = t;
        break;
      case 'pause':
        closePart(t);
        break;
      case 'resume':
        if (take && partStart == null) partStart = t;
        break;
      case 'take-end':
        if (take) closeTake(t, ev.reason || 'next');
        break;
      case 'session-end':
        if (take) closeTake(t, 'stop');
        ended = true;
        break;
      default:
        break;
    }
  }

  const end = Math.max(lastT, endHint ?? 0);
  if (take) closeTake(end, 'crash', true);
  for (const tr of tracks) {
    if (tr.end == null && (endHint != null || ended)) tr.end = endHint ?? lastT;
  }
  return { id: session.id, wall, tracks, takes, lastT, ended };
}

/**
 * Groups every take by cue and picks the one to use: the most recent take
 * that isn't NG, excluded by hand, or too short. Sessions must be passed in
 * recording order (session ids are time-based, so sorting by id works).
 */
export function chooseTakes(sessions, excluded = new Set()) {
  const byCue = new Map();
  sessions.forEach((s, sessionIndex) => {
    for (const tk of s.takes) {
      const item = {
        ...tk,
        wall: s.wall,
        order: sessionIndex * 1e10 + tk.start,
        excluded: excluded.has(tk.takeId),
        chosen: false,
      };
      item.usable = !item.ng && !item.excluded && !item.tooShort && item.parts.length > 0;
      if (!byCue.has(tk.cueId)) byCue.set(tk.cueId, []);
      byCue.get(tk.cueId).push(item);
    }
  });
  const chosen = new Map();
  for (const [cueId, list] of byCue) {
    list.sort((a, b) => a.order - b.order);
    const pick = findLast(list, (x) => x.usable);
    if (pick) {
      pick.chosen = true;
      chosen.set(cueId, pick);
    }
  }
  return { byCue, chosen };
}

export function showFaceOf(cue) {
  if (cue.type === 'face') return true;
  if (typeof cue.showFace === 'boolean') return cue.showFace;
  return cue.type !== 'video';
}

function overlap(tr, start, end) {
  const trEnd = tr.end ?? Infinity;
  return Math.max(0, Math.min(end, trEnd) - Math.max(start, tr.start));
}

function bestTrack(tracks, kind, start, end) {
  let best = null;
  let bestOverlap = 0;
  for (const tr of tracks) {
    if (tr.kind !== kind) continue;
    const o = overlap(tr, start, end);
    if (o > bestOverlap) {
      best = tr;
      bestOverlap = o;
    }
  }
  return best;
}

/**
 * Lays out the final video: one segment per recorded part of each cue's
 * chosen take, in cue-sheet order.
 */
export function planSegments({ cues, sessionsById, chosen }) {
  const segments = [];
  const warnings = [];
  cues.forEach((cue, index) => {
    const take = chosen.get(cue.id);
    if (!take) {
      warnings.push({ type: 'no-take', cueId: cue.id, index });
      return;
    }
    const session = sessionsById.get(take.sessionId);
    for (const part of take.parts) {
      const camera = bestTrack(session.tracks, 'camera', part.start, part.end);
      if (!camera) {
        warnings.push({ type: 'no-camera', cueId: cue.id, index });
        continue;
      }
      let layout = cue.type === 'slide' ? 'slide' : cue.type === 'face' ? 'face' : 'screen';
      let screen = null;
      if (layout === 'screen') {
        screen = bestTrack(session.tracks, 'screen', part.start, part.end);
        if (!screen) {
          warnings.push({ type: 'no-screen', cueId: cue.id, index });
          layout = 'face';
        }
      }
      segments.push({
        cueId: cue.id,
        cueIndex: index,
        cueType: cue.type,
        layout,
        page: cue.type === 'slide' ? cue.page : null,
        showFace: layout === 'face' ? true : showFaceOf(cue),
        sessionId: session.id,
        takeId: take.takeId,
        start: part.start,
        end: part.end,
        duration: part.end - part.start,
        camera: { file: camera.file, offset: part.start - camera.start },
        screen: screen ? { file: screen.file, offset: part.start - screen.start } : null,
      });
    }
  });
  return { segments, warnings };
}
