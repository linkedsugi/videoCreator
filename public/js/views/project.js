// Cue sheet editor: import slides and notes, add demo/video/face cues, write scripts.

import { api } from '../api.js';
import { html, $, $$, debounce, toast, autoGrow } from '../ui.js';
import { CUE_TYPES, newCueId, cueTitle, showFaceOf, slideUrl } from '../cues.js';

const DECK_ACCEPT = '.pdf,.pptx,.ppt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint';
const CONVERTER_NAMES = { powerpoint: 'PowerPoint', keynote: 'Keynote', libreoffice: 'LibreOffice' };

export async function renderProject(root, { pid }) {
  let project = await api.getProject(pid);
  const health = await api.health().catch(() => null);
  const summary = await api.getTakes(pid).catch(() => ({ cues: {} }));
  const goodTakes = (id) => (summary.cues?.[id] ?? []).filter((t) => !t.ng && !t.tooShort && !t.excluded).length;

  let saving = null;
  let dirty = false;
  const setSaveStatus = (text, kind = '') => {
    const el = $('#save-status');
    if (el) {
      el.textContent = text;
      el.className = `save-status ${kind}`;
    }
  };

  async function saveNow() {
    save.cancel();
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    setSaveStatus('저장 중…');
    saving = api.saveProject(pid, { title: project.title, cues: project.cues })
      .then((p) => {
        project.updatedAt = p.updatedAt;
        setSaveStatus('저장됨', 'ok');
      })
      .catch((err) => {
        dirty = true;
        setSaveStatus('저장 실패', 'bad');
        toast(`저장하지 못했습니다: ${err.message}`, 'error');
      })
      .finally(() => {
        saving = null;
      });
    await saving;
  }
  const save = debounce(saveNow, 600);
  const changed = () => {
    dirty = true;
    setSaveStatus('수정됨');
    save();
  };

  function cueRow(cue, i) {
    const missingSlide = cue.type === 'slide' && cue.page > (project.slides?.count ?? 0);
    const takes = goodTakes(cue.id);
    return html`
      <li class="cue t-${cue.type}" data-id="${cue.id}">
        <div class="cue-num">${i + 1}</div>
        <div class="cue-visual">
          ${cue.type === 'slide' && !missingSlide
            ? html`<img src="${slideUrl(project, cue.page)}" alt="슬라이드 ${cue.page}" loading="lazy">`
            : html`<div class="visual-placeholder t-${cue.type}">${missingSlide ? '슬라이드 없음' : CUE_TYPES[cue.type].label}</div>`}
        </div>
        <div class="cue-body">
          <div class="cue-head">
            <span class="type-badge t-${cue.type}">${CUE_TYPES[cue.type].label}</span>
            ${cue.type === 'slide'
              ? html`<span class="cue-title">슬라이드 ${cue.page}</span>${cue.title ? html`<span class="cue-subtitle">${cue.title}</span>` : ''}`
              : html`<input class="cue-title-input" data-field="title" value="${cue.title}" placeholder="${cueTitle(cue)} 제목" maxlength="200">`}
            ${cue.type !== 'face' ? html`<label class="check small" title="완성 영상에서 얼굴 창을 보여줄지"><input type="checkbox" data-field="showFace" ${showFaceOf(cue) ? 'checked' : ''}> 얼굴 창</label>` : ''}
            <span class="grow"></span>
            ${takes ? html`<span class="pill ok small">✓ 테이크 ${takes}</span>` : ''}
            <div class="cue-actions">
              <button class="icon-btn" data-act="up" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="icon-btn" data-act="down" title="아래로" ${i === project.cues.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="icon-btn" data-act="delete" title="장면 삭제">✕</button>
            </div>
          </div>
          ${cue.type === 'video' ? html`<input class="url-input" data-field="url" value="${cue.url}" placeholder="영상 주소 (선택) — 촬영 중 프롬프터에서 복사할 수 있습니다">` : ''}
          <textarea data-field="script" rows="2" placeholder="${CUE_TYPES[cue.type].hint}">${cue.script}</textarea>
        </div>
      </li>
      <li class="insert-row" data-after="${cue.id}">
        <button class="insert-btn" data-act="insert-menu">+ 여기에 장면 추가</button>
        <span class="insert-menu" hidden>
          <button class="btn small" data-add="demo">데모</button>
          <button class="btn small" data-add="video">영상</button>
          <button class="btn small" data-add="face">얼굴</button>
          <button class="btn small" data-add="slide">슬라이드…</button>
        </span>
      </li>`;
  }

  function render() {
    const cues = project.cues;
    const slideCount = project.slides?.count ?? 0;
    root.innerHTML = String(html`
      <header class="topbar">
        <a class="brand" href="#/">● 강의 스튜디오</a>
        <input class="title-input" id="title-input" value="${project.title}" maxlength="120" aria-label="강의 제목">
        <span class="save-status" id="save-status">저장됨</span>
        <span class="grow"></span>
        <a class="help-link" href="/guide.html" target="_blank" rel="noopener">사용법</a>
        <a class="btn" href="#/p/${pid}/takes">테이크 · 영상 만들기</a>
        <a class="btn rec" href="#/p/${pid}/studio">● 촬영하기</a>
      </header>
      <main class="page">
        <section class="import-bar">
          <div class="import-item">
            <button class="btn primary" id="import-btn">슬라이드 가져오기</button>
            <span class="muted small">${importHint(slideCount)}</span>
          </div>
          <div class="import-item">
            <button class="btn" id="notes-btn" ${slideCount ? '' : 'disabled'}>발표자 노트 → 대본</button>
            <span class="muted small">PDF로 가져왔다면, 같은 발표 파일(.pptx, .ppt)에서 대본만 채웁니다</span>
          </div>
          <div class="import-item">
            <button class="btn" id="paste-btn" ${cues.length ? '' : 'disabled'}>대본 한꺼번에 붙여넣기</button>
          </div>
          <input type="file" id="import-file" accept="${DECK_ACCEPT}" multiple hidden>
          <input type="file" id="notes-file" accept=".pptx,.ppt" hidden>
        </section>
        <div class="progress-line" id="import-progress" hidden><div class="bar"><div class="bar-fill"></div></div><span class="label"></span></div>

        <section>
          <div class="section-head">
            <h2>큐시트 <span class="muted">${cues.length}개 장면</span></h2>
            <span class="grow"></span>
            <span class="add-inline">
              장면 추가:
              <button class="btn small" data-add-end="demo">데모</button>
              <button class="btn small" data-add-end="video">영상</button>
              <button class="btn small" data-add-end="face">얼굴</button>
            </span>
          </div>
          ${cues.length ? html`<ol class="cue-sheet" id="cue-sheet">
            <li class="insert-row" data-after="">
              <button class="insert-btn" data-act="insert-menu">+ 맨 앞에 장면 추가</button>
              <span class="insert-menu" hidden>
                <button class="btn small" data-add="demo">데모</button>
                <button class="btn small" data-add="video">영상</button>
                <button class="btn small" data-add="face">얼굴</button>
                <button class="btn small" data-add="slide">슬라이드…</button>
              </span>
            </li>
            ${cues.map(cueRow)}
          </ol>` : html`<div class="empty-state">
              <p><b>슬라이드 PDF를 가져오면</b> 슬라이드마다 장면이 만들어집니다.</p>
              <p class="muted">슬라이드 없이 진행하려면 위의 [데모] [영상] [얼굴]로 장면을 추가하세요.</p>
            </div>`}
        </section>
      </main>
      <dialog id="paste-dialog" class="dialog">
        <form method="dialog">
          <h3>대본 한꺼번에 붙여넣기</h3>
          <p class="muted small">장면 순서대로 붙여넣고, 장면과 장면 사이는 <code>---</code> 만 있는 줄로 구분하세요. 비어 있는 부분은 기존 대본을 그대로 둡니다.</p>
          <textarea id="paste-text" rows="14" placeholder="첫 번째 장면 대본&#10;---&#10;두 번째 장면 대본&#10;---&#10;..."></textarea>
          <div class="radio-row">
            <label><input type="radio" name="target" value="all" checked> 모든 장면에 순서대로</label>
            <label><input type="radio" name="target" value="slide"> 슬라이드 장면에만</label>
          </div>
          <div class="dialog-actions">
            <button class="btn" value="cancel">취소</button>
            <button class="btn primary" value="ok">적용</button>
          </div>
        </form>
      </dialog>`);
    bind();
    $$('textarea[data-field="script"]').forEach(autoGrow);
  }

  function findCue(el) {
    const li = el.closest('li.cue');
    return li ? project.cues.find((c) => c.id === li.dataset.id) : null;
  }

  function insertCue(afterId, type) {
    let cue;
    if (type === 'slide') {
      const count = project.slides?.count ?? 0;
      if (!count) return toast('먼저 슬라이드 PDF를 가져와 주세요.', 'warn');
      const page = Number(prompt(`몇 번 슬라이드를 넣을까요? (1~${count})`));
      if (!Number.isInteger(page) || page < 1 || page > count) return;
      cue = { id: newCueId(), type, page, title: '', script: '' };
    } else {
      cue = { id: newCueId(), type, title: '', script: '' };
    }
    const idx = afterId === null ? project.cues.length : afterId === '' ? 0 : project.cues.findIndex((c) => c.id === afterId) + 1;
    project.cues.splice(idx, 0, cue);
    changed();
    render();
    $(`li.cue[data-id="${cue.id}"] ${cue.type === 'slide' ? 'textarea' : '.cue-title-input'}`)?.focus();
  }

  function bind() {
    $('#title-input').addEventListener('input', (e) => {
      project.title = e.target.value;
      changed();
    });
    $('#import-btn').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => e.target.files.length && importFiles(e.target.files));
    $('#notes-btn').addEventListener('click', () => $('#notes-file').click());
    $('#notes-file').addEventListener('change', (e) => e.target.files[0] && importNotes(e.target.files[0]));
    $('#paste-btn').addEventListener('click', () => $('#paste-dialog').showModal());
    $('#paste-dialog').addEventListener('close', (e) => {
      if (e.target.returnValue === 'ok') applyPaste($('#paste-text').value, $('input[name="target"]:checked').value);
    });
    for (const btn of $$('[data-add-end]')) btn.addEventListener('click', () => insertCue(null, btn.dataset.addEnd));

    const sheet = $('#cue-sheet');
    if (!sheet) return;
    sheet.addEventListener('input', (e) => {
      const field = e.target.dataset.field;
      const cue = findCue(e.target);
      if (!cue || !field) return;
      if (field === 'showFace') cue.showFace = e.target.checked;
      else cue[field] = e.target.value;
      if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
      changed();
    });
    sheet.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act === 'insert-menu') {
        btn.hidden = true;
        btn.nextElementSibling.hidden = false;
        return;
      }
      if (btn.dataset.add) {
        insertCue(btn.closest('.insert-row').dataset.after, btn.dataset.add);
        return;
      }
      const cue = findCue(btn);
      if (!cue) return;
      const idx = project.cues.indexOf(cue);
      if (btn.dataset.act === 'up' && idx > 0) {
        project.cues.splice(idx - 1, 0, ...project.cues.splice(idx, 1));
      } else if (btn.dataset.act === 'down' && idx < project.cues.length - 1) {
        project.cues.splice(idx + 1, 0, ...project.cues.splice(idx, 1));
      } else if (btn.dataset.act === 'delete') {
        const hasContent = cue.script?.trim() || goodTakes(cue.id);
        if (hasContent && !confirm(`${idx + 1}번 장면(${cueTitle(cue)})을 삭제할까요?`)) return;
        project.cues.splice(idx, 1);
      } else {
        return;
      }
      changed();
      render();
    });
  }

  function showProgress(label, fraction = null) {
    const box = $('#import-progress');
    if (!box) return;
    box.hidden = false;
    box.querySelector('.bar').classList.toggle('busy', fraction === null);
    box.querySelector('.bar-fill').style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
    box.querySelector('.label').textContent = label;
  }

  function hideProgress() {
    const box = $('#import-progress');
    if (box) box.hidden = true;
    for (const id of ['#import-file', '#notes-file']) if ($(id)) $(id).value = '';
  }

  function importHint(slideCount) {
    if (slideCount) return `슬라이드 ${slideCount}장 · 고친 파일을 다시 가져오면 이미지만 바뀝니다`;
    const hint = 'PDF 또는 PowerPoint(.pptx, .ppt) · 여기에 파일을 끌어다 놓아도 됩니다';
    return health?.converters?.length ? hint : `${hint} · PowerPoint 파일은 PowerPoint나 Keynote가 있어야 바로 열 수 있습니다`;
  }

  /**
   * Imports slides from a PDF and/or a PowerPoint file. A PowerPoint file on
   * its own is converted on this Mac; with both, the PDF gives the images and
   * the PowerPoint file the titles and speaker notes.
   */
  async function importFiles(fileList) {
    const files = [...fileList];
    const pdf = files.find((f) => /\.pdf$/i.test(f.name));
    const deck = files.find((f) => /\.pptx?$/i.test(f.name));
    if (!pdf && !deck) {
      toast('PDF 또는 PowerPoint 파일(.pptx, .ppt)을 골라 주세요.', 'warn');
      return;
    }
    await saveNow();
    try {
      let source = pdf;
      let via = null;
      if (!source) {
        showProgress(`${deck.name}을(를) 슬라이드 이미지로 바꾸는 중… 처음 한 번은 PowerPoint·Keynote의 "제어 허용"이나 "파일 접근 권한" 창이 뜰 수 있습니다. 허용해 주세요.`);
        ({ blob: source, via } = await api.convert(deck, 'pdf'));
      }
      const { count, added } = await importSlideImages(source);
      let deckResult = { msg: '', warn: false };
      if (deck) {
        try {
          deckResult = await applyDeck(deck);
        } catch (err) {
          deckResult = { msg: ` 발표자 노트는 읽지 못했습니다: ${err.message}`, warn: true };
        }
      }
      dirty = true;
      await saveNow();
      render();
      const missing = project.cues.filter((c) => c.type === 'slide' && c.page > count).length;
      const parts = [`슬라이드 ${count}장을 가져왔습니다${added ? ` (새 장면 ${added}개)` : ''}${via ? ` · ${CONVERTER_NAMES[via] ?? via}로 변환` : ''}.`];
      if (deckResult.msg) parts.push(deckResult.msg.trim());
      if (missing) parts.push(`없어진 슬라이드 장면 ${missing}개를 확인하세요.`);
      toast(parts.join(' '), missing || deckResult.warn ? 'warn' : 'info', 9000);
    } catch (err) {
      const tip = deck && !pdf ? '\nPowerPoint에서 PDF로 저장한 뒤, PDF와 PowerPoint 파일을 함께 골라도 됩니다.' : '';
      toast(`슬라이드를 가져오지 못했습니다: ${err.message}${tip}`, 'error', 15000);
    } finally {
      hideProgress();
    }
  }

  async function importSlideImages(pdfFile) {
    const { renderPdfPages } = await import('../importers/pdf.js');
    showProgress('PDF 여는 중…', 0);
    await api.beginSlides(pid);
    const count = await renderPdfPages(pdfFile, async (n, blob, total) => {
      await api.putStagedSlide(pid, n, blob);
      showProgress(`슬라이드 ${n}/${total}장 가져오는 중…`, n / total);
    });
    const updated = await api.commitSlides(pid, count);
    project.slides = updated.slides;
    return { count, added: mergeSlideCues(count) };
  }

  /** Adds a cue for each page that doesn't have one yet, after the previous page. */
  function mergeSlideCues(count) {
    const have = new Set(project.cues.filter((c) => c.type === 'slide').map((c) => c.page));
    let added = 0;
    for (let page = 1; page <= count; page++) {
      if (have.has(page)) continue;
      let at = -1;
      project.cues.forEach((c, i) => {
        if (c.type === 'slide' && c.page < page) at = i;
      });
      project.cues.splice(at + 1, 0, { id: newCueId(), type: 'slide', page, title: '', script: '' });
      added += 1;
    }
    return added;
  }

  /**
   * Takes slide titles and speaker notes from a PowerPoint file. Titles always
   * follow the deck; scripts someone already wrote are only replaced after asking.
   */
  async function applyDeck(file) {
    const { readPptxSlides, matchSlidesToPages } = await import('../importers/pptx.js');
    let pptx = file;
    if (!/\.pptx$/i.test(file.name)) {
      showProgress('.ppt 파일에서 발표자 노트를 읽는 중…');
      pptx = (await api.convert(file, 'pptx')).blob;
    }
    const deckSlides = await readPptxSlides(pptx);
    const count = project.slides?.count ?? 0;
    const { list, exact } = matchSlidesToPages(deckSlides, count);
    const slideCues = project.cues.filter((c) => c.type === 'slide');
    for (const cue of slideCues) {
      const slide = list[cue.page - 1];
      if (slide) cue.title = slide.title;
    }
    const withNotes = slideCues.filter((c) => list[c.page - 1]?.notes);
    const conflicts = withNotes.filter((c) => c.script?.trim() && c.script.trim() !== list[c.page - 1].notes);
    const overwrite = conflicts.length === 0 || confirm(
      `대본이 이미 있는 장면이 ${conflicts.length}개 있습니다.\n[확인] 발표자 노트로 덮어쓰기\n[취소] 비어 있는 장면만 채우기`,
    );
    let applied = 0;
    for (const cue of withNotes) {
      const notes = list[cue.page - 1].notes;
      if (cue.script === notes || (!overwrite && cue.script?.trim())) continue;
      cue.script = notes;
      applied += 1;
    }
    let msg = applied ? `대본 ${applied}개를 발표자 노트에서 채웠습니다.` : withNotes.length ? '' : '발표자 노트는 없었습니다.';
    if (!exact) {
      const hidden = deckSlides.filter((s) => s.hidden).length;
      msg += ` 발표 파일은 ${deckSlides.length}장${hidden ? `(숨김 ${hidden}장)` : ''}, 슬라이드 이미지는 ${count}장이라 대본 순서가 어긋났을 수 있습니다.`;
    }
    return { msg: msg.trim(), warn: !exact };
  }

  async function importNotes(file) {
    try {
      const { msg, warn } = await applyDeck(file);
      changed();
      render();
      toast(msg || '바뀐 대본이 없습니다.', warn ? 'warn' : 'info', warn ? 10000 : 5000);
    } catch (err) {
      toast(`발표자 노트를 읽지 못했습니다: ${err.message}`, 'error', 10000);
    } finally {
      hideProgress();
    }
  }

  function applyPaste(text, target) {
    const chunks = text.split(/^\s*-{3,}\s*$/m).map((s) => s.trim());
    const cues = target === 'slide' ? project.cues.filter((c) => c.type === 'slide') : project.cues;
    let applied = 0;
    chunks.forEach((chunk, i) => {
      if (!chunk || !cues[i]) return;
      cues[i].script = chunk;
      applied += 1;
    });
    changed();
    render();
    const extra = chunks.length > cues.length ? ` 장면보다 대본이 ${chunks.length - cues.length}개 더 많아 남은 부분은 버렸습니다.` : '';
    toast(`대본 ${applied}개를 넣었습니다.${extra}`, extra ? 'warn' : 'info', 6000);
  }

  // Dropping files anywhere on the page imports them.
  const onDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    root.classList.add('dropping');
  };
  const onDragLeave = (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('dropping');
  };
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    root.classList.remove('dropping');
    importFiles(e.dataTransfer.files);
  };
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);

  render();
  return () => {
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('dragleave', onDragLeave);
    root.removeEventListener('drop', onDrop);
    root.classList.remove('dropping');
    return saveNow();
  };
}
