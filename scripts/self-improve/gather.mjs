#!/usr/bin/env node
// 자가개선 루프 1단계 — 'feedback' 라벨 이슈를 모은다.
// 필요: GH_TOKEN, GITHUB_REPOSITORY(Actions가 자동 주입, "owner/repo" 형식).
// 결과는 data/self-improve/feedback.json 에 쓰고, 개수를 $GITHUB_OUTPUT 의 count로
// 남긴다 — 다음 스텝이 "너무 적으면 건너뛴다"를 판단하는 데 쓴다.
//
// 고르는 순서(2026-09-26):
//   1) 사람 피드백을 먼저 — AI 자동플레이가 하루 10건씩 쌓이는데 예전엔 "가장
//      오래된 20건"만 가져와서, PR을 며칠 안 처리하면 그보다 늦게 온 사람 피드백은
//      목록에 들어오지도 못했다.
//   2) AI 피드백은 hintPrompt.ts가 main에 마지막으로 반영된 뒤에 만들어진 것만 —
//      그 전 것은 이미 고친(또는 바뀐) 프롬프트에 대한 신호라, 반영하지 않고
//      코멘트를 남겨 닫는다. 사람 피드백은 드물고 "너무 어렵다" 같은 전반적인
//      의견도 섞여 있어서 오래됐어도 계속 쓴다.
//
//   DRY=1 node scripts/self-improve/gather.mjs   네트워크 없이 배선만 확인

import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DRY = process.env.DRY === '1';
const MAX_ITEMS = 20; // 정렬 후 앞에서 20개만 넘긴다 — 토큰 예산 보호(다음 스텝용)
const FETCH_LIMIT = 100; // 사람 피드백을 놓치지 않게 넉넉히 가져온 뒤 고른다
const PROMPT_FILE = 'apps/backend/src/bot/hintPrompt.ts';
const AI_NICKNAME = 'AI자동플레이'; // apps/backend/src/bot/autoPlay.ts의 NICKNAME과 같아야 한다

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
    `https://api.github.com/repos/${REPO}/issues?labels=feedback&state=open&per_page=${FETCH_LIMIT}&sort=created&direction=asc`,
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

// hintPrompt.ts가 main에 마지막으로 반영된 시각. --first-parent라 PR로 들어온 변경은
// 머지 커밋(=머지한 시각)이 잡힌다 — PR 브랜치 커밋 시각을 쓰면 "PR은 열렸지만 아직
// 머지 전"에 옛 프롬프트로 만든 피드백을 새 것으로 착각한다. 워크플로 checkout이
// fetch-depth: 0 이어야 한다(self-improve.yml). 실패하면 필터 없이 전부 쓴다.
function promptChangedAt() {
  if (DRY) return null;
  try {
    const iso = execSync(`git log -1 --first-parent --format=%cI -- ${PROMPT_FILE}`, { encoding: 'utf8' }).trim();
    return iso ? new Date(iso) : null;
  } catch (e) {
    console.error('hintPrompt.ts 변경 시각 조회 실패 — 오래된 피드백 거르기 없이 진행:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function closeStale(number, since) {
  const headers = { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' };
  const base = `https://api.github.com/repos/${REPO}/issues/${number}`;
  await fetch(`${base}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      body: `hintPrompt.ts가 이 피드백 이후에 바뀌어서(${since.toISOString()} main 반영) 이전 프롬프트 기준 신호로 보고 반영하지 않고 닫습니다 — scripts/self-improve/gather.mjs`,
    }),
  });
  const res = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
  if (!res.ok) console.error(`#${number} 닫기 실패 ${res.status}`);
}

const issues = await listFeedbackIssues();
const parsed = issues
  .map((issue) => ({ number: issue.number, createdAt: new Date(issue.created_at ?? 0), data: parseFeedback(issue.body ?? '') }))
  .filter((x) => x.data !== null)
  // hintPrompt.ts는 한국어 프롬프트라 한국어 피드백만 반영해야 한다(2026-09-17
  // 영어 버전 추가). lang 필드가 없는 옛 이슈는 전부 영어 버전 이전 것이므로
  // 한국어로 본다 — ?? 'ko' 가 그 하위호환이다.
  .filter((x) => (x.data.lang ?? 'ko') === 'ko');

const since = promptChangedAt();
const isAi = (x) => x.data.nickname === AI_NICKNAME;
const stale = since ? parsed.filter((x) => isAi(x) && x.createdAt < since) : [];
for (const x of stale) await closeStale(x.number, since);
if (stale.length) console.log(`이전 프롬프트 기준 AI 피드백 ${stale.length}건 닫음: ${stale.map((x) => '#' + x.number).join(' ')}`);

const fresh = parsed.filter((x) => !stale.includes(x));
const items = [...fresh.filter((x) => !isAi(x)), ...fresh.filter(isAi)]
  .slice(0, MAX_ITEMS)
  .map(({ number, data }) => ({ number, data }));

await mkdir('data/self-improve', { recursive: true });
await writeFile('data/self-improve/feedback.json', JSON.stringify(items, null, 2));

console.log(`피드백 이슈 ${items.length}개 수집${DRY ? ' (DRY)' : ''}`);

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  await appendFile(outFile, `count=${items.length}\n`);
}
