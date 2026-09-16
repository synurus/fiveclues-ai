// AI 라이어게임 — 턴제 API(apps/backend/src/routes/game.ts) 전용 화면.
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

type Stage =
  | { kind: 'nickname' }
  | { kind: 'loading' }
  | { kind: 'playing'; session: string; round: 1 | 2; hints: string[] }
  | { kind: 'result'; outcome: 'round1' | 'round2' | 'failed'; word: string; category: string; hintsSoFar: string[] }
  | { kind: 'error'; message: string };

type FeedbackStatus = 'idle' | 'sending' | 'sent' | 'error';

export function WordGuessGame() {
  const [nickname, setNickname] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'nickname' });
  const [revealed, setRevealed] = useState(0);
  const [guess, setGuess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hintsSoFar, setHintsSoFar] = useState<string[]>([]);

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
      setHintsSoFar(firstHints);
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
    try {
      const res: GuessResponse = await submitGuess(stage.session, guess.trim());
      if (res.result === 'continue') {
        const round2Hints = res.hints.map((h) => h.text);
        setRevealed(0);
        setGuess('');
        setHintsSoFar((prev) => [...prev, ...round2Hints]);
        setStage({ kind: 'playing', session: res.session, round: res.round, hints: round2Hints });
      } else {
        setStage({ kind: 'result', outcome: res.result, word: res.word, category: res.category, hintsSoFar });
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
        hints: stage.hintsSoFar,
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
        <h1 className="wg-title">AI 라이어게임</h1>

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
            <p className="wg-round">{stage.round}라운드</p>
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
                  {stage.hintsSoFar.map((text, i) => {
                    const isKey = keyHints.has(i);
                    const isUseless = uselessHints.has(i);
                    return (
                      <li
                        key={i}
                        className={
                          'wg-hint-row' + (isKey ? ' wg-hint-row-key' : '') + (isUseless ? ' wg-hint-row-useless' : '')
                        }
                      >
                        <button
                          type="button"
                          className={'wg-hint-tag' + (isKey ? ' wg-hint-tag-active' : '')}
                          aria-pressed={isKey}
                          aria-label="결정적인 힌트로 표시"
                          onClick={() => toggleKey(i)}
                        >
                          👍
                        </button>
                        <span className="wg-hint-text">{text}</span>
                        <button
                          type="button"
                          className={'wg-hint-tag' + (isUseless ? ' wg-hint-tag-active' : '')}
                          aria-pressed={isUseless}
                          aria-label="무쓸모한 힌트로 표시"
                          onClick={() => toggleUseless(i)}
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
                  variant="secondary"
                  block
                  onClick={handleFeedbackSubmit}
                  disabled={feedbackStatus === 'sending'}
                >
                  {feedbackStatus === 'sending' ? '보내는 중…' : feedbackStatus === 'error' ? '다시 시도' : '피드백 보내기'}
                </Button>
              </div>
            )}

            <Button variant="primary" block onClick={handleStart}>
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
