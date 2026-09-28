/**
 * 턴제 게임 API — 다섯고개(기획서 v2). 실시간(WebSocket) 없이 요청-응답만으로
 * 한 판이 진행된다(2026-09-15, 새 설계엔 다른 플레이어·토론이 없어 실시간이 필요
 * 없다고 판단). 상태는 gameToken.ts 의 암호화된 세션 토큰에 담아 클라이언트가
 * 들고 다닌다.
 *
 * 흐름:
 *   POST /game/start  → 단어를 뽑고 1라운드 묘사 5개를 생성, session 발급
 *   POST /game/guess  → session + 추측을 받아 판정
 *     - 맞으면(exact/loose 둘 다 정답 — "카메라"/"사진찍기" 같은 포함관계도 정답으로
 *       봐야 한다는 실측 논의를 그대로 따름): 결과 + 정답 공개 + result 토큰
 *     - 1라운드에서 틀리면: 2라운드 묘사를 그 자리에서 같이 생성해 한 번에 돌려준다
 *     - 2라운드에서도 틀리면: 실패 + 정답 공개 + result 토큰
 *   POST /game/feedback → result 토큰 + 결과 화면에서 고른 결정적/무쓸모 힌트(복수
 *     선택 가능) + 코멘트를 GitHub Issue로 쌓는다(자가개선 루프 입력)
 *   POST /game/daily/start → 오늘의 문제(bot/dailyPuzzle.ts) — 날짜마다 모두 같은 제시어·
 *     묘사. 이후 /guess·/feedback은 자유 플레이와 같다(세션에 daily 날짜가 실려 있다).
 *   두 시작 요청 다 body.easy === true면 쉬움 모드(2026-09-29): 1라운드부터 카테고리를
 *     응답에 같이 준다. 묘사는 똑같다 — 성적표(metrics.mjs)에선 쉬움 모드 판을 따로 뺀다.
 *
 * result 토큰(2026-09-28): 예전엔 /feedback이 단어·묘사·추측을 클라이언트가 보낸 그대로
 * 믿어서, 누구나 없는 판을 지어내 이슈를 만들 수 있었다 — 그 내용은 자가개선 AI 프롬프트에
 * 그대로 들어간다. 이제 판의 내용은 서버가 암호화해 넘긴 result 토큰에서만 읽고,
 * 클라이언트에선 태그·코멘트·닉네임만 받는다.
 *
 * 오류 응답은 { error, code } — error는 사람이 읽을 짧은 안내, code는 화면이 언어별
 * 문구를 고르는 데 쓴다. 모델 이름·AI 업체 오류 같은 내부 내용은 서버 로그에만 남긴다.
 */

import { Router, type Request, type Response } from 'express';
import { judgeGuess, type Hint } from '../bot/wordGuessBot';
import { round1Hints, round2Hints } from '../bot/hintSource';
import { encodeSession, decodeSession, InvalidSessionError, SessionExpiredError } from './gameToken';
import { pickWord, findWord } from './wordPool';
import { acceptableDate, dailyFor } from '../bot/dailyPuzzle';
import { PREGEN_PREFIX } from '../bot/hintSource';
import { rateLimit } from './rateLimit';
import { createFeedbackIssue, type FeedbackPayload } from '../github/feedbackIssue';

// 라운드당 묘사 개수(5)는 bot/hintSource.ts의 HINT_COUNT가 정한다.

// 입력 길이 상한 — 추측은 2라운드 프롬프트에 그대로 들어가서(wrongGuess) 길면 토큰을
// 먹고, 코멘트·닉네임은 공개 이슈에 그대로 실린다. 화면 쪽 제한(maxLength)과 맞춘다.
export const MAX_GUESS_LEN = 40;
export const MAX_FEEDBACK_LEN = 300;
export const MAX_NICKNAME_LEN = 12;

// 결과 화면에 오래 머물다 피드백을 보낼 수도 있어서 게임 세션(30분)보다 넉넉히.
const RESULT_TTL_MS = 2 * 60 * 60_000;

type Lang = 'ko' | 'en';
type Outcome = FeedbackPayload['outcome'];

