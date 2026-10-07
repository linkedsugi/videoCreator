async function request(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof Blob) {
    init.body = body;
    init.headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 터미널에서 npm start가 실행 중인지 확인해 주세요.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `요청 실패 (HTTP ${res.status})`);
  return data;
}

const P = (pid) => `/api/projects/${encodeURIComponent(pid)}`;

export const api = {
  health: () => request('GET', '/api/health'),
  listProjects: () => request('GET', '/api/projects'),
  createProject: (title) => request('POST', '/api/projects', { title }),
  getProject: (pid) => request('GET', P(pid)),
  saveProject: (pid, patch) => request('PUT', P(pid), patch),
  getTakes: (pid) => request('GET', `${P(pid)}/takes`),
  beginSlides: (pid) => request('POST', `${P(pid)}/slides/begin`),
  putStagedSlide: (pid, page, blob) => request('PUT', `${P(pid)}/slides/staging/${page}`, blob),
  commitSlides: (pid, count) => request('POST', `${P(pid)}/slides/commit`, { count }),
  createSession: (pid) => request('POST', `${P(pid)}/sessions`, { userAgent: navigator.userAgent }),
  startBuild: (pid) => request('POST', `${P(pid)}/build`),
  buildStatus: (pid) => request('GET', `${P(pid)}/build`),
  openFolder: (pid, target) => request('POST', `${P(pid)}/open`, { target }),
  storage: (pid) => request('GET', `${P(pid)}/storage`),
  lookInfo: (pid) => request('GET', `${P(pid)}/look`),
  cutout: (pid) => request('GET', `${P(pid)}/look/cutout`),
  putAsset: (pid, name, blob) => request('PUT', `${P(pid)}/assets/${name}`, blob),
  deleteAsset: (pid, name) => request('DELETE', `${P(pid)}/assets/${name}`),
  clearCache: (pid) => request('DELETE', `${P(pid)}/cache`),
  /** Converts a PowerPoint file on this Mac. Resolves { blob, via }. */
  convert: async (file, to) => {
    let res;
    try {
      res = await fetch(`/api/convert?to=${to}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    } catch {
      throw new Error('서버에 연결할 수 없습니다. 터미널에서 npm start가 실행 중인지 확인해 주세요.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `변환 실패 (HTTP ${res.status})`);
    }
    return { blob: await res.blob(), via: res.headers.get('X-Converted-By') };
  },
  chunkUrl: (pid, sid, file, seq) => `${P(pid)}/sessions/${sid}/tracks/${file}/chunks?seq=${seq}`,
  eventUrl: (pid, sid, seq) => `${P(pid)}/sessions/${sid}/events?seq=${seq}`,
};
