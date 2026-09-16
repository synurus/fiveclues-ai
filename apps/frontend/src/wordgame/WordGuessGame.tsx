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
import { useState } from 'react';
import Button from '../components/Button';
import { NAME_MAX_LENGTH } from './constants';
import { startGame, submitGuess, submitFeedback, type GuessResponse } from './api';
import { Typewriter } from './Typewriter';
import './wordgame.css';

type RoundLog = { hints: string[]; guess: string };

type Stage =
  | { kind: 'nickname' }
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
    }
  | { kind: 'result'; outcome: 'round1' | 'round2' | 'failed'; word: string; category: string; rounds: RoundLog[] }
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

  const handleStart = async () => {
    setStage({ kind: 'loading' });
    try {
      const res = await startGame();
      const firstHints = res.hints.map((h) => h.text);
      setRevealed(0);
      setGuess('');
      setKeyHints(new Set());
      setUselessHints(new Set());
      setFeedbackText('');
      setFeedbackStatus('idle');
      setStage({ kind: 'playing', session: res.session, round: res.round, hints: firstHints });
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleGuess = async () => {
    if (stage.kind !== 'playing' || !guess.trim() || submitting) return;
    setSubmitting(true);
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
        });
      } else {
        const rounds: RoundLog[] = stage.previous
          ? [stage.previous, { hints: stage.hints, guess: attemptedGuess }]
          : [{ hints: stage.hints, guess: attemptedGuess }];
        setStage({ kind: 'result', outcome: res.result, word: res.word, category: res.category, rounds });
      }
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleFeedbackSubmit = async () => {
    if (stage.kind !== 'result' || feedbackStatus === 'sending' || feedbackStatus === 'sent') return;
    setFeedbackStatus('sending');
    try {
      await submitFeedback({
        word: stage.word,
        category: stage.category,
        hints: stage.rounds.flatMap((r) => r.hints),
        roundHintCounts: stage.rounds.map((r) => r.hints.length),
        guesses: stage.rounds.map((r) => r.guess),
        outcome: stage.outcome,
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
    <div className="wg-page">
      <div className="wg-card">
        <h1 className="wg-title">다섯고개</h1>

        {stage.kind === 'nickname' && (
          <>
            <p className="text-muted">AI가 묘사하는 제시어를 맞혀보세요.</p>
            <input
              className="wg-input"
              placeholder="닉네임"
              maxLength={NAME_MAX_LENGTH}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <Button variant="primary" block onClick={handleStart}>
              시작
            </Button>
          </>
        )}

        {stage.kind === 'loading' && <p className="text-muted">묘사를 만드는 중…</p>}

        {stage.kind === 'playing' && (
          <>
            {stage.previous && (
              <div className="wg-recap">
                <p className="wg-round wg-round-recap">1라운드 힌트</p>
                <ul className="wg-hints wg-hints-recap">
                  {stage.previous.hints.map((text, i) => (
                    <li key={`recap-${i}`}>{text}</li>
                  ))}
                </ul>
                <p className="wg-recap-guess">
                  내 추측 "{stage.previous.guess}" <span className="wg-recap-wrong">[땡! 틀렸습니다]</span>
                </p>
              </div>
            )}
            <p className="wg-round">
              {stage.round}라운드
              {stage.category && <span className="wg-category"> · 제시어 카테고리 : {stage.category}</span>}
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
              placeholder="정답을 입력하세요"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGuess()}
              disabled={submitting}
            />
            <Button variant="primary" block onClick={handleGuess} disabled={submitting || !guess.trim()}>
              추측하기
            </Button>
          </>
        )}

        {stage.kind === 'result' && (
          <>
            <p className="wg-result-badge">
              {stage.outcome === 'round1' ? '참 잘했어요' : stage.outcome === 'round2' ? '잘했어요' : '아쉬워요'}
            </p>
            <p className="text-muted">정답은 "{stage.word}" 였습니다.</p>

            {feedbackStatus === 'sent' ? (
              <p className="wg-feedback-done">피드백 고마워요! 다음 프롬프트 개선에 참고할게요.</p>
            ) : (
              <div className="wg-feedback">
                <p className="wg-feedback-title">결정적이었던 힌트엔 👍, 전혀 도움 안 된 힌트엔 👎 — 여러 개 골라도 돼요.</p>
                <ul className="wg-hints wg-hints-taggable">
                  {buildResultRows(stage.rounds, stage.outcome).map((row, ri) => {
                    if (row.kind === 'divider') return <li key={`div-${ri}`} className="wg-hint-divider" />;
                    if (row.kind === 'guess') {
                      return (
                        <li key={`guess-${ri}`} className="wg-hint-guess-row">
                          내 추측 "{row.text}"{' '}
                          {row.wrong && <span className="wg-hint-guess-wrong">[땡! 틀렸습니다]</span>}
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
                  placeholder="추가로 남기고 싶은 말 (선택)"
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
                  {feedbackStatus === 'sending' ? '보내는 중…' : feedbackStatus === 'error' ? '다시 시도' : '피드백 보내기'}
                </Button>
              </div>
            )}

            {/* 피드백 보내기 전엔 그쪽을 강조하려고 secondary, 보내고 나면(버튼이
                사라지고) 다시 원래 강조 스타일로(2026-09-16). */}
            <Button variant={feedbackStatus === 'sent' ? 'primary' : 'secondary'} block onClick={handleStart}>
              다시하기
            </Button>
          </>
        )}

        {stage.kind === 'error' && (
          <>
            <p style={{ color: 'var(--color-danger)' }}>{stage.message}</p>
            <Button variant="secondary" block onClick={handleStart}>
              다시 시도
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