interface SessionPayload {
  word: string;
  category: string;
  accept: string[];
  round: 1 | 2; // 이 토큰으로 판정할 라운드
  lang: Lang; // 한 판 내내 언어를 고정한다 — 2라운드 힌트도 이 값을 그대로 쓴다.
  hints: string[][]; // 라운드별 묘사. 2라운드 생성 시 1라운드 것은 "겹치지 말 것"에 쓴다
  guesses: string[]; // 지난 라운드들의 추측(오답)
  models: string[]; // 라운드별로 묘사를 만든 모델
  promptVersion: string; // 이 판 묘사의 출제 프롬프트 세대(미리 만든 세트면 그 세트를 만든 세대)
  setId?: string; // 미리 만든 세트를 썼으면 그 id — 2라운드가 같은 세트의 round2를 쓴다
  daily?: string; // 오늘의 문제면 그 날짜 — 2라운드도 그날 문제의 round2를 쓴다
  easy?: boolean; // 쉬움 모드 — 1라운드부터 카테고리 공개(성적표에선 따로 뺀다)
}

/** 판이 끝났을 때 발급하는 result 토큰의 내용 — /feedback이 이것만 믿는다. */
interface ResultPayload {
  // 게임 세션 토큰과 같은 키로 암호화되므로, 진행 중인 판의 세션 토큰을 result 자리에
  // 넣지 못하게 종류를 표시한다.
  kind: 'result';
  word: string;
  category: string;
  lang: Lang;
  hints: string[][];
  guesses: string[];
  models: string[];
  outcome: Outcome;
  promptVersion: string;
  daily?: string;
  easy?: boolean;
}

// 이 브라우저에서 몇 번째로 끝낸 판인지(1부터) — 화면이 localStorage로 세서 보낸다
// (기획서 v2 §8: 같은 사람이 반복하면 요령이 생겨 정답률이 오르니, 세대 비교는 초행
// 판만 따로 볼 수 있어야 한다). 클라이언트 값이라 참고용 — 범위만 검사한다.
const toPlayCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100_000 ? v : undefined;

// body.lang이 'en'이 아니면 전부 'ko'로 본다(기존 클라이언트·값 없는 요청과
// 호환되게, 2026-09-17 영어 버전 추가).
const toLang = (v: unknown): Lang => (v === 'en' ? 'en' : 'ko');

// 플레이어 화면엔 묘사 문장만 나간다 — angle은 기록·분석용이라 노출할 이유가 없다.
const toPlayerHints = (hints: Hint[]): { text: string }[] => hints.map((h) => ({ text: h.text }));

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// body에서 온 값을 "hints 범위 안의 인덱스 배열"로만 걸러낸다(중복 제거).
const toIndexArray = (v: unknown, length: number): number[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < length))]
    : [];

// body.exclude — 클라이언트가 이번 세션에서 이미 본 단어들. wordPool.ts의 pickWord 참고.
const toExcludeArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 100) : [];

const cleanText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// EEA(EU 27개국 + 아이슬란드·리히텐슈타인·노르웨이)·스위스·영국 — 제미나이 API 무료
// 할당량으로는 이 지역 이용자에게 서비스할 수 없다(Gemini API 추가 약관, 2026-09-27
// 확인). Vercel이 붙여주는 접속 국가 헤더로 판단하고, 그 지역이면 출제 모델 체인에서
// 제미나이를 뺀다(wordGuessBot.ts의 HINT_CHAIN). 헤더가 없으면(로컬 개발) 제한 없음.
const RESTRICTED_COUNTRIES = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB'.split(' '),
);
const isRestrictedRegion = (req: Request): boolean =>
  RESTRICTED_COUNTRIES.has(String(req.headers['x-vercel-ip-country'] ?? '').toUpperCase());

// 묘사 생성 실패 — 자세한 원인(어느 모델이 왜)은 로그에만 남기고 화면엔 짧은 안내만.
function hintFailed(res: Response, e: unknown): void {
  console.error('[game] 묘사 생성 실패:', errorMessage(e));
  res.status(502).json({ error: '지금 묘사를 만들 수 없습니다. 잠시 후 다시 시도해 주세요.', code: 'hint_failed' });
}

function sessionError(res: Response, e: InvalidSessionError): void {
  const expired = e instanceof SessionExpiredError;
  res.status(400).json({ error: e.message, code: expired ? 'session_expired' : 'session_invalid' });
}

