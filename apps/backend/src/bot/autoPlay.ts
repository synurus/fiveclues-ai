/**
 * 자가개선 루프 0단계 — AI가 직접 게임을 플레이해서 피드백을 만들어낸다.
 * (.github/workflows/self-improve-autoplay.yml 이 01~07시 KST 매시 이 스크립트를 돌리고,
 *  08시엔 self-improve.yml의 propose.mjs가 그 피드백들을 모아 PR을 낸다 — 2026-09-16 결정)
 *
 * 서버가 아직 어디에도 배포돼 있지 않아서(로컬 npm run dev 뿐) HTTP로 게임을 호출할
 * 수가 없다 — 그래서 scripts/spectate.mjs 가 그랬던 것처럼 프로덕션 힌트 생성
 * 로직(generateHints/judgeGuess/pickWord)을 직접 import해서 서버 없이 한 판을
 * 통째로 흉내 낸다.
 *
 * 흐름: 단어 뽑기 → 1라운드 힌트 생성(프로덕션 코드) → 추측자 LLM이 카테고리 없이
 * 힌트만 보고 추측(사람 플레이어와 동일 조건) → 틀리면 2라운드도 같은 방식 → 게임이
 * 끝나면 그 추측자에게 "방금 뭘 플레이했다" 소감을 물어서 결정적/무쓸모 힌트(들)와
 * 코멘트를 뽑아냄(사람이 결과 화면에서 말풍선을 클릭해 태그하는 걸 대신) →
 * createFeedbackIssue()를 HTTP 없이 직접 호출.
 *
 * 닉네임은 항상 "AI자동플레이"로 고정 — Issues 목록·PR 본문에서 실제 플레이어
 * 피드백과 한눈에 구분되게 하려는 것.
 *
 * 여러 판을 동시에(Promise.all) 돌리지 않고 순서대로 돈다 — Groq 무료 티어 TPM
 * 한도가 게임 본체 트래픽과 공유되므로 굳이 몰아서 부담을 줄 이유가 없다.
 *
 * 환경변수: BOT_BASE_URL/BOT_API_KEY/BOT_MODEL(힌트 생성 — 추측·소감도 기본은 이걸 쓴다),
 *   GITHUB_FEEDBACK_TOKEN/GITHUB_REPO(createFeedbackIssue 용 — Actions에서는 보통
 *   secrets.GITHUB_TOKEN 과 github.repository 를 그대로 이 이름으로 넘긴다),
 *   AUTO_PLAY_GAMES(1회 실행에 플레이할 판 수, 기본 2),
 *   AUTOPLAY_GUESSER_BOT_BASE_URL/API_KEY/MODEL·AUTOPLAY_GUESSER_HOURS(2026-09-17
 *   추가 — 제미나이 추측자 비교 실험. 전용 키가 없으면 SELFIMPROVE_BOT_*(propose.mjs
 *   용)를 재사용한다. 아래 GUESSER_HOURS/GUESSER_OVERRIDE 참고)
 *
 *   로컬 테스트: npm run autoplay -w backend
 */

import 'dotenv/config';
import { generateHints, judgeGuess, callBot, parseJson, type Hint, type BotConfig } from './wordGuessBot';
import { pickWord } from '../routes/wordPool';
import { createFeedbackIssue, type FeedbackPayload } from '../github/feedbackIssue';

const HINT_COUNT = 5; // routes/game.ts의 HINT_COUNT와 같은 값이어야 실제 게임과 동일 조건이 된다.
const GAMES = Math.max(1, Number(process.env.AUTO_PLAY_GAMES ?? '2') || 2);
const NICKNAME = 'AI자동플레이';

// ── 제미나이 추측자 비교(2026-09-17) ──────────────────────────────────────
// hintPrompt.ts 자체가 안 좋은 건지, 추측하는 모델(Groq gpt-oss-120b)이 유독
// 못 맞히는 건지 구분해보려는 실험. 힌트 생성은 항상 BOT_*(Groq) 그대로 두고,
// GUESSER_HOURS에 든 KST 시각의 "그 실행의 첫 판"만 추측+소감을 이 엔드포인트가
// 대신 맡는다. 기본 01~04시·판당 1개 = 하루 4판(판당 콜 2~3개, 8~12콜) — 제미나이
// 무료 티어 하루 20건(RPD, 2026-09-17 확인) 안에서 자가개선 분석(SELFIMPROVE_BOT_*,
// 제미나이면 하루 1콜)까지 합쳐도 여유 있게 두려는 계산이다. 시간·판수를 늘리려면
// 그 합이 20을 넘지 않는지 다시 계산해볼 것.
const GUESSER_HOURS = new Set(
  (process.env.AUTOPLAY_GUESSER_HOURS || '1,2,3,4')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n)),
);

