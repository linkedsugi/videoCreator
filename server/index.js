import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Store, HttpError } from './store.js';
import { BuildManager } from './build/manager.js';
import { SlideConverter } from './convert.js';
import { findFfmpeg } from './build/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bodyBuffer(req) {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

export async function createApp({ dataDir = path.join(ROOT, 'projects'), ffmpeg, converter } = {}) {
  const store = new Store(dataDir);
  await store.init();
  const ff = ffmpeg === undefined ? await findFfmpeg() : ffmpeg;
  const builds = new BuildManager({ store, ffmpeg: ff });
  const slides = converter ?? new SlideConverter(path.join(store.dataDir, '_convert'));

  const app = express();
  app.disable('x-powered-by');
  const json = express.json({ limit: '10mb' });
  const binary = (limit) => express.raw({ type: () => true, limit });

  const api = express.Router();
  api.get('/health', async (req, res) => {
    res.json({
      ok: true,
      platform: process.platform,
      ffmpeg: ff ? { version: ff.version, encoder: ff.h264 } : null,
      converters: await slides.available(),
    });
  });

  // PowerPoint file → PDF (slide images) or .pptx (speaker notes of old .ppt files).
  api.post('/convert', binary('500mb'), async (req, res) => {
    const to = req.query.to === 'pptx' ? 'pptx' : 'pdf';
    const ext = path.extname(String(req.query.name ?? '')).toLowerCase();
    if (ext !== '.pptx' && ext !== '.ppt') throw new HttpError(400, 'PowerPoint 파일(.pptx, .ppt)만 변환할 수 있습니다.');
    const data = bodyBuffer(req);
    if (!data.length) throw new HttpError(400, '빈 파일입니다.');
    const { file, via } = await slides.convert(data, ext, to);
    res.setHeader('X-Converted-By', via);
    res.type(to === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.sendFile(file, { dotfiles: 'allow' }, (err) => {
      fsp.rm(file, { force: true });
      if (err && !res.headersSent) res.status(500).json({ error: `변환한 파일을 보내지 못했습니다: ${err.message}` });
    });
  });

  api.get('/projects', async (req, res) => res.json(await store.listProjects()));
  api.post('/projects', json, async (req, res) => res.status(201).json(await store.createProject(req.body ?? {})));
  api.get('/projects/:pid', async (req, res) => res.json(await store.getProject(req.params.pid)));
  api.put('/projects/:pid', json, async (req, res) => res.json(await store.saveProject(req.params.pid, req.body ?? {})));
  api.get('/projects/:pid/takes', async (req, res) => res.json(await store.takeSummary(req.params.pid)));

  api.post('/projects/:pid/slides/begin', async (req, res) => {
    await store.beginSlides(req.params.pid);
    res.json({ ok: true });
  });
  api.put('/projects/:pid/slides/staging/:page', binary('50mb'), async (req, res) => {
    await store.putStagedSlide(req.params.pid, Number(req.params.page), bodyBuffer(req));
    res.json({ ok: true });
  });
  api.post('/projects/:pid/slides/commit', json, async (req, res) => {
    res.json(await store.commitSlides(req.params.pid, Number(req.body?.count)));
  });

  api.post('/projects/:pid/sessions', json, async (req, res) => {
    res.status(201).json(await store.createSession(req.params.pid, req.body ?? {}));
  });
  api.post('/projects/:pid/sessions/:sid/tracks/:file/chunks', binary('256mb'), async (req, res) => {
    const { pid, sid, file } = req.params;
    const r = await store.appendTrackChunk(pid, sid, file, Number(req.query.seq), bodyBuffer(req));
    res.status(r.ok ? 200 : 409).json(r);
  });
  api.post('/projects/:pid/sessions/:sid/events', binary('1mb'), async (req, res) => {
    const r = await store.appendEvent(req.params.pid, req.params.sid, Number(req.query.seq), bodyBuffer(req));
    res.status(r.ok ? 200 : 409).json(r);
  });

  api.post('/projects/:pid/build', async (req, res) => res.status(202).json(await builds.start(req.params.pid)));
  api.get('/projects/:pid/storage', async (req, res) => res.json(await store.storage(req.params.pid)));
  api.delete('/projects/:pid/cache', async (req, res) => {
    if (builds.isRunning(req.params.pid)) throw new HttpError(409, '영상을 만드는 중에는 정리할 수 없습니다.');
    res.json(await store.clearCache(req.params.pid));
  });
  api.get('/projects/:pid/build', (req, res) => res.json(builds.status(req.params.pid)));

  // Opens the project's folder in Finder (macOS only).
  api.post('/projects/:pid/open', json, async (req, res) => {
    await store.getProject(req.params.pid);
    if (process.platform !== 'darwin') throw new HttpError(501, '폴더 열기는 macOS에서만 됩니다.');
    const dir = path.join(store.projectDir(req.params.pid), req.body?.target === 'exports' ? 'exports' : '');
    spawn('open', [dir], { stdio: 'ignore', detached: true }).unref();
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: '없는 API입니다.' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? `서버 오류: ${err.message}` : err.message });
  });

  app.use('/api', api);

  const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');
  const staticDir = (dir) => express.static(path.join(ROOT, dir), {
    setHeaders: (res, file) => {
      noCache(res);
      if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    },
  });
  app.use('/vendor/pdfjs', staticDir('node_modules/pdfjs-dist/build'));
  app.use('/vendor/pdfjs-cmaps', staticDir('node_modules/pdfjs-dist/cmaps'));
  app.use('/vendor/pdfjs-fonts', staticDir('node_modules/pdfjs-dist/standard_fonts'));
  app.use('/vendor/jszip', staticDir('node_modules/jszip/dist'));
  app.use('/data', express.static(store.dataDir, { setHeaders: noCache, dotfiles: 'ignore' }));
  app.use(staticDir('public'));

  return { app, store, builds, ffmpeg: ff, converter: slides };
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'darwin') {
    const chrome = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    chrome.on('exit', (code) => {
      if (code !== 0) spawn('open', [url], { stdio: 'ignore' });
    });
  }
}

async function main() {
  const port = Number(process.env.PORT) || 4545;
  const { app, ffmpeg, store } = await createApp({ dataDir: process.env.VC_DATA_DIR || undefined });
  const url = `http://localhost:${port}`;

  // Listen on both loopback addresses so "localhost" works whichever one the
  // browser picks, without exposing recordings to the network.
  const servers = [];
  await new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
    servers.push(server);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n포트 ${port}를 이미 쓰고 있습니다. 이미 켜져 있다면 크롬에서 ${url} 을 여세요.\n`);
      process.exit(1);
    }
    throw err;
  });
  const v6 = http.createServer(app);
  v6.on('error', () => {});
  v6.listen(port, '::1');
  servers.push(v6);

  console.log('\n  강의 스튜디오가 켜졌습니다.');
  console.log(`  크롬에서 여세요: ${url}`);
  console.log(`  데이터 폴더: ${store.dataDir}`);
  console.log(ffmpeg ? `  FFmpeg: ${ffmpeg.bin} (${ffmpeg.h264})` : '  ⚠ FFmpeg를 찾지 못했습니다. 녹화는 되지만 MP4 만들기는 안 됩니다.');
  console.log('  끄려면 이 창에서 Ctrl+C\n');
  openBrowser(url);

  const shutdown = () => {
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
