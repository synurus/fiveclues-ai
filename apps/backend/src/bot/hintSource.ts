/**
 * 한 판의 묘사를 어디서 가져올지 정한다(2026-09-28): 미리 만든 세트(hintSets.ts)가 있으면
 * 그걸, 없으면 출제 모델 체인으로 실시간 생성(wordGuessBot.ts의 generateHints).
 * routes/game.ts(실제 게임)와 bot/autoPlay.ts(AI 자동플레이)가 같이 쓴다 — 자동플레이가
 * 실제 게임과 같은 묘사를 받아야 그 피드백이 의미가 있다.
 *
 * - 2라운드는 1라운드와 같은 세트의 round2를 쓴다. 미리 만든 2라운드는 플레이어의 1라운드
 *   오답을 모르고 만든 것이다(실시간 생성은 오답을 알려 줘 같은 오답으로 끌려가는 걸 피하게
 *   했다) — 대신 품질이 가장 좋은 모델이 만든 묘사를 쓰는 쪽을 택했다.
 * - EEA·스위스·영국 접속(restrictedRegion)엔 미리 만든 세트를 쓰지 않는다 — 제미나이 무료
 *   할당량으로 만든 결과라 실시간 생성 때와 같은 약관 제한을 그대로 적용한다.
 */

import { generateHints, type Hint } from './wordGuessBot';
import { findHintSet, pickHintSet, type Lang } from './hintSets';
import { PROMPT_VERSION } from './promptVersion';

// 라운드당 묘사 개수(기획서 v2: "5냐 4냐는 밸런스 보고" — 5로 확정, 2026-09-16). 실제 게임과
// 자동플레이가 둘 다 이 파일을 거치므로 여기 하나다. 미리 만든 세트(pregenHints.ts)도 이 값을 쓴다.
export const HINT_COUNT = 5;

/** 미리 만든 세트로 낸 묘사의 모델 이름 앞에 붙인다 — 피드백·성적표에서 실시간 생성과 구분. */
export const PREGEN_PREFIX = 'pregen:';

const asHints = (texts: string[]): Hint[] => texts.map((text) => ({ text, angle: '' }));

export interface Round1 {
  hints: Hint[];
  model: string;
  promptVersion: string;
  /** 미리 만든 세트를 썼으면 그 id — 2라운드가 같은 세트의 round2를 찾는 데 쓴다. */
  setId?: string;
}

/**
 * currentOnly: 지금 프롬프트 세대 세트만 쓴다(없으면 실시간 생성) — 자동플레이용. 자동플레이
 * 피드백은 "지금 프롬프트"를 평가해야 하는데, 옛 세대 세트로 플레이하면 이미 바뀐 프롬프트를
 * 재게 된다. 사람 판은 품질을 위해 옛 세대 세트도 쓴다(hintSets.ts의 pickHintSet 주석).
 */
export async function round1Hints(input: {
  word: string;
  category: string;
  lang: Lang;
  restrictedRegion?: boolean;
  currentOnly?: boolean;
}): Promise<Round1> {
  const { word, category, lang } = input;
  if (!input.restrictedRegion) {
    const set = pickHintSet(lang, word, PROMPT_VERSION[lang], !input.currentOnly);
    if (set) return { hints: asHints(set.round1), model: PREGEN_PREFIX + set.model, promptVersion: set.promptVersion, setId: set.id };
  }
  const r = await generateHints({
    word,
    category,
    round: 1,
    hintCount: HINT_COUNT,
    lang,
    ...(input.restrictedRegion ? { restrictedRegion: true } : {}),
  });
  return { hints: r.hints, model: r.model, promptVersion: PROMPT_VERSION[lang] };
}

export async function round2Hints(input: {
  word: string;
  category: string;
  lang: Lang;
  restrictedRegion?: boolean;
  setId?: string;
  previousHints: Hint[];
  wrongGuess: string;
}): Promise<{ hints: Hint[]; model: string }> {
  const { word, category, lang } = input;
  if (input.setId && !input.restrictedRegion) {
    const set = findHintSet(lang, word, input.setId);
    if (set) return { hints: asHints(set.round2), model: PREGEN_PREFIX + set.model };
    // 배포 사이에 세트 파일이 바뀌어 그 세트가 없어졌으면 실시간 생성으로.
  }
  const r = await generateHints({
    word,
    category,
    round: 2,
    hintCount: HINT_COUNT,
    previousHints: input.previousHints,
    wrongGuess: input.wrongGuess,
    lang,
    ...(input.restrictedRegion ? { restrictedRegion: true } : {}),
  });
  return { hints: r.hints, model: r.model };
}
