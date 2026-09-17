// 다섯고개 / Five Clues — 화면에 보이는 고정 UI 문구만 담는다(2026-09-17, 영어
// 버전 추가). AI가 만드는 힌트·정답 자체는 여기 대상이 아니다 — 그건 언어별
// 단어 풀(scripts/words.json · scripts/wordsEn.json)과 출제자 프롬프트
// (bot/hintPrompt.ts · bot/hintPromptEn.ts)가 따로 담당한다.
export type Lang = 'ko' | 'en';

export const strings = {
  ko: {
    title: '다섯고개',
    subtitle: 'AI가 묘사하는 제시어를 맞혀보세요.',
    nicknamePlaceholder: '닉네임',
    start: '시작',
    loading: '묘사를 만드는 중…',
    guessPlaceholder: '정답을 입력하세요',
    guess: '추측하기',
    wrongTag: '[땡! 틀렸습니다]',
    recapRoundLabel: '1라운드 힌트',
    round: (n: 1 | 2) => `${n}라운드`,
    category: (c: string) => ` · 제시어 카테고리 : ${c}`,
    myGuess: (text: string) => `내 추측 "${text}"`,
    resultBadge: { round1: '참 잘했어요', round2: '잘했어요', failed: '아쉬워요' },
    answer: (word: string, category: string) => `정답은 "${word}(${category})" 였습니다.`,
    feedbackDone: '피드백 고마워요! 다음 프롬프트 개선에 참고할게요.',
    feedbackTitle: ['결정적 힌트는 👍', '무쓸모 힌트는 👎', '여러 개 골라도 돼요'],
    feedbackPlaceholder: '추가로 남기고 싶은 말 (선택)',
    feedbackSending: '보내는 중…',
    feedbackRetry: '다시 시도',
    feedbackSubmit: '피드백 보내기',
    playAgain: '다시하기',
    retry: '다시 시도',
  },
  en: {
    title: 'Five Clues',
    subtitle: "Guess the word from the AI's clues.",
    nicknamePlaceholder: 'Nickname',
    start: 'Start',
    loading: 'Writing clues…',
    guessPlaceholder: 'Type your guess',
    guess: 'Guess',
    wrongTag: '[Nope, wrong]',
    recapRoundLabel: 'Round 1 clues',
    round: (n: 1 | 2) => `Round ${n}`,
    category: (c: string) => ` · Category: ${c}`,
    myGuess: (text: string) => `My guess: "${text}"`,
    resultBadge: { round1: 'Nailed it!', round2: 'Nice!', failed: 'So close!' },
    answer: (word: string, category: string) => `The answer was "${word}" (${category}).`,
    feedbackDone: "Thanks for the feedback — it'll help improve future clues.",
    feedbackTitle: ['👍 the CRUCIAL clues', '👎 the USELESS clues', 'Multiple picks OK'],
    feedbackPlaceholder: 'Anything else? (optional)',
    feedbackSending: 'Sending…',
    feedbackRetry: 'Retry',
    feedbackSubmit: 'Send feedback',
    playAgain: 'Play again',
    retry: 'Retry',
  },
} as const;

// 별도 Geo-IP 서비스 없이 브라우저 언어 설정으로 판단한다(navigator.language,
// 2026-09-17 스카이 선택). 수동으로 한 번 바꾸면 이후엔 그 값을 우선한다.
const STORAGE_KEY = 'fiveclues-lang';

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    // 프라이빗 모드 등에서 localStorage가 막혀 있을 수 있다 — 무시하고 감지로 넘어간다.
  }
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 무시 — 다음 방문 때 다시 감지될 뿐, 기능에 지장은 없다.
  }
}
