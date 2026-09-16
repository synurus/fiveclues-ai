#!/usr/bin/env node
// 자가개선 루프 1단계 — 'feedback' 라벨 이슈를 모은다.
// 필요: GH_TOKEN, GITHUB_REPOSITORY(Actions가 자동 주입, "owner/repo" 형식).
// 결과는 data/self-improve/feedback.json 에 쓰고, 개수를 $GITHUB_OUTPUT 의 count로
// 남긴다 — 다음 스텝이 "너무 적으면 건너뛴다"를 판단하는 데 쓴다.
//
//   DRY=1 node scripts/self-improve/gather.mjs   네트워크 없이 배선만 확인

import { writeFile, mkdir, appendFile } from 'node:fs/promises';

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DRY = process.env.DRY === '1';
const MAX_ITEMS = 20; // 밀려 있어도 최근 20개만 본다 — 토큰 예산 보호(다음 스텝용)

async function listFeedbackIssues() {
  if (DRY) {
    return [
      {
        number: 1,
        body:
          '더미 · 동물 · round2\n\n> 힌트가 너무 어려웠어요\n\n```json\n' +
          JSON.stringify({
            word: '장구',
            category: '악기',
            hints: ['통이 둘로 나뉘어', '치는 손이 다르면 소리도 다르다', '전통 혼례에 자주 쓰였다'],
            outcome: 'round2',
            keyHintIndexes: [1],
            uselessHintIndexes: [0],
            feedbackText: '두 번째 힌트가 결정적이었어요',
            nickname: '더미',
          }) +
          '\n```',
      },
    ];
  }
  if (!TOKEN || !REPO) {
    console.error('GH_TOKEN 또는 GITHUB_REPOSITORY 가 없습니다.');
    process.exit(1);
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/issues?labels=feedback&state=open&per_page=${MAX_ITEMS}&sort=created&direction=asc`,
    { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) {
    throw new Error(`이슈 목록 조회 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function parseFeedback(issueBody) {
  const m = issueBody.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const issues = await listFeedbackIssues();
const items = issues
  .map((issue) => ({ number: issue.number, data: parseFeedback(issue.body ?? '') }))
  .filter((x) => x.data !== null);

await mkdir('data/self-improve', { recursive: true });
await writeFile('data/self-improve/feedback.json', JSON.stringify(items, null, 2));

console.log(`피드백 이슈 ${items.length}개 수집${DRY ? ' (DRY)' : ''}`);

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  await appendFile(outFile, `count=${items.length}\n`);
}
