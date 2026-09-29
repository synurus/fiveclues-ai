/**
 * 묘사 세트 사전 생성기(2026-09-28) — bot/hintSets.ts 참고.
 * .github/workflows/pregen-hints.yml이 하루 3번 돌리고 결과(scripts/hintsets/*.json)를 커밋한다.
 *
 *   npm run pregen -w backend               한 번 실행(이번 실행 최대 PREGEN_RUN_CALLS회 호출)
 *   PREGEN_DRY=1 npm run pregen -w backend  호출 없이 다음에 만들 묶음만 보여 준다
 *
 * ── 예산 ──
 * gemini-3.8-flash 무료 한도는 하루 20회(RPD)·분당 5회(RPM)이고, 하루는 태평양 시간(PT)
 * 자정에 바뀐다. 같은 모델을 자가개선 분석(propose.mjs, 하루 1회 + 503 재시도)도 쓰므로
 * 사전 생성은 PT 하루 최대 PREGEN_DAILY_CALLS(기본 16)회 — 4회를 남긴다. 호출 횟수는
 * scripts/hintsets/usage.json에 PT 날짜별로 적어 커밋한다(예약 실행이 몇 시간씩 밀리거나
 * 겹쳐도 하루 합이 넘지 않게). 실패한 시도(503 등)도 한도에 잡힐 수 있어 1회로 센다.
 * 하루 한도 429가 오면 그날 몫을 다 쓴 것으로 적는다.
 *
 * ── 대체 모델(2026-09-29) ──
 * 3.8-flash가 과부하(503이 이어짐)이거나 그날 몫을 다 썼으면, 그 실행의 나머지는 대체 모델
 * (PREGEN_FALLBACK_MODEL, 기본 gemini-3.1-flash-lite — 실시간 출제의 주력이라 품질이 검증됐고
 * 하루 500회라 넉넉하다)로 만든다. 3.8-flash가 이틀 연속(미국 아침·밤 모두) 몇 분씩 503만 내서
 * 세트가 하나도 안 생겼기 때문. 대체 모델 예산은 따로 센다(PT 하루 PREGEN_FALLBACK_DAILY_CALLS
 * 기본 48회, 한 실행 PREGEN_FALLBACK_RUN_CALLS 기본 16회 — 나머지 한도는 실시간 출제 몫).
 * 세트엔 실제로 만든 모델 이름이 남는다(성적표·피드백에서 갈린다).
 *
 * ── 한 번에 여러 단어 ──
 * 호출 한 번에 같은 카테고리 단어 PREGEN_BATCH(기본 8)개를 묶는다 — 출제 프롬프트가
 * 카테고리를 넣어 만들어지므로 같은 카테고리끼리면 그대로 쓸 수 있다. 1라운드 1회 + 2라운드
 * 1회 = 묶음당 2회. 하루 16회면 약 64단어.
 *
 * ── 무엇부터 ──
 * 세트가 없는 단어 → 지금 프롬프트 세대 세트가 없는 단어 → 세트가 MAX_SETS_PER_WORD개
 * 미만인 단어 → (다 찼으면) 가장 오래된 세트 교체. 같은 단계면 한국어 먼저.
 *
 * ── 검증 ──
 * 묘사가 5개 미만·너무 김·제시어(또는 같은 묶음의 다른 제시어)가 들어감·2라운드가 1라운드와
 * 같은 문장이면 그 단어는 버리고 다음 실행에 다시 만든다.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callBot, parseJson, leaksWord, LlmError, type BotConfig } from './wordGuessBot';
import { hintSystem as hintSystemKo } from './hintPrompt';
import { hintSystem as hintSystemEn } from './hintPromptEn';
import { PROMPT_VERSION } from './promptVersion';
import { HINT_COUNT, cleanBanned } from './hintSource';
import { hintSetsDir, hintSetsPath, readHintSetFile, type HintSet, type HintSetFile, type Lang } from './hintSets';
import type { WordEntry } from '../routes/wordPool';
import { addDays, dailyNumber, readDailyFile, scheduleDaily, utcToday, writeDailyFile, type DailyPuzzle } from './dailyPuzzle';
import { buildReviewItems, openReviewIssue } from './dailyReview';

const API_KEY = process.env.GEMINI_API_KEY || process.env.SELFIMPROVE_BOT_API_KEY || '';
const BATCH = Number(process.env.PREGEN_BATCH || 8);
export const MAX_SETS_PER_WORD = 2;
const MAX_HINT_LEN = 60; // 프롬프트는 30자 이내(영어는 8단어)를 요구 — 넉넉히 두고 이상치만 거른다
const MIN_CALL_GAP_MS = 13_000; // RPM 5
const DRY = process.env.PREGEN_DRY === '1';

const gemini = (model: string): BotConfig => ({
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: API_KEY,
  model,
  maxTokens: 24_000, // 8단어 × (금지어·필러·묘사) + 모델의 생각 토큰
});

interface Provider {
  bot: BotConfig;
  dailyCap: number; // PT 하루
  runCap: number; // 한 실행
  usageKey: 'calls' | 'fallbackCalls';
}

const PRIMARY: Provider = {
  bot: gemini(process.env.PREGEN_MODEL || 'gemini-3.8-flash'),
  dailyCap: Number(process.env.PREGEN_DAILY_CALLS || 16),
  runCap: Number(process.env.PREGEN_RUN_CALLS || 8),
  usageKey: 'calls',
};
const FALLBACK: Provider = {
  bot: gemini(process.env.PREGEN_FALLBACK_MODEL || 'gemini-3.1-flash-lite'),
  dailyCap: Number(process.env.PREGEN_FALLBACK_DAILY_CALLS || 48),
  runCap: Number(process.env.PREGEN_FALLBACK_RUN_CALLS || 16),
  usageKey: 'fallbackCalls',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 사용량(PT 하루) ────────────────────────────────────────────────────

interface Usage {
  date: string; // PT 기준 YYYY-MM-DD
  calls: number; // 주 모델(3.8-flash)
  fallbackCalls: number; // 대체 모델
}
const usagePath = (): string => path.join(hintSetsDir(), 'usage.json');

export function ptDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

function readUsage(): Usage {
  const today = ptDate();
  try {
    const u = JSON.parse(fs.readFileSync(usagePath(), 'utf8')) as Partial<Usage>;
    return u.date === today
      ? { date: today, calls: u.calls ?? 0, fallbackCalls: u.fallbackCalls ?? 0 }
      : { date: today, calls: 0, fallbackCalls: 0 };
  } catch {
    return { date: today, calls: 0, fallbackCalls: 0 };
  }
}

function writeUsage(u: Usage): void {
  fs.mkdirSync(hintSetsDir(), { recursive: true });
  fs.writeFileSync(usagePath(), JSON.stringify(u, null, 2) + '\n');
}

// ── 무엇을 만들지 ──────────────────────────────────────────────────────

interface Need {
  lang: Lang;
  word: string;
  category: string;
  tier: number; // 낮을수록 먼저
  oldest: string; // 같은 단계 안에서 오래된 것부터
}

export function planNeeds(pools: Record<Lang, WordEntry[]>, files: Record<Lang, HintSetFile>, versions: Record<Lang, string>): Need[] {
  const needs: Need[] = [];
  for (const lang of ['ko', 'en'] as const) {
    for (const { word, category } of pools[lang]) {
      const sets = files[lang].sets[word] ?? [];
      const current = sets.filter((s) => s.promptVersion === versions[lang]);
      const oldest = sets.map((s) => s.generatedAt).sort()[0] ?? '';
      const tier = sets.length === 0 ? 0 : current.length === 0 ? 1 : current.length < MAX_SETS_PER_WORD ? 2 : 3;
      needs.push({ lang, word, category, tier, oldest });
    }
  }
  // 단계 → 언어(한국어 먼저) → 오래된 순
  return needs.sort((a, b) => a.tier - b.tier || (a.lang === b.lang ? 0 : a.lang === 'ko' ? -1 : 1) || a.oldest.localeCompare(b.oldest));
}

/** 맨 앞 단어의 언어·카테고리로 같은 단계의 단어를 최대 size개 묶는다. */
export function nextBatch(needs: Need[], size: number): Need[] {
  const head = needs[0];
  if (!head) return [];
  return needs.filter((n) => n.lang === head.lang && n.category === head.category && n.tier === head.tier).slice(0, size);
}

