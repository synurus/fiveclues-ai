// AI 라이어게임 — 턴제 API(apps/backend/src/routes/game.ts) 전용 화면.
// 기존 App.tsx는 실시간(socket.io) 게임 전용 상태머신(useGameState)에 묶여 있어서
// 그 트리에 얹지 않고 완전히 독립된 화면으로 뒀다(2026-09-15, 실시간 불필요 판단).
//
// 결과 화면의 피드백 폼(결정적/무쓸모 힌트 선택 + 자유 코멘트)은 자가개선 루프
// (scripts/self-improve/) 의 입력이다 — /game/feedback 이 GitHub Issue로 쌓고,
// 주간 워크플로가 그 이슈들을 읽어 hintPrompt.ts 수정 PR을 연다. 제출은 선택이고
// "다시하기" 는 피드백을 보내든 안 보내든 항상 가능하다.
import { useState } from 'react';
import Button from '../components/Button';
import { NAME_MAX_LENGTH } from '../roomConfig';
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

  const [keyHintIndex, setKeyHintIndex] = useState<number | null>(null);
  const [uselessHintIndex, setUselessHintIndex] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus>('idle');

  const handleStart = async () => {
    setStage({ kind: 'loading' });
    try {
      const res = await startGame();
      const firstHints = res.hints.map((h) => h.text);
      setRevealed(0);
      setGuess('');
      setHintsSoFar(firstHints);
      setKeyHintIndex(null);
      setUselessHintIndex(null);
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
        keyHintIndex,
        uselessHintIndex,
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
                <p className="wg-feedback-title">어떤 힌트가 결정적이었나요?</p>
                <div className="wg-feedback-options">
                  <label className="wg-feedback-option">
                    <input
                      type="radio"
                      name="key-hint"
                      checked={keyHintIndex === null}
                      onChange={() => setKeyHintIndex(null)}
                    />
                    없음
                  </label>
                  {stage.hintsSoFar.map((text, i) => (
                    <label className="wg-feedback-option" key={`key-${i}`}>
                      <input
                        type="radio"
                        name="key-hint"
                        checked={keyHintIndex === i}
                        onChange={() => setKeyHintIndex(i)}
                      />
                      {text}
                    </label>
                  ))}
                </div>

                <p className="wg-feedback-title">어떤 힌트가 전혀 도움이 안 됐나요?</p>
                <div className="wg-feedback-options">
                  <label className="wg-feedback-option">
                    <input
                      type="radio"
                      name="useless-hint"
                      checked={uselessHintIndex === null}
                      onChange={() => setUselessHintIndex(null)}
                    />
                    없음
                  </label>
                  {stage.hintsSoFar.map((text, i) => (
                    <label className="wg-feedback-option" key={`useless-${i}`}>
                      <input
                        type="radio"
                        name="useless-hint"
                        checked={uselessHintIndex === i}
                        onChange={() => setUselessHintIndex(i)}
                      />
                      {text}
                    </label>
                  ))}
                </div>

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
