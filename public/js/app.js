import { renderHome } from './views/home.js';
import { renderProject } from './views/project.js';
import { renderTakes } from './views/takes.js';
import { renderStudio } from './views/studio.js';
import { checkNavGuard } from './nav.js';
import { html, toast } from './ui.js';

const root = document.getElementById('app');
let cleanup = null;
let currentHash = null;
let routing = Promise.resolve();

async function route() {
  if (currentHash !== null && location.hash !== currentHash && !checkNavGuard()) {
    history.replaceState(null, '', currentHash);
    return;
  }
  currentHash = location.hash;
  document.getElementById('toasts')?.replaceChildren();
  if (cleanup) {
    const fn = cleanup;
    cleanup = null;
    try {
      await fn();
    } catch (err) {
      console.error(err);
    }
  }
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  root.innerHTML = '<div class="page narrow"><p class="muted">불러오는 중…</p></div>';
  try {
    if (parts[0] === 'p' && parts[1]) {
      const view = parts[2] === 'studio' ? renderStudio : parts[2] === 'takes' ? renderTakes : renderProject;
      document.body.classList.toggle('dark', parts[2] === 'studio');
      cleanup = await view(root, { pid: decodeURIComponent(parts[1]), params });
    } else {
      document.body.classList.remove('dark');
      cleanup = await renderHome(root, { params });
    }
  } catch (err) {
    console.error(err);
    root.innerHTML = String(html`
      <div class="page narrow">
        <div class="notice error">${err.message}</div>
        <a class="btn" href="#/">처음으로</a>
      </div>`);
  }
}

window.addEventListener('hashchange', () => {
  routing = routing.then(route);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(e.reason?.message ?? String(e.reason), 'error', 8000);
});
routing = routing.then(route);
