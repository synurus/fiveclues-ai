/**
 * 자가개선 루프 0단계 — AI가 직접 게임을 플레이해서 피드백을 만들어낸다.
 * (.github/workflows/self-improve-autoplay.yml 이 01~07시 KST 매시 이 스크립트를 돌리고,
 *  08시엔 self-improve.yml의 propose.mjs가 그 피드백들을 모아 PR을 낸다 — 2026-09-16 결정)
 *
 * 서버가 아직 어디에도 배포돼 있지 않아서(로컬 npm run turn 뿐) HTTP로 게임을 호출할
 * 수가 없다 — 그래서 scripts/spectate.mjs 가 그랬던 것처럼 프로덕션 힌트 생성
 * 로직(generateHints/judgeGuess/pickWord)을 직접 import해서 서버 없이 한 판을
 * 통째로 흉내 낸다.
 *
 * 흐름: 단어 뽑기 → 1라운드 힌트 생성(프로덕션 코드) → 추측자 LLM이 카테고리 없이
 * 힌트만 보고 추측(사람 플레이어와 동일 조건) → 틀리면 2라운드도 같은 방식 → 게임이
 * 끝나면 그 추측자에게 "방금 뭘 플레이했다" 소감을 물어서 결정적/무쓸모 힌트와
 * 코멘트를 뽑아냄(사람이 결과 화면에서 직접 고르는 걸 대신) → createFeedbackIssue()를
 * HTTP 없이 직접 호출.
 *
 * 닉네임은 항상 "AI자동플레이"로 고정 — Issues 목록·PR 본문에서 실제 플레이어
 * 피드백과 한눈에 구분되게 하려는 것.
 *
 * 여러 판을 동시에(Promise.all) 돌리지 않고 순서대로 돈다 — Groq 무료 티어 TPM
 * 한도가 게임 본체 트래픽과 공유되므로 굳이 몰아서 부담을 줄 이유가 없다.
 *
 * 환경변수: BOT_BASE_URL/BOT_API_KEY/BOT_MODEL(힌트·추측·소감 모두 동일 엔드포인트),
 *   GITHUB_FEEDBACK_TOKEN/GITHUB_REPO(createFeedbackIssue 용 — Actions에서는 보통
 *   secrets.GITHUB_TOKEN 과 github.repository 를 그대로 이 이름으로 넘긴다),
 *   AUTO_PLAY_GAMES(1회 실행에 플레이할 판 수, 기본 2)
 *
 *   로컬 테스트: npm run autoplay -w backend
 */

import 'dotenv/config';
import { generateHints, judgeGuess, callBot, parseJson, type Hint } from './wordGuessBot';
import { pickWord } from '../routes/wordPool';
import { createFeedbackIssue, type FeedbackPayload } from '../github/feedbackIssue';

const HINT_COUNT = 5; // routes/game.ts의 HINT_COUNT와 같은 값이어야 실제 게임과 동일 조건이 된다.
const GAMES = Math.max(1, Number(process.env.AUTO_PLAY_GAMES ?? '2') || 2);
const NICKNAME = 'AI자동플레이';

type Outcome = 'round1' | 'round2' | 'failed';

// ── 추측자 — 사람 플레이어 대역. 카테고리를 안 준다(프로덕션에서 사람이 안 보는 것과 동일). ──
async function guessWord(hints: Hint[]): Promise<string> {
  const system =
    `너는 한국어 낱말 맞히기 게임의 참가자다. 아래 묘사만 보고 제시어를 하나 맞혀라.\n` +
    `주제는 알려주지 않는다 — 묘사만으로 추론해야 한다. 망설여지면 그래도 가장 그럴듯한 단어 하나를 골라라.\n` +
    `JSON만 출력한다: {"guess":"네 생각에 정답인 단어"}`;
  const user = hints.map((h) => `- ${h.text}`).join('\n');
  const raw = await callBot(system, user);
  const parsed = parseJson<{ guess?: unknown }>(raw, {});
  return String(parsed.guess ?? '').trim();
}

// ── 소감 — 같은 추측자에게 방금 판을 되돌아보게 한다. 사람이 결과 화면에서 하는 선택을 대신. ──
interface Reflection {
  keyHintIndex: number | null;
  uselessHintIndex: number | null;
  feedbackText: string;
}