// 전용 시크릿(AUTOPLAY_GUESSER_BOT_*)이 없으면 propose.mjs가 이미 쓰고 있는
// SELFIMPROVE_BOT_*(제미나이)를 그대로 재사용한다(2026-09-17, 스카이 선택 — 새
// 키를 따로 안 만들어도 됨). 어느 것도 없으면 실험이 꺼지고 늘 하던 대로 Groq만
// 추측한다. 같은 키를 나눠 쓰는 거라 propose.mjs의 하루 1콜 + 여기 8~12콜을
// 합쳐서 제미나이 무료 티어 하루 20건(RPD) 안에 들어오는지가 기준이다.
const GUESSER_BASE_URL = process.env.AUTOPLAY_GUESSER_BOT_BASE_URL || process.env.SELFIMPROVE_BOT_BASE_URL || '';
const GUESSER_API_KEY = process.env.AUTOPLAY_GUESSER_BOT_API_KEY || process.env.SELFIMPROVE_BOT_API_KEY || '';
const GUESSER_MODEL = process.env.AUTOPLAY_GUESSER_BOT_MODEL || process.env.SELFIMPROVE_BOT_MODEL || 'gemini-3.8-flash';

const GUESSER_OVERRIDE: BotConfig | undefined = GUESSER_API_KEY
  ? { baseUrl: GUESSER_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GUESSER_API_KEY, model: GUESSER_MODEL }
  : undefined;

const currentKstHour = (): number => (new Date().getUTCHours() + 9) % 24;

// index===1(이 실행의 첫 판)이고 지금이 GUESSER_HOURS에 든 시각일 때만 override를 준다.
function guesserOverrideFor(index: number): BotConfig | undefined {
  if (!GUESSER_OVERRIDE || index !== 1) return undefined;
  return GUESSER_HOURS.has(currentKstHour()) ? GUESSER_OVERRIDE : undefined;
}

type Outcome = 'round1' | 'round2' | 'failed';

// ── 추측자 — 사람 플레이어 대역. 카테고리를 안 준다(프로덕션에서 사람이 안 보는 것과 동일). ──
async function guessWord(hints: Hint[], guesser?: BotConfig): Promise<string> {
  const system =
    `너는 한국어 낱말 맞히기 게임의 참가자다. 아래 묘사만 보고 제시어를 하나 맞혀라.\n` +
    `주제는 알려주지 않는다 — 묘사만으로 추론해야 한다. 망설여지면 그래도 가장 그럴듯한 단어 하나를 골라라.\n` +
    `JSON만 출력한다: {"guess":"네 생각에 정답인 단어"}`;
  const user = hints.map((h) => `- ${h.text}`).join('\n');
  const raw = await callBot(system, user, guesser);
  const parsed = parseJson<{ guess?: unknown }>(raw, {});
  return String(parsed.guess ?? '').trim();
}

// ── 소감 — 같은 추측자에게 방금 판을 되돌아보게 한다. 사람이 결과 화면에서 하는 선택을 대신. ──
interface Reflection {
  keyHintIndexes: number[];
  uselessHintIndexes: number[];
  feedbackText: string;
}

async function reflectFeedback(
  word: string,
  category: string,
  hints: Hint[],
  outcome: Outcome,
  guesses: string[],
  guesser?: BotConfig,
): Promise<Reflection> {
  // feedbackText 는 이 게임의 유일한 자유서술 필드라 — propose.mjs 가 이걸 그대로
  // LLM에 보여주고 hintPrompt.ts 를 고치게 시킨다. "재밌었다/아쉬웠다" 같은 감상은
  // 프롬프트를 고치는 데 아무 쓸모가 없어서, 진단(왜 그 단어를 떠올렸는지 · 힌트의
  // 어떤 부분이 오답 쪽으로 끌고 갔는지)을 쓰게 명시적으로 요구한다(2026-09-16,
  // "캥거루"를 "개구리"로 두 번 헛짚었는데 feedbackText가 "아쉬웠다"뿐이라 왜
  // 헷갈렸는지 전혀 안 남았던 사례에서 고침).
  //
  // keyHintIndex/uselessHintIndex는 원래 각각 숫자 하나였는데, 사람 플레이어가
  // 결과 화면 말풍선 여러 개를 동시에 태그할 수 있게 되면서(2026-09-16) 배열로
  // 바뀌었다 — 이 추측자도 같은 스키마로 답해야 gather.mjs/propose.mjs가 사람
  // 피드백과 AI 피드백을 구분 없이 처리할 수 있다.
  const system =
    `너는 방금 아래 낱말 맞히기 게임을 플레이한 참가자다. 게임을 만든 사람에게 실제로 ` +
    `도움이 될 구체적인 피드백을 남긴다.\n` +
    `JSON만 출력한다:\n` +
    `{"keyHintIndexes": [숫자, ...], "uselessHintIndexes": [숫자, ...], "feedbackText": "한국어 피드백 한두 문장"}\n` +
    `- keyHintIndexes: 확신을 갖고 정답을 맞히는 데 실제로 도움이 된 묘사(들)의 인덱스. ` +
    `여러 개가 같이 결정적이었으면 전부 넣어라. 못 맞혔거나 딱히 결정적인 묘사가 없었으면 빈 배열.\n` +
    `- uselessHintIndexes: 전혀 도움이 안 됐던 묘사(들)의 인덱스. 없으면 빈 배열.\n` +
    `- feedbackText: "재밌었다"/"아쉬웠다" 같은 감상은 절대 쓰지 마라. 대신 진단을 써라 — ` +
    `틀렸다면 왜 그 단어를 떠올렸는지, 묘사들의 어떤 공통된 인상이 오답 쪽으로 끌고 갔는지, ` +
    `제시어만의 특징이 안 보여서 다른 단어와 구별이 안 됐는지를 구체적으로. 맞혔다면 무엇이 ` +
    `결정적이었는지를 구체적으로.`;
  const hintList = hints.map((h, i) => `${i}: ${h.text}`).join('\n');
  const outcomeKo = outcome === 'round1' ? '1라운드에 맞힘' : outcome === 'round2' ? '2라운드에 맞힘' : '끝까지 못 맞힘';
  const user =
    `제시어: ${word} (주제: ${category})\n\n묘사 목록:\n${hintList}\n\n` +
    `내가 한 추측: ${guesses.join(' → ')}\n결과: ${outcomeKo}`;
  const raw = await callBot(system, user, guesser);
  const parsed = parseJson<{ keyHintIndexes?: unknown; uselessHintIndexes?: unknown; feedbackText?: unknown }>(raw, {});

  const toIndexArray = (v: unknown): number[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < hints.length))]
      : [];

  return {
    keyHintIndexes: toIndexArray(parsed.keyHintIndexes),
    uselessHintIndexes: toIndexArray(parsed.uselessHintIndexes),
    feedbackText: String(parsed.feedbackText ?? '').slice(0, 200),
  };
}