function finish(res: Response, payload: SessionPayload, guess: string, outcome: Outcome, verdict: string): void {
  const resultToken = encodeSession<ResultPayload>({
    kind: 'result',
    word: payload.word,
    category: payload.category,
    lang: payload.lang,
    hints: payload.hints,
    guesses: [...payload.guesses, guess],
    models: payload.models,
    outcome,
    promptVersion: payload.promptVersion,
    ...(payload.daily ? { daily: payload.daily } : {}),
    ...(payload.easy ? { easy: true } : {}),
  });
  res.json({ result: outcome, word: payload.word, category: payload.category, verdict, resultToken });
}

export const gameRouter = Router();

// 1분당 횟수 — 사람 한 명이 정상적으로 플레이하면 절대 닿지 않을 만큼 넉넉하게.
gameRouter.post('/start', rateLimit('start', 12, 60_000), async (req: Request, res: Response) => {
  const body = req.body as { lang?: unknown; exclude?: unknown; easy?: unknown } | undefined;
  const easy = body?.easy === true;
  const lang = toLang(body?.lang);
  const { word, category, accept } = pickWord(lang, toExcludeArray(body?.exclude));
  try {
    // 미리 만든 세트가 있으면 그걸, 없으면 실시간 생성(bot/hintSource.ts).
    const { hints, model, promptVersion, setId } = await round1Hints({
      word,
      category,
      lang,
      restrictedRegion: isRestrictedRegion(req),
    });

    const session = encodeSession<SessionPayload>({
      word,
      category,
      accept: accept ?? [],
      round: 1,
      lang,
      hints: [hints.map((h) => h.text)],
      guesses: [],
      models: [model],
      promptVersion,
      ...(setId ? { setId } : {}),
      ...(easy ? { easy: true } : {}),
    });

    res.json({ session, round: 1, hints: toPlayerHints(hints), ...(easy ? { category } : {}) });
  } catch (e) {
    hintFailed(res, e);
  }
});

// 오늘의 문제. body.date는 이용자 기기의 날짜(YYYY-MM-DD) — 자정이 각자 시간대에 맞게
// 넘어가게(Wordle처럼). UTC 오늘 ±1일 밖이면 거부. 그날 문제가 아직 없으면 404.
gameRouter.post('/daily/start', rateLimit('start', 12, 60_000), async (req: Request, res: Response) => {
  const body = req.body as { lang?: unknown; date?: unknown; easy?: unknown } | undefined;
  const easy = body?.easy === true;
  const lang = toLang(body?.lang);
  const date = acceptableDate(body?.date);
  if (!date) {
    res.status(400).json({ error: '날짜가 올바르지 않습니다.', code: 'bad_date' });
    return;
  }
  const daily = dailyFor(lang, date);
  if (!daily) {
    res.status(404).json({ error: '오늘의 문제가 아직 준비되지 않았습니다.', code: 'daily_unavailable' });
    return;
  }
  const { puzzle, number } = daily;
  try {
    // 제한 지역(EEA·스위스·영국)은 같은 제시어로 묘사만 실시간 생성 — 미리 만든 묘사는
    // 제미나이 무료 할당량으로 만든 것이라(bot/hintSource.ts 주석).
    const restricted = isRestrictedRegion(req);
    const r1 = restricted
      ? await round1Hints({ word: puzzle.word, category: puzzle.category, lang, restrictedRegion: true })
      : {
          hints: puzzle.round1.map((text) => ({ text, angle: '' })),
          model: PREGEN_PREFIX + puzzle.model,
          promptVersion: puzzle.promptVersion,
        };

    const session = encodeSession<SessionPayload>({
      word: puzzle.word,
      category: puzzle.category,
      accept: findWord(lang, puzzle.word)?.accept ?? [],
      round: 1,
      lang,
      hints: [r1.hints.map((h) => h.text)],
      guesses: [],
      models: [r1.model],
      promptVersion: r1.promptVersion,
      daily: date,
      ...(easy ? { easy: true } : {}),
    });

    res.json({
      session,
      round: 1,
      hints: toPlayerHints(r1.hints),
      daily: { date, number },
      ...(easy ? { category: puzzle.category } : {}),
    });
  } catch (e) {
    hintFailed(res, e);
  }
});

