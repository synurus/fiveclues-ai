/**
 * 오늘의 문제(2026-09-29) — 날짜마다 모두가 같은 제시어·같은 묘사를 푼다(Wordle처럼 결과를
 * 공유해 비교할 수 있게, 그리고 같은 묘사를 여럿이 풀어 정답률을 깨끗하게 재려고).
 *
 * 날짜별 문제는 scripts/daily/{ko,en}.json에 **묘사까지 통째로 복사해** 둔다. 묘사 세트
 * 파일(scripts/hintsets/)은 새 세대로 바뀌며 세트가 교체되니, 참조만 해 두면 하루 중간에
 * 묘사가 바뀔 수 있어서다. 일정은 pregenHints.ts가 실행 끝에 scheduleDaily()로 7일 앞까지
 * 채우고(워크플로가 커밋), 이미 정한 날짜는 절대 바꾸지 않는다.
 *
 * ⚠️ 이 파일과 묘사 세트는 공개 저장소에 있다 — 마음먹으면 정답을 찾아볼 수 있다. 순위표가
 * 없고 공유는 자기 결과뿐이라 받아들였다.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HintSet, HintSetFile, Lang } from './hintSets';

export interface DailyPuzzle {
  word: string;
  category: string;
  promptVersion: string;
  model: string;
  round1: string[];
  round2: string[];
  banned?: string[]; // 결과 화면에 보여 줄 "AI가 일부러 말하지 않은 특징"
}

export type DailyFile = Record<string, DailyPuzzle>; // "YYYY-MM-DD" → 문제

/** 1번 문제의 날짜. 문제 번호 = 이 날부터 며칠째인지(1부터). */
export const DAILY_EPOCH = '2026-09-29';
/** 이 기간 안에 나온 제시어는 다시 고르지 않는다. */
export const DAILY_NO_REPEAT_DAYS = 90;

export function dailyDir(): string {
  return process.env.DAILY_DIR || path.join(__dirname, '../../../../scripts/daily');
}
export const dailyPath = (lang: Lang): string => path.join(dailyDir(), `${lang}.json`);

export function readDailyFile(lang: Lang): DailyFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(dailyPath(lang), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as DailyFile) : {};
  } catch {
    return {};
  }
}

const cache = new Map<Lang, DailyFile>();
export function clearDailyCache(): void {
  cache.clear();
}

// ── 날짜 ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const toDay = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
export const addDays = (d: string, n: number): string => new Date((toDay(d) + n) * DAY_MS).toISOString().slice(0, 10);
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toDay(v));
export const utcToday = (now = new Date()): string => now.toISOString().slice(0, 10);

export function dailyNumber(date: string): number {
  return toDay(date) - toDay(DAILY_EPOCH) + 1;
}

/**
 * 이용자 기기의 날짜를 받되, 세계 어딘가에서 실제로 "오늘"일 수 있는 범위(UTC 오늘 ±1일)만
 * 받는다 — 그 밖이면 null(내일 문제를 미리 푸는 걸 막는 정도의 검사).
 */
export function acceptableDate(date: unknown, now = new Date()): string | null {
  if (!isDate(date)) return null;
  const diff = toDay(date) - toDay(utcToday(now));
  return diff >= -1 && diff <= 1 ? date : null;
}

export function dailyFor(lang: Lang, date: string): { puzzle: DailyPuzzle; number: number } | null {
  let file = cache.get(lang);
  if (!file) {
    file = readDailyFile(lang);
    cache.set(lang, file);
  }
  const puzzle = file[date];
  return puzzle && dailyNumber(date) >= 1 ? { puzzle, number: dailyNumber(date) } : null;
}

// ── 일정 채우기(pregenHints.ts가 부른다) ────────────────────────────────

/**
 * from부터 days일 동안 비어 있는 날짜에 문제를 정한다. 이미 있는 날짜는 그대로 둔다.
 * 고르는 법: 세트가 있는 단어 중 최근 DAILY_NO_REPEAT_DAYS일 안에 안 나온 것, 지금 세대
 * 세트가 있는 단어를 먼저, 그 안에선 무작위. 세트는 그 단어의 가장 최근 것.
 * 반환: 새로 채운 날짜들. (file을 직접 고친다)
 */
export function scheduleDaily(
  file: DailyFile,
  sets: HintSetFile,
  categoryOf: (word: string) => string | undefined,
  currentVersion: string,
  from: string,
  days: number,
  random: () => number = Math.random,
): string[] {
  const added: string[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (file[date] || dailyNumber(date) < 1) continue;
    const recent = new Set(
      Object.entries(file)
        .filter(([d]) => Math.abs(toDay(d) - toDay(date)) < DAILY_NO_REPEAT_DAYS)
        .map(([, p]) => p.word),
    );
    const candidates = Object.entries(sets.sets).filter(([word, s]) => s.length && !recent.has(word) && categoryOf(word));
    if (!candidates.length) break;
    const fresh = candidates.filter(([, s]) => s.some((x) => x.promptVersion === currentVersion));
    const pool = fresh.length ? fresh : candidates;
    const [word, wordSets] = pool[Math.floor(random() * pool.length)]!;
    const set: HintSet = [...wordSets].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]!;
    file[date] = {
      word,
      category: categoryOf(word)!,
      promptVersion: set.promptVersion,
      model: set.model,
      round1: set.round1,
      round2: set.round2,
      ...(set.banned?.length ? { banned: set.banned } : {}),
    };
    added.push(date);
  }
  return added;
}

export function writeDailyFile(lang: Lang, file: DailyFile): void {
  fs.mkdirSync(dailyDir(), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(file).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(dailyPath(lang), JSON.stringify(sorted, null, 1) + '\n');
}