// ── 검증 ──────────────────────────────────────────────────────────────

/** 모델이 낸 한 단어의 묘사 목록을 검사해 HINT_COUNT개를 돌려준다. 못 쓰면 null. */
export function validateRound(raw: unknown, word: string, others: string[], previous: string[] = []): string[] | null {
  if (!Array.isArray(raw)) return null;
  const texts = raw
    .map((h) => String((h as { text?: unknown })?.text ?? h ?? '').trim())
    .filter((t) => t.length > 0 && t.length <= MAX_HINT_LEN)
    .filter((t) => !leaksWord(t, word) && !others.some((o) => o !== word && leaksWord(t, o)))
    .filter((t) => !previous.includes(t));
  return texts.length >= HINT_COUNT ? texts.slice(0, HINT_COUNT) : null;
}

// ── 프롬프트(여러 단어 묶음) ───────────────────────────────────────────

export const system = (lang: Lang, round: 1 | 2, category: string): string =>
  (lang === 'en' ? hintSystemEn : hintSystemKo)(round, category, HINT_COUNT);

export function batchUser(lang: Lang, round: 1 | 2, category: string, words: string[], round1?: Record<string, string[]>): string {
  if (lang === 'en') {
    const head =
      round === 1
        ? `There are ${words.length} target words, all in the category "${category}": ${words.join(', ')}\n\n`
        : `There are ${words.length} target words in the category "${category}". The player missed each in round 1 ` +
          `(their guess is unknown — don't aim at any particular wrong answer, just narrow the range). ` +
          `Round-1 clues for each (don't repeat these):\n\n` +
          words.map((w) => `[${w}]\n${(round1?.[w] ?? []).map((t) => `- ${t}`).join('\n')}`).join('\n\n') +
          '\n\n';
    return (
      head +
      `For each word, follow the steps above separately and write ${HINT_COUNT} ${round === 2 ? 'round 2 ' : ''}clues. ` +
      `Keep the words independent — never let one word's clues hint at another word in this list.\n` +
      `Instead of the single-object format above, output ONE JSON object that wraps every word's result:\n` +
      `{"sets":[{"word":"target word","banned":[...],"avoidFillers":[...],"hints":[{"text":"clue","angle":"what it's about"}]}]}`
    );
  }
  const head =
    round === 1
      ? `제시어 ${words.length}개 — 주제는 모두 "${category}"다: ${words.join(', ')}\n\n`
      : `제시어 ${words.length}개 — 주제 "${category}". 플레이어가 각 제시어를 1라운드에서 못 맞혔다(무엇을 ` +
        `추측했는지는 모른다 — 특정 오답을 겨냥하지 말고 범위만 좁혀라). 제시어별 1라운드 묘사(겹치지 말 것):\n\n` +
        words.map((w) => `[${w}]\n${(round1?.[w] ?? []).map((t) => `- ${t}`).join('\n')}`).join('\n\n') +
        '\n\n';
  return (
    head +
    `제시어마다 위 [작업 순서]를 따로 수행해 ${round === 2 ? '2라운드 ' : ''}묘사 ${HINT_COUNT}개씩 만든다. ` +
    `제시어끼리 섞이지 않게 — 한 제시어의 묘사가 목록의 다른 제시어를 떠올리게 하면 안 된다.\n` +
    `출력은 위의 한 제시어 형식 대신, 제시어별 결과를 묶은 JSON 하나로 한다:\n` +
    `{"sets":[{"word":"제시어","banned":["결정적 특징"],"avoidFillers":["뻔한 곁다리 표현"],"hints":[{"text":"묘사","angle":"무엇에 대해"}]}]}`
  );
}