gameRouter.post('/guess', rateLimit('guess', 30, 60_000), async (req: Request, res: Response) => {
  const { session } = req.body as { session?: unknown };
  const guess = cleanText((req.body as { guess?: unknown }).guess, Infinity);
  if (typeof session !== 'string' || !guess) {
    res.status(400).json({ error: 'session과 guess가 필요합니다.', code: 'bad_request' });
    return;
  }
  if (guess.length > MAX_GUESS_LEN) {
    res.status(400).json({ error: `추측은 ${MAX_GUESS_LEN}자 이내로 입력해 주세요.`, code: 'guess_too_long' });
    return;
  }

  let payload: SessionPayload;
  try {
    payload = decodeSession<SessionPayload>(session);
  } catch (e) {
    if (!(e instanceof InvalidSessionError)) throw e;
    sessionError(res, e);
    return;
  }

  const verdict = judgeGuess(payload.word, guess, payload.accept);
  if (verdict === 'exact' || verdict === 'loose') {
    finish(res, payload, guess, payload.round === 1 ? 'round1' : 'round2', verdict);
    return;
  }
  if (payload.round === 2) {
    finish(res, payload, guess, 'failed', verdict);
    return;
  }

  try {
    const previousHints: Hint[] = (payload.hints[0] ?? []).map((text) => ({ text, angle: '' }));
    const restricted = isRestrictedRegion(req);
    // 오늘의 문제는 그날 정해 둔 2라운드를 쓴다(제한 지역은 1라운드처럼 실시간 생성).
    const daily = payload.daily && !restricted ? dailyFor(payload.lang, payload.daily) : null;
    const { hints: r2, model } =
      daily && daily.puzzle.word === payload.word
        ? { hints: daily.puzzle.round2.map((text) => ({ text, angle: '' })), model: PREGEN_PREFIX + daily.puzzle.model }
        : await round2Hints({
            word: payload.word,
            category: payload.category,
            lang: payload.lang,
            restrictedRegion: restricted,
            ...(payload.setId ? { setId: payload.setId } : {}),
            previousHints,
            wrongGuess: guess,
          });

    const nextSession = encodeSession<SessionPayload>({
      ...payload,
      round: 2,
      hints: [...payload.hints, r2.map((h) => h.text)],
      guesses: [...payload.guesses, guess],
      models: [...payload.models, model],
    });

    // 2라운드부터는 카테고리를 공개한다(2026-09-16) — 1라운드는 지금처럼 범위 없이
    // 순수 추론, 2라운드는 "1라운드 오답"에 더해 카테고리까지 주는 구제책.
    res.json({
      result: 'continue',
      session: nextSession,
      round: 2,
      category: payload.category,
      hints: toPlayerHints(r2),
    });
  } catch (e) {
    // 1라운드 세션은 그대로 유효하다 — 화면은 같은 추측으로 다시 시도할 수 있다.
    hintFailed(res, e);
  }
});

gameRouter.post('/feedback', rateLimit('feedback', 5, 60_000), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.result !== 'string') {
    res.status(400).json({ error: 'result 토큰이 필요합니다.', code: 'bad_request' });
    return;
  }

  let game: ResultPayload;
  try {
    game = decodeSession<ResultPayload>(body.result, RESULT_TTL_MS);
    if (game.kind !== 'result') throw new InvalidSessionError('결과 토큰이 아닙니다.');
  } catch (e) {
    if (!(e instanceof InvalidSessionError)) throw e;
    sessionError(res, e);
    return;
  }

  const hints = game.hints.flat();
  const playCount = toPlayCount(body.playCount);
  try {
    const { issueNumber } = await createFeedbackIssue({
      word: game.word,
      category: game.category,
      hints,
      roundHintCounts: game.hints.map((r) => r.length),
      outcome: game.outcome,
      keyHintIndexes: toIndexArray(body.keyHintIndexes, hints.length),
      uselessHintIndexes: toIndexArray(body.uselessHintIndexes, hints.length),
      feedbackText: cleanText(body.feedbackText, MAX_FEEDBACK_LEN),
      nickname: cleanText(body.nickname, MAX_NICKNAME_LEN),
      guesses: game.guesses,
      hintModels: game.models,
      lang: game.lang,
      // 배포 직전에 시작한 판의 토큰엔 없을 수 있다 — 그땐 metrics.mjs가 이슈 시각으로 세대를 정한다.
      ...(game.promptVersion ? { promptVersion: game.promptVersion } : {}),
      ...(game.daily ? { daily: game.daily } : {}),
      ...(game.easy ? { easy: true } : {}),
      ...(playCount ? { playCount } : {}),
    });
    res.json({ ok: true, issueNumber });
  } catch (e) {
    console.error('[game] 피드백 이슈 생성 실패:', errorMessage(e));
    res.status(502).json({ error: '피드백을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'feedback_failed' });
  }
});
