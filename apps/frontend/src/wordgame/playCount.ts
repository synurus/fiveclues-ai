// 이 브라우저에서 끝낸 판 수(2026-09-28). 피드백에 "몇 번째 판"으로 실려 간다 — 기획서
// v2 §8: 같은 사람이 반복하면 요령이 생겨 정답률이 오르니, 프롬프트 세대를 비교할 때
// 처음 몇 판만 따로 볼 수 있어야 한다. 숫자 하나만 저장하고 서버로는 피드백을 보낼 때만 간다.
const STORAGE_KEY = 'fiveclues-plays';

/** 판 하나가 끝났을 때 부른다. 이번 판이 몇 번째인지(1부터) 돌려준다 — 저장소가 막혀 있으면 0. */
export function recordFinishedGame(): number {
  try {
    const next = (Number(localStorage.getItem(STORAGE_KEY)) || 0) + 1;
    localStorage.setItem(STORAGE_KEY, String(next));
    return next;
  } catch {
    return 0; // 프라이빗 모드 등 — 기록 없이 진행
  }
}