// ── 실행 ──────────────────────────────────────────────────────────────

class BudgetExhausted extends Error {}

// 503(과부하, "high demand")도 **하루 한도에 잡는다**(2026-09-29). 처음엔 처리 전 거절이라
// 예산에서 도로 뺐는데, 3.8-flash가 몇 분씩 503만 내는 동안 재시도를 이어 가다 성공 0회로 하루
// 한도(429)에 닿았다 — 503 시도가 구글 쪽 RPD에 잡힌 것으로 보인다(같은 날 자동플레이 추측도
// 3.8-flash를 쓰고 있어서 완전히 확정은 아님). 그래서 503은 한 실행에 MAX_503_RETRIES번만
// 기다려 보고, 그래도 과부하면 주 모델은 대체 모델로 넘어가고(아래 switchToFallback), 대체 모델까지
// 과부하면 이번 실행을 접는다 — 하루 3번 실행이 각자 다시 시도한다.
// 2026-09-28 실측: 미국 아침(KST 23시 전후)엔 3.8-flash가 요청 즉시 503을 냈다 — 그래서
// 워크플로를 미국 밤(PT 자정 직후 = KST 16~22시)에 돌린다(2026-09-29 KST 14시에도 503이었다).
const MAX_503_RETRIES = 2;
const BACKOFF_MS = [60_000, 120_000];

