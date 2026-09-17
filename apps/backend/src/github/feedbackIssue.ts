/**
 * 플레이어 피드백을 GitHub Issue로 쌓는다. Supabase가 아직 없어서(2026-09-15) DB
 * 대신 GitHub를 저장소로 쓴다 — 자가개선 워크플로(.github/workflows/self-improve.yml)가
 * 'feedback' 라벨이 붙은 이슈를 그대로 읽어서 프롬프트 수정 PR을 낸다.
 *
 * 파일 커밋(Contents API)이 아니라 Issue를 고른 이유: 동시에 여러 명이 피드백을
 * 보내도 파일 SHA 충돌이 없다 — 이슈 생성은 서로 독립적이다.
 *
 * 환경변수: GITHUB_FEEDBACK_TOKEN, GITHUB_REPO ("owner/repo")
 *   토큰은 이 레포 하나에만 Issues: write 권한을 준 fine-grained PAT를 쓸 것 —
 *   classic PAT의 repo 스코프(저장소 전체 쓰기 권한)는 이 용도엔 과하다.
 */

export interface FeedbackPayload {
  word: string;
  category: string;
  hints: string[]; // 1·2라운드 전부, 순서대로
  /** hints를 라운드별로 다시 자를 때 쓰는 길이들 — 합이 hints.length와 같다.
   *  예: [5, 5]면 hints[0..4]가 1라운드, hints[5..9]가 2라운드. 이슈 본문에서
   *  라운드 사이 구분선을 그리는 데 쓴다(2026-09-16). */
  roundHintCounts: number[];
  outcome: 'round1' | 'round2' | 'failed';
  /** 결정적이었던 힌트들의 hints 인덱스. 여러 개 고를 수 있다(2026-09-16, 말풍선
   *  하나만 고르게 강제하니 "묘사 두 개가 같이 확신을 줬다" 같은 경우를 못 담아서
   *  배열로 바꿨다). 없으면 빈 배열. */
  keyHintIndexes: number[];
  /** 전혀 도움이 안 됐던 힌트들의 인덱스. 여러 개 가능, 없으면 빈 배열. */
  uselessHintIndexes: number[];
  feedbackText: string;
  nickname: string;
  /** 'ko'|'en'. 2026-09-17 영어 버전 추가 — gather.mjs가 이 값으로 한국어
   *  피드백만 골라 propose.mjs(hintPrompt.ts 자가개선)에 넘긴다. 영어 힌트
   *  프롬프트(hintPromptEn.ts)는 아직 이 루프 대상이 아니라서다. */
  lang: 'ko' | 'en';
  /** 실제로 뭐라고 추측했는지, 라운드마다 하나씩 순서대로 — roundHintCounts와 길이가
   *  같다. 실제 플레이어 피드백(routes/game.ts의 /feedback)도 결과 화면이 라운드별
   *  추측을 들고 있어서(2026-09-16) 채워 보낸다. AI 자동플레이(bot/autoPlay.ts)도
   *  항상 채운다 — "힌트는 괜찮았는데 헛짚었다"와 "힌트 자체가 안 좋았다"를 이슈만
   *  보고도 구분하려는 것. */
  guesses: string[];
}

// hints를 roundHintCounts 길이대로 잘라 라운드별 배열로 되돌린다. roundHintCounts가
// 비었거나 합이 안 맞으면(방어적으로) 한 라운드로 취급 — 렌더링이 깨지진 않게.
function splitByRound(hints: string[], roundHintCounts: number[]): string[][] {
  const total = roundHintCounts.reduce((a, b) => a + b, 0);
  if (roundHintCounts.length === 0 || total !== hints.length) return [hints];
  const rounds: string[][] = [];
  let offset = 0;
  for (const count of roundHintCounts) {
    rounds.push(hints.slice(offset, offset + count));
    offset += count;
  }
  return rounds;
}

// 이슈 본문 인트로에 라운드별 힌트 + 그 라운드에 뭐라고 추측했는지·맞았는지를
// 구분선(────)으로 나눠 보여준다(2026-09-16) — 예전엔 "추측: A → B" 한 줄만 있어서
// 어떤 힌트를 보고 그 추측을 했는지 이슈만 봐서는 알 수 없었다.
function buildHintLog(data: FeedbackPayload): string {
  const rounds = splitByRound(data.hints, data.roundHintCounts);
  return rounds
    .map((hints, i) => {
      const guess = data.guesses[i] ?? '(기록 없음)';
      const isLastRound = i === rounds.length - 1;
      const wrong = !(isLastRound && data.outcome !== 'failed');
      const hintLines = hints.map((h) => `- ${h}`).join('\n');
      return `${hintLines}\n→ 추측 "${guess}" (${wrong ? '오답' : '정답'})`;
    })
    .join('\n\n────────────\n\n');
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`환경변수 ${name} 이(가) 없습니다.`);
  return value;
}

export async function createFeedbackIssue(data: FeedbackPayload): Promise<{ issueNumber: number }> {
  const token = required('GITHUB_FEEDBACK_TOKEN', process.env.GITHUB_FEEDBACK_TOKEN);
  const repo = required('GITHUB_REPO', process.env.GITHUB_REPO);

  // 이슈 목록에서 피드백 코멘트를 바로 볼 수 있게 제목에도 넣는다(2026-09-16) —
  // 개행은 공백으로 뭉개고 40자 넘으면 자른다(제목 줄이 길어지는 걸 막는 용도라
  // GitHub 제목 길이 한도 자체는 훨씬 넉넉하다).
  const titleComment = data.feedbackText.replace(/\s+/g, ' ').trim();
  const titleCommentPart = titleComment
    ? ` · "${titleComment.length > 40 ? `${titleComment.slice(0, 40)}…` : titleComment}"`
    : '';
  const title = `[feedback]${data.lang === 'en' ? ' [EN]' : ''} ${data.word} · ${data.outcome}${titleCommentPart}`;
  const keyText = data.keyHintIndexes.map((i) => data.hints[i]).filter(Boolean);
  const uselessText = data.uselessHintIndexes.map((i) => data.hints[i]).filter(Boolean);
  // 본문은 사람이 Issues 탭에서 읽을 요약(라운드별 힌트+추측 로그 포함) + self-improve/
  // gather.mjs 가 그대로 파싱하는 JSON 코드블록. JSON 코드블록의 ```json\n...\n``` 형식만
  // 안 바꾸면 되고(gather.mjs 정규식이 그것만 본다), 그 위 요약 텍스트는 자유롭게 바꿔도
  // 된다 — guesses/roundHintCounts는 JSON 쪽에도 그대로 담겨 있다.
  const body =
    `${data.nickname || '(닉네임 없음)'} · ${data.category} · ${data.outcome}` +
    `\n\n${buildHintLog(data)}` +
    (keyText.length ? `\n\n결정적: ${keyText.map((t) => `"${t}"`).join(', ')}` : '') +
    (uselessText.length ? `\n무쓸모: ${uselessText.map((t) => `"${t}"`).join(', ')}` : '') +
    (data.feedbackText ? `\n\n> ${data.feedbackText}` : '') +
    '\n\n```json\n' +
    JSON.stringify(data, null, 2) +
    '\n```';

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: ['feedback'] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Issue 생성 실패 ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { number: number };
  return { issueNumber: json.number };
}
