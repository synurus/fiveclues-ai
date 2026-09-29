// 다섯고개 — 턴제 API(apps/backend/src/routes/game.ts) 전용 화면.
//
// 결과 화면의 피드백(결정적/무쓸모 힌트 태그 + 자유 코멘트)은 자가개선 루프
// (scripts/self-improve/) 의 입력이다 — /game/feedback 이 GitHub Issue로 쌓고,
// 매일 08시 KST 워크플로가 그 이슈들을 읽어 hintPrompt.ts 수정 PR을 연다. 제출은
// 선택이고 "다시하기" 는 피드백을 보내든 안 보내든 항상 가능하다.
//
// 힌트 선택 UX(2026-09-16 개편): 재생됐던 힌트 말풍선(채팅 로그)을 결과 화면에도
// 그대로 띄우고, 말풍선 왼쪽 👍/오른쪽 👎을 직접 클릭해 태그한다. 예전엔 힌트
// 텍스트를 라디오 버튼 목록으로 따로 다시 나열했는데, 그러면 "지금 본 그 말풍선"과
// "고르는 목록"이 시각적으로 분리돼 대응 관계가 흐려졌다. 결정적/무쓸모 둘 다
// 복수 선택 가능 — 힌트 여러 개가 같이 결정적이었거나(또는 같이 무쓸모였거나) 하는
// 실제 상황을 하나만 고르라고 강제하면 정보가 사라진다. 한 말풍선이 동시에
// 결정적이면서 무쓸모일 수는 없게 막는다(토글 시 반대쪽에서 자동으로 뺀다).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Button from '../components/Button';
import { NAME_MAX_LENGTH } from './constants';
import { startGame, startDaily, listDaily, submitGuess, submitFeedback, ApiError, type GuessResponse } from './api';
import { Typewriter } from './Typewriter';
import { recordFinishedGame } from './playCount';
import { recentWords, recordGame } from './history';
import { ArchiveView } from './ArchiveView';
import { StatsView } from './StatsView';
import { localDate, getDaily, saveDaily, solvedStreak, shareText, shareResult, type DailyRecord } from './daily';
import { strings, detectLang, saveLang, type Lang } from './i18n';
import { loadEasy, saveEasy } from './easyMode';
import './wordgame.css';

type RoundLog = { hints: string[]; guess: string };
// 오늘의 문제(2026-09-29)면 채워진다 — 날짜는 이 기기의 날짜, 번호는 서버가 준 것.
// archive: 지난 문제로 푸는 판 — 연속 정답(fiveclues-daily)엔 안 남긴다.
type DailyInfo = { date: string; number: number; archive?: boolean };
type ShareStatus = 'idle' | 'shared' | 'copied' | 'failed';

// 서버 오류를 화면 언어의 짧은 안내로 바꾼다(2026-09-28) — 예전엔 서버 메시지를 그대로
// 띄워서 모델 이름·AI 업체 오류가 보이고 영어 화면에도 한국어가 나왔다.
function errorText(e: unknown, s: (typeof strings)[Lang]): string {
  if (!(e instanceof ApiError)) return s.errors.generic;
  switch (e.code) {
    case 'hint_failed':
      return s.errors.hint;
    case 'rate_limited':
      return s.errors.rateLimited;
    case 'session_expired':
    case 'session_invalid':
      return s.errors.expired;
    case 'guess_too_long':
      return s.errors.guessTooLong;
    case 'network':
      return s.errors.network;
    default:
      return s.errors.generic;
  }
}

// 이 추측 입력칸 글자 수 상한 — 서버(game.ts의 MAX_GUESS_LEN)와 같다.
const GUESS_MAX_LENGTH = 40;

// 한글 등 조합형 입력 중의 엔터는 무시한다(2026-09-28). 맥 크롬 등에선 조합 중 엔터에
// keydown이 두 번 와서 게임 시작·추측이 두 번 요청됐다(무료 AI 한도 낭비·화면 꼬임).
const isEnter = (e: KeyboardEvent): boolean => e.key === 'Enter' && !e.nativeEvent.isComposing;

