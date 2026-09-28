/**
 * 미리 만든 묘사 세트(2026-09-28). 게임 요청 때마다 무료 모델로 묘사를 새로 만들면 모델
 * 과부하·한도에 따라 품질이 오르내렸다(제미나이 flash-lite가 503이면 gpt-oss로 넘어가 틀린
 * 말이 늘었다 — 이슈 #183~#190). 그래서 하루 한도가 작지만 품질이 가장 좋은 모델
 * (gemini-3.8-flash)로 단어마다 1·2라운드 묘사를 미리 만들어 저장해 두고, 게임은 그걸 먼저
 * 쓴다. 만드는 쪽은 bot/pregenHints.ts(.github/workflows/pregen-hints.yml),
 * 쓰는 쪽은 bot/hintSource.ts.
 *
 * 저장 위치: scripts/hintsets/{ko,en}.json — wordPool.ts의 단어 풀처럼 fs로 읽고, Vercel
 * 함수에 같이 묶이는 건 루트 vercel.json의 includeFiles가 보장한다.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HintSet {
  id: string;
  /** 이 세트를 만들 때의 출제 프롬프트 세대(bot/promptVersion.ts). */
  promptVersion: string;
  /** 만든 모델(예: "gemini-3.8-flash"). */
  model: string;
  generatedAt: string; // ISO
  round1: string[];
  round2: string[];
  /** 1라운드를 만들 때 AI가 적은 결정적 특징(결과 화면 공개용, 2026-09-29~). 옛 세트엔 없다. */
  banned?: string[];
}

export interface HintSetFile {
  sets: Record<string, HintSet[]>; // 제시어 → 세트들
}

export type Lang = 'ko' | 'en';

/** 테스트에서 다른 폴더(빈 폴더 등)를 쓰려고 환경변수로 바꿀 수 있다. */
export function hintSetsDir(): string {
  return process.env.HINT_SETS_DIR || path.join(__dirname, '../../../../scripts/hintsets');
}

export function hintSetsPath(lang: Lang): string {
  return path.join(hintSetsDir(), `${lang}.json`);
}

/** 파일이 없거나 깨졌으면 빈 세트 — 그러면 게임은 전부 실시간 생성으로 돈다. */
export function readHintSetFile(lang: Lang): HintSetFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(hintSetsPath(lang), 'utf8')) as Partial<HintSetFile>;
    return { sets: parsed.sets && typeof parsed.sets === 'object' ? parsed.sets : {} };
  } catch {
    return { sets: {} };
  }
}

const cache = new Map<Lang, HintSetFile>();
function loaded(lang: Lang): HintSetFile {
  let file = cache.get(lang);
  if (!file) {
    file = readHintSetFile(lang);
    cache.set(lang, file);
  }
  return file;
}

/** 테스트용 — 다시 읽게 한다. */
export function clearHintSetCache(): void {
  cache.clear();
}

/**
 * 이 단어의 세트 하나를 고른다: 지금 프롬프트 세대로 만든 것 중 무작위 → 없으면 옛 세대 중
 * 가장 최근 것 → 없으면 null(실시간 생성). 옛 세대 세트도 쓰는 이유: 프롬프트가 거의 매일
 * 바뀔 수 있는데, 새로 다 만들기까지 며칠 걸리는 동안 실시간 생성(품질이 낮은 모델이 섞임)
 * 으로 돌아가는 것보다 낫다고 봤다. 어느 세대 세트였는지는 피드백에 남아 metrics.mjs가 가른다.
 */
export function pickHintSet(lang: Lang, word: string, currentVersion: string, allowOld = true): HintSet | null {
  const sets = loaded(lang).sets[word] ?? [];
  const current = sets.filter((s) => s.promptVersion === currentVersion);
  if (current.length) return current[Math.floor(Math.random() * current.length)] ?? null;
  if (!allowOld) return null;
  const newest = [...sets].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  return newest ?? null;
}

/** 지금 프롬프트 세대로 만든 세트가 있는 단어들 — 자동플레이가 현재 프롬프트를 평가하려고 쓴다. */
export function wordsWithVersion(lang: Lang, version: string): string[] {
  return Object.entries(loaded(lang).sets)
    .filter(([, sets]) => sets.some((s) => s.promptVersion === version))
    .map(([word]) => word);
}

export function findHintSet(lang: Lang, word: string, id: string): HintSet | null {
  return (loaded(lang).sets[word] ?? []).find((s) => s.id === id) ?? null;
}
