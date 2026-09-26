import { api } from '../api.js';
import { html, $, fmtDateTime, toast } from '../ui.js';

export async function renderHome(root) {
  const [health, projects] = await Promise.all([api.health().catch(() => null), api.listProjects()]);

  root.innerHTML = String(html`
    <header class="topbar"><a class="brand" href="#/">● 강의 스튜디오</a><span class="grow"></span><a class="help-link" href="/guide.html" target="_blank" rel="noopener">사용법</a></header>
    <main class="page narrow">
      ${/Chrome\//.test(navigator.userAgent) ? '' : html`
        <div class="notice error">이 도구는 <b>Google Chrome</b>에서만 제대로 동작합니다. 크롬에서 <code>${location.origin}</code> 을 열어 주세요.</div>`}
      ${health && !health.ffmpeg ? html`
        <div class="notice warn">FFmpeg를 찾지 못했습니다. 녹화는 되지만 MP4 만들기가 안 됩니다.
          터미널에서 <code>npm install</code>을 다시 실행하거나 <code>brew install ffmpeg</code>으로 설치한 뒤 서버를 다시 켜 주세요.</div>` : ''}
      <section class="hero">
        <h1>새 강의 만들기</h1>
        <form class="inline-form" id="new-form">
          <input name="title" placeholder="예: 생성형 AI 입문 1차시" maxlength="120" required autocomplete="off">
          <button class="btn primary">만들기</button>
        </form>
        <ol class="flow">
          <li><b>큐시트</b> 슬라이드 PDF를 가져오고 장면마다 대본을 적습니다. 데모·영상·얼굴 장면도 끼워 넣습니다.</li>
          <li><b>촬영</b> 리모컨으로 <kbd>다음</kbd> <kbd>다시</kbd>만 누르며 진행합니다. 녹화는 끊기지 않습니다.</li>
          <li><b>영상 만들기</b> NG를 빼고 슬라이드·데모·얼굴을 합친 MP4가 나옵니다.</li>
        </ol>
      </section>
      <section>
        <h2>내 강의</h2>
        ${projects.length ? html`
          <div class="project-grid">
            ${projects.map((p) => html`
              <a class="project-card" href="#/p/${p.id}">
                <div class="project-title">${p.title}</div>
                <div class="muted small">장면 ${p.cueCount}개 · 촬영 ${p.sessionCount}회</div>
                <div class="muted small">${fmtDateTime(p.updatedAt)} 수정</div>
              </a>`)}
          </div>` : html`<p class="muted">아직 강의가 없습니다. 위에서 첫 강의를 만들어 보세요.</p>`}
      </section>
    </main>`);

  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = new FormData(e.target).get('title');
    try {
      const p = await api.createProject(String(title));
      location.hash = `#/p/${p.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  return () => {};
}
