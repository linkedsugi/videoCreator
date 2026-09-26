import { buildProject } from './builder.js';
import { HttpError } from '../store.js';

/** Runs one export at a time and keeps each project's latest job status. */
export class BuildManager {
  constructor({ store, ffmpeg }) {
    this.store = store;
    this.ffmpeg = ffmpeg;
    this.jobs = new Map();
    this.active = null;
  }

  status(pid) {
    const job = this.jobs.get(pid);
    return job ? { ...job } : { state: 'idle' };
  }

  async start(pid) {
    await this.store.getProject(pid);
    if (!this.ffmpeg) {
      throw new HttpError(503, 'FFmpeg를 찾지 못했습니다. README의 설치 안내를 확인해 주세요.');
    }
    if (this.active) {
      throw new HttpError(409, this.active.pid === pid ? '이미 영상을 만드는 중입니다.' : '다른 강의 영상을 만드는 중입니다. 끝난 뒤 다시 시도해 주세요.');
    }
    const job = {
      pid,
      state: 'running',
      step: '시작하는 중',
      progress: 0,
      startedAt: Date.now(),
      finishedAt: null,
      output: null,
      warnings: [],
      error: null,
    };
    this.jobs.set(pid, job);
    this.active = job;
    buildProject({
      store: this.store,
      pid,
      ffmpeg: this.ffmpeg,
      onProgress: ({ step, progress }) => {
        job.step = step;
        if (typeof progress === 'number') job.progress = progress;
      },
    })
      .then((result) => {
        job.state = 'done';
        job.progress = 1;
        job.step = '완료';
        job.output = result;
        job.warnings = result.warnings;
      })
      .catch((err) => {
        console.error('[build]', err);
        job.state = 'error';
        job.error = err.message;
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.active = null;
      });
    return { ...job };
  }
}
