/**
 * 출제 프롬프트 "세대" 식별자(2026-09-28, 기획서 v2 §6 — 세대끼리 성적을 비교하려면 각
 * 판이 어느 프롬프트로 만들어졌는지 알아야 한다).
 *
 * 파일 커밋이 아니라 **게임에 실제로 들어가는 본문**의 해시다 — 헤더 주석만 고친 커밋은
 * 같은 세대로 묶인다. 1·2라운드 본문을 고정 인자로 뽑아 sha256 앞 8자리.
 *
 * ⚠️ scripts/metrics.mjs의 promptVersionOf()가 과거 버전 파일에 똑같은 계산을 해서 옛
 * 이슈(이 값이 없던 때)에도 세대를 소급해 붙인다 — 계산 방식을 바꾸면 둘 다 같이 바꿀 것
 * (game.test.ts의 "metrics.mjs와 같은 값" 테스트가 어긋나면 잡는다).
 */

import crypto from 'node:crypto';
import { hintSystem as hintSystemKo } from './hintPrompt';
import { hintSystem as hintSystemEn } from './hintPromptEn';

type HintSystem = (round: 1 | 2, category: string, hintCount: number) => string;

export function promptVersionOf(hintSystem: HintSystem): string {
  const canonical = hintSystem(1, '{category}', 5) + '\u0000' + hintSystem(2, '{category}', 5);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
}

export const PROMPT_VERSION: Record<'ko' | 'en', string> = {
  ko: promptVersionOf(hintSystemKo),
  en: promptVersionOf(hintSystemEn),
};
