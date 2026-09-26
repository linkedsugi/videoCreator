// Recording studio.
//
// Recording never stops between cues: the camera (and the shared demo tab)
// record continuously, and the buttons only log what happened when. The
// export later cuts the recording by that log. So a take is never lost to a
// slow start/stop, and a crash loses at most the last second.

import { api } from '../api.js';
import { html, $, $$, fmtClock, fmtBytes, toast } from '../ui.js';
import { CUE_TYPES, cueTitle, needsScreen, slideUrl } from '../cues.js';
import { setNavGuard } from '../nav.js';
import {
  listDevices, openCamera, openScreen, stopStream, describeVideo, LevelMeter,
  loadDevicePrefs, saveDevicePrefs,
} from '../studio/devices.js';
import { SeqUploader, TrackRecorder, EventLog } from '../studio/recorder.js';
import { Prompter } from '../studio/prompter.js';
import { steadySleep, steadyInterval } from '../studio/clock.js';

const ACTION_GAP_MS = 450;
const COUNT_STEP_MS = 650;

export async function renderStudio(root, { pid, params }) {
  const project = await api.getProject(pid);
  const cues = project.cues;
  if (!cues.length) {
    root.innerHTML = String(html`
      <div class="page narrow">
        <p class="notice">아직 장면이 없습니다. 큐시트에서 슬라이드를 가져오거나 장면을 추가해 주세요.</p>
        <a class="btn" href="#/p/${pid}">← 큐시트로</a>
      </div>`);
    return () => {};
  }

  // Takes recorded before this visit, to show counts and pick where to start.
  const prior = await api.getTakes(pid).catch(() => ({ cues: {} }));
  const priorAll = new Map();
  const priorGood = new Map();
  for (const [cueId, list] of Object.entries(prior.cues ?? {})) {
    priorAll.set(cueId, list.length);
    priorGood.set(cueId, list.filter((t) => !t.ng && !t.tooShort && !t.excluded).length);
  }

  const S = {
    phase: 'setup', // setup | live | finished
    mode: null, // countdown | take | paused | idle (live only)
    index: 0,
    sessionId: null,
    t0: 0,
    takeStartedAt: 0,
    takeElapsedBefore: 0,
    lastAction: 0,
    stopping: false,
    camStream: null,
    screenStream: null,
    screenCount: 0,
    tracks: new Map(), // file -> { rec, kind, uploader, stream }
    finishedUploaders: [], // tracks that ended mid-session, possibly still uploading
    events: null,
    meter: null,
    wakeLock: null,
    sessionAll: new Map(),
    sessionGood: new Map(),
    stopTicking: null,
  };
  const prefs = loadDevicePrefs();

  const fromCue = params.get('from');
  const fromIndex = cues.findIndex((c) => c.id === fromCue);
  const firstMissing = cues.findIndex((c) => !priorGood.get(c.id));
  S.index = fromIndex >= 0 ? fromIndex : firstMissing >= 0 ? firstMissing : 0;

  const prompter = new Prompter({
    onAction: (act) => act === 'next' ? next() : act === 'retake' ? retake() : act === 'pause' ? togglePause() : null,
    onKey: (e) => onKey(e),
    onClose: () => {
      renderPromptPanel();
      updateUi();
    },
  });

  // ---------- helpers ----------
  const now = () => Math.round((performance.now() - S.t0) * 10) / 10;
  const cue = () => cues[S.index];
  const goodCount = (c) => (priorGood.get(c.id) ?? 0) + (S.sessionGood.get(c.id) ?? 0);
  const takeNumber = (c) => (priorAll.get(c.id) ?? 0) + (S.sessionAll.get(c.id) ?? 0) + 1;
  const takeElapsed = () => S.takeElapsedBefore + (S.mode === 'take' ? performance.now() - S.takeStartedAt : 0);

  function uploaders() {
    const list = [...S.tracks.values()].map((t) => t.uploader).concat(S.finishedUploaders);
    if (S.events) list.push(S.events.uploader);
    return list;
  }

  function saveState() {
    const list = uploaders();
    const pending = list.reduce((n, u) => n + u.pending, 0);
    const error = list.find((u) => u.error)?.error;
    const bytes = list.reduce((n, u) => n + u.savedBytes, 0);
    return { pending, error, bytes };
  }

  // ---------- setup ----------
  function renderSetup() {
    root.innerHTML = String(html`
      <div class="studio">
        <header class="studio-top">
          <a class="link" href="#/p/${pid}">← 큐시트</a>
          <div class="studio-title">${project.title}</div>
          <span></span>
        </header>
        <div class="setup">
          <div class="setup-preview">
            <div class="preview-box">
              <video id="cam-preview" class="mirror" autoplay muted playsinline></video>
              <div class="preview-empty" id="preview-empty">카메라를 켜는 중…</div>
            </div>
            <div class="meter" title="마이크 소리 크기"><div class="meter-fill" id="meter-fill"></div></div>
            <div class="muted small" id="cam-info"></div>
          </div>
          <div class="setup-panel">
            <h2>촬영 준비</h2>
            <label class="field"><span>카메라</span><select id="cam-select"></select></label>
            <label class="field"><span>마이크</span><select id="mic-select"></select></label>
            <label class="check"><input type="checkbox" id="ns-toggle" ${prefs.noiseSuppression !== false ? 'checked' : ''}> 배경 소음 줄이기</label>

            <div class="setup-step">
              <div class="setup-step-head"><b>데모 탭</b> <span class="pill" id="screen-pill">연결 안 됨</span></div>
              <p class="hint">데모·영상 장면에 쓸 <b>크롬 탭</b>을 고르세요. 창에서 <b>“탭 오디오도 공유”</b>를 켜야 유튜브 소리가 녹음됩니다. 그 탭 화면만 녹화됩니다.</p>
              <div class="row"><button class="btn" id="screen-btn">데모 탭 연결</button></div>
            </div>

            <div class="setup-step">
              <div class="setup-step-head"><b>프롬프터 창</b> <span class="pill" id="pip-pill">닫힘</span></div>
              <p class="hint">대본이 뜨는 작은 창입니다. <b>카메라 바로 아래</b>로 옮겨 두세요. 데모 중에도 맨 위에 떠 있고, 녹화에는 찍히지 않습니다.</p>
              <div class="row"><button class="btn" id="pip-btn">프롬프터 창 띄우기</button></div>
            </div>

            <label class="field"><span>시작 장면</span>
              <select id="start-select">
                ${cues.map((c, i) => html`<option value="${i}" ${i === S.index ? 'selected' : ''}>${i + 1}. ${cueTitle(c)}${goodCount(c) ? ' ✓' : ''}</option>`)}
              </select>
            </label>
            <button class="btn rec big" id="start-btn">● 녹화 시작</button>
            <ul class="tips">
              <li>리모컨·키보드: <kbd>다음</kbd> ▶ / PgDn / 스페이스 · <kbd>다시</kbd> ◀ / PgUp · <kbd>일시정지</kbd> B</li>
              <li>이어폰을 쓰면 영상 소리가 마이크에 섞이지 않습니다.</li>
              <li>방해금지 모드를 켜서 알림을 꺼 두세요.</li>
            </ul>
          </div>
        </div>
      </div>`);

    $('#cam-select').addEventListener('change', () => reopenCamera());
    $('#mic-select').addEventListener('change', () => reopenCamera());
    $('#ns-toggle').addEventListener('change', () => reopenCamera());
    $('#screen-btn').addEventListener('click', () => (S.screenStream ? disconnectScreen() : connectScreen()));
    $('#pip-btn').addEventListener('click', () => openPrompter());
    $('#start-btn').addEventListener('click', () => startRecording());
    $('#start-select').addEventListener('change', (e) => {
      S.index = Number(e.target.value);
      updatePrompter();
    });
    root.addEventListener('click', () => S.meter?.resume(), { once: true });
    updateSetupStatus();
  }

  async function fillDeviceLists() {
    const { cams, mics } = await listDevices();
    const fill = (select, list, chosen, fallback) => {
      select.innerHTML = String(html`${list.map((d, i) => html`<option value="${d.deviceId}" ${d.deviceId === chosen ? 'selected' : ''}>${d.label || `${fallback} ${i + 1}`}</option>`)}`);
    };
    const camTrack = S.camStream?.getVideoTracks()[0];
    const micTrack = S.camStream?.getAudioTracks()[0];
    fill($('#cam-select'), cams, camTrack?.getSettings().deviceId ?? prefs.camId, '카메라');
    fill($('#mic-select'), mics, micTrack?.getSettings().deviceId ?? prefs.micId, '마이크');
  }

  async function reopenCamera(first = false) {
    const camId = first ? prefs.camId : $('#cam-select')?.value;
    const micId = first ? prefs.micId : $('#mic-select')?.value;
    const noiseSuppression = $('#ns-toggle')?.checked ?? true;
    stopStream(S.camStream);
    S.meter?.close();
    S.meter = null;
    try {
      S.camStream = await openCamera({ camId, micId, noiseSuppression });
    } catch (err) {
      if (first && (camId || micId)) {
        // The remembered device is gone (e.g. iPhone not nearby): use the defaults.
        return reopenCamera(false);
      }
      S.camStream = null;
      const empty = $('#preview-empty');
      if (empty) empty.textContent = err.name === 'NotAllowedError'
        ? '카메라·마이크 권한이 필요합니다. 주소창 왼쪽 아이콘에서 허용해 주세요.'
        : `카메라를 켜지 못했습니다: ${err.message}`;
      return;
    }
    const v = S.camStream.getVideoTracks()[0];
    const a = S.camStream.getAudioTracks()[0];
    saveDevicePrefs({ camId: v?.getSettings().deviceId, micId: a?.getSettings().deviceId, noiseSuppression });
    Object.assign(prefs, loadDevicePrefs());
    v?.addEventListener('ended', () => {
      if (S.phase === 'live') toast('카메라 연결이 끊겼습니다! 녹화를 종료하고 카메라를 확인해 주세요.', 'error', 15000);
    });
    const preview = $('#cam-preview');
    if (preview) {
      preview.srcObject = S.camStream;
      $('#preview-empty').hidden = true;
    }
    const info = $('#cam-info');
    if (info) info.textContent = `${v?.label ?? ''} · ${describeVideo(S.camStream)}`;
    if (a) {
      S.meter = new LevelMeter(S.camStream, (level, clip) => {
        const fill = $('#meter-fill') ?? $('#meter-mini');
        if (fill) {
          fill.style.width = `${Math.round(level * 100)}%`;
          fill.classList.toggle('clip', clip);
        }
      });
    }
    await fillDeviceLists();
  }

  async function connectScreen() {
    try {
      const stream = await openScreen();
      stream.getVideoTracks()[0].addEventListener('ended', () => onScreenEnded(stream));
      S.screenStream = stream;
      if (!stream.getAudioTracks().length) {
        toast('탭 소리가 공유되지 않았습니다. 유튜브 소리가 필요하면 다시 연결하고 “탭 오디오도 공유”를 켜 주세요.', 'warn', 9000);
      }
      if (S.phase === 'live') {
        await startScreenTrack();
        renderCue();
      }
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast(`데모 탭을 연결하지 못했습니다: ${err.message}`, 'error');
    }
    updateUi();
  }

  async function disconnectScreen() {
    const stream = S.screenStream;
    if (!stream) return;
    stopStream(stream);
    await onScreenEnded(stream);
  }

  async function onScreenEnded(stream) {
    if (S.screenStream === stream) S.screenStream = null;
    for (const [file, t] of S.tracks) {
      if (t.stream !== stream) continue;
      await t.rec.stop();
      S.events.log({ type: 'track-end', file, t: now() });
      S.tracks.delete(file);
      S.finishedUploaders.push(t.uploader);
      if (S.phase === 'live' && !S.stopping) toast('데모 탭 공유가 끝났습니다. 데모 장면 전에 다시 연결해 주세요.', 'warn', 8000);
    }
    if (S.phase === 'live' && !S.stopping) renderCue();
    updateUi();
  }

  async function openPrompter() {
    try {
      await prompter.open();
      updatePrompter();
      renderPromptPanel();
    } catch (err) {
      toast(err.message, 'error');
    }
    updateUi();
  }

  function updateSetupStatus() {
    const sp = $('#screen-pill');
    if (sp) {
      const s = S.screenStream;
      sp.textContent = s ? (s.getAudioTracks().length ? '연결됨 · 소리 포함' : '연결됨 · 소리 없음') : '연결 안 됨';
      sp.className = `pill ${s ? (s.getAudioTracks().length ? 'ok' : 'warn') : ''}`;
      $('#screen-btn').textContent = s ? '연결 끊기' : '데모 탭 연결';
    }
    const pp = $('#pip-pill');
    if (pp) {
      pp.textContent = prompter.isOpen ? '열림' : '닫힘';
      pp.className = `pill ${prompter.isOpen ? 'ok' : ''}`;
      $('#pip-btn').disabled = prompter.isOpen;
    }
  }

  // ---------- live ----------
  function renderLive() {
    root.innerHTML = String(html`
      <div class="studio live">
        <header class="studio-top">
          <div class="rec-pill" id="rec-pill"><span class="dot"></span><span id="rec-state">녹화 중</span> <span id="rec-clock">0:00</span></div>
          <div class="pill" id="pos-pill"></div>
          <div class="pill" id="take-pill"></div>
          <div class="pill" id="screen-live-pill"></div>
          <div class="pill" id="save-pill"></div>
          <span class="grow"></span>
          <div class="mini-cam"><video id="cam-mini" class="mirror" autoplay muted playsinline></video><div class="meter mini"><div class="meter-fill" id="meter-mini"></div></div></div>
          <button class="btn small" id="screen-live-btn"></button>
          <button class="btn small" id="pip-live-btn">프롬프터 창</button>
          <button class="btn danger" id="stop-btn">■ 녹화 종료</button>
        </header>
        <div class="stage">
          <div class="stage-main">
            <section class="prompt-panel" id="prompt-panel"></section>
            <section class="cue-view" id="cue-view"></section>
          </div>
          <aside class="cue-list" id="cue-list"></aside>
        </div>
        <footer class="controls">
          <button class="ctl" id="prev-btn" title="이전 장면을 다시 찍습니다">⏮ 이전 장면</button>
          <button class="ctl" id="retake-btn">⟲ 다시 <kbd>◀ PgUp</kbd></button>
          <button class="ctl" id="pause-btn">❚❚ 일시정지 <kbd>B</kbd></button>
          <button class="ctl primary" id="next-btn">다음 ▶ <kbd>▶ PgDn</kbd></button>
        </footer>
        <div class="countdown" id="countdown" hidden></div>
      </div>`);
    $('#cam-mini').srcObject = S.camStream;
    for (const btn of $$('.controls button, .studio-top button')) {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
    }
    $('#next-btn').addEventListener('click', () => next());
    $('#retake-btn').addEventListener('click', () => retake());
    $('#pause-btn').addEventListener('click', () => togglePause());
    $('#prev-btn').addEventListener('click', () => S.index > 0 && jumpTo(S.index - 1));
    $('#stop-btn').addEventListener('click', () => stopRecording());
    $('#pip-live-btn').addEventListener('click', () => openPrompter());
    $('#screen-live-btn').addEventListener('click', () => (S.screenStream ? disconnectScreen() : connectScreen()));
    $('#cue-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-index]');
      if (item) jumpTo(Number(item.dataset.index));
    });
    renderCueList();
    renderCue();
    updateUi();
  }

  function renderCueList() {
    const list = $('#cue-list');
    if (!list) return;
    list.innerHTML = String(html`${cues.map((c, i) => html`
      <button class="cue-item ${i === S.index ? 'current' : ''}" data-index="${i}">
        <span class="num">${i + 1}</span>
        <span class="type-badge t-${c.type}">${CUE_TYPES[c.type].label}</span>
        <span class="title">${cueTitle(c)}</span>
        <span class="takes">${goodCount(c) ? `✓${goodCount(c)}` : ''}</span>
      </button>`)}`);
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  function renderCue() {
    const c = cue();
    const view = $('#cue-view');
    if (!view) return;
    const nextCue = cues[S.index + 1];
    let body;
    if (c.type === 'slide') {
      body = html`<img class="slide-img" src="${slideUrl(project, c.page)}" alt="슬라이드 ${c.page}">`;
    } else {
      const guide = {
        demo: '데모 탭으로 가서 진행하세요. 끝나면 프롬프터 창의 [다음]을 누르세요.',
        video: '데모 탭에서 영상을 재생하세요. 끝나면 [다음]을 누르세요.',
        face: '카메라를 보고 말하세요.',
      }[c.type];
      body = html`
        <div class="cue-card t-${c.type}">
          <span class="type-badge t-${c.type}">${CUE_TYPES[c.type].label}</span>
          <h2>${cueTitle(c)}</h2>
          <p class="guide">${guide}</p>
          ${needsScreen(c) && !S.screenStream ? html`<p class="warn-text">⚠ 데모 탭이 연결되지 않았습니다. 위의 [데모 탭 연결]을 눌러 주세요.</p>` : ''}
          ${c.type === 'video' && c.url ? html`<p class="url-row"><code>${c.url}</code> <button class="btn small" id="copy-url">링크 복사</button></p>` : ''}
        </div>`;
    }
    view.innerHTML = String(html`
      ${body}
      <div class="next-up">${nextCue ? html`다음: <b>${S.index + 2}. ${cueTitle(nextCue)}</b>` : '마지막 장면입니다'}</div>`);
    $('#copy-url')?.addEventListener('click', () => navigator.clipboard.writeText(c.url).then(() => toast('링크를 복사했습니다')));
    renderPromptPanel();
  }

  function renderPromptPanel() {
    const panel = $('#prompt-panel');
    if (!panel) return;
    const c = cue();
    if (prompter.isOpen) {
      panel.innerHTML = '<div class="prompt-note">대본은 프롬프터 창에 표시 중입니다</div>';
      panel.classList.add('compact');
      return;
    }
    panel.classList.remove('compact');
    panel.innerHTML = String(html`<div class="prompt-script ${c.script ? '' : 'empty'}">${c.script || '(대본 없음)'}</div>`);
  }

  function statusText() {
    if (S.phase !== 'live') return { status: 'setup', text: '준비' };
    if (S.mode === 'countdown') return { status: 'countdown', text: '곧 시작' };
    if (S.mode === 'paused') return { status: 'paused', text: '일시정지' };
    if (S.mode === 'idle') return { status: 'idle', text: '대기' };
    return { status: 'rec', text: '녹화 중' };
  }

  function updatePrompter(extra = {}) {
    const c = cue();
    const nextCue = cues[S.index + 1];
    const st = statusText();
    let warn = null;
    if (S.phase === 'live' && needsScreen(c) && !S.screenStream) warn = '데모 탭이 연결되지 않았습니다';
    if (S.phase === 'live' && S.mode === 'idle' && S.index === cues.length - 1) warn = '마지막 장면까지 녹화했습니다. [녹화 종료]를 누르세요.';
    prompter.update({
      status: st.status,
      statusText: st.text,
      position: `${S.index + 1}/${cues.length}`,
      take: S.phase === 'live' ? `테이크 ${takeNumber(c) - (S.mode === 'take' || S.mode === 'paused' ? 1 : 0)}` : '',
      clock: S.phase === 'live' ? fmtClock(takeElapsed()) : '',
      type: c.type,
      typeLabel: CUE_TYPES[c.type].label,
      title: cueTitle(c),
      script: c.script,
      url: c.type === 'video' ? c.url : '',
      nextTitle: nextCue ? `${S.index + 2}. ${cueTitle(nextCue)}` : '',
      warn,
      ...extra,
    });
  }

  function updateUi() {
    if (S.phase === 'setup') {
      updateSetupStatus();
      updatePrompter();
      return;
    }
    if (S.phase !== 'live') return;
    const c = cue();
    const st = statusText();
    $('#rec-pill').dataset.status = st.status;
    $('#rec-state').textContent = st.text;
    $('#rec-clock').textContent = fmtClock(performance.now() - S.t0);
    $('#pos-pill').textContent = `장면 ${S.index + 1}/${cues.length}`;
    const inTake = S.mode === 'take' || S.mode === 'paused';
    $('#take-pill').textContent = inTake ? `테이크 ${takeNumber(c) - 1} · ${fmtClock(takeElapsed())}` : '테이크 대기';
    const sp = $('#screen-live-pill');
    const s = S.screenStream;
    sp.textContent = s ? `데모 탭 연결됨${s.getAudioTracks().length ? '' : ' (소리 없음)'}` : '데모 탭 없음';
    sp.className = `pill ${s ? 'ok' : needsScreen(c) ? 'bad' : ''}`;
    $('#screen-live-btn').textContent = s ? '데모 탭 끊기' : '데모 탭 연결';
    $('#pip-live-btn').hidden = prompter.isOpen;
    const save = saveState();
    const savePill = $('#save-pill');
    savePill.textContent = save.error ? '저장 오류 · 재시도 중' : save.pending > 3 ? `저장 대기 ${save.pending}` : `저장됨 ${fmtBytes(save.bytes)}`;
    savePill.className = `pill ${save.error ? 'bad' : save.pending > 3 ? 'warn' : 'ok'}`;
    $('#pause-btn').innerHTML = S.mode === 'paused' ? '▶ 이어서 <kbd>B</kbd>' : '❚❚ 일시정지 <kbd>B</kbd>';
    $('#prev-btn').disabled = S.index === 0;
    updatePrompter();
  }

  // ---------- recording ----------
  async function startTrack(kind, stream) {
    const file = kind === 'camera' ? 'camera.webm' : `screen-${++S.screenCount}.webm`;
    const uploader = new SeqUploader((seq) => api.chunkUrl(pid, S.sessionId, file, seq), () => {});
    const rec = new TrackRecorder(stream, {
      uploader,
      videoBitsPerSecond: kind === 'camera' ? 8_000_000 : 6_000_000,
      onError: (err) => toast(`${kind === 'camera' ? '카메라' : '데모 탭'} 녹화 오류: ${err.message}`, 'error', 10000),
    });
    const startedAt = await rec.start();
    S.events.log({ type: 'track-start', track: kind, file, t: Math.round((startedAt - S.t0) * 10) / 10, mime: rec.mimeType });
    S.tracks.set(file, { rec, kind, uploader, stream });
  }

  async function startScreenTrack() {
    if (!S.screenStream) return;
    try {
      await startTrack('screen', S.screenStream);
    } catch (err) {
      toast(`데모 탭 녹화를 시작하지 못했습니다: ${err.message}`, 'error', 10000);
    }
  }

  async function startRecording() {
    if (!S.camStream) return toast('카메라를 먼저 켜 주세요.', 'error');
    if (!S.camStream.getAudioTracks().length && !confirm('마이크가 없습니다. 소리 없이 녹화할까요?')) return;
    if (cues.some(needsScreen) && !S.screenStream
      && !confirm('데모·영상 장면이 있는데 데모 탭이 연결되지 않았습니다.\n그대로 시작할까요? (녹화 중에도 연결할 수 있습니다)')) return;
    const btn = $('#start-btn');
    btn.disabled = true;
    try {
      const { id } = await api.createSession(pid);
      S.sessionId = id;
      S.events = new EventLog((seq) => api.eventUrl(pid, id, seq), () => {});
      S.finishedUploaders = [];
      S.t0 = performance.now();
      S.events.log({ type: 'session-start', t: 0, wall: Date.now() });
      await startTrack('camera', S.camStream);
      await startScreenTrack();
    } catch (err) {
      btn.disabled = false;
      toast(`녹화를 시작하지 못했습니다: ${err.message}`, 'error', 10000);
      return;
    }
    S.phase = 'live';
    S.stopping = false;
    setNavGuard(() => confirm('녹화 중입니다. 이 화면을 나가면 녹화가 종료됩니다. 나갈까요?'));
    window.addEventListener('beforeunload', onBeforeUnload);
    requestWakeLock();
    renderLive();
    S.stopTicking = steadyInterval(updateUi, 250);
    document.addEventListener('visibilitychange', onVisibility);
    await countdown();
    beginTake();
  }

  async function countdown() {
    S.mode = 'countdown';
    updateUi();
    const box = $('#countdown');
    try {
      for (const n of [3, 2, 1]) {
        if (box) {
          box.hidden = false;
          box.textContent = n;
        }
        updatePrompter({ countdown: n });
        await steadySleep(COUNT_STEP_MS);
        if (S.phase !== 'live' || S.stopping) return;
      }
    } finally {
      if (box && !S.stopping) box.hidden = true;
      updatePrompter({ countdown: null });
    }
  }

  function beginTake() {
    if (S.phase !== 'live' || S.stopping) return;
    const c = cue();
    S.events.log({ type: 'take-start', cueId: c.id, t: now() });
    S.sessionAll.set(c.id, (S.sessionAll.get(c.id) ?? 0) + 1);
    S.mode = 'take';
    S.takeStartedAt = performance.now();
    S.takeElapsedBefore = 0;
    renderCueList();
    renderCue();
    updateUi();
    if (needsScreen(c) && !S.screenStream) toast('이 장면은 데모 탭이 필요한데 연결되어 있지 않습니다.', 'warn', 6000);
  }

  function endTake(reason) {
    const c = cue();
    const elapsed = takeElapsed();
    S.events.log({ type: 'take-end', cueId: c.id, t: now(), reason });
    if (reason !== 'retake' && elapsed >= 500) S.sessionGood.set(c.id, (S.sessionGood.get(c.id) ?? 0) + 1);
    S.mode = 'idle';
    S.takeElapsedBefore = 0;
  }

  function canAct() {
    const t = performance.now();
    if (S.phase !== 'live' || S.stopping || S.mode === 'countdown') return false;
    if (t - S.lastAction < ACTION_GAP_MS) return false;
    S.lastAction = t;
    return true;
  }

  async function next() {
    if (!canAct()) return;
    const wasPaused = S.mode === 'paused';
    if (S.mode === 'take' || wasPaused) endTake('next');
    if (S.index >= cues.length - 1) {
      S.mode = 'idle';
      renderCueList();
      updateUi();
      toast('마지막 장면까지 녹화했습니다. 확인 후 [녹화 종료]를 누르세요.', 'info', 6000);
      return;
    }
    S.index += 1;
    if (wasPaused) await countdown();
    beginTake();
  }

  async function retake() {
    if (!canAct()) return;
    if (S.mode === 'take' || S.mode === 'paused') endTake('retake');
    await countdown();
    beginTake();
  }

  async function togglePause() {
    if (!canAct()) return;
    if (S.mode === 'take') {
      S.events.log({ type: 'pause', t: now() });
      S.takeElapsedBefore += performance.now() - S.takeStartedAt;
      S.mode = 'paused';
      updateUi();
    } else if (S.mode === 'paused') {
      await countdown();
      if (S.phase !== 'live') return;
      S.events.log({ type: 'resume', t: now() });
      S.takeStartedAt = performance.now();
      S.mode = 'take';
      updateUi();
    }
  }

  async function jumpTo(i) {
    if (i < 0 || i >= cues.length) return;
    if (i === S.index && (S.mode === 'take' || S.mode === 'paused')) return;
    if (!canAct()) return;
    if (S.mode === 'take' || S.mode === 'paused') endTake('jump');
    S.index = i;
    renderCueList();
    renderCue();
    await countdown();
    beginTake();
  }

  function onKey(e) {
    if (S.phase !== 'live') return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'PageDown' || e.key === 'ArrowRight' || e.code === 'Space') {
      e.preventDefault();
      next();
    } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      retake();
    } else if (e.code === 'KeyB' || e.code === 'Period') {
      e.preventDefault();
      togglePause();
    } else if (e.key === 'F5' || e.key === 'Escape') {
      // Presentation remotes send these; never let them reload or leave the page.
      e.preventDefault();
    }
  }

  function onBeforeUnload(e) {
    if (S.phase === 'live') {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  async function requestWakeLock() {
    try {
      S.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      // not critical
    }
  }

  // The screen wake lock is dropped whenever the tab is hidden (e.g. during a demo).
  function onVisibility() {
    if (document.visibilityState === 'visible' && S.phase === 'live' && !S.stopping) requestWakeLock();
  }

  async function stopRecording({ ask = true } = {}) {
    if (S.phase !== 'live' || S.stopping) return;
    if (ask && !confirm('녹화를 종료할까요?')) return;
    S.stopping = true;
    S.stopTicking?.();
    document.removeEventListener('visibilitychange', onVisibility);
    if (S.mode === 'take' || S.mode === 'paused') endTake('stop');
    S.mode = 'idle';
    const overlay = $('#countdown');
    if (overlay) {
      overlay.hidden = false;
      overlay.classList.add('saving');
      overlay.textContent = '저장 중…';
    }
    for (const [file, t] of S.tracks) {
      await t.rec.stop();
      S.events.log({ type: 'track-end', file, t: now() });
      S.finishedUploaders.push(t.uploader);
    }
    S.tracks.clear();
    S.events.log({ type: 'session-end', t: now() });
    const all = [...S.finishedUploaders, S.events.uploader];
    const results = await Promise.all(all.map((u) => u.flush(90000)));
    const bytes = all.reduce((n, u) => n + u.savedBytes, 0);
    S.wakeLock?.release?.().catch(() => {});
    S.wakeLock = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
    setNavGuard(null);
    S.phase = 'finished';
    renderFinished({ allSaved: results.every(Boolean), bytes });
  }

  function renderFinished({ allSaved, bytes }) {
    const missing = cues.map((c, i) => ({ c, i })).filter(({ c }) => !goodCount(c));
    const recorded = cues.filter((c) => S.sessionGood.get(c.id)).length;
    root.innerHTML = String(html`
      <div class="page narrow">
        <div class="done-card">
          <h1>${allSaved ? '녹화를 저장했습니다' : '⚠ 일부 데이터가 아직 저장되지 않았습니다'}</h1>
          <p class="muted">이번 촬영: ${recorded}개 장면 · ${fmtBytes(bytes)} 저장</p>
          ${allSaved ? '' : html`<p class="warn-text">서버(터미널)가 켜져 있는지 확인하고 이 창을 닫지 마세요. 저장을 계속 다시 시도합니다.</p>`}
          ${missing.length
            ? html`<div class="missing"><b>아직 찍지 않은 장면 ${missing.length}개</b>
                <ul>${missing.slice(0, 12).map(({ c, i }) => html`<li>${i + 1}. ${cueTitle(c)}</li>`)}</ul>
                ${missing.length > 12 ? html`<p class="muted small">외 ${missing.length - 12}개</p>` : ''}</div>`
            : html`<p class="ok-text">모든 장면에 테이크가 있습니다.</p>`}
          <div class="row">
            <button class="btn" id="again-btn">이어서 촬영</button>
            <a class="btn primary" href="#/p/${pid}/takes">영상 만들기 →</a>
          </div>
        </div>
      </div>`);
    $('#again-btn').addEventListener('click', () => {
      for (const [id, n] of S.sessionGood) priorGood.set(id, (priorGood.get(id) ?? 0) + n);
      for (const [id, n] of S.sessionAll) priorAll.set(id, (priorAll.get(id) ?? 0) + n);
      S.sessionGood.clear();
      S.sessionAll.clear();
      S.events = null;
      S.sessionId = null;
      S.screenCount = 0;
      const nextMissing = cues.findIndex((c) => !priorGood.get(c.id));
      S.index = nextMissing >= 0 ? nextMissing : S.index;
      S.phase = 'setup';
      renderSetup();
      const preview = $('#cam-preview');
      if (S.camStream && preview) {
        preview.srcObject = S.camStream;
        $('#preview-empty').hidden = true;
        $('#cam-info').textContent = describeVideo(S.camStream);
        fillDeviceLists();
      } else {
        reopenCamera(true);
      }
      updateUi();
    });
  }

  // ---------- start ----------
  document.addEventListener('keydown', onKey);
  renderSetup();
  await reopenCamera(true);
  updateUi();

  return async () => {
    document.removeEventListener('keydown', onKey);
    if (S.phase === 'live') await stopRecording({ ask: false });
    S.stopTicking?.();
    S.meter?.close();
    stopStream(S.camStream);
    stopStream(S.screenStream);
    prompter.close();
  };
}