type Stage =
  | { kind: 'nickname' }
  | { kind: 'archive' } // 지난 문제 목록(ArchiveView)
  | { kind: 'stats' } // 내 기록(StatsView)
  | { kind: 'loading' }
  | {
      kind: 'playing';
      session: string;
      round: 1 | 2;
      hints: string[];
      // 2라운드 진입 시 1라운드 화면이 리셋되면서 방금 본 힌트·오답을 까먹는
      // 문제(2026-09-16)가 있어, round===2일 때만 채워 결과 화면 바로 위에
      // 요약으로 다시 보여준다.
      previous?: RoundLog;
      // 1라운드는 범위 없이 순수 추론, 2라운드부터 카테고리 공개(2026-09-16) —
      // round===2일 때만 채워진다.
      category?: string;
      daily?: DailyInfo;
      easy?: boolean; // 쉬움 모드로 시작한 판
    }
  | {
      kind: 'result';
      outcome: 'round1' | 'round2' | 'failed';
      word: string;
      category: string;
      rounds: RoundLog[];
      resultToken: string; // 피드백을 보낼 때 그대로 돌려준다(판 내용은 서버가 이 토큰에서 읽는다)
      playCount: number; // 이 브라우저에서 몇 번째로 끝낸 판인지(playCount.ts, 모르면 0)
      daily?: DailyInfo;
      easy?: boolean;
      // 출제 AI가 피한 결정적 특징 — "아, 그래서 그렇게 돌려 말했구나"를 보여 준다(2026-09-29).
      banned?: string[];
    }
  | { kind: 'error'; message: string };

type FeedbackStatus = 'idle' | 'sending' | 'sent' | 'error';

// 결과 화면 로그를 "힌트 행 / 라운드 구분선 / 그 라운드에 뭐라고 추측했는지" 순서로
// 펼친다(2026-09-16). 힌트 행의 index는 라운드를 넘나드는 전역 인덱스 — 피드백
// payload의 keyHintIndexes/uselessHintIndexes가 이 인덱스를 그대로 쓴다.
type ResultRow =
  | { kind: 'hint'; index: number; text: string }
  | { kind: 'guess'; text: string; wrong: boolean }
  | { kind: 'divider' };

function buildResultRows(rounds: RoundLog[], outcome: 'round1' | 'round2' | 'failed'): ResultRow[] {
  const rows: ResultRow[] = [];
  let index = 0;
  rounds.forEach((round, ri) => {
    if (ri > 0) rows.push({ kind: 'divider' });
    round.hints.forEach((text) => {
      rows.push({ kind: 'hint', index, text });
      index += 1;
    });
    const isFinalGuess = ri === rounds.length - 1;
    rows.push({ kind: 'guess', text: round.guess, wrong: !(isFinalGuess && outcome !== 'failed') });
  });
  return rows;
}