class ModelBusy extends Error {}

interface Run {
  current: Provider;
  used: Map<Provider, number>;
  retries503: number;
}

const runUsed = (run: Run, p: Provider): number => run.used.get(p) ?? 0;
const hasBudget = (usage: Usage, run: Run, p: Provider, need = 1): boolean =>
  usage[p.usageKey] + need <= p.dailyCap && runUsed(run, p) + need <= p.runCap;

/** 이번 실행이 쓸 수 있는 모델로 need회 더 부를 수 있는지(묶음 하나 = 2회). */
function canAfford(usage: Usage, run: Run, need: number): boolean {
  return hasBudget(usage, run, run.current, need) || (run.current === PRIMARY && hasBudget(usage, run, FALLBACK, need));
}

function switchToFallback(run: Run, why: string): void {
  console.log(`[pregen] ${PRIMARY.bot.model} ${why} — 이번 실행 나머지는 대체 모델 ${FALLBACK.bot.model}로`);
  run.current = FALLBACK;
  run.retries503 = 0;
}

let lastCallAt = 0;
/** 한 번 부르고 { raw, model }. 주 모델이 안 되면 대체 모델로 넘어간다. */
async function budgetedCall(usage: Usage, run: Run, sys: string, user: string): Promise<{ raw: string; model: string }> {
  for (let attempt = 0; ; attempt++) {
    const p = run.current;
    if (!hasBudget(usage, run, p)) {
      if (p === PRIMARY && hasBudget(usage, run, FALLBACK)) {
        switchToFallback(run, '예산 소진');
        attempt = -1;
        continue;
      }
      throw new BudgetExhausted('예산 소진');
    }
    const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    usage[p.usageKey] += 1;
    run.used.set(p, runUsed(run, p) + 1);
    writeUsage(usage);
    lastCallAt = Date.now();
    try {
      return { raw: await callBot(sys, user, p.bot, { failFast: true, timeoutMs: 240_000 }), model: p.bot.model };
    } catch (e) {
      if (e instanceof LlmError && e.status === 429 && e.dailyQuota) {
        usage[p.usageKey] = p.dailyCap; // 그 모델의 그날 몫은 끝 — 다음 실행도 PT 날짜가 바뀔 때까지 쉰다
        writeUsage(usage);
        if (p === PRIMARY) {
          switchToFallback(run, '하루 한도(429)');
          attempt = -1;
          continue;
        }
        throw new BudgetExhausted(`${p.bot.model} 하루 한도(429)`);
      }
      if (!(e instanceof LlmError && e.status === 503)) throw e;
      if (run.retries503 >= MAX_503_RETRIES || attempt >= BACKOFF_MS.length) {
        if (p === PRIMARY) {
          switchToFallback(run, '과부하(503)');
          attempt = -1;
          continue;
        }
        throw new ModelBusy(`${p.bot.model} 과부하(503)`);
      }
      run.retries503 += 1;
      const ms = BACKOFF_MS[attempt]!;
      console.log(`[pregen] ${p.bot.model} 503(과부하) — ${ms / 1000}초 뒤 재시도 (${run.retries503}/${MAX_503_RETRIES})`);
      await sleep(ms);
    }
  }
}

// 모델이 단어를 대소문자·띄어쓰기만 바꿔 돌려주는 경우가 있어 정규화해서 찾는다.
const key = (w: string): string => w.toLowerCase().replace(/\s+/g, '');

/** 모델 응답 → 정규화한 제시어 → 그 제시어의 hints·banned(검증 전). */
export function parseSets(raw: string): Map<string, { hints: unknown; banned: unknown }> {
  const out = parseJson<{ sets?: unknown }>(raw, {});
  const map = new Map<string, { hints: unknown; banned: unknown }>();
  if (Array.isArray(out.sets)) {
    for (const s of out.sets as { word?: unknown; hints?: unknown; banned?: unknown }[]) {
      if (typeof s?.word === 'string') map.set(key(s.word), { hints: s.hints, banned: s.banned });
    }
  }
  return map;
}

