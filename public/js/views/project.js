// Cue sheet editor: import slides and notes, add demo/video/face cues, write scripts.

import { api } from '../api.js';
import { html, $, $$, debounce, toast, autoGrow } from '../ui.js';
import { CUE_TYPES, newCueId, cueTitle, showFaceOf, slideUrl } from '../cues.js';

export async function renderProject(root, { pid }) {
  let project = await api.getProject(pid);
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
              ? html`<span class="cue-title">슬라이드 ${cue.page}</span>`
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
        <a class="btn" href="#/p/${pid}/takes">테이크 · 영상 만들기</a>
        <a class="btn rec" href="#/p/${pid}/studio">● 촬영하기</a>
      </header>
      <main class="page">
        <section class="import-bar">
          <div class="import-item">
            <button class="btn" id="pdf-btn">슬라이드 PDF 가져오기</button>
            <span class="muted small">${slideCount ? `슬라이드 ${slideCount}장 · 고친 PDF를 다시 가져오면 이미지만 바뀝니다` : 'PowerPoint·Keynote·구글 슬라이드에서 PDF로 내보내세요'}</span>
          </div>
          <div class="import-item">
            <button class="btn" id="notes-btn" ${slideCount ? '' : 'disabled'}>발표자 노트 → 대본</button>
            <span class="muted small">같은 발표 파일을 .pptx로 올리면 노트를 대본으로 채웁니다</span>
          </div>
          <div class="import-item">
            <button class="btn" id="paste-btn" ${cues.length ? '' : 'disabled'}>대본 한꺼번에 붙여넣기</button>
          </div>
          <input type="file" id="pdf-file" accept="application/pdf,.pdf" hidden>
          <input type="file" id="notes-file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden>
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
    $('#pdf-btn').addEventListener('click', () => $('#pdf-file').click());
    $('#pdf-file').addEventListener('change', (e) => e.target.files[0] && importPdf(e.target.files[0]));
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

  function showProgress(fraction, label) {
    const box = $('#import-progress');
    if (!box) return;
    box.hidden = fraction == null;
    if (fraction == null) return;
    box.querySelector('.bar-fill').style.width = `${Math.round(fraction * 100)}%`;
    box.querySelector('.label').textContent = label;
  }

  async function importPdf(file) {
    const { renderPdfPages } = await import('../importers/pdf.js');
    await saveNow();
    try {
      showProgress(0, 'PDF 여는 중…');
      await api.beginSlides(pid);
      const count = await renderPdfPages(file, async (n, blob, total) => {
        await api.putStagedSlide(pid, n, blob);
        showProgress(n / total, `슬라이드 ${n}/${total}장 가져오는 중…`);
      });
      const updated = await api.commitSlides(pid, count);
      project.slides = updated.slides;
      const added = mergeSlideCues(count);
      dirty = true;
      await saveNow();
      render();
      const missing = project.cues.filter((c) => c.type === 'slide' && c.page > count).length;
      toast(`슬라이드 ${count}장을 가져왔습니다${added ? ` (새 장면 ${added}개)` : ''}.${missing ? ` 없어진 슬라이드 장면 ${missing}개를 확인하세요.` : ''}`, missing ? 'warn' : 'info', 7000);
    } catch (err) {
      toast(`PDF를 가져오지 못했습니다: ${err.message}`, 'error', 8000);
    } finally {
      showProgress(null);
      $('#pdf-file') && ($('#pdf-file').value = '');
    }
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

  async function importNotes(file) {
    try {
      const { readPptxNotes } = await import('../importers/pptx.js');
      const notes = await readPptxNotes(file);
      const slides = project.cues.filter((c) => c.type === 'slide');
      const filled = slides.filter((c) => c.script?.trim());
      const overwrite = filled.length === 0 || confirm(
        `대본이 이미 있는 장면이 ${filled.length}개 있습니다.\n[확인] 발표자 노트로 덮어쓰기\n[취소] 비어 있는 장면만 채우기`,
      );
      let applied = 0;
      for (const cue of slides) {
        const text = notes[cue.page - 1]?.trim();
        if (!text || (!overwrite && cue.script?.trim())) continue;
        cue.script = text;
        applied += 1;
      }
      changed();
      render();
      const count = project.slides?.count ?? 0;
      const mismatch = notes.length !== count
        ? ` PPTX는 ${notes.length}장, PDF는 ${count}장입니다. 숨긴 슬라이드 때문에 번호가 어긋났는지 확인하세요.`
        : '';
      toast(`대본 ${applied}개를 채웠습니다.${mismatch}`, mismatch ? 'warn' : 'info', mismatch ? 10000 : 4000);
    } catch (err) {
      toast(`발표자 노트를 읽지 못했습니다: ${err.message}`, 'error', 8000);
    } finally {
      $('#notes-file') && ($('#notes-file').value = '');
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

  render();
  return () => saveNow();
}
