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
  outcome: 'round1' | 'round2' | 'failed';
  keyHintIndex: number | null; // hints 인덱스. "없음"이면 null
  uselessHintIndex: number | null;
  feedbackText: string;
  nickname: string;
  /** 실제로 뭐라고 추측했는지, 순서대로(라운드마다 하나). 실제 플레이어 피드백(routes/game.ts
   *  의 /feedback)엔 없어서 빈다 — 사람 플레이어의 추측은 /guess 판정 시점에만 오가고
   *  결과 화면 피드백엔 따로 안 남긴다. AI 자동플레이(bot/autoPlay.ts)는 항상 채워서
   *  보낸다 — "힌트는 괜찮았는데 AI가 헛짚었다"와 "힌트 자체가 안 좋았다"를 이슈만
   *  보고도 구분하려는 것(2026-09-16, 파일럿/직업 오답 사례에서 필요해짐). */
  guesses?: string[];
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`환경변수 ${name} 이(가) 없습니다.`);
  return value;
}

export async function createFeedbackIssue(data: FeedbackPayload): Promise<{ issueNumber: number }> {
  const token = required('GITHUB_FEEDBACK_TOKEN', process.env.GITHUB_FEEDBACK_TOKEN);
  const repo = required('GITHUB_REPO', process.env.GITHUB_REPO);

  const title = `[feedback] ${data.word} · ${data.outcome}`;
  // 본문은 사람이 Issues 탭에서 읽을 요약 한 줄 + self-improve/gather.mjs 가 그대로
  // 파싱하는 JSON 코드블록. 형식을 바꾸면 gather.mjs의 정규식도 같이 고쳐야 한다.
  const body =
    `${data.nickname || '(닉네임 없음)'} · ${data.category} · ${data.outcome}` +
    (data.guesses?.length ? `\n추측: ${data.guesses.join(' → ')}` : '') +
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
