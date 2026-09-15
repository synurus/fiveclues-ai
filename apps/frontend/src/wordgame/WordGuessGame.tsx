// AI 라이어게임 — 턴제 API(apps/backend/src/routes/game.ts) 전용 화면.
// 기존 App.tsx는 실시간(socket.io) 게임 전용 상태머신(useGameState)에 묶여 있어서
// 그 트리에 얹지 않고 완전히 독립된 화면으로 뒀다(2026-09-15, 실시간 불필요 판단).
//
// 아직 안 만든 것(다음 단계): 결정적 힌트 선택 · 무쓸모 힌트 선택 · 피드백 입력
// 화면. 기획서 v2엔 있지만 게임 판정 로직과는 무관한 사후 설문이라 핵심 루프
// (묘사→추측→결과)부터 검증하는 게 우선이라고 판단해 이번 범위에서 뺐다.
import { useState } from 'react';
import Button from '../components/Button';
import { NAME_MAX_LENGTH } from '../roomConfig';
import { startGame, submitGuess, type GuessResponse } from './api';
import { Typewriter } from './Typewriter';
import './wordgame.css';

type Stage =
  | { kind: 'nickname' }
  | { kind: 'loading' }
  | { kind: 'playing'; session: string; round: 1 | 2; hints: string[] }
  | { kind: 'result'; outcome: 'round1' | 'round2' | 'failed'; word: string }
  | { kind: 'error'; message: string };

export function WordGuessGame() {
  const [nickname, setNickname] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'nickname' });
  const [revealed, setRevealed] = useState(0);
  const [guess, setGuess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleStart = async () => {
    setStage({ kind: 'loading' });
    try {
      const res = await startGame();
      setRevealed(0);
      setGuess('');
      setStage({ kind: 'playing', session: res.session, round: res.round, hints: res.hints.map((h) => h.text) });
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
        setRevealed(0);
        setGuess('');
        setStage({ kind: 'playing', session: res.session, round: res.round, hints: res.hints.map((h) => h.text) });
      } else {
        setStage({ kind: 'result', outcome: res.result, word: res.word });
      }
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
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
            <Button variant="secondary" block onClick={handleStart}>
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
