import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { MockHarness } from './mock/MockHarness';
import { WordGuessGame } from './wordgame/WordGuessGame';
import './styles/tokens.css';
import './styles/ambience.css';

// URL 쿼리로 셋 중 하나를 고른다.
//   ?wordgame  턴제 AI 라이어게임(2026-09-15~, 새 설계) — 실시간 서버 필요 없음
//   ?mock      개발용 하네스(실시간 게임 화면을 서버 없이 봄)
//   (없음)     실시간 게임 본편(App.tsx, socket.io)
// 파트 C는 서버 없이 화면을 보고, 파트 D는 App.tsx 를 그대로 개발할 수 있다.
// 서로의 파일을 고칠 필요가 없다 — wordgame도 같은 이유로 쿼리 하나만 더 얹었다.
const params = new URLSearchParams(location.search);
const useWordGame = params.has('wordgame');
const useMock = params.has('mock');

function pickApp() {
  if (useWordGame) return <WordGuessGame />;
  if (useMock) return <MockHarness />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{pickApp()}</ErrorBoundary>
  </StrictMode>,
);
