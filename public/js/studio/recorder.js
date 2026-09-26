import { sleep } from '../ui.js';

/**
 * Sends numbered chunks to the server one at a time, in order, retrying until
 * each is stored. Chunks stay in memory until the server confirms them.
 */
export class SeqUploader {
  constructor(urlFor, onChange = () => {}) {
    this.urlFor = urlFor;
    this.onChange = onChange;
    this.queue = [];
    this.seq = 0;
    this.running = false;
    this.savedBytes = 0;
    this.error = null;
    this.waiters = [];
  }

  get pending() {
    return this.queue.length;
  }

  push(blob) {
    this.queue.push({ seq: this.seq++, blob });
    this.onChange();
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    let delay = 500;
    while (this.queue.length) {
      const item = this.queue[0];
      try {
        const res = await fetch(this.urlFor(item.seq), {
          method: 'POST',
          body: item.blob,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          // The server already has this chunk (an earlier attempt landed).
          if (typeof body.next === 'number' && body.next > item.seq) {
            this.queue.shift();
            continue;
          }
          throw new Error(`저장 순서 오류 (서버는 ${body.next}번을 기다림)`);
        }
        if (!res.ok) throw new Error(`저장 실패 (HTTP ${res.status})`);
        this.queue.shift();
        this.savedBytes += item.blob.size;
        this.error = null;
        delay = 500;
        this.onChange();
      } catch (err) {
        this.error = err;
        this.onChange();
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
    this.running = false;
    this.waiters.splice(0).forEach((resolve) => resolve(true));
    this.onChange();
  }

  /** Resolves true once everything is saved, or false after `timeoutMs`. */
  flush(timeoutMs = 60000) {
    if (!this.queue.length && !this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setTimeout(() => resolve(false), timeoutMs);
    });
  }
}

export function pickMimeType(stream) {
  const hasAudio = stream.getAudioTracks().length > 0;
  for (const codec of ['h264', 'vp9', 'vp8']) {
    const type = hasAudio ? `video/webm;codecs=${codec},opus` : `video/webm;codecs=${codec}`;
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

/** Records one stream to one file, uploading a chunk every second. */
export class TrackRecorder {
  constructor(stream, { uploader, videoBitsPerSecond, onError }) {
    this.uploader = uploader;
    this.mimeType = pickMimeType(stream);
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond,
      audioBitsPerSecond: 160000,
      // A keyframe every second keeps long recordings quick to cut.
      // Browsers that don't know this option ignore it.
      videoKeyFrameIntervalDuration: 1000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.uploader.push(e.data);
    };
    this.recorder.onerror = (e) => onError?.(e.error ?? new Error('녹화 오류'));
  }

  /** Starts recording; resolves with the performance.now() of the start. */
  start() {
    return new Promise((resolve, reject) => {
      this.recorder.onstart = () => resolve(performance.now());
      try {
        this.recorder.start(1000);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Stops recording; resolves after the last chunk was handed to the uploader. */
  stop() {
    if (this.recorder.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      this.recorder.onstop = () => resolve();
      this.recorder.stop();
    });
  }
}

/** The session's event log, saved to the server in order. */
export class EventLog {
  constructor(urlFor, onChange) {
    this.uploader = new SeqUploader(urlFor, onChange);
  }

  log(event) {
    this.uploader.push(new Blob([JSON.stringify(event)], { type: 'application/json' }));
  }

  flush(timeoutMs) {
    return this.uploader.flush(timeoutMs);
  }
}
