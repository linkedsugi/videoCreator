// Converts PowerPoint files with whatever the Mac has, in order of fidelity:
// Microsoft PowerPoint (looks exactly like the original), Keynote, LibreOffice.
//
// to 'pdf':  slide images come from the PDF.
// to 'pptx': old .ppt files are turned into .pptx so their speaker notes can be read.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HttpError } from './store.js';

const TIMEOUT_MS = 5 * 60 * 1000;

// PowerPoint and Keynote may first ask for permission (to be controlled, or to
// access the folder). The generous timeout leaves time to answer.
const POWERPOINT_SCRIPT = `
on run argv
  set inFile to POSIX file (item 1 of argv)
  set outPath to (POSIX file (item 2 of argv)) as text
  set wantPdf to (item 3 of argv) is "pdf"
  with timeout of 280 seconds
    tell application "Microsoft PowerPoint"
      open inFile
      set pres to active presentation
      if wantPdf then
        save pres in outPath as save as PDF
      else
        save pres in outPath as save as Open XML presentation
      end if
      close pres saving no
    end tell
  end timeout
end run`;

const KEYNOTE_SCRIPT = `
on run argv
  set inFile to POSIX file (item 1 of argv)
  set outFile to POSIX file (item 2 of argv)
  set wantPdf to (item 3 of argv) is "pdf"
  with timeout of 280 seconds
    tell application "Keynote"
      set theDoc to open inFile
      if wantPdf then
        export theDoc to outFile as PDF
      else
        export theDoc to outFile as Microsoft PowerPoint
      end if
      close theDoc saving no
    end tell
  end timeout
end run`;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
        reject(new Error(err.killed ? '시간이 너무 오래 걸려 중단했습니다.' : detail));
      } else resolve({ stdout, stderr });
    });
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findApp(name) {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const app = path.join(dir, `${name}.app`);
    if (await exists(app)) return app;
  }
  return null;
}

async function findOnPath(bin) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && (await exists(path.join(dir, bin)))) return path.join(dir, bin);
  }
  return null;
}

function appleScriptConverter({ id, label, appName, script }) {
  return {
    id,
    label,
    async available() {
      return process.platform === 'darwin' && !!(await findApp(appName));
    },
    async convert(input, output, to) {
      const file = path.join(os.tmpdir(), `videocreator-${id}.applescript`);
      await fsp.writeFile(file, script);
      await run('osascript', [file, input, output, to]);
    },
  };
}

export const libreOffice = {
  id: 'libreoffice',
  label: 'LibreOffice',
  async bin() {
    const mac = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    if (process.platform === 'darwin' && (await exists(mac))) return mac;
    return findOnPath('soffice');
  },
  async available() {
    return !!(await this.bin());
  },
  async convert(input, output, to) {
    const outDir = path.join(path.dirname(output), `lo-${crypto.randomBytes(4).toString('hex')}`);
    // A separate profile lets it run even while LibreOffice is open.
    const profile = pathToFileURL(path.join(os.tmpdir(), 'videocreator-lo-profile')).href;
    try {
      await run(await this.bin(), [
        '--headless', '--norestore', `-env:UserInstallation=${profile}`,
        '--convert-to', to, '--outdir', outDir, input,
      ]);
      const produced = path.join(outDir, `${path.basename(input, path.extname(input))}.${to}`);
      await fsp.rename(produced, output);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  },
};

export const CONVERTERS = [
  appleScriptConverter({ id: 'powerpoint', label: 'PowerPoint', appName: 'Microsoft PowerPoint', script: POWERPOINT_SCRIPT }),
  appleScriptConverter({ id: 'keynote', label: 'Keynote', appName: 'Keynote', script: KEYNOTE_SCRIPT }),
  libreOffice,
];

export class SlideConverter {
  /** @param {string} workDir PowerPoint remembers folder access, so one fixed folder is used. */
  constructor(workDir, converters = CONVERTERS) {
    this.workDir = workDir;
    this.converters = converters;
    this.queue = Promise.resolve();
  }

  async available() {
    const out = [];
    for (const c of this.converters) if (await c.available()) out.push(c.id);
    return out;
  }

  /**
   * @param {Buffer} data  the .pptx / .ppt file
   * @param {string} ext   '.pptx' or '.ppt'
   * @param {'pdf'|'pptx'} to
   * @returns {Promise<{file: string, via: string}>} caller deletes `file`
   */
  convert(data, ext, to) {
    // One at a time: these apps are driven through their windows.
    const job = this.queue.then(() => this.convertNow(data, ext, to));
    this.queue = job.catch(() => {});
    return job;
  }

  async convertNow(data, ext, to) {
    await fsp.mkdir(this.workDir, { recursive: true });
    const base = path.join(this.workDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const input = `${base}${ext}`;
    const output = `${base}-out.${to}`;
    await fsp.writeFile(input, data);
    const failures = [];
    try {
      for (const c of this.converters) {
        if (!(await c.available())) continue;
        try {
          await c.convert(input, output, to);
          const stat = await fsp.stat(output).catch(() => null);
          if (!stat || stat.size === 0) throw new Error('결과 파일이 만들어지지 않았습니다.');
          return { file: output, via: c.id };
        } catch (err) {
          failures.push(`${c.label}: ${err.message}`);
          await fsp.rm(output, { force: true });
        }
      }
    } finally {
      await fsp.rm(input, { force: true });
    }
    const reason = failures.length
      ? `PowerPoint 파일을 변환하지 못했습니다.\n${failures.join('\n')}`
      : 'PowerPoint 파일을 변환할 프로그램(PowerPoint, Keynote, LibreOffice)이 없습니다.';
    throw new HttpError(422, reason);
  }
}
