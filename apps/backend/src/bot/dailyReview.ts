/**
 * 오늘의 문제 검토 이슈(2026-09-29, 기획서 v3 §3.6). 오늘의 문제는 모두가 같은 단어를 풀어서,
 * 정답으로 인정할 동의어(words.json의 accept)가 빠져 있으면 억울한 오답이 공유 결과(🟥)를 타고
 * 번진다. 일정이 새로 잡히면(pregenHints.ts) 문제마다 가벼운 모델(flash-lite)에게 동의어 후보를
 * 묻고, 운영자가 확인할 GitHub 이슈(라벨 daily-review)를 연다. 일정이 7일 앞까지 미리 차니
 * 검토할 시간은 있다. 고치는 곳은 scripts/words.json·wordsEn.json의 accept — 런타임이 바로 읽는다.
 *
 * ⚠️ 다른 제시어(또는 그 동의어)와 겹치는 말을 accept에 넣으면 판정이 꼬인다(CLAUDE.md) —
 * 그런 후보는 이슈에 경고를 붙인다. 이슈 본문엔 정답이 적힌다(일정 파일도 공개라 같은 수준).
 */

import { callBot, parseJson, type BotConfig } from './wordGuessBot';
import { allPoolTerms, findWord } from '../routes/wordPool';
import type { DailyPuzzle } from './dailyPuzzle';
import type { Lang } from './hintSets';