/**
 * 한 라운드를 부르고 검증한다. 통과한 단어가 하나도 없으면 한 번만 다시 부른다 — 2026-09-29 첫 실행에서
 * 4묶음 중 3묶음이 "전부 불합격"이었는데, 같은 묶음을 다시 부르면 8/8 통과해서 가끔 응답이 비거나 깨져
 * 오는 것으로 보인다. 원인을 확인할 수 있게 그때의 응답 앞부분을 로그에 남긴다.
 * others: 제시어 노출 검사에 쓸 묶음 전체 단어(다른 제시어가 묘사에 섞이면 버린다).
 */
async function callRound(
  usage: Usage,
  run: Run,
  lang: Lang,
  round: 1 | 2,
  category: string,
  words: string[],
  others: string[],
  round1?: Record<string, string[]>,
): Promise<{ model: string; parsed: Map<string, { hints: unknown; banned: unknown }>; ok: Record<string, string[]> }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await budgetedCall(usage, run, system(lang, round, category), batchUser(lang, round, category, words, round1));
    const parsed = parseSets(r.raw);
    const ok: Record<string, string[]> = {};
    for (const w of words) {
      const v = validateRound(parsed.get(key(w))?.hints, w, others, round1?.[w]);
      if (v) ok[w] = v;
    }
    if (Object.keys(ok).length) return { model: r.model, parsed, ok };
    console.log(
      `[pregen] ${round}라운드 전부 불합격(${attempt}번째) — 응답 ${r.raw.length}자, 파싱 ${parsed.size}단어: ` +
        r.raw.slice(0, 200).replace(/\s+/g, ' '),
    );
  }
  throw new Error(`${round}라운드 결과를 하나도 못 썼다`);
}

function addSet(file: HintSetFile, word: string, set: HintSet): void {
  const sets = [...(file.sets[word] ?? []), set];
  // 넘치면 옛 세대 → 오래된 순으로 뺀다
  while (sets.length > MAX_SETS_PER_WORD) {
    const victim =
      sets.filter((s) => s.promptVersion !== set.promptVersion).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))[0] ??
      [...sets].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))[0]!;
    sets.splice(sets.indexOf(victim), 1);
  }
  file.sets[word] = sets;
}

function writeFile(lang: Lang, file: HintSetFile): void {
  fs.mkdirSync(hintSetsDir(), { recursive: true });
  const sorted: HintSetFile = { sets: Object.fromEntries(Object.entries(file.sets).sort(([a], [b]) => a.localeCompare(b))) };
  fs.writeFileSync(hintSetsPath(lang), JSON.stringify(sorted, null, 1) + '\n');
}

function loadPool(lang: Lang): WordEntry[] {
  const f = lang === 'en' ? 'wordsEn.json' : 'words.json';
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../scripts', f), 'utf8')) as WordEntry[];
}