async function playOne(index: number): Promise<void> {
  const { word, category, accept } = pickWord();
  const hintsSoFar: Hint[] = [];
  const guesses: string[] = [];
  const roundHintCounts: number[] = [];
  const guesser = guesserOverrideFor(index);

  const r1 = await generateHints({ word, category, round: 1, hintCount: HINT_COUNT });
  hintsSoFar.push(...r1.hints);
  roundHintCounts.push(r1.hints.length);
  const guess1 = await guessWord(hintsSoFar, guesser);
  guesses.push(guess1);
  const verdict1 = judgeGuess(word, guess1, accept ?? []);

  let outcome: Outcome;
  if (verdict1 === 'exact' || verdict1 === 'loose') {
    outcome = 'round1';
  } else {
    const r2 = await generateHints({
      word,
      category,
      round: 2,
      hintCount: HINT_COUNT,
      previousHints: r1.hints,
      wrongGuess: guess1,
    });
    hintsSoFar.push(...r2.hints);
    roundHintCounts.push(r2.hints.length);
    const guess2 = await guessWord(hintsSoFar, guesser);
    guesses.push(guess2);
    const verdict2 = judgeGuess(word, guess2, accept ?? []);
    outcome = verdict2 === 'exact' || verdict2 === 'loose' ? 'round2' : 'failed';
  }

  const reflection = await reflectFeedback(word, category, hintsSoFar, outcome, guesses, guesser);

  const payload: FeedbackPayload = {
    word,
    category,
    hints: hintsSoFar.map((h) => h.text),
    roundHintCounts,
    outcome,
    keyHintIndexes: reflection.keyHintIndexes,
    uselessHintIndexes: reflection.uselessHintIndexes,
    feedbackText: reflection.feedbackText,
    nickname: NICKNAME,
    guesses, // 실제로 뭐라고 찍었는지 — 힌트가 나빴는지 AI가 헛짚었는지 이슈만 보고 구분하려는 것.
    lang: 'ko', // 자동플레이는 한국어 게임만 돈다(2026-09-17 영어 버전 추가 — generateHints도 lang 미지정 시 'ko').
    ...(guesser ? { guesserModel: guesser.model } : {}), // exactOptionalPropertyTypes라 undefined를 명시로 넣지 않는다.
  };
  const { issueNumber } = await createFeedbackIssue(payload);

  console.log(
    `[${index}/${GAMES}]${guesser ? ` [추측자=${guesser.model}]` : ''} [${outcome}] "${word}"(${category}) 추측=${guesses.join(' → ')} → 이슈 #${issueNumber}`,
  );
}

async function main(): Promise<void> {
  console.log(`AI 자동플레이 ${GAMES}판 시작`);
  for (let i = 1; i <= GAMES; i++) {
    try {
      await playOne(i);
    } catch (e) {
      // 한 판이 실패해도(LLM 오류 등) 나머지 판은 계속 — 밤새 여러 번 도는 배치라
      // 하나 실패했다고 전체를 죽일 이유가 없다.
      console.error(`[${i}/${GAMES}] 실패:`, e instanceof Error ? e.message : e);
    }
  }
}

main();
