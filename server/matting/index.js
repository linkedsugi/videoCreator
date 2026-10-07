// Runs presenter cut-out jobs on a small pool of worker threads, so the server
// keeps answering (recording uploads, progress polls) while they run.

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.js');
export const MODEL_FILE = path.join(HERE, 'models', 'selfie-segmenter.onnx');
/** Bump when the matte changes, so cached mattes are made again. */
export const MATTE_VERSION = 1;

let available = null;

/** Whether cutting out the presenter works here (model + runtime installed). */
export async function mattingAvailable() {
  if (available === null) {
    try {
      await fsp.access(MODEL_FILE);
      await import('onnxruntime-web');
      available = true;
    } catch {
      available = false;
    }
  }
  return available;
}

export function defaultWorkerCount() {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export class MattingPool {
  constructor({ size = defaultWorkerCount() } = {}) {
    this.size = size;
    this.idle = [];
    this.all = new Set();
    this.queue = [];
    this.nextId = 1;
  }

  #spawn() {
    const worker = new Worker(WORKER);
    worker.unref();
    const slot = { worker, task: null };
    worker.on('message', (msg) => {
      const task = slot.task;
      if (!task || msg.id !== task.id) return;
      if (msg.type === 'progress') {
        task.onProgress?.(msg);
        return;
      }
      slot.task = null;
      if (msg.type === 'done') task.resolve(msg.result);
      else task.reject(new Error(msg.message));
      this.#release(slot);
    });
    const fail = (err) => {
      this.all.delete(slot);
      this.idle = this.idle.filter((s) => s !== slot);
      if (slot.task) {
        slot.task.reject(err instanceof Error ? err : new Error(`배경 지우기 작업이 멈췄습니다 (코드 ${err}).`));
        slot.task = null;
      }
      this.#pump();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (this.all.has(slot)) fail(code);
    });
    this.all.add(slot);
    return slot;
  }

  #release(slot) {
    this.idle.push(slot);
    this.#pump();
  }

  #pump() {
    while (this.queue.length) {
      let slot = this.idle.pop();
      if (!slot) {
        if (this.all.size >= this.size) return;
        slot = this.#spawn();
      }
      const task = this.queue.shift();
      slot.task = task;
      slot.worker.postMessage({ id: task.id, job: task.job });
    }
  }

  /** Runs one job; `onProgress` gets `{frames}` updates for footage jobs. */
  run(job, onProgress) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject, onProgress });
      this.#pump();
    });
  }

  async close() {
    const slots = [...this.all];
    this.all.clear();
    this.idle = [];
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}