async function reflectFeedback(
  word: string,
  category: string,
  hints: Hint[],
  outcome: Outcome,
  guesses: string[],
): Promise<Reflection> {
  // feedbackText 는 이 게임의 유일한 자유서술 필드라 — propose.mjs 가 이걸 그대로
  // LLM에 보여주고 hintPrompt.ts 를 고치게 시킨다. "재밌었다/아쉬웠다" 같은 감상은
  // 프롬프트를 고치는 데 아무 쓸모가 없어서, 진단(왜 그 단어를 떠올렸는지 · 힌트의
  // 어떤 부분이 오답 쪽으로 끌고 갔는지)을 쓰게 명시적으로 요구한다(2026-09-16,
  // "캥거루"를 "개구리"로 두 번 헛짚었는데 feedbackText가 "아쉬웠다"뿐이라 왜
  // 헷갈렸는지 전혀 안 남았던 사례에서 고침).
  const system =
    `너는 방금 아래 낱말 맞히기 게임을 플레이한 참가자다. 게임을 만든 사람에게 실제로 ` +
    `도움이 될 구체적인 피드백을 남긴다.\n` +
    `JSON만 출력한다:\n` +
    `{"keyHintIndex": 숫자 또는 null, "uselessHintIndex": 숫자 또는 null, "feedbackText": "한국어 피드백 한두 문장"}\n` +
    `- keyHintIndex: 그 묘사 덕분에 확신을 갖고 정답을 맞혔다면 그 묘사의 인덱스. 못 맞혔거나 ` +
    `특별히 결정적인 묘사가 없었으면 null.\n` +
    `- uselessHintIndex: 전혀 도움이 안 됐던 묘사의 인덱스. 없으면 null.\n` +
    `- feedbackText: "재밌었다"/"아쉬웠다" 같은 감상은 절대 쓰지 마라. 대신 진단을 써라 — ` +
    `틀렸다면 왜 그 단어를 떠올렸는지, 묘사들의 어떤 공통된 인상이 오답 쪽으로 끌고 갔는지, ` +
    `제시어만의 특징이 안 보여서 다른 단어와 구별이 안 됐는지를 구체적으로. 맞혔다면 무엇이 ` +
    `결정적이었는지를 구체적으로.`;
  const hintList = hints.map((h, i) => `${i}: ${h.text}`).join('\n');
  const outcomeKo = outcome === 'round1' ? '1라운드에 맞힘' : outcome === 'round2' ? '2라운드에 맞힘' : '끝까지 못 맞힘';
  const user =
    `제시어: ${word} (주제: ${category})\n\n묘사 목록:\n${hintList}\n\n` +
    `내가 한 추측: ${guesses.join(' → ')}\n결과: ${outcomeKo}`;
  const raw = await callBot(system, user);
  const parsed = parseJson<{ keyHintIndex?: unknown; uselessHintIndex?: unknown; feedbackText?: unknown }>(raw, {});

  const toIndex = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < hints.length ? v : null;

  return {
    keyHintIndex: toIndex(parsed.keyHintIndex),
    uselessHintIndex: toIndex(parsed.uselessHintIndex),
    feedbackText: String(parsed.feedbackText ?? '').slice(0, 200),
  };
}

async function playOne(index: number): Promise<void> {
  const { word, category, accept } = pickWord();
  const hintsSoFar: Hint[] = [];
  const guesses: string[] = [];

  const r1 = await generateHints({ word, category, round: 1, hintCount: HINT_COUNT });
  hintsSoFar.push(...r1.hints);
  const guess1 = await guessWord(hintsSoFar);
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
    const guess2 = await guessWord(hintsSoFar);
    guesses.push(guess2);
    const verdict2 = judgeGuess(word, guess2, accept ?? []);
    outcome = verdict2 === 'exact' || verdict2 === 'loose' ? 'round2' : 'failed';
  }

  const reflection = await reflectFeedback(word, category, hintsSoFar, outcome, guesses);

  const payload: FeedbackPayload = {
    word,
    category,
    hints: hintsSoFar.map((h) => h.text),
    outcome,
    keyHintIndex: reflection.keyHintIndex,
    uselessHintIndex: reflection.uselessHintIndex,
    feedbackText: reflection.feedbackText,
    nickname: NICKNAME,
    guesses, // 실제로 뭐라고 찍었는지 — 힌트가 나빴는지 AI가 헛짚었는지 이슈만 보고 구분하려는 것.
  };
  const { issueNumber } = await createFeedbackIssue(payload);

  console.log(
    `[${index}/${GAMES}] [${outcome}] "${word}"(${category}) 추측=${guesses.join(' → ')} → 이슈 #${issueNumber}`,
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
