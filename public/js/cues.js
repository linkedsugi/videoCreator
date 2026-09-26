export const CUE_TYPES = {
  slide: { label: '슬라이드', hint: '이 슬라이드에서 할 말 (프롬프터에 그대로 뜹니다)' },
  demo: { label: '데모', hint: '진행 순서와 메모. 예) 1. 새 대화 열기  2. 프롬프트 붙여넣기  3. 결과 설명' },
  video: { label: '영상', hint: '영상 틀기 전후에 할 말' },
  face: { label: '얼굴', hint: '카메라를 보고 할 말. 예) 인사, 오늘 배울 내용, 마무리' },
};

export function newCueId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `c${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function cueTitle(cue) {
  if (cue.type === 'slide') return cue.title?.trim() || `슬라이드 ${cue.page}`;
  return cue.title?.trim() || `${CUE_TYPES[cue.type]?.label ?? ''} 장면`;
}

/** Whether the face window is shown on top of this cue in the final video. */
export function showFaceOf(cue) {
  if (cue.type === 'face') return true;
  if (typeof cue.showFace === 'boolean') return cue.showFace;
  return cue.type !== 'video';
}

export function needsScreen(cue) {
  return cue.type === 'demo' || cue.type === 'video';
}

export function slideUrl(project, page) {
  return `/data/${project.id}/slides/p${String(page).padStart(3, '0')}.png?v=${project.slides?.version ?? 0}`;
}
