// Takes overview and export.

import { api } from '../api.js';
import { html, $, $$, fmtClock, fmtDateTime, fmtBytes, toast } from '../ui.js';
import { CUE_TYPES, cueTitle } from '../cues.js';

const REASONS = { retake: 'NG', next: '', jump: '', stop: '', crash: '중단됨', interrupted: '' };

export async function renderTakes(root, { pid }) {
  let project = await api.getProject(pid);
  let summary = await api.getTakes(pid);
  let job = await api.buildStatus(pid);
  let poll = null;
  const health = await api.health().catch(() => null);
  let storage = await api.storage(pid).catch(() => null);

  function takeState(t) {
    if (t.chosen) return { label: '사용', cls: 'ok' };
    if (t.excluded) return { label: '제외함', cls: 'muted' };
    if (t.ng) return { label: 'NG', cls: 'bad' };
    if (t.tooShort) return { label: '너무 짧음', cls: 'muted' };
    return { label: '이전 테이크', cls: 'muted' };
  }

  function stats() {
    let used = 0;
    let duration = 0;
    const missing = [];
    project.cues.forEach((c, i) => {
      const chosen = (summary.cues[c.id] ?? []).find((t) => t.chosen);
      if (chosen) {
        used += 1;
        duration += chosen.duration;
      } else missing.push({ c, i });
    });
    return { used, duration, missing };
  }

  function jobView() {
    if (job.state === 'running') {
      return html`
        <div class="job running">
          <div class="bar"><div class="bar-fill" style="width:${Math.round((job.progress ?? 0) * 100)}%"></div></div>
          <div>${job.step} · ${Math.round((job.progress ?? 0) * 100)}%</div>
          <p class="muted small">화면을 닫아도 계속 만듭니다. 촬영 길이에 따라 몇 분 걸릴 수 있습니다.</p>
        </div>`;
    }
    if (job.state === 'error') {
      return html`<div class="job error"><b>영상을 만들지 못했습니다.</b><pre>${job.error}</pre></div>`;
    }
    if (job.state === 'done' && job.output) {
      const o = job.output;
      return html`
        <div class="job done">
          <div class="row"><b>완성: ${o.name}</b> <span class="muted">${fmtClock(o.duration * 1000)} · 장면 ${o.cueCount}개</span></div>
          <video class="result-video" src="${o.url}" controls preload="metadata"></video>
          <div class="row">
            <a class="btn" href="${o.url}" download="${o.name}">다운로드</a>
            ${health?.platform === 'darwin' ? html`<button class="btn" id="open-folder">Finder에서 보기</button>` : ''}
          </div>
          ${o.warnings?.length ? html`<div class="warnings"><b>확인할 점</b><ul>${o.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
        </div>`;
    }
    return '';
  }

  function render() {
    const s = project.settings ?? {};
    const { used, duration, missing } = stats();
    root.innerHTML = String(html`
      <header class="topbar">
        <a class="brand" href="#/">● 강의 스튜디오</a>
        <a class="link" href="#/p/${pid}">← ${project.title}</a>
        <span class="grow"></span>
        <a class="help-link" href="/guide.html" target="_blank" rel="noopener">사용법</a>
        <a class="btn rec" href="#/p/${pid}/studio">● 촬영하기</a>
      </header>
      <main class="page">
        <section class="export-panel">
          <div class="export-summary">
            <h2>영상 만들기</h2>
            <p>장면 <b>${used}</b>/${project.cues.length}개 · 예상 길이 <b>${fmtClock(duration)}</b></p>
            ${missing.length ? html`<p class="warn-text">테이크가 없는 장면 ${missing.length}개는 빠집니다.
              <a href="#/p/${pid}/studio?from=${missing[0].c.id}">${missing[0].i + 1}번 장면부터 촬영하기 →</a></p>` : ''}
          </div>
          <div class="export-options">
            <div class="opt">
              <span class="opt-label">얼굴 창 위치</span>
              <div class="corner-picker">
                ${[['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘']].map(([v, icon]) => html`
                  <button class="corner ${s.pipCorner === v ? 'on' : ''}" data-corner="${v}" title="${v}">${icon}</button>`)}
              </div>
            </div>
            <div class="opt">
              <span class="opt-label">얼굴 창 크기</span>
              <div class="seg-picker">
                ${[['s', '작게'], ['m', '보통'], ['l', '크게']].map(([v, label]) => html`
                  <button class="${s.pipSize === v ? 'on' : ''}" data-size="${v}">${label}</button>`)}
              </div>
            </div>
            <label class="check"><input type="checkbox" id="loudnorm" ${s.loudnorm !== false ? 'checked' : ''}> 소리 크기 자동 맞춤</label>
          </div>
          <div class="export-action">
            <button class="btn primary big" id="build-btn" ${job.state === 'running' || !used || !health?.ffmpeg ? 'disabled' : ''}>MP4 만들기</button>
            ${!health?.ffmpeg ? html`<p class="warn-text small">FFmpeg가 없어 만들 수 없습니다. README를 확인하세요.</p>` : ''}
          </div>
          <div id="job">${jobView()}</div>
          <div class="storage-box">${storageView()}</div>
        </section>

        <section>
          <h2>장면별 테이크</h2>
          <p class="muted small">각 장면은 <b>가장 최근의 NG가 아닌 테이크</b>를 씁니다. 마음에 들지 않는 테이크는 [제외]하면 그 전 테이크가 쓰입니다.</p>
          <ol class="take-list">
            ${project.cues.map((c, i) => {
              const takes = summary.cues[c.id] ?? [];
              return html`
                <li class="take-cue ${takes.some((t) => t.chosen) ? '' : 'missing'}">
                  <div class="take-cue-head">
                    <span class="cue-num">${i + 1}</span>
                    <span class="type-badge t-${c.type}">${CUE_TYPES[c.type].label}</span>
                    <span class="title">${cueTitle(c)}</span>
                    <span class="grow"></span>
                    ${takes.length ? '' : html`<span class="pill bad small">테이크 없음</span>`}
                    <a class="link small" href="#/p/${pid}/studio?from=${c.id}">이 장면 촬영 →</a>
                  </div>
                  ${takes.length ? html`<ul class="takes">
                    ${takes.map((t, n) => {
                      const st = takeState(t);
                      return html`<li class="take ${st.cls}">
                        <span>테이크 ${n + 1}</span>
                        <span class="muted">${fmtDateTime(t.wall)}</span>
                        <span>${fmtClock(t.duration)}</span>
                        <span class="pill small ${st.cls}">${st.label}</span>
                        ${REASONS[t.endReason] && !t.ng ? html`<span class="muted small">${REASONS[t.endReason]}</span>` : ''}
                        ${t.ng || t.tooShort ? '' : html`<button class="btn small" data-toggle="${t.takeId}">${t.excluded ? '다시 사용' : '제외'}</button>`}
                      </li>`;
                    })}
                  </ul>` : ''}
                </li>`;
            })}
          </ol>
        </section>
      </main>`);
    bind();
  }

  async function saveSettings(patch) {
    try {
      project = await api.saveProject(pid, { settings: { ...project.settings, ...patch } });
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function storageView() {
    if (!storage) return '';
    const low = storage.free != null && storage.free < 20e9;
    return html`
      <div class="storage">
        <span>녹화 원본 <b>${fmtBytes(storage.raw)}</b></span>
        <span>완성 영상 <b>${fmtBytes(storage.exports)}</b></span>
        <span>중간 파일 <b>${fmtBytes(storage.cache)}</b>
          ${storage.cache > 0 ? html`<button class="btn small" id="clear-cache" ${job.state === 'running' ? 'disabled' : ''}>정리</button>` : ''}</span>
        ${storage.free != null ? html`<span class="grow"></span><span>맥 남은 공간 <b>${fmtBytes(storage.free)}</b></span>` : ''}
      </div>
      ${low ? html`<p class="warn-text small">남은 공간이 적습니다. 35분 강의 하나를 만들 때 10GB 넘게 필요할 수 있습니다. 영상을 다 만든 강의는 중간 파일을 정리해 주세요.</p>` : ''}`;
  }

  async function clearCache() {
    if (!confirm('중간 파일을 지울까요?\n녹화 원본과 완성 영상은 그대로 남습니다. 다음에 영상을 만들 때는 조금 더 오래 걸립니다.')) return;
    try {
      const { freed } = await api.clearCache(pid);
      storage = await api.storage(pid).catch(() => storage);
      render();
      toast(`중간 파일 ${fmtBytes(freed)}를 지웠습니다.`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function bind() {
    $('#clear-cache')?.addEventListener('click', clearCache);
    for (const b of $$('[data-corner]')) b.addEventListener('click', () => saveSettings({ pipCorner: b.dataset.corner }));
    for (const b of $$('[data-size]')) b.addEventListener('click', () => saveSettings({ pipSize: b.dataset.size }));
    $('#loudnorm').addEventListener('change', (e) => saveSettings({ loudnorm: e.target.checked }));
    $('#build-btn').addEventListener('click', startBuild);
    $('#open-folder')?.addEventListener('click', () => api.openFolder(pid, 'exports').catch((err) => toast(err.message, 'error')));
    for (const b of $$('[data-toggle]')) {
      b.addEventListener('click', async () => {
        const id = b.dataset.toggle;
        const set = new Set(project.excludedTakes ?? []);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        try {
          project = await api.saveProject(pid, { excludedTakes: [...set] });
          summary = await api.getTakes(pid);
          render();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  async function startBuild() {
    try {
      job = await api.startBuild(pid);
      render();
      watch();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  function watch() {
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        job = await api.buildStatus(pid);
      } catch {
        return;
      }
      const box = $('#job');
      if (box) box.innerHTML = String(jobView());
      if (job.state !== 'running') {
        clearInterval(poll);
        poll = null;
        storage = await api.storage(pid).catch(() => storage);
        render();
        if (job.state === 'done') toast('영상을 만들었습니다.', 'info', 6000);
      }
    }, 1000);
  }

  render();
  if (job.state === 'running') watch();
  return () => clearInterval(poll);
}
