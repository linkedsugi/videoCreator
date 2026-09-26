// Chrome slows down timers in hidden tabs, up to one wake-up per minute. The
// studio tab is hidden while a demo runs in another tab, yet its countdown and
// clock must keep time (the prompter window shows them). Timers in a worker
// are not slowed down that way, so they run there.

const SOURCE = `
const intervals = new Map();
onmessage = ({ data }) => {
  if (data.type === 'timeout') setTimeout(() => postMessage(data.id), data.ms);
  else if (data.type === 'interval') intervals.set(data.id, setInterval(() => postMessage(data.id), data.ms));
  else if (data.type === 'clear') { clearInterval(intervals.get(data.id)); intervals.delete(data.id); }
};`;

let worker = null;
let nextId = 1;
const callbacks = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' })));
    worker.onmessage = ({ data: id }) => callbacks.get(id)?.();
  }
  return worker;
}

export function steadySleep(ms) {
  return new Promise((resolve) => {
    const id = nextId++;
    callbacks.set(id, () => {
      callbacks.delete(id);
      resolve();
    });
    getWorker().postMessage({ type: 'timeout', id, ms });
  });
}

/** Calls fn every `ms`; returns a function that stops it. */
export function steadyInterval(fn, ms) {
  const id = nextId++;
  callbacks.set(id, fn);
  getWorker().postMessage({ type: 'interval', id, ms });
  return () => {
    callbacks.delete(id);
    getWorker().postMessage({ type: 'clear', id });
  };
}
