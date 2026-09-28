// 쉬움 모드 설정(2026-09-29) — 1라운드부터 카테고리를 보여 준다. 다음 방문에도 유지되게
// localStorage에 켜짐/꺼짐만 저장한다(서버엔 게임을 시작할 때 easy 값으로만 간다).
const STORAGE_KEY = 'fiveclues-easy';

export function loadEasy(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveEasy(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 무시 — 다음 방문 때 꺼진 채로 시작할 뿐
  }
}