export function WordGuessGame() {
  const [nickname, setNickname] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'nickname' });
  const [revealed, setRevealed] = useState(0);
  const [guess, setGuess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 추측 처리 중 오류(주로 2라운드 묘사 생성 실패) — 판을 버리지 않고 이 안내만 띄운다.
  // 1라운드 세션은 서버에서 그대로 유효해서 같은 추측으로 다시 누르면 이어진다.
  const [guessError, setGuessError] = useState('');
  const [lang, setLang] = useState<Lang>(detectLang);
  const s = strings[lang];

  const switchLang = (next: Lang) => {
    setLang(next);
    saveLang(next);
  };

  // 게임 아래 정적 소개 영역(index.html)의 한/영 블록 순서를 현재 언어에 맞춘다
  // (site.css의 html[data-lang] 규칙 — 둘 다 보이고 현재 언어가 위). 첫 페인트는
  // index.html 인라인 스크립트가 맞춘다.
  useEffect(() => {
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const [keyHints, setKeyHints] = useState<Set<number>>(new Set());
  const [uselessHints, setUselessHints] = useState<Set<number>>(new Set());
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus>('idle');

  const toggleKey = (i: number) => {
    setKeyHints((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    setUselessHints((prev) => (prev.has(i) ? new Set([...prev].filter((x) => x !== i)) : prev));
  };

  const toggleUseless = (i: number) => {
    setUselessHints((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    setKeyHints((prev) => (prev.has(i) ? new Set([...prev].filter((x) => x !== i)) : prev));
  };

  // 공유 결과 안내.
  // 오늘의 문제가 이 기기 날짜로 준비돼 있는지 — 시작 화면에서 미리 확인한다(2026-09-29). 예전엔 없을 때
  // 눌러 보고서야 알았고, 로딩 뒤 시작 화면으로 돌아오면서 안내가 맨 아래 작은 글씨라 "눌러도 되돌아온다"로
  // 보였다. null = 아직 모름(확인 실패 포함 — 그땐 누를 수 있게 둔다).
  const [dailyReady, setDailyReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    listDaily(lang)
      .then((res) => alive && setDailyReady(res.puzzles.some((p) => p.date === localDate())))
      .catch(() => alive && setDailyReady(null));
    return () => {
      alive = false;
    };
  }, [lang]);
  // 쉬움 모드(2026-09-29) — 1라운드부터 카테고리 공개. 판을 시작할 때의 값이 그 판 내내 간다.
  const [easy, setEasy] = useState<boolean>(loadEasy);
  const [shareStatus, setShareStatus] = useState<ShareStatus>('idle');

  const beginPlaying = (session: string, hints: string[], daily?: DailyInfo, category?: string) => {
    setRevealed(0);
    setGuess('');
    setKeyHints(new Set());
    setUselessHints(new Set());
    setFeedbackText('');
    setFeedbackStatus('idle');
    setGuessError('');
    setShareStatus('idle');
    setStage({ kind: 'playing', session, round: 1, hints, ...(daily ? { daily } : {}), ...(category ? { category, easy: true } : {}) });
  };

  // 화면이 바뀔 때(새 판·2라운드·결과·로딩) 봐야 할 곳이 화면 밖이면 스크롤을 옮긴다(2026-09-29).
  // 아래쪽 버튼(다시하기·추측하기)을 누르면 카드 아래 소개 글 때문에 페이지가 짧아지지 않아 스크롤이
  // 그대로 남고, 새 묘사가 화면 위로 가려져 있었다. 2라운드는 1라운드 요약 아래 새 묘사가 시작되는
  // 곳(roundRef), 나머지는 게임 영역(.wg-page) 맨 위 — 카드는 화면 세로 가운데 정렬이라 묘사가 타이핑되며
  // 길어지면 윗부분이 위로 올라가서, 카드가 아니라 화면 높이짜리 영역 맨 위를 기준으로 삼는다.
  // 이미 화면 위쪽 절반에 보이면 건드리지 않는다.
  const pageRef = useRef<HTMLDivElement>(null);
  const roundRef = useRef<HTMLDivElement>(null);
  const screenKey = stage.kind === 'playing' ? `playing-${stage.round}-${stage.session}` : stage.kind;
  const scrollTarget = stage.kind === 'playing' && stage.round === 2 ? 'round' : 'page';
  useEffect(() => {
    const el = scrollTarget === 'round' ? roundRef.current : pageRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // 즉시 이동 — smooth는 묘사가 타이핑되며 화면이 바뀌는 중엔 끊기거나 아예 안 움직이는 경우가 있었다.
    if (top < 0 || top > window.innerHeight / 2) el.scrollIntoView({ block: 'start' });
  }, [screenKey, scrollTarget]);

  const handleStart = async () => {
    setStage({ kind: 'loading' });
    try {
      // 반복 출제 방지 — 이 브라우저의 내 기록에서 최근 제시어(history.ts recentWords). 새로고침해도 유지된다.
      const res = await startGame(lang, recentWords(lang), easy);
      beginPlaying(res.session, res.hints.map((h) => h.text), undefined, res.category);
    } catch (e) {
      setStage({ kind: 'error', message: errorText(e, s) });
    }
  };

  // date를 주면 지난 문제(아카이브), 안 주면 오늘의 문제.
  const handleStartDaily = async (past?: { date: string }) => {
    setStage({ kind: 'loading' });
    try {
      const res = await startDaily(lang, past?.date ?? localDate(), easy, !!past);
      beginPlaying(res.session, res.hints.map((h) => h.text), past ? { ...res.daily, archive: true } : res.daily, res.category);
    } catch (e) {
      // 아직 문제가 없으면 오류 화면 대신 시작 화면에 안내만 — 자유 플레이는 그대로 할 수 있다.
      if (e instanceof ApiError && e.code === 'daily_unavailable') {
        setDailyReady(false);
        setStage({ kind: 'nickname' });
      } else {
        setStage({ kind: 'error', message: errorText(e, s) });
      }
    }
  };

  const handleShare = async (record: DailyRecord, date: string) => {
    const streak = record.archive ? 0 : solvedStreak(lang, date);
    const status = await shareResult(shareText(lang, record, streak, `${location.origin}/`));
    setShareStatus(status);
  };

  const today = localDate();
  const todayRecord = getDaily(lang, today);

  const handleGuess = async () => {
    if (stage.kind !== 'playing' || !guess.trim() || submitting) return;
    setSubmitting(true);
    setGuessError('');
    const attemptedGuess = guess.trim();
    try {
      const res: GuessResponse = await submitGuess(stage.session, attemptedGuess);
      if (res.result === 'continue') {
        const round2Hints = res.hints.map((h) => h.text);
        setRevealed(0);
        setGuess('');
        setStage({
          kind: 'playing',
          session: res.session,
          round: res.round,
          hints: round2Hints,
          category: res.category,
          previous: { hints: stage.hints, guess: attemptedGuess },
          ...(stage.daily ? { daily: stage.daily } : {}),
          ...(stage.easy ? { easy: true } : {}),
        });
      } else {
        const rounds: RoundLog[] = stage.previous
          ? [stage.previous, { hints: stage.hints, guess: attemptedGuess }]
          : [{ hints: stage.hints, guess: attemptedGuess }];
        if (stage.daily && !stage.daily.archive) {
          saveDaily(lang, stage.daily.date, { number: stage.daily.number, outcome: res.result, ...(stage.easy ? { easy: true } : {}) });
        }
        // 내 기록(history.ts) — 모든 판을 남긴다.
        recordGame({
          date: localDate(),
          lang,
          mode: stage.daily ? (stage.daily.archive ? 'archive' : 'daily') : 'free',
          outcome: res.result,
          category: res.category,
          ...(stage.easy ? { easy: true } : {}),
          ...(stage.daily ? { number: stage.daily.number } : {}),
          word: res.word,
        });
        setStage({
          kind: 'result',
          outcome: res.result,
          word: res.word,
          category: res.category,
          rounds,
          resultToken: res.resultToken,
          playCount: recordFinishedGame(),
          ...(stage.daily ? { daily: stage.daily } : {}),
          ...(stage.easy ? { easy: true } : {}),
          ...(res.banned?.length ? { banned: res.banned } : {}),
        });
      }
    } catch (e) {
      // 세션이 만료·손상됐으면 이 판은 더 못 이어간다 — 새 게임 안내로. 그 밖(묘사 생성
      // 실패·요청 제한·네트워크)은 판을 유지하고 다시 누를 수 있게 한다.
      const expired = e instanceof ApiError && (e.code === 'session_expired' || e.code === 'session_invalid');
      if (expired) setStage({ kind: 'error', message: errorText(e, s) });
      else setGuessError(`${errorText(e, s)} ${s.guessRetryHint}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFeedbackSubmit = async () => {
    if (stage.kind !== 'result' || feedbackStatus === 'sending' || feedbackStatus === 'sent') return;
    setFeedbackStatus('sending');
    try {
      await submitFeedback({
        result: stage.resultToken,
        playCount: stage.playCount,
        keyHintIndexes: [...keyHints].sort((a, b) => a - b),
        uselessHintIndexes: [...uselessHints].sort((a, b) => a - b),
        feedbackText: feedbackText.trim(),
        nickname,
      });
      setFeedbackStatus('sent');
    } catch {
      setFeedbackStatus('error');
    }
  };

  return (
    <div className="wg-page" ref={pageRef}>
      <div className="wg-card">
        <h1 className="wg-title">{s.title}</h1>

        {stage.kind === 'nickname' && (
          <>
            <div className="wg-lang-toggle">
              <button type="button" className={lang === 'ko' ? 'wg-lang-active' : ''} onClick={() => switchLang('ko')}>
                한글
              </button>
              <span className="wg-lang-sep">|</span>
              <button type="button" className={lang === 'en' ? 'wg-lang-active' : ''} onClick={() => switchLang('en')}>
                English
              </button>
            </div>
            <p className="text-muted">{s.subtitle}</p>
            <input
              className="wg-input"
              placeholder={s.nicknamePlaceholder}
              maxLength={NAME_MAX_LENGTH}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => isEnter(e) && (todayRecord || dailyReady === false ? handleStart() : handleStartDaily())}
            />
            {/* 오늘의 문제가 먼저(2026-09-29). 오늘 이미 풀었으면 그 자리에서 결과를 공유한다
                — 하루 한 번만 풀게 하는 건 이 브라우저 기록(daily.ts) 기준이다. */}
            {todayRecord ? (
              <Button variant="primary" block onClick={() => handleShare(todayRecord, today)}>
                {s.dailyShareDone(todayRecord.number)}
              </Button>
            ) : dailyReady === false ? (
              <>
                <Button variant="primary" block disabled>
                  {s.dailyNotReady}
                </Button>
                <p className="wg-notice-box">{s.dailyUnavailable}</p>
              </>
            ) : (
              <Button variant="primary" block onClick={() => handleStartDaily()}>
                {s.dailyStart}
              </Button>
            )}
            <Button variant="secondary" block onClick={handleStart}>
              {s.freePlay}
            </Button>
            <label className="wg-easy">
              <input
                type="checkbox"
                checked={easy}
                onChange={(e) => {
                  setEasy(e.target.checked);
                  saveEasy(e.target.checked);
                }}
              />
              {s.easyLabel}
            </label>
            {/* 지난 문제·내 기록(2026-09-29) */}
            <div className="wg-links">
              <button type="button" onClick={() => setStage({ kind: 'archive' })}>
                {s.archive}
              </button>
              <span className="wg-lang-sep">|</span>
              <button type="button" onClick={() => setStage({ kind: 'stats' })}>
                {s.stats}
              </button>
            </div>
            {shareStatus !== 'idle' && <p className="wg-notice">{s[shareStatus === 'failed' ? 'shareFailed' : shareStatus]}</p>}
          </>
        )}

        {stage.kind === 'loading' && <p className="text-muted">{s.loading}</p>}

        {stage.kind === 'archive' && (
          <ArchiveView lang={lang} onPlay={(p) => handleStartDaily(p)} onBack={() => setStage({ kind: 'nickname' })} />
        )}

        {stage.kind === 'stats' && <StatsView lang={lang} onBack={() => setStage({ kind: 'nickname' })} />}

        {stage.kind === 'playing' && (
          <>
            {stage.previous && (
              <div className="wg-recap">
                <p className="wg-round wg-round-recap">{s.recapRoundLabel}</p>
                <ul className="wg-hints wg-hints-recap">
                  {stage.previous.hints.map((text, i) => (
                    <li key={`recap-${i}`}>{text}</li>
                  ))}
                </ul>
                <p className="wg-recap-guess">
                  {s.myGuess(stage.previous.guess)} <span className="wg-recap-wrong">{s.wrongTag}</span>
                </p>
              </div>
            )}
            <div ref={roundRef} className="wg-round-anchor" />
            {stage.daily && (
              <p className="wg-daily-title">
                {stage.daily.archive ? s.archiveTitle(stage.daily.number) : s.dailyTitle(stage.daily.number)}
              </p>
            )}
            <p className="wg-round">
              {s.round(stage.round)}
              {stage.category && <span className="wg-category">{s.category(stage.category)}</span>}
            </p>
            <ul className="wg-hints">
              {stage.hints.map((text, i) =>
                i <= revealed ? (
                  <li key={`${stage.round}-${i}`}>
                    <Typewriter text={text} onDone={() => i === revealed && setRevealed((n) => n + 1)} />
                  </li>
                ) : null,
              )}
            </ul>
            <input
              className="wg-input"
              placeholder={s.guessPlaceholder}
              value={guess}
              maxLength={GUESS_MAX_LENGTH}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => isEnter(e) && handleGuess()}
              disabled={submitting}
            />
            {guessError && <p style={{ color: 'var(--color-danger)' }}>{guessError}</p>}
            <Button variant="primary" block onClick={handleGuess} disabled={submitting || !guess.trim()}>
              {s.guess}
            </Button>
          </>
        )}

        {stage.kind === 'result' && (
          <>
            <p className="wg-result-badge">{s.resultBadge[stage.outcome]}</p>
            <p className="wg-answer">{s.answer(stage.word, stage.category)}</p>
            {stage.banned && (
              <p className="wg-banned">
                <span className="wg-banned-title">{s.bannedTitle}</span>
                {stage.banned.join(' · ')}
              </p>
            )}

            {stage.daily && (
              <div className="wg-daily-share">
                <p className="wg-daily-title">
                  {stage.daily.archive ? s.archiveTitle(stage.daily.number) : s.dailyTitle(stage.daily.number)}
                </p>
                {!stage.daily.archive && solvedStreak(lang, stage.daily.date) > 1 && (
                  <p className="wg-streak">{s.streak(solvedStreak(lang, stage.daily.date))}</p>
                )}
                <Button
                  variant="primary"
                  block
                  onClick={() =>
                    stage.daily &&
                    handleShare(
                      {
                        number: stage.daily.number,
                        outcome: stage.outcome,
                        ...(stage.easy ? { easy: true } : {}),
                        ...(stage.daily.archive ? { archive: true } : {}),
                      },
                      stage.daily.date,
                    )
                  }
                >
                  {s.share}
                </Button>
                {shareStatus !== 'idle' && (
                  <p className="wg-notice">{s[shareStatus === 'failed' ? 'shareFailed' : shareStatus]}</p>
                )}
                {!stage.daily.archive && <p className="wg-notice">{s.dailyNext}</p>}
              </div>
            )}

            {feedbackStatus === 'sent' ? (
              <p className="wg-feedback-done">
                {s.feedbackDone}
                <br />
                <a href="/guides/prompt-history">{s.historyLink}</a>
              </p>
            ) : (
              <div className="wg-feedback">
                <p className="wg-feedback-title">
                  {s.feedbackTitle.map((line, i) => (
                    <span key={line}>
                      {i > 0 && <br />}
                      {line}
                    </span>
                  ))}
                </p>
                <ul className="wg-hints wg-hints-taggable">
                  {buildResultRows(stage.rounds, stage.outcome).map((row, ri) => {
                    if (row.kind === 'divider') return <li key={`div-${ri}`} className="wg-hint-divider" />;
                    if (row.kind === 'guess') {
                      return (
                        <li key={`guess-${ri}`} className="wg-hint-guess-row">
                          {s.myGuess(row.text)} {row.wrong && <span className="wg-hint-guess-wrong">{s.wrongTag}</span>}
                        </li>
                      );
                    }
                    const isKey = keyHints.has(row.index);
                    const isUseless = uselessHints.has(row.index);
                    return (
                      <li
                        key={row.index}
                        className={
                          'wg-hint-row' + (isKey ? ' wg-hint-row-key' : '') + (isUseless ? ' wg-hint-row-useless' : '')
                        }
                      >
                        <button
                          type="button"
                          className={'wg-hint-tag' + (isKey ? ' wg-hint-tag-active' : '')}
                          aria-pressed={isKey}
                          aria-label="결정적인 힌트로 표시"
                          onClick={() => toggleKey(row.index)}
                        >
                          👍
                        </button>
                        <span className="wg-hint-text">{row.text}</span>
                        <button
                          type="button"
                          className={'wg-hint-tag' + (isUseless ? ' wg-hint-tag-active' : '')}
                          aria-pressed={isUseless}
                          aria-label="무쓸모한 힌트로 표시"
                          onClick={() => toggleUseless(row.index)}
                        >
                          👎
                        </button>
                      </li>
                    );
                  })}
                </ul>

                <textarea
                  className="wg-textarea"
                  placeholder={s.feedbackPlaceholder}
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  maxLength={300}
                />

                <Button
                  variant="primary"
                  block
                  onClick={handleFeedbackSubmit}
                  disabled={feedbackStatus === 'sending'}
                >
                  {feedbackStatus === 'sending' ? s.feedbackSending : feedbackStatus === 'error' ? s.feedbackRetry : s.feedbackSubmit}
                </Button>
              </div>
            )}

            {/* 피드백 보내기 전엔 그쪽을 강조하려고 secondary, 보내고 나면(버튼이
                사라지고) 다시 원래 강조 스타일로(2026-09-16). */}
            <Button variant={feedbackStatus === 'sent' ? 'primary' : 'secondary'} block onClick={handleStart}>
              {s.playAgain}
            </Button>
          </>
        )}

        {stage.kind === 'error' && (
          <>
            <p style={{ color: 'var(--color-danger)' }}>{stage.message}</p>
            <Button variant="secondary" block onClick={handleStart}>
              {s.retry}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
