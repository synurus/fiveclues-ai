/**
 * 제시어 풀. 지금은 scripts/words.json 을 그대로 복사해 들고 있다 — 단어를
 * DB(Supabase)로 옮길지 JSON으로 둘지 아직 미정이라(game-redesign.md), 그
 * 결정과 무관하게 라우트가 동작하도록 로더만 분리해뒀다. DB로 옮기면 이
 * 파일의 구현만 바꾸면 되고 game.ts는 pickWord() 시그니처를 그대로 쓴다.
 *
 * ⚠️ scripts/words.json 과 내용이 갈라질 수 있다 — 단어 풀을 고치면 두 곳 다
 * 고치거나, 한쪽을 정본으로 정하고 빌드 스텝에서 복사하는 게 좋다.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WordEntry {
  word: string;
  category: string;
  accept?: string[];
}

const POOL: WordEntry[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/words.json'), 'utf8'));

export function pickWord(): WordEntry {
  const entry = POOL[Math.floor(Math.random() * POOL.length)];
  if (!entry) throw new Error('단어 풀이 비어 있습니다.');
  return entry;
}