async function main(): Promise<void> {
  if (!API_KEY && !DRY) {
    console.error('제미나이 키(GEMINI_API_KEY 또는 SELFIMPROVE_BOT_API_KEY)가 없다 — 종료.');
    process.exitCode = 1;
    return;
  }
  const pools = { ko: loadPool('ko'), en: loadPool('en') };
  const files = { ko: readHintSetFile('ko'), en: readHintSetFile('en') };
  const usage = readUsage();
  const run: Run = { current: PRIMARY, used: new Map(), retries503: 0 };
  console.log(
    `[pregen] PT ${usage.date} · ${PRIMARY.bot.model} ${usage.calls}/${PRIMARY.dailyCap}(실행당 ${PRIMARY.runCap}) · ` +
      `대체 ${FALLBACK.bot.model} ${usage.fallbackCalls}/${FALLBACK.dailyCap}(실행당 ${FALLBACK.runCap}) · 묶음 ${BATCH}단어`,
  );

  let failures = 0;
  const done = new Set<string>(); // 이번 실행에서 이미 시도한 단어(실패 포함) — 같은 단어만 반복하지 않게
  for (;;) {
    const needs = planNeeds(pools, files, PROMPT_VERSION).filter((n) => !done.has(`${n.lang}:${n.word}`));
    const batch = nextBatch(needs, BATCH);
    if (!batch.length) {
      console.log('[pregen] 만들 것이 없다.');
      break;
    }
    const { lang, category, tier } = batch[0]!;
    const words = batch.map((b) => b.word);
    if (DRY) {
      console.log(`[pregen] (DRY) 다음 묶음: ${lang} "${category}" 단계${tier} — ${words.join(', ')}`);
      break;
    }
    if (!canAfford(usage, run, 2)) {
      console.log('[pregen] 예산이 묶음 하나(2회)에 모자란다 — 멈춤');
      break;
    }
    words.forEach((w) => done.add(`${lang}:${w}`));
    try {
      const r1 = await callRound(usage, run, lang, 1, category, words, words);
      const round1 = r1.ok;
      const ok1 = Object.keys(round1);
      const r2 = await callRound(usage, run, lang, 2, category, ok1, words, round1);
      // 라운드 사이에 대체 모델로 넘어갔으면 둘 다 남긴다.
      const model = r1.model === r2.model ? r1.model : `${r1.model}/${r2.model}`;
      const now = new Date().toISOString();
      const saved: string[] = [];
      for (const w of ok1) {
        const round2 = r2.ok[w];
        if (!round2) continue;
        addSet(files[lang], w, {
          id: crypto.randomBytes(4).toString('hex'),
          promptVersion: PROMPT_VERSION[lang],
          model,
          generatedAt: now,
          round1: round1[w]!,
          round2,
          banned: cleanBanned(r1.parsed.get(key(w))?.banned, w), // 결과 화면 "AI가 말하지 않은 것"
        });
        saved.push(w);
      }
      writeFile(lang, files[lang]);
      const dropped = words.filter((w) => !saved.includes(w));
      console.log(`[pregen] ${lang} "${category}" 저장 ${saved.length}/${words.length}${dropped.length ? ` (버림: ${dropped.join(', ')})` : ''}`);
      failures = 0;
    } catch (e) {
      if (e instanceof BudgetExhausted || e instanceof ModelBusy) {
        console.log(`[pregen] ${e.message} — 멈춤`);
        break;
      }
      failures += 1;
      console.error(`[pregen] 묶음 실패(${lang} "${category}"): ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      if (failures >= 2) break; // 연속 실패면 모델 쪽 문제 — 예산을 더 태우지 않는다
    }
  }
  // 오늘의 문제 일정(bot/dailyPuzzle.ts) — 세트가 생긴 단어로 어제~7일 뒤까지 빈 날짜를 채운다
  // (어제부터인 건 UTC보다 늦은 시간대에선 아직 "어제"가 오늘이라서). 이미 정한 날짜는 안 바꾼다.
  const toReview: { lang: Lang; date: string; number: number; puzzle: DailyPuzzle }[] = [];
  for (const lang of DRY ? [] : (['ko', 'en'] as const)) {
    const daily = readDailyFile(lang);
    const categoryOf = (word: string): string | undefined => pools[lang].find((w) => w.word === word)?.category;
    const added = scheduleDaily(daily, files[lang], categoryOf, PROMPT_VERSION[lang], addDays(utcToday(), -1), 9);
    if (added.length) {
      writeDailyFile(lang, daily);
      console.log(`[pregen] 오늘의 문제(${lang}) 일정 추가: ${added.join(', ')}`);
      toReview.push(...added.map((date) => ({ lang, date, number: dailyNumber(date), puzzle: daily[date]! })));
    }
  }
  // 새로 잡힌 문제는 동의어 검토 이슈로(bot/dailyReview.ts) — 실패해도 생성 결과엔 영향 없다.
  if (toReview.length) {
    try {
      await openReviewIssue(await buildReviewItems(toReview));
    } catch (e) {
      console.error('[daily-review] 실패:', e instanceof Error ? e.message : e);
    }
  }

  const covered = (lang: Lang): number => pools[lang].filter((w) => files[lang].sets[w.word]?.length).length;
  console.log(
    `[pregen] 끝 — PT 하루 사용 주 ${usage.calls}/${PRIMARY.dailyCap}·대체 ${usage.fallbackCalls}/${FALLBACK.dailyCap}, ` +
      `이번 실행 주 ${runUsed(run, PRIMARY)}회·대체 ${runUsed(run, FALLBACK)}회. ` +
      `세트 있는 단어: 한국어 ${covered('ko')}/${pools.ko.length}, 영어 ${covered('en')}/${pools.en.length}`,
  );
}

if (require.main === module) void main();
