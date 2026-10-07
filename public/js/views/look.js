// The look editor: how the finished video looks. A big preview of one scene
// (drag the presenter to move them), the settings beside it, and every scene
// below as a thumbnail that can be changed on its own.

import { api } from '../api.js';
import { html, $, $$, debounce, toast } from '../ui.js';
import { CUE_TYPES, cueTitle, showFaceOf, slideUrl } from '../cues.js';
import {
  OUT_W, OUT_H, CAPTION_COLORS, DEFAULT_PERSON, cleanLook, sceneLayout, sideFor, captionWindow, drawCaption,
} from '../look.js';

const SIDE_LABEL = { right: '오른쪽', left: '왼쪽', shrink: '슬라이드 줄이기' };
const PLACEMENT_HELP = {
  auto: '슬라이드마다 내용이 적은 쪽에 섭니다. 양쪽 다 차 있으면 슬라이드를 줄여 옆에 섭니다.',
  right: '모든 장면에서 오른쪽에 섭니다.',
  left: '모든 장면에서 왼쪽에 섭니다.',
};

// Stand-in presenter until there is a real picture: a figure in a 16:9 frame.
const SILHOUETTE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><g fill="#8a919c" fill-opacity=".92">'
  + '<circle cx="800" cy="300" r="150"/>'
  + '<path d="M420 900 C430 640 560 520 800 520 C1040 520 1170 640 1180 900 Z"/></g></svg>',
)}`;

const pct = (b) => `left:${(b.x / OUT_W) * 100}%;top:${(b.y / OUT_H) * 100}%;width:${(b.w / OUT_W) * 100}%;height:${(b.h / OUT_H) * 100}%`;

function kindOf(cue) {
  if (cue.type === 'slide') return 'slide';
  if (cue.type === 'face') return 'face';
  return 'screen';
}

/** Draws an image file (or slide) into a 1920×1080 JPEG, filling the frame. */
async function coverJpeg(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(OUT_W / img.naturalWidth, OUT_H / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

export async function renderLook(root, { pid, params }) {
  let project = await api.getProject(pid);
  let info = await api.lookInfo(pid).catch(() => ({ assets: {}, densities: [], matting: false }));
  let cutout = null;
  let cutoutState = 'loading';
  let selected = Math.max(0, project.cues.findIndex((c) => c.id === params.get('cue')));
  let captionUrl = info.assets.caption;
  let captionObjectUrl = null;
  let dragging = null;
  let disposed = false;
  let lookDirty = false;
  let captionDirty = false;

  const look = () => project.settings.look;
  const aspect = () => (cutout ? cutout.width / cutout.height : 16 / 9);
  const person = () => cutout?.person ?? DEFAULT_PERSON;
  const firstFaceIndex = () => project.cues.findIndex((c) => c.type === 'face');

  function sceneOf(cue, index) {
    const kind = kindOf(cue);
    const showFace = showFaceOf(cue);
    const side = kind === 'face' ? null : sideFor(cue, look(), info.densities[(cue.page ?? 0) - 1]);
    const spec = sceneLayout({ kind, side, showFace, look: look(), settings: project.settings, aspect: aspect(), person: person() });
    const caption = kind === 'face' && !!captionUrl && !!captionWindow(look(), { firstFace: index === firstFaceIndex() }, 60);
    return { kind, side, showFace, spec, caption };
  }

  // ---------- one composed picture ----------
  function stage(cue, index, { big = false } = {}) {
    const sc = sceneOf(cue, index);
    const { spec } = sc;
    const layers = [];
    const frame = cutout?.frameUrl;
    const contentLayer = (box, extra = '') => {
      if (cue.type === 'slide' && cue.page <= (project.slides?.count ?? 0)) {
        return html`<img class="layer content ${extra}" style="${pct(box)}" src="${slideUrl(project, cue.page)}" alt="" draggable="false">`;
      }
      if (cue.type === 'slide') return html`<div class="layer content mock ${extra}" style="${pct(box)}"><span>슬라이드 없음</span></div>`;
      return html`<div class="layer content mock ${cue.type} ${extra}" style="${pct(box)}"><span>${cue.type === 'video' ? '▶ 영상' : '데모 화면'}</span></div>`;
    };

    if (spec.backdrop === 'content-blur') {
      layers.push(contentLayer({ x: 0, y: 0, w: OUT_W, h: OUT_H }, 'blurred cover'));
      layers.push(contentLayer(spec.content, 'rounded'));
    } else if (spec.content) {
      layers.push(contentLayer(spec.content));
    } else if (spec.backdrop === 'image') {
      layers.push(info.assets.background
        ? html`<img class="layer cover" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}" src="${info.assets.background}" alt="" draggable="false">`
        : html`<div class="layer mock" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}"><span>배경 이미지를 골라 주세요</span></div>`);
    } else if (spec.backdrop === 'camera-blur') {
      layers.push(frame
        ? html`<img class="layer blurred" style="${pct(spec.camera)}" src="${frame}" alt="" draggable="false">`
        : html`<div class="layer room" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}"></div>`);
    }

    if (spec.camera) {
      const canDrag = big && spec.cut && sc.kind === 'slide' && sc.side !== 'shrink';
      const drag = canDrag ? 'data-drag="1"' : '';
      if (spec.cut) {
        layers.push(html`<img class="layer cam ${canDrag ? 'draggable' : ''}" ${drag} style="${pct(spec.camera)}" src="${cutout?.url ?? SILHOUETTE}" alt="발표자" draggable="false">`);
      } else if (spec.rounded) {
        layers.push(frame
          ? html`<img class="layer cam pip" style="${pct(spec.camera)}" src="${frame}" alt="" draggable="false">`
          : html`<div class="layer cam pip room" style="${pct(spec.camera)}"><img src="${SILHOUETTE}" alt=""></div>`);
      } else {
        layers.push(frame
          ? html`<img class="layer cam cover" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}" src="${frame}" alt="" draggable="false">`
          : html`<div class="layer room" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}"><img class="layer" style="${pct(spec.camera)}" src="${SILHOUETTE}" alt=""></div>`);
      }
    }
    if (sc.caption) layers.push(html`<img class="layer" style="${pct({ x: 0, y: 0, w: OUT_W, h: OUT_H })}" src="${captionObjectUrl ?? captionUrl}" alt="" draggable="false">`);
    return html`<div class="stage-frame ${big ? 'big' : ''}">${layers}</div>`;
  }

  function sideNote(cue, sc) {
    if (sc.kind === 'face') return look().faceBg === 'image' ? '가운데 · 배경 이미지' : look().faceBg === 'blur' ? '가운데 · 배경 흐리게' : '카메라 화면 그대로';
    if (!sc.showFace) return '발표자 없음';
    if (look().style === 'pip') return '작은 얼굴 창';
    const auto = !cue.side && look().placement === 'auto' && cue.type === 'slide';
    return `${SIDE_LABEL[sc.side]}${auto ? ' (자동)' : ''}`;
  }

  // ---------- page ----------
  function render() {
    const cues = project.cues;
    root.innerHTML = String(html`
      <header class="topbar">
        <a class="brand" href="#/">● 강의 스튜디오</a>
        <a class="link" href="#/p/${pid}">← ${project.title}</a>
        <span class="grow"></span>
        <a class="help-link" href="/guide.html#look" target="_blank" rel="noopener">사용법</a>
        <a class="btn" href="#/p/${pid}/takes">영상 만들기 →</a>
      </header>
      <main class="page wide look-page">
        <h1>화면 구성</h1>
        <p class="muted look-lead">완성 영상에서 발표자가 어디에, 어떻게 나올지 정합니다. 여기서 보이는 그대로 영상이 만들어집니다.
          ${cues.length ? '' : html`<b>먼저 슬라이드를 가져오거나 장면을 추가해 주세요.</b>`}</p>
        <div class="look-top">
          <div class="look-stage-col" id="stage-col">${stageColumn()}</div>
          <aside class="look-panel" id="panel">${panel()}</aside>
        </div>
        <section>
          <div class="section-head"><h2>장면별 미리보기</h2><span class="muted small">장면을 누르면 위에서 크게 보고, 그 장면만 따로 바꿀 수 있습니다.</span></div>
          <ol class="board" id="board">${board()}</ol>
        </section>
      </main>`);
    bind();
  }

  function stageColumn() {
    const cue = project.cues[selected];
    if (!cue) return html`<div class="stage-frame big empty"><span>장면이 없습니다</span></div>`;
    const sc = sceneOf(cue, selected);
    const canSide = sc.kind !== 'face' && look().style === 'cutout';
    const current = !sc.showFace ? 'none' : cue.side ?? 'default';
    return html`
      ${stage(cue, selected, { big: true })}
      <div class="stage-info">
        <span class="cue-num">${selected + 1}</span>
        <span class="type-badge t-${cue.type}">${CUE_TYPES[cue.type].label}</span>
        <b class="stage-title">${cueTitle(cue)}</b>
        <span class="muted">${sideNote(cue, sc)}</span>
        <span class="grow"></span>
        <button class="icon-btn" data-step="-1" title="이전 장면" ${selected === 0 ? 'disabled' : ''}>←</button>
        <button class="icon-btn" data-step="1" title="다음 장면" ${selected >= project.cues.length - 1 ? 'disabled' : ''}>→</button>
      </div>
      ${sc.kind === 'face' ? '' : html`
        <div class="stage-controls">
          <span class="opt-label">이 장면만</span>
          <div class="seg-picker" role="group">
            ${[['default', '기본'], ...(canSide ? [['right', '오른쪽'], ['left', '왼쪽'], ['shrink', '줄이기']] : [['show', '보이기']]), ['none', '발표자 없음']].map(([v, label]) => html`
              <button class="${current === v || (v === 'show' && current !== 'none' && current !== 'default') ? 'on' : ''}" data-scene="${v}">${label}</button>`)}
          </div>
        </div>`}
      ${look().style === 'cutout' && sc.kind === 'slide' && sc.side !== 'shrink' && sc.showFace
        ? html`<p class="hint">발표자를 좌우로 끌어 위치를 옮길 수 있습니다. 모든 슬라이드에 똑같이 적용됩니다.</p>` : ''}
      ${cutoutNote()}`;
  }

  function cutoutNote() {
    if (look().style !== 'cutout') return '';
    if (cutoutState === 'loading') return html`<p class="hint">발표자 모습을 불러오는 중…</p>`;
    if (!info.matting && look().keyer === 'ai') return html`<p class="notice warn small">배경 지우기 기능을 쓸 수 없습니다. 터미널에서 npm install을 다시 실행해 주세요.</p>`;
    if (!cutout) return html`<p class="hint">회색 인물은 자리 표시입니다. <a href="#/p/${pid}/studio">촬영 화면</a>에서 카메라를 한 번 켜면 실제 모습으로 바뀝니다.</p>`;
    if (!cutout.person) return html`<p class="notice warn small">카메라 화면에서 사람을 찾지 못했습니다. 상반신이 화면에 나오게 앉아 주세요.</p>`;
    return html`<p class="hint">${cutout.source === 'recording' ? '최근 녹화' : '촬영 화면에서 찍힌 카메라 사진'}으로 만든 미리보기입니다.</p>`;
  }

  function seg(name, value, options) {
    return html`<div class="seg-picker" role="group">${options.map(([v, label]) => html`
      <button class="${value === v ? 'on' : ''}" data-set="${name}" data-value="${v}">${label}</button>`)}</div>`;
  }

  function panel() {
    const L = look();
    const s = project.settings;
    const slideCount = project.slides?.count ?? 0;
    return html`
      <div class="look-group">
        <div class="group-title">화면 방식</div>
        <div class="style-cards">
          <button class="style-card ${L.style === 'cutout' ? 'on' : ''}" data-set="style" data-value="cutout">
            <svg viewBox="0 0 96 54" aria-hidden="true"><rect width="96" height="54" rx="4" fill="#e8edff"/><rect x="8" y="9" width="40" height="6" rx="2" fill="#3355ff"/><rect x="8" y="21" width="44" height="3" rx="1.5" fill="#98a2b3"/><rect x="8" y="28" width="38" height="3" rx="1.5" fill="#98a2b3"/><circle cx="74" cy="25" r="7" fill="#475467"/><path d="M60 54c0-12 6-17 14-17s14 5 14 17z" fill="#475467"/></svg>
            <b>발표자 합성</b><span>배경을 지우고 슬라이드 위에 (대학 샘플 방식)</span>
          </button>
          <button class="style-card ${L.style === 'pip' ? 'on' : ''}" data-set="style" data-value="pip">
            <svg viewBox="0 0 96 54" aria-hidden="true"><rect width="96" height="54" rx="4" fill="#e8edff"/><rect x="8" y="9" width="40" height="6" rx="2" fill="#3355ff"/><rect x="8" y="21" width="44" height="3" rx="1.5" fill="#98a2b3"/><rect x="8" y="28" width="38" height="3" rx="1.5" fill="#98a2b3"/><rect x="64" y="32" width="26" height="17" rx="3" fill="#475467"/></svg>
            <b>작은 얼굴 창</b><span>카메라 화면을 모서리에 작게</span>
          </button>
        </div>
      </div>
      ${L.style === 'cutout' ? html`
        <div class="look-group">
          <div class="group-title">발표자 위치</div>
          ${seg('placement', L.placement, [['auto', '자동'], ['right', '오른쪽'], ['left', '왼쪽']])}
          <p class="hint">${PLACEMENT_HELP[L.placement]}</p>
          <label class="slider-row"><span>크기</span><input type="range" id="size" min="0.55" max="1.1" step="0.01" value="${L.size}"><output id="size-out">${Math.round(L.size * 100)}%</output></label>
        </div>
        <div class="look-group">
          <div class="group-title">배경 지우기</div>
          ${seg('keyer', L.keyer, [['ai', 'AI 자동'], ['green', '초록 배경천']])}
          <p class="hint">${L.keyer === 'ai'
            ? '그냥 책상에 앉아 찍으면 됩니다. 뒤가 단순하고 밝을수록 깔끔합니다.'
            : '초록 배경천(크로마키) 앞에서 찍은 경우. 가장 깔끔하게 지워집니다. 얼굴 장면 배경은 ‘이미지’를 고르세요.'}</p>
        </div>
        <div class="look-group">
          <div class="group-title">얼굴 장면 배경</div>
          ${seg('faceBg', L.faceBg, [['original', '원래 배경'], ['blur', '흐리게'], ['image', '이미지']])}
          ${L.faceBg === 'image' ? html`
            <div class="bg-pick">
              ${info.assets.background ? html`<img class="bg-thumb" src="${info.assets.background}" alt="배경 이미지">` : html`<div class="bg-thumb empty">없음</div>`}
              <div class="bg-actions">
                <button class="btn small" id="bg-file-btn">이미지 파일…</button>
                ${slideCount ? html`<select id="bg-slide" class="small-select"><option value="">슬라이드에서 고르기</option>
                  ${Array.from({ length: slideCount }, (_, i) => html`<option value="${i + 1}">슬라이드 ${i + 1}</option>`)}</select>` : ''}
                <input type="file" id="bg-file" accept="image/*" hidden>
              </div>
            </div>
            <p class="hint">인사·마무리 같은 얼굴 장면에서 발표자 뒤에 깔립니다. 강의 표지 슬라이드를 써도 좋습니다.</p>` : ''}
        </div>` : html`
        <div class="look-group">
          <div class="group-title">얼굴 창</div>
          <div class="row">
            <div class="corner-picker">
              ${[['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘']].map(([v, icon]) => html`
                <button class="corner ${s.pipCorner === v ? 'on' : ''}" data-corner="${v}" title="${v}">${icon}</button>`)}
            </div>
            <div class="seg-picker">
              ${[['s', '작게'], ['m', '보통'], ['l', '크게']].map(([v, label]) => html`
                <button class="${s.pipSize === v ? 'on' : ''}" data-size="${v}">${label}</button>`)}
            </div>
          </div>
        </div>`}
      <div class="look-group">
        <div class="group-title">이름 자막</div>
        <label class="field"><span>이름</span><input id="cap-name" value="${L.caption.name}" placeholder="예) 황승환 교수" maxlength="60"></label>
        <label class="field"><span>소속</span><input id="cap-org" value="${L.caption.org}" placeholder="예) 경북전문대학교 호텔외식학과" maxlength="80"></label>
        <div class="row">
          <div class="swatches">${CAPTION_COLORS.map((c) => html`
            <button class="swatch ${L.caption.color === c ? 'on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`)}</div>
          <span class="grow"></span>
          ${seg('captionShow', L.caption.show, [['first', '첫 얼굴 장면'], ['all', '모든 얼굴 장면'], ['off', '끄기']])}
        </div>
        <p class="hint">얼굴 장면이 시작되고 약 8초 동안 왼쪽 아래에 나옵니다.</p>
      </div>`;
  }

  function board() {
    return html`${project.cues.map((cue, i) => {
      const sc = sceneOf(cue, i);
      return html`
        <li class="board-item ${i === selected ? 'on' : ''}" data-index="${i}">
          ${stage(cue, i)}
          <div class="board-meta">
            <span class="cue-num">${i + 1}</span>
            <span class="type-badge t-${cue.type}">${CUE_TYPES[cue.type].label}</span>
            <span class="board-note ${cue.side || cue.showFace === false ? 'manual' : ''}">${sideNote(cue, sc)}</span>
          </div>
        </li>`;
    })}`;
  }

  function refreshVisuals() {
    const col = $('#stage-col');
    if (col) col.innerHTML = String(stageColumn());
    const b = $('#board');
    if (b) b.innerHTML = String(board());
    bindStage();
  }

  // ---------- saving ----------
  const saveLookNow = async () => {
    if (!lookDirty) return;
    lookDirty = false;
    try {
      const saved = await api.saveProject(pid, { settings: { look: look() } });
      project.settings.look = saved.settings.look;
    } catch (err) {
      lookDirty = true;
      toast(`저장하지 못했습니다: ${err.message}`, 'error');
    }
  };
  const saveLookSoon = debounce(saveLookNow, 500);
  const saveLook = () => {
    lookDirty = true;
    saveLookSoon();
  };

  function setLook(patch, { panelToo = true } = {}) {
    project.settings.look = cleanLook({ ...look(), ...patch });
    if (panelToo) {
      const p = $('#panel');
      if (p) p.innerHTML = String(panel());
      bindPanel();
    }
    refreshVisuals();
    saveLook();
  }

  async function saveSettings(patch) {
    try {
      project = await api.saveProject(pid, { settings: { ...project.settings, ...patch } });
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function setScene(index, value) {
    const id = project.cues[index]?.id;
    if (!id) return;
    const apply = (cue) => {
      delete cue.side;
      if (value === 'none') cue.showFace = false;
      else if (value === 'default') delete cue.showFace;
      else {
        cue.showFace = true;
        if (value !== 'show') cue.side = value;
      }
    };
    apply(project.cues[index]);
    refreshVisuals();
    try {
      // Start from the saved cue sheet so edits made elsewhere are kept.
      const latest = await api.getProject(pid);
      const cue = latest.cues.find((c) => c.id === id);
      if (!cue) return;
      apply(cue);
      const saved = await api.saveProject(pid, { cues: latest.cues });
      project.cues = saved.cues;
    } catch (err) {
      toast(`저장하지 못했습니다: ${err.message}`, 'error');
    }
  }

  // ---------- caption picture ----------
  async function uploadCaptionNow() {
    if (!captionDirty) return;
    captionDirty = false;
    const L = look();
    try {
      if (!L.caption.name.trim()) {
        await api.deleteAsset(pid, 'caption');
        captionUrl = null;
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = OUT_W;
        canvas.height = OUT_H;
        drawCaption(canvas.getContext('2d'), L.caption);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        captionUrl = (await api.putAsset(pid, 'caption', blob)).url;
      }
    } catch (err) {
      captionDirty = true;
      toast(`자막을 저장하지 못했습니다: ${err.message}`, 'error');
    }
  }
  const uploadCaptionSoon = debounce(uploadCaptionNow, 700);

  const previewCaption = debounce(async () => {
    const L = look();
    if (captionObjectUrl) URL.revokeObjectURL(captionObjectUrl);
    captionObjectUrl = null;
    if (L.caption.name.trim()) {
      const canvas = document.createElement('canvas');
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      drawCaption(canvas.getContext('2d'), L.caption);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (disposed) return;
      captionObjectUrl = URL.createObjectURL(blob);
      captionUrl ??= captionObjectUrl;
    }
    refreshVisuals();
  }, 120);

  function setCaption(patch) {
    project.settings.look = cleanLook({ ...look(), caption: { ...look().caption, ...patch } });
    saveLook();
    previewCaption();
    captionDirty = true;
    uploadCaptionSoon();
  }

  async function setBackground(src) {
    try {
      const blob = await coverJpeg(src);
      const res = await api.putAsset(pid, 'background', blob);
      info.assets.background = res.url;
      const p = $('#panel');
      if (p) p.innerHTML = String(panel());
      bindPanel();
      refreshVisuals();
      toast('얼굴 장면 배경을 바꿨습니다.');
    } catch (err) {
      toast(`배경 이미지를 쓰지 못했습니다: ${err.message}`, 'error');
    }
  }

  // ---------- events ----------
  function bindPanel() {
    for (const b of $$('[data-set]', $('#panel'))) {
      b.addEventListener('click', () => {
        const { set, value } = b.dataset;
        if (set === 'captionShow') setCaption({ show: value });
        else setLook({ [set]: value });
        if (set === 'captionShow') {
          const p = $('#panel');
          p.innerHTML = String(panel());
          bindPanel();
        }
        if (set === 'keyer') loadCutout();
      });
    }
    $('#size')?.addEventListener('input', (e) => {
      $('#size-out').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
      setLook({ size: Number(e.target.value) }, { panelToo: false });
    });
    $('#cap-name')?.addEventListener('input', (e) => setCaption({ name: e.target.value }));
    $('#cap-org')?.addEventListener('input', (e) => setCaption({ org: e.target.value }));
    for (const b of $$('[data-color]')) {
      b.addEventListener('click', () => {
        setCaption({ color: b.dataset.color });
        for (const x of $$('[data-color]')) x.classList.toggle('on', x === b);
      });
    }
    for (const b of $$('[data-corner]')) b.addEventListener('click', () => saveSettings({ pipCorner: b.dataset.corner }));
    for (const b of $$('[data-size]')) b.addEventListener('click', () => saveSettings({ pipSize: b.dataset.size }));
    $('#bg-file-btn')?.addEventListener('click', () => $('#bg-file').click());
    $('#bg-file')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      setBackground(url).finally(() => URL.revokeObjectURL(url));
    });
    $('#bg-slide')?.addEventListener('change', (e) => {
      const page = Number(e.target.value);
      if (page) setBackground(slideUrl(project, page));
    });
  }

  function bindStage() {
    for (const b of $$('[data-step]')) {
      b.addEventListener('click', () => select(selected + Number(b.dataset.step)));
    }
    for (const b of $$('[data-scene]')) b.addEventListener('click', () => setScene(selected, b.dataset.scene));
    const cam = $('[data-drag]');
    if (cam) cam.addEventListener('pointerdown', startDrag);
  }

  function select(index) {
    if (index < 0 || index >= project.cues.length) return;
    selected = index;
    history.replaceState(null, '', `#/p/${pid}/look?cue=${project.cues[index].id}`);
    refreshVisuals();
    // Bring the big preview into view (it scrolls away below the settings).
    const top = $('.look-top');
    const r = $('#stage-col')?.getBoundingClientRect();
    if (top && r && (r.top < 60 || r.bottom > innerHeight)) {
      window.scrollTo({ top: window.scrollY + top.getBoundingClientRect().top - 76, behavior: 'smooth' });
    }
  }

  function startDrag(e) {
    const frame = e.target.closest('.stage-frame');
    if (!frame) return;
    e.preventDefault();
    const cue = project.cues[selected];
    const sc = sceneOf(cue, selected);
    dragging = { frame, left: sc.side === 'left', startX: e.clientX, startLook: look().x };
    e.target.setPointerCapture(e.pointerId);
    e.target.addEventListener('pointermove', onDrag);
    e.target.addEventListener('pointerup', endDrag, { once: true });
    e.target.addEventListener('pointercancel', endDrag, { once: true });
  }

  function onDrag(e) {
    if (!dragging) return;
    const rect = dragging.frame.getBoundingClientRect();
    const dx = (e.clientX - dragging.startX) / rect.width;
    const x = dragging.startLook + (dragging.left ? -dx : dx);
    project.settings.look = cleanLook({ ...look(), x });
    lookDirty = true;
    const cue = project.cues[selected];
    const sc = sceneOf(cue, selected);
    const cam = $('[data-drag]');
    if (cam && sc.spec.camera) cam.setAttribute('style', pct(sc.spec.camera));
  }

  function endDrag(e) {
    e.target.removeEventListener('pointermove', onDrag);
    dragging = null;
    refreshVisuals();
    saveLook();
  }

  function bind() {
    bindPanel();
    bindStage();
    $('#board').addEventListener('click', (e) => {
      const item = e.target.closest('.board-item');
      if (item) select(Number(item.dataset.index));
    });
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight') select(selected + 1);
    if (e.key === 'ArrowLeft') select(selected - 1);
  }

  async function loadCutout() {
    cutoutState = 'loading';
    refreshVisuals();
    try {
      cutout = (await api.cutout(pid)).cutout;
    } catch (err) {
      cutout = null;
      console.warn(err);
    }
    if (disposed) return;
    cutoutState = cutout ? 'ready' : 'none';
    refreshVisuals();
  }

  render();
  document.addEventListener('keydown', onKey);
  loadCutout();
  return async () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    saveLookSoon.cancel();
    uploadCaptionSoon.cancel();
    previewCaption.cancel();
    await Promise.all([saveLookNow(), uploadCaptionNow()]);
    if (captionObjectUrl) URL.revokeObjectURL(captionObjectUrl);
  };
}
