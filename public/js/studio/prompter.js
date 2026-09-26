// The prompter is a small always-on-top window (Chrome's Document
// Picture-in-Picture). It floats above the demo tab, and because only the demo
// tab is recorded it never shows up in the video.

const FONT_KEY = 'vc.prompter.font';

function loadFont() {
  const n = Number(localStorage.getItem(FONT_KEY));
  return n >= 18 && n <= 72 ? n : 32;
}

const TEMPLATE = `
  <div class="pp">
    <div class="pp-status">
      <span class="pp-dot"></span>
      <span class="pp-state"></span>
      <span class="pp-pos"></span>
      <span class="pp-take"></span>
      <span class="pp-clock"></span>
      <span class="pp-spacer"></span>
      <button class="pp-font" data-act="font-down" title="글자 작게">가-</button>
      <button class="pp-font" data-act="font-up" title="글자 크게">가+</button>
    </div>
    <div class="pp-title"><span class="pp-type"></span><span class="pp-title-text"></span></div>
    <div class="pp-warn" hidden></div>
    <div class="pp-url" hidden><span class="pp-url-text"></span><button data-act="copy-url">링크 복사</button></div>
    <div class="pp-script"></div>
    <div class="pp-bottom">
      <div class="pp-next"></div>
      <div class="pp-buttons">
        <button data-act="retake" class="pp-btn">⟲ 다시</button>
        <button data-act="pause" class="pp-btn pp-pause">❚❚ 일시정지</button>
        <button data-act="next" class="pp-btn pp-primary">다음 ▶</button>
      </div>
    </div>
    <div class="pp-count" hidden></div>
  </div>`;

export class Prompter {
  constructor({ onAction, onKey, onClose }) {
    this.onAction = onAction;
    this.onKey = onKey;
    this.onClose = onClose;
    this.win = null;
    this.state = {};
    this.font = loadFont();
    this.lastScript = null;
  }

  static get supported() {
    return 'documentPictureInPicture' in window;
  }

  get isOpen() {
    return !!this.win && !this.win.closed;
  }

  async open() {
    if (!Prompter.supported) throw new Error('이 브라우저는 프롬프터 창을 지원하지 않습니다. 크롬을 사용해 주세요.');
    if (this.isOpen) return;
    const win = await window.documentPictureInPicture.requestWindow({ width: 760, height: 330 });
    this.win = win;
    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('/css/prompter.css', location.href).href;
    win.document.head.append(link);
    win.document.title = '프롬프터';
    win.document.body.innerHTML = TEMPLATE;
    this.el = (sel) => win.document.querySelector(sel);
    win.document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'font-up' || act === 'font-down') this.setFont(this.font + (act === 'font-up' ? 4 : -4));
      else if (act === 'copy-url') this.copyUrl();
      else this.onAction(act);
    });
    // Buttons must not keep focus, or the next key press would click them again.
    win.document.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    win.document.addEventListener('keydown', (e) => this.onKey(e));
    win.addEventListener('pagehide', () => {
      this.win = null;
      this.lastScript = null;
      this.onClose?.();
    });
    this.applyFont();
    this.render();
  }

  close() {
    this.win?.close();
  }

  setFont(px) {
    this.font = Math.min(72, Math.max(18, px));
    try {
      localStorage.setItem(FONT_KEY, String(this.font));
    } catch {
      // not remembered
    }
    this.applyFont();
  }

  applyFont() {
    if (this.isOpen) this.win.document.documentElement.style.setProperty('--font', `${this.font}px`);
  }

  async copyUrl() {
    const url = this.state.url;
    if (!url) return;
    try {
      await (this.win?.navigator.clipboard ?? navigator.clipboard).writeText(url);
      this.flash('링크를 복사했습니다');
    } catch {
      this.flash('복사하지 못했습니다');
    }
  }

  flash(text) {
    if (!this.isOpen) return;
    const warn = this.el('.pp-warn');
    warn.textContent = text;
    warn.hidden = false;
    setTimeout(() => this.render(), 1500);
  }

  update(state) {
    this.state = { ...this.state, ...state };
    this.render();
  }

  render() {
    if (!this.isOpen) return;
    const s = this.state;
    const root = this.el('.pp');
    root.dataset.status = s.status ?? 'setup';
    this.el('.pp-state').textContent = s.statusText ?? '';
    this.el('.pp-pos').textContent = s.position ?? '';
    this.el('.pp-take').textContent = s.take ?? '';
    this.el('.pp-clock').textContent = s.clock ?? '';
    this.el('.pp-type').textContent = s.typeLabel ?? '';
    this.el('.pp-type').dataset.type = s.type ?? '';
    this.el('.pp-title-text').textContent = s.title ?? '';
    this.el('.pp-next').textContent = s.nextTitle ? `다음: ${s.nextTitle}` : '마지막 장면';
    const warn = this.el('.pp-warn');
    warn.hidden = !s.warn;
    warn.textContent = s.warn ?? '';
    const url = this.el('.pp-url');
    url.hidden = !s.url;
    this.el('.pp-url-text').textContent = s.url ?? '';
    this.el('.pp-pause').textContent = s.status === 'paused' ? '▶ 이어서' : '❚❚ 일시정지';
    const script = s.script ?? '';
    if (script !== this.lastScript) {
      const box = this.el('.pp-script');
      box.textContent = script || '(대본 없음)';
      box.classList.toggle('empty', !script);
      box.scrollTop = 0;
      this.lastScript = script;
    }
    const count = this.el('.pp-count');
    count.hidden = !s.countdown;
    count.textContent = s.countdown ?? '';
  }
}
