import { spawn } from 'node:child_process';

const TAIL = 4000;

function tail(text, n = TAIL) {
  return text.length > n ? text.slice(-n) : text;
}

/** Runs a binary and collects its output. Never rejects on a non-zero exit code. */
function capture(bin, args, { timeoutMs = 20000, keep = 200000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout = tail(stdout + d, keep);
    });
    child.stderr.on('data', (d) => {
      stderr = tail(stderr + d, keep);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function versionOf(bin) {
  try {
    const r = await capture(bin, ['-hide_banner', '-version']);
    return r.code === 0 ? r.stdout.split('\n')[0].trim() : null;
  } catch {
    return null;
  }
}

async function canEncode(bin, encoder) {
  const r = await capture(bin, [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2',
    '-c:v', encoder, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
  ]).catch(() => ({ code: 1 }));
  return r.code === 0;
}

async function pickH264(bin) {
  const r = await capture(bin, ['-hide_banner', '-encoders']).catch(() => null);
  if (!r || r.code !== 0) return null;
  if (process.platform === 'darwin' && r.stdout.includes('h264_videotoolbox') && (await canEncode(bin, 'h264_videotoolbox'))) {
    return 'h264_videotoolbox';
  }
  if (r.stdout.includes('libx264') && (await canEncode(bin, 'libx264'))) return 'libx264';
  return null;
}

/**
 * Finds a usable FFmpeg. Homebrew's build is preferred on macOS because it has
 * the hardware H.264 encoder; the bundled ffmpeg-static is the fallback.
 * @returns {Promise<{bin: string, version: string, h264: string} | null>}
 */
export async function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg');
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default) candidates.push(mod.default);
  } catch {
    // optional dependency not installed
  }
  for (const bin of candidates) {
    const version = await versionOf(bin);
    if (!version) continue;
    const h264 = await pickH264(bin);
    if (h264) return { bin, version, h264 };
  }
  return null;
}

/** Video encoder options. `purpose` is 'intermediate' (edit-friendly) or 'final'. */
export function videoEncoderArgs(ff, purpose) {
  const gop = purpose === 'intermediate' ? '30' : '60';
  if (ff.h264 === 'h264_videotoolbox') {
    // Slides and a small face window need far less than camera footage; about
    // 1.3 GB for 35 minutes keeps files uploadable to a university LMS.
    const rate = purpose === 'intermediate' ? ['-b:v', '12M'] : ['-b:v', '5M', '-maxrate', '8M', '-bufsize', '10M'];
    return ['-c:v', 'h264_videotoolbox', ...rate, '-profile:v', 'high', '-g', gop, '-pix_fmt', 'yuv420p'];
  }
  const crf = purpose === 'intermediate' ? '18' : '20';
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-g', gop, '-pix_fmt', 'yuv420p'];
}

const PROGRESS_ARGS = ['-progress', 'pipe:1', '-stats_period', '0.5', '-nostats'];

function runOnce(ff, args, { totalSec, onProgress, stallMs }) {
  return new Promise((resolve, reject) => {
    // Progress lines arrive every half second, so silence means FFmpeg is stuck.
    const child = spawn(ff.bin, ['-nostdin', ...PROGRESS_ARGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    let lastActivity = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) {
        stalled = true;
        child.kill('SIGKILL');
      }
    }, 1000);
    child.stderr.on('data', (d) => {
      lastActivity = Date.now();
      stderr = tail(stderr + d, 100000);
    });
    child.stdout.on('data', (d) => {
      lastActivity = Date.now();
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && totalSec > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSec));
      }
    });
    child.on('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      if (code === 0 && !stalled) return resolve({ stderr });
      const err = new Error(
        stalled
          ? 'FFmpeg가 응답하지 않아 중단했습니다.'
          : `FFmpeg가 실패했습니다 (코드 ${code}).\n${tail(stderr, 1500)}`,
      );
      err.stalled = stalled;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/**
 * Runs FFmpeg. With `totalSec`, reports progress (0–1). A run that stops
 * making progress is killed and started again, up to `retries` times.
 */
export async function runFfmpeg(ff, args, { totalSec, onProgress, stallMs = 60000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(ff, args, { totalSec, onProgress, stallMs });
    } catch (err) {
      if (!err.stalled || attempt >= retries) throw err;
      console.warn(`[ffmpeg] stalled, retrying (${attempt + 1}/${retries})`);
    }
  }
}

function parseClock(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

/** Reads duration, audio presence and video size from `ffmpeg -i` output. */
export async function probeMedia(ff, file) {
  const r = await capture(ff.bin, ['-hide_banner', '-i', file], { timeoutMs: 60000 });
  const text = r.stderr;
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const v = /Stream #\d+:\d+.*?: Video: .*?, (\d{2,5})x(\d{2,5})/.exec(text);
  return {
    duration: d ? parseClock(d[1], d[2], d[3]) : null,
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(text),
    video: v ? { width: Number(v[1]), height: Number(v[2]) } : null,
  };
}

/**
 * Duration of a file without a duration header (browser recordings), found by
 * reading it through once without decoding.
 */
export async function scanDuration(ff, file) {
  const r = await capture(ff.bin, ['-hide_banner', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], {
    timeoutMs: 15 * 60000,
    keep: 20000,
  });
  const all = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  return parseClock(last[1], last[2], last[3]);
}
