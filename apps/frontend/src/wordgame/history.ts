// 내 기록(2026-09-29) — 끝낸 판을 이 브라우저에만 쌓아 통계를 보여 준다. 서버로는 보내지 않는다
// (DB 없음). 오늘의 문제 연속 정답은 daily.ts의 기록(fiveclues-daily)에서 따로 센다 — 지난 문제
// (아카이브)는 그쪽에 안 남겨서 빈 날을 나중에 채워 연속 기록을 늘릴 수 없다.
import type { Lang } from './i18n';
import type { Outcome } from './daily';

export type Mode = 'daily' | 'archive' | 'free';

export interface GameRecord {
  date: string; // 끝낸 날(이 기기 날짜)
  lang: Lang;
  mode: Mode;
  outcome: Outcome;
  category: string;
  easy?: boolean;
  number?: number; // 오늘의 문제·지난 문제 번호
}

const STORAGE_KEY = 'fiveclues-history';
const KEEP = 500;

function load(): GameRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as GameRecord[]) : [];
  } catch {
    return [];
  }
}

export function recordGame(record: GameRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...load(), record].slice(-KEEP)));
  } catch {
    // 무시 — 기록이 안 남을 뿐
  }
}

export function loadHistory(lang: Lang): GameRecord[] {
  return load().filter((r) => r.lang === lang);
}

/** 오늘의 문제·지난 문제 번호 → 가장 최근 결과(지난 문제 목록에 표시). */
export function puzzleResults(lang: Lang): Map<number, Outcome> {
  const map = new Map<number, Outcome>();
  for (const r of loadHistory(lang)) if (r.number && r.mode !== 'free') map.set(r.number, r.outcome);
  return map;
}

export interface Stats {
  total: number;
  won: number;
  round1: number;
  recent: Outcome[]; // 최근 것이 앞
  categories: { category: string; n: number; won: number }[]; // 2판 이상, 정답률 높은 순
}

export function computeStats(list: GameRecord[]): Stats {
  const won = list.filter((r) => r.outcome !== 'failed').length;
  const byCat = new Map<string, { n: number; won: number }>();
  for (const r of list) {
    const c = byCat.get(r.category) ?? { n: 0, won: 0 };
    c.n += 1;
    if (r.outcome !== 'failed') c.won += 1;
    byCat.set(r.category, c);
  }
  return {
    total: list.length,
    won,
    round1: list.filter((r) => r.outcome === 'round1').length,
    recent: list.slice(-10).reverse().map((r) => r.outcome),
    categories: [...byCat]
      .filter(([, c]) => c.n >= 2)
      .map(([category, c]) => ({ category, ...c }))
      .sort((a, b) => b.won / b.n - a.won / a.n || b.n - a.n),
  };
}

export const OUTCOME_EMOJI: Record<Outcome, string> = { round1: '🟩', round2: '🟨', failed: '🟥' };
