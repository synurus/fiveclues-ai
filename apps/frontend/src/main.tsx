import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';
import { WordGuessGame } from './wordgame/WordGuessGame';
import './styles/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <WordGuessGame />
    </ErrorBoundary>
  </StrictMode>,
);
