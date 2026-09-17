/**
 * 제시어 풀. scripts/words.json(한국어) · scripts/wordsEn.json(영어)을 정본(단일
 * 소스)으로 읽는다(2026-09-16 — apps/backend/src/data/words.json 사본을 없애고
 * 하나로 통일했다. 그 사본은 self-improve/spectate.mjs 가 쓰는 scripts/words.json
 * 과 내용이 갈라질 수 있는 위험이 있었다). 영어 풀은 2026-09-17에 추가했다.
 *
 * import가 아니라 fs.readFileSync를 쓰는 이유: apps/backend의 tsconfig가
 * rootDir을 "./src"로 잡고 있어서(dist/ 구조를 깔끔하게 유지하려고), src 바깥의
 * scripts/*.json을 정적 import로 끌어오면 tsc가 rootDir 위반으로 빌드를
 * 거부한다. fs 읽기는 컴파일 타임 모듈 추적 대상이 아니라 이 제약에 안 걸린다.
 * Vercel 배포에서 이 파일들을 확실히 함께 묶어주는 건 루트 vercel.json의
 * functions["api/index.ts"].includeFiles 설정이 한다.
 *
 * 단어를 DB(Supabase)로 옮길지는 아직 결정 안 했다 — 그 결정과 무관하게 라우트가
 * 동작하도록 로더만 이 파일에 분리해뒀다. DB로 옮기면 이 파일의 구현만 바꾸면
 * 되고 game.ts는 pickWord() 시그니처를 그대로 쓴다.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WordEntry {
  word: string;
  category: string;
  accept?: string[];
}

export type Lang = 'ko' | 'en';

const WORDS_PATH = path.join(__dirname, '../../../../scripts/words.json');
const WORDS_EN_PATH = path.join(__dirname, '../../../../scripts/wordsEn.json');
const POOL_KO: WordEntry[] = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
const POOL_EN: WordEntry[] = JSON.parse(fs.readFileSync(WORDS_EN_PATH, 'utf8'));

export function pickWord(lang: Lang = 'ko'): WordEntry {
  const pool = lang === 'en' ? POOL_EN : POOL_KO;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  if (!entry) throw new Error('단어 풀이 비어 있습니다.');
  return entry;
}
