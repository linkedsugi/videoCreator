// File-based storage. Everything lives under the data directory:
//
//   <pid>/project.json          title, cue sheet, settings
//   <pid>/slides/p001.png       slide images rendered in the browser
//   <pid>/sessions/<sid>/       one recording session
//       events.jsonl            what happened when (cue changes, retakes, ...)
//       camera.webm             camera + mic, appended every second
//       screen-1.webm           shared demo tab (+ its sound)
//   <pid>/build/                cached intermediate files
//   <pid>/exports/              finished MP4 files

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSession, chooseTakes } from './build/timeline.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TRACK_FILE_RE = /^(camera|screen-\d{1,3})\.webm$/;
const CUE_ID_RE = /^[a-zA-Z0-9_-]{3,40}$/;
const CUE_TYPES = new Set(['slide', 'demo', 'video', 'face']);
const MAX_SLIDES = 999;

function assertId(id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `잘못된 ${what}입니다.`);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newId(prefix) {
  return `${prefix}${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
}

export function slideFileName(page) {
  return `p${String(page).padStart(3, '0')}.png`;
}

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

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

function text(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const s = value.slice(0, max);
  return multiline ? s : s.replace(/[\r\n]+/g, ' ');
}

export function defaultSettings() {
  return { pipCorner: 'br', pipSize: 'm', loudnorm: true };
}

function cleanSettings(s) {
  return {
    pipCorner: ['br', 'bl', 'tr', 'tl'].includes(s.pipCorner) ? s.pipCorner : 'br',
    pipSize: ['s', 'm', 'l'].includes(s.pipSize) ? s.pipSize : 'm',
    loudnorm: s.loudnorm !== false,
  };
}

function cleanCues(list) {
  const seen = new Set();
  const out = [];
  for (const c of list.slice(0, 2000)) {
    if (!c || typeof c !== 'object' || !CUE_TYPES.has(c.type)) continue;
    let id = typeof c.id === 'string' && CUE_ID_RE.test(c.id) ? c.id : null;
    if (!id || seen.has(id)) id = `c${crypto.randomBytes(5).toString('hex')}`;
    seen.add(id);
    const cue = {
      id,
      type: c.type,
      title: text(c.title, 200),
      script: text(c.script, 20000, { multiline: true }),
    };
    if (c.type === 'slide') cue.page = Math.min(MAX_SLIDES, Math.max(1, Math.floor(Number(c.page) || 1)));
    if (c.type === 'video') cue.url = text(c.url, 2000);
    if (typeof c.showFace === 'boolean') cue.showFace = c.showFace;
    out.push(cue);
  }
  return out;
}

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.locks = new Map();
    this.nextSeq = new Map();
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
  }

  /** Serializes async work per key (one project file, one recording file, ...). */
  withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  projectDir(pid) {
    assertId(pid, '강의 ID');
    return path.join(this.dataDir, pid);
  }

  sessionDir(pid, sid) {
    assertId(sid, '세션 ID');
    return path.join(this.projectDir(pid), 'sessions', sid);
  }

  slidePath(pid, page) {
    return path.join(this.projectDir(pid), 'slides', slideFileName(page));
  }

  async listProjects() {
    const entries = await fsp.readdir(this.dataDir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      try {
        const p = await readJson(path.join(this.dataDir, e.name, 'project.json'));
        const sessions = await this.listSessionIds(e.name);
        out.push({
          id: p.id,
          title: p.title,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          cueCount: p.cues?.length ?? 0,
          slideCount: p.slides?.count ?? 0,
          sessionCount: sessions.length,
        });
      } catch {
        // not a project folder
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async createProject({ title }) {
    const id = newId('p');
    const now = new Date().toISOString();
    const project = {
      id,
      title: text(title, 120).trim() || '새 강의',
      createdAt: now,
      updatedAt: now,
      slides: { count: 0, version: 0 },
      cues: [],
      excludedTakes: [],
      settings: defaultSettings(),
    };
    await fsp.mkdir(path.join(this.dataDir, id, 'sessions'), { recursive: true });
    await writeJsonAtomic(path.join(this.dataDir, id, 'project.json'), project);
    return project;
  }

  async getProject(pid) {
    const file = path.join(this.projectDir(pid), 'project.json');
    try {
      const p = await readJson(file);
      p.settings = { ...defaultSettings(), ...p.settings };
      return p;
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, '강의를 찾을 수 없습니다.');
      throw err;
    }
  }

  /** Read-modify-write of project.json under the project lock. */
  updateProject(pid, mutate) {
    return this.withLock(`project:${pid}`, async () => {
      const current = await this.getProject(pid);
      const next = await mutate(current);
      next.updatedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(this.projectDir(pid), 'project.json'), next);
      return next;
    });
  }

  saveProject(pid, body) {
    return this.updateProject(pid, (current) => {
      const next = { ...current };
      if (typeof body.title === 'string') next.title = text(body.title, 120).trim() || current.title;
      if (Array.isArray(body.cues)) next.cues = cleanCues(body.cues);
      if (Array.isArray(body.excludedTakes)) {
        next.excludedTakes = body.excludedTakes.filter((x) => typeof x === 'string' && x.length < 100).slice(0, 10000);
      }
      if (body.settings && typeof body.settings === 'object') {
        next.settings = cleanSettings({ ...current.settings, ...body.settings });
      }
      return next;
    });
  }

  // Slides are uploaded to a staging folder and swapped in at once, so a
  // failed import never leaves half-replaced slides behind.
  stagingDir(pid) {
    return path.join(this.projectDir(pid), 'slides.staging');
  }

  async beginSlides(pid) {
    await this.getProject(pid);
    const dir = this.stagingDir(pid);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
  }

  async putStagedSlide(pid, page, buf) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_SLIDES) throw new HttpError(400, '잘못된 슬라이드 번호입니다.');
    if (!isPng(buf)) throw new HttpError(400, 'PNG 이미지가 아닙니다.');
    const dir = this.stagingDir(pid);
    if (!(await exists(dir))) throw new HttpError(409, '슬라이드 가져오기를 먼저 시작해 주세요.');
    await fsp.writeFile(path.join(dir, slideFileName(page)), buf);
  }

  async commitSlides(pid, count) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SLIDES) throw new HttpError(400, '잘못된 슬라이드 수입니다.');
    const staging = this.stagingDir(pid);
    for (let p = 1; p <= count; p++) {
      if (!(await exists(path.join(staging, slideFileName(p))))) throw new HttpError(400, `${p}번 슬라이드 이미지가 없습니다.`);
    }
    return this.updateProject(pid, async (current) => {
      const dir = path.join(this.projectDir(pid), 'slides');
      const old = path.join(this.projectDir(pid), `slides.old-${Date.now()}`);
      if (await exists(dir)) await fsp.rename(dir, old);
      await fsp.rename(staging, dir);
      await fsp.rm(old, { recursive: true, force: true });
      return {
        ...current,
        slides: { count, version: (current.slides?.version ?? 0) + 1, updatedAt: new Date().toISOString() },
      };
    });
  }

  async createSession(pid, meta = {}) {
    await this.getProject(pid);
    const id = newId('s');
    const dir = this.sessionDir(pid, id);
    await fsp.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, 'session.json'), {
      id,
      createdAt: new Date().toISOString(),
      userAgent: text(meta.userAgent, 300),
    });
    return { id };
  }

  async requireSession(pid, sid) {
    const dir = this.sessionDir(pid, sid);
    if (!(await exists(dir))) throw new HttpError(404, '녹화 세션을 찾을 수 없습니다.');
    return dir;
  }

  async appendTrackChunk(pid, sid, file, seq, buf) {
    if (!TRACK_FILE_RE.test(file)) throw new HttpError(400, '잘못된 녹화 파일 이름입니다.');
    const dir = await this.requireSession(pid, sid);
    return this.appendInOrder(path.join(dir, file), seq, buf);
  }

  async appendEvent(pid, sid, seq, buf) {
    const dir = await this.requireSession(pid, sid);
    let ev;
    try {
      ev = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new HttpError(400, '잘못된 이벤트입니다.');
    }
    if (!ev || typeof ev.type !== 'string') throw new HttpError(400, '잘못된 이벤트입니다.');
    const line = Buffer.from(`${JSON.stringify({ ...ev, seq })}\n`);
    return this.appendInOrder(path.join(dir, 'events.jsonl'), seq, line);
  }

  /**
   * Appends chunk number `seq` to a file. Chunks must arrive in order; a
   * repeated chunk (a retry whose first attempt did land) is acknowledged
   * without writing it twice.
   */
  appendInOrder(file, seq, buf) {
    if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'seq 값이 필요합니다.');
    return this.withLock(file, async () => {
      let expected = this.nextSeq.get(file);
      if (expected === undefined) {
        const last = Number.parseInt(await fsp.readFile(`${file}.seq`, 'utf8').catch(() => ''), 10);
        expected = Number.isInteger(last) ? last + 1 : 0;
      }
      if (seq < expected) return { ok: true, duplicate: true, next: expected };
      if (seq > expected) return { ok: false, next: expected };
      await fsp.appendFile(file, buf);
      await fsp.writeFile(`${file}.seq`, String(seq));
      this.nextSeq.set(file, seq + 1);
      return { ok: true, next: seq + 1 };
    });
  }

  async listSessionIds(pid) {
    const dir = path.join(this.projectDir(pid), 'sessions');
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name).sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async loadSessions(pid) {
    const out = [];
    for (const id of await this.listSessionIds(pid)) {
      const dir = this.sessionDir(pid, id);
      const raw = await fsp.readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => '');
      const events = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // a line cut off by a crash
        }
      }
      out.push({ id, dir, events });
    }
    return out;
  }

  /** Disk use of a project and free space on the disk, in bytes. */
  async storage(pid) {
    const dir = this.projectDir(pid);
    await this.getProject(pid);
    let free = null;
    try {
      const fsStat = await fsp.statfs(this.dataDir);
      free = fsStat.bavail * fsStat.bsize;
    } catch {
      // statfs needs Node 18.15+
    }
    return {
      raw: await dirSize(path.join(dir, 'sessions')),
      cache: await dirSize(path.join(dir, 'build')),
      exports: await dirSize(path.join(dir, 'exports')),
      free,
    };
  }

  /**
   * Deletes the intermediate files of an export. Recordings and finished videos
   * stay; the next export just takes longer because it prepares them again.
   */
  async clearCache(pid) {
    const dir = path.join(this.projectDir(pid), 'build');
    const freed = await dirSize(dir);
    await fsp.rm(dir, { recursive: true, force: true });
    return { freed };
  }

  /**
   * Where the recording of a session that never ended properly (browser
   * closed or crashed) stops. Chunks arrive about once a second, so the number
   * of stored camera chunks is a good estimate. The export measures it exactly.
   */
  async estimateEnd(raw) {
    const cam = parseSession(raw).tracks.find((t) => t.kind === 'camera');
    if (!cam) return undefined;
    const last = Number.parseInt(await fsp.readFile(path.join(raw.dir, `${cam.file}.seq`), 'utf8').catch(() => ''), 10);
    return Number.isInteger(last) ? cam.start + (last + 1) * 1000 : undefined;
  }

  /** Every take of every cue, with which one the export would use. */
  async takeSummary(pid) {
    const project = await this.getProject(pid);
    const sessions = [];
    for (const raw of await this.loadSessions(pid)) {
      let parsed = parseSession(raw);
      if (!parsed.ended) parsed = parseSession(raw, { endHint: await this.estimateEnd(raw) });
      sessions.push(parsed);
    }
    const { byCue } = chooseTakes(sessions, new Set(project.excludedTakes ?? []));
    const cues = {};
    for (const [cueId, list] of byCue) {
      cues[cueId] = list.map((t) => ({
        takeId: t.takeId,
        sessionId: t.sessionId,
        wall: t.wall != null ? t.wall + t.start : null,
        duration: t.duration,
        ng: t.ng,
        tooShort: t.tooShort,
        excluded: t.excluded,
        chosen: t.chosen,
        incomplete: !!t.incomplete,
        endReason: t.endReason,
      }));
    }
    return {
      sessions: sessions.map((s) => ({ id: s.id, wall: s.wall, ended: s.ended, takeCount: s.takes.length })),
      cues,
    };
  }
}