export interface ReviewItem {
  lang: Lang;
  date: string;
  number: number;
  puzzle: DailyPuzzle;
  accept: string[];
  /** null이면 후보를 받지 못했다(모델 과부하 등) — 이슈에 "직접 확인"으로 표시. */
  suggestions: { text: string; conflict: boolean }[] | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s.,!?"'·-]/g, '');

const LITE: BotConfig = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: process.env.GEMINI_API_KEY || process.env.SELFIMPROVE_BOT_API_KEY || '',
  // 2026-09-30 3.1-flash-lite(구형) → 3.5: 같은 지시로 5단어 비교 — 후보 품질 비슷, 더 빠름.
  model: process.env.DAILY_REVIEW_MODEL || 'gemini-3.5-flash-lite',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 동의어 후보 — 제미나이 flash-lite(503이면 10초 뒤 한 번 더) → 안 되면 Groq(BOT_*). 둘 다 실패하면
 * null(검토 이슈는 후보 없이도 연다). 2026-09-28 실측: 미국 낮엔 flash-lite도 503이 잦았다.
 */
export async function suggestSynonyms(word: string, category: string, lang: Lang): Promise<string[] | null> {
  const system =
    lang === 'en'
      ? `You help judge answers in a word-guessing game. List up to 5 other expressions that should also count as a correct guess for the target word: true synonyms, other common names, abbreviations, alternative spellings. Do NOT include broader or narrower terms, or merely related words. Output JSON only: {"synonyms":["..."]}`
      : `낱말 맞히기 게임의 정답 판정을 돕는다. 제시어를 맞힌 것으로 인정해야 할 다른 표현을 최대 5개 적어라 — 같은 대상을 가리키는 동의어, 흔히 쓰는 다른 이름·줄임말·외래어 표기. 더 넓거나 좁은 말(상위어·하위어)이나 관련만 있는 말은 넣지 마라. JSON만 출력한다: {"synonyms":["..."]}`;
  const user = lang === 'en' ? `Target word: ${word} (category: ${category})` : `제시어: ${word} (주제: ${category})`;
  const parse = (raw: string): string[] | null => {
    const out = parseJson<{ synonyms?: unknown }>(raw, {});
    return Array.isArray(out.synonyms) ? out.synonyms.map((s) => String(s).trim()).filter((s) => s && s.length <= 30) : null;
  };
  const attempts: (BotConfig | undefined)[] = [...(LITE.apiKey ? [LITE, LITE] : []), ...(process.env.BOT_API_KEY ? [undefined] : [])];
  for (const [i, bot] of attempts.entries()) {
    try {
      const got = parse(await callBot(system, user, bot, { failFast: true, timeoutMs: 20_000 }));
      if (got) return got;
    } catch {
      if (i === 0) await sleep(10_000);
    }
  }
  return null;
}

/** 후보에서 이미 인정되는 말을 빼고, 다른 제시어와 겹치는 것엔 conflict 표시. */
export function classifySuggestions(word: string, accept: string[], suggestions: string[], poolTerms: string[]): { text: string; conflict: boolean }[] {
  const own = new Set([word, ...accept].map(norm));
  const others = new Set(poolTerms.map(norm).filter((t) => !own.has(t)));
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const n = norm(s);
      if (!n || own.has(n) || seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .map((text) => ({ text, conflict: others.has(norm(text)) }));
}

export async function buildReviewItems(added: { lang: Lang; date: string; number: number; puzzle: DailyPuzzle }[]): Promise<ReviewItem[]> {
  const poolTerms = allPoolTerms();
  const items: ReviewItem[] = [];
  for (const a of added) {
    const accept = findWord(a.lang, a.puzzle.word)?.accept ?? [];
    const raw = await suggestSynonyms(a.puzzle.word, a.puzzle.category, a.lang);
    items.push({ ...a, accept, suggestions: raw ? classifySuggestions(a.puzzle.word, accept, raw, poolTerms) : null });
  }
  return items;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/@/g, '@\u200b');

export function reviewTitle(items: ReviewItem[]): string {
  const dates = items.map((i) => i.date).sort();
  return `[오늘의 문제 검토] ${dates[0]}${dates.length > 1 ? ` ~ ${dates.at(-1)}` : ''} (${items.length}문제)`;
}

export function reviewBody(items: ReviewItem[]): string {
  const rows = items.map((i) => {
    const sug = !i.suggestions
      ? '(제안 실패 — 직접 확인)'
      : i.suggestions.length
      ? i.suggestions.map((s) => (s.conflict ? `~~${cell(s.text)}~~ ⚠️다른 제시어` : cell(s.text))).join(' · ')
      : '-';
    return `| ${i.date} | ${i.lang === 'en' ? 'EN ' : ''}#${i.number} | **${cell(i.puzzle.word)}** | ${cell(i.puzzle.category)} | ${i.accept.length ? i.accept.map(cell).join(' · ') : '(없음)'} | ${sug} |`;
  });
  const details = items.map(
    (i) =>
      `<details><summary>${i.date} ${cell(i.puzzle.word)} — 묘사 보기</summary>\n\n` +
      `1라운드: ${i.puzzle.round1.map(cell).join(' / ')}\n\n2라운드: ${i.puzzle.round2.map(cell).join(' / ')}\n\n` +
      (i.puzzle.banned?.length ? `AI가 피한 특징: ${i.puzzle.banned.map(cell).join(' · ')}\n\n` : '') +
      `</details>`,
  );
  return [
    '오늘의 문제 일정에 새로 올라간 문제입니다. **정답으로 인정할 말이 빠지지 않았는지** 확인해 주세요 — 모두가 같은 문제를 풀어서 억울한 오답은 공유 결과를 타고 번집니다.',
    '',
    '- 추가할 말이 있으면 `scripts/words.json`(영어는 `wordsEn.json`)에서 그 단어의 `accept`에 넣으면 됩니다(배포되면 바로 적용).',
    '- ⚠️ 표시(취소선)는 **다른 제시어와 겹치는 말**이라 넣으면 안 됩니다 — 판정이 꼬입니다.',
    '- 묘사가 이상하면 `scripts/daily/{ko,en}.json`에서 그 날짜 항목을 지우세요. 다음 생성 실행 때 다른 문제로 다시 채워집니다(이미 지난 날짜는 제외).',
    '- ⚠️ 아래에 정답이 적혀 있습니다.',
    '',
    '| 날짜 | 번호 | 제시어 | 카테고리 | 지금 인정되는 말 | AI 제안 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    ...details,
    '',
    ...items.map((i) => `- [ ] ${i.date} ${cell(i.puzzle.word)} 확인`),
    '',
    '— `apps/backend/src/bot/dailyReview.ts`(pregen-hints.yml)',
  ].join('\n');
}

/** 검토 이슈를 연다. 토큰이 없으면(로컬 실행) 본문을 로그로만 남긴다. */
export async function openReviewIssue(items: ReviewItem[]): Promise<void> {
  if (!items.length) return;
  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const title = reviewTitle(items);
  const body = reviewBody(items);
  if (!token || !repo) {
    console.log(`[daily-review] (토큰 없음 — 이슈 대신 로그)\n${title}\n${body}`);
    return;
  }
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(`${apiBase}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ title, body, labels: ['daily-review'] }),
  });
  if (!res.ok) console.error(`[daily-review] 이슈 생성 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  else console.log(`[daily-review] 검토 이슈 #${((await res.json()) as { number: number }).number}`);
}
