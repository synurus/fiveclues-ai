// 오늘의 문제 — 이 브라우저의 기록·연속 정답·공유 문구(2026-09-29). 서버는 기록을 갖지 않는다
// (DB 없음) — "오늘 이미 풀었는지"와 연속 기록은 이 브라우저의 localStorage에만 있다.
import type { Lang } from './i18n';

export type Outcome = 'round1' | 'round2' | 'failed';
export interface DailyRecord {
  number: number;
  outcome: Outcome;
  easy?: boolean; // 쉬움 모드로 풀었는지 — 공유 문구에 표시
}

const STORAGE_KEY = 'fiveclues-daily';
const KEEP = 120; // 오래된 기록은 이만큼만 남긴다

/** 이 기기의 오늘 날짜(YYYY-MM-DD) — 자정이 각자 시간대에 맞게 넘어간다. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prevDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function load(): Record<string, DailyRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DailyRecord>) : {};
  } catch {
    return {}; // 프라이빗 모드 등 — 기록 없이 진행
  }
}

export function getDaily(lang: Lang, date: string): DailyRecord | null {
  return load()[`${lang}:${date}`] ?? null;
}

export function saveDaily(lang: Lang, date: string, record: DailyRecord): void {
  try {
    const all = { ...load(), [`${lang}:${date}`]: record };
    const trimmed = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)).slice(-KEEP));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 무시 — 기록이 안 남을 뿐 게임엔 지장 없다
  }
}

/** 오늘(아직 안 풀었으면 어제)부터 거슬러 올라가며 맞힌 날이 연속 며칠인지. */
export function solvedStreak(lang: Lang, today: string): number {
  const all = load();
  let date = all[`${lang}:${today}`] ? today : prevDate(today);
  let n = 0;
  for (;;) {
    const r = all[`${lang}:${date}`];
    if (!r || r.outcome === 'failed') return n;
    n += 1;
    date = prevDate(date);
  }
}

const GRID: Record<Outcome, string> = { round1: '🟩', round2: '🟥🟩', failed: '🟥🟥' };

/** Wordle식 공유 문구 — 정답은 안 들어간다. */
export function shareText(lang: Lang, record: DailyRecord, streak: number, url: string): string {
  const ko = lang === 'ko';
  const label = ko
    ? { round1: '1라운드에 맞힘', round2: '2라운드에 맞힘', failed: '못 맞힘' }[record.outcome]
    : { round1: 'Got it in round 1', round2: 'Got it in round 2', failed: 'Missed it' }[record.outcome];
  const lines = [
    ko ? `다섯고개 오늘의 문제 #${record.number}` : `Five Clues Daily #${record.number}`,
    `${GRID[record.outcome]} ${label}${record.easy ? (ko ? ' · 쉬움 모드' : ' · easy mode') : ''}`,
    ...(streak > 1 ? [ko ? `연속 정답 ${streak}일` : `${streak}-day streak`] : []),
    url,
  ];
  return lines.join('\n');
}

/** 휴대폰이면 공유 창, 아니면 클립보드 복사. */
export async function shareResult(text: string): Promise<'shared' | 'copied' | 'failed'> {
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (touch && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch {
      // 취소했거나 막힘 — 복사로 넘어간다
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
