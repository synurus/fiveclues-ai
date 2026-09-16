#!/usr/bin/env node
// 자가개선 루프 2단계 — gather.mjs 가 모은 피드백으로 hintPrompt.ts 를 다시 쓰고
// PR을 연다. 병합은 사람이 한다("PR 제안형" — 2026-09-15 스카이 선택).
//
// 이 스크립트가 건드리는 파일은 apps/backend/src/bot/hintPrompt.ts 하나뿐이다.
// wordGuessBot.ts 를 일부러 hintPrompt.ts 로 쪼개둔 이유가 바로 이거다 — 자동화의
// 손이 닿는 범위를 "프롬프트 문구"로 물리적으로 좁혀서, 재시도·타입·API 호출 같은
// 코드 로직은 이 스크립트가 절대 못 건드리게 한다.
//
// JSON 모드(response_format: json_object)를 안 쓰는 이유: 응답에 파일 전체(코드+
// 템플릿 리터럴 안의 JSON 예시 문자열)를 통째로 담아야 하는데, 오픈웨이트 모델이
// 그 안의 개행·따옴표를 JSON 문자열로 이스케이프하다 깨뜨릴 위험이 있다. 대신
// "===FILE===...===END===" 같은 구분자로 평문 그대로 받는다.
//
// 안전장치 4단계:
//   1) 이미 열려있는(병합 안 된) 자가개선 PR이 있으면 그 자리에서 멈춘다 — 매일
//      08시 KST(self-improve.yml) 한 번만 돌지만, 전날 PR을 아직 안 처리했으면
//      같은 피드백으로 새 PR이 또 생기는 걸 막는 백업 안전장치다. 이슈는
//      "Closes #N"으로 머지 시에만 닫히므로, 사람이 그 PR을 처리하기 전까지는
//      재실행해도 항상 여기서 끝난다.
//   2) 응답에서 뽑은 파일이 구조 가드(함수 시그니처·JSON 스키마 문구)를 통과해야 한다
//   3) apps/backend 에서 tsc --noEmit 이 통과해야 한다 — 실패하면 파일을 되돌리고 끝낸다
//   4) 그래도 병합은 사람이 한다 — PR만 열고, 피드백 이슈는 "Closes #N"으로 머지 시에만 닫힌다
//
//   DRY=1 node scripts/self-improve/propose.mjs   네트워크·git 없이 배선만 확인

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const DRY = process.env.DRY === '1';
const REPO = process.env.GITHUB_REPOSITORY ?? '';
const GH_TOKEN = process.env.GH_TOKEN;

// SELFIMPROVE_BOT_* 가 있으면 그걸 쓰고, 없으면 게임 봇과 같은 BOT_* 를 그대로 쓴다 —
// 별도 키를 안 만들어도 당장은 돌아가되, 자가개선 호출량이 게임 본체의 TPM 예산을
// 갉아먹는 게 문제가 되면 그때 SELFIMPROVE_BOT_* 를 따로 발급해 분리할 수 있다.
//
// ⚠️ ?? 가 아니라 || 를 쓴다. GitHub Actions는 존재하지 않는 시크릿을 참조해도
// 그 env 를 "빈 문자열"로 채우지 undefined 로 두지 않는다 — SELFIMPROVE_BOT_* 를
// 안 만든 레포에서도 워크플로의 env: 블록이 그 이름을 선언해두면 process.env.SELFIMPROVE_BOT_API_KEY
// 는 "" 가 된다. ??는 null/undefined 일 때만 다음으로 넘어가고 ""는 "값 있음"으로
// 쳐버려서, BOT_API_KEY를 제대로 넣어도 계속 빈 값으로 잡히는 버그가 났었다(2026-09-16).
const BASE_URL = process.env.SELFIMPROVE_BOT_BASE_URL || process.env.BOT_BASE_URL || 'https://api.groq.com/openai/v1';
const API_KEY = process.env.SELFIMPROVE_BOT_API_KEY || process.env.BOT_API_KEY || '';
const MODEL = process.env.SELFIMPROVE_BOT_MODEL || process.env.BOT_MODEL || 'openai/gpt-oss-120b';

const PROMPT_FILE = 'apps/backend/src/bot/hintPrompt.ts';
const FEEDBACK_FILE = 'data/self-improve/feedback.json';
const MAX_FEEDBACK_FOR_PROMPT = 10; // gather.mjs 는 최대 20개를 모으지만, 토큰 예산 때문에 여기선 더 줄인다.

function sh(cmd) {
  return execSync(cmd, { stdio: 'inherit' });
}
function shOut(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function loadFeedback() {
  try {
    const raw = await readFile(FEEDBACK_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// gather.mjs 가 저장한 형태: [{ number, data: FeedbackPayload }, ...]
function summarizeForPrompt(items) {
  const tally = { round1: 0, round2: 0, failed: 0 };
  const lines = items.slice(0, MAX_FEEDBACK_FOR_PROMPT).map(({ number, data }) => {
    tally[data.outcome] = (tally[data.outcome] ?? 0) + 1;
    const key = typeof data.keyHintIndex === 'number' ? (data.hints[data.keyHintIndex] ?? '?') : '없음';
    const useless = typeof data.uselessHintIndex === 'number' ? (data.hints[data.uselessHintIndex] ?? '?') : '없음';
    const comment = data.feedbackText ? ` · "${data.feedbackText}"` : '';
    return `- #${number} [${data.outcome}] "${data.word}"(${data.category}) 결정적:"${key}" 무쓸모:"${useless}"${comment}`;
  });
  const tallyLine = `집계: 1라운드에 맞음 ${tally.round1 ?? 0} · 2라운드까지 가서 맞음 ${tally.round2 ?? 0} · 실패(정답 공개) ${tally.failed ?? 0}`;
  return `${tallyLine}\n\n${lines.join('\n')}`;
}

function retryAfterMs(res, body) {
  const h = Number(res.headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return h * 1000 + 500;
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Number(m[1]) * 1000 + 500;
  return 5000;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isReasoningModel = (model) => /gpt-oss/.test(model);

async function callLlm(system, user) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.7,
    max_tokens: 6000, // 파일 전체(설명+코드)를 받아야 해서 wordGuessBot.ts 보다 여유를 크게 뒀다.
    ...(isReasoningModel(MODEL) ? { reasoning_effort: 'low', reasoning_format: 'hidden' } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    }
    const text = await res.text();
    if (res.status === 429 && attempt <= 6) {
      await sleep(retryAfterMs(res, text));
      continue;
    }
    throw new Error(`LLM 호출 실패 ${res.status}: ${text.slice(0, 300)}`);
  }
}

function buildSystemPrompt() {
  return (
    `너는 한국어 낱말 맞히기 게임의 "출제자 프롬프트 파일"을 유지보수하는 도구다.\n` +
    `아래에 현재 파일 전체(apps/backend/src/bot/hintPrompt.ts)와, 실제 플레이어 피드백을 준다.\n` +
    `피드백을 반영해 프롬프트 "문구"만 다듬어라.\n\n` +
    `[반드시 지킬 것 — 어기면 자동 검증에서 통째로 버려진다]\n` +
    `1. 파일 구조를 그대로 유지한다: 맨 위 주석(용도 설명) + ` +
    `"export function hintSystem(round: 1 | 2, category: string, hintCount: number): string {" ` +
    `시그니처 + 그 안의 template literal 하나. 이 시그니처 줄은 글자 하나도 바꾸지 마라.\n` +
    `2. import 문을 새로 추가하지 마라. 다른 export 를 추가하지 마라.\n` +
    `3. 맨 끝의 JSON 출력 스키마 줄 ` +
    `{"banned":["결정적 특징4개"],"hints":[{"text":"묘사","angle":"무엇에 대해 말했나"}]} ` +
    `의 키 이름(banned/hints/text/angle)은 절대 바꾸지 마라 — 백엔드가 이 키로 파싱한다.\n` +
    `4. round/category/hintCount 세 매개변수는 지금과 같은 방식으로 계속 써야 한다(템플릿 리터럴 안에서).\n` +
    `5. 피드백에 나온 구체적인 단어(예: "장구")에 맞춰 프롬프트를 고치지 마라 — ` +
    `이 프롬프트는 매판 다른 단어에 쓰인다. 피드백에서 읽어낼 "패턴"(예: 특정 종류의 묘사가 ` +
    `자꾸 결정적이 되더라 / 특정 종류가 자꾸 무쓸모하더라)만 반영해라.\n` +
    `6. 변경이 필요 없다고 판단되면 파일을 원문 그대로 돌려줘도 된다 — 억지로 바꾸지 마라.\n\n` +
    `[출력 형식 — 이 형식을 벗어나면 자동 파싱이 실패해 PR이 안 열린다]\n` +
    `===SUMMARY===\n(무엇을 왜 바꿨는지 한국어 2~3문장. 안 바꿨으면 "변경 없음"과 이유)\n` +
    `===FILE===\n(hintPrompt.ts 의 완성된 전체 내용. 이 마커 사이엔 파일 내용 말고 아무것도 넣지 마라)\n` +
    `===END===`
  );
}

function buildUserPrompt(currentFile, feedbackSummary) {
  return (
    `[현재 hintPrompt.ts 전체]\n${currentFile}\n\n` +
    `[플레이어 피드백 — 결정적: 그 힌트만으로 바로 맞혔다 / 무쓸모: 전혀 도움 안 됐다]\n${feedbackSummary}`
  );
}

function parseLlmResponse(text) {
  const summaryMatch = text.match(/===SUMMARY===\s*([\s\S]*?)\s*===FILE===/);
  const fileMatch = text.match(/===FILE===\s*([\s\S]*?)\s*===END===/);
  if (!summaryMatch || !fileMatch) return null;
  return { summary: summaryMatch[1].trim(), file: fileMatch[1].trim() + '\n' };
}

// 이미 병합 안 된 자가개선 PR이 있으면 그 브랜치를 반환한다(없으면 null).
// 하루 여러 번 도는 스케줄에서 같은 피드백으로 PR이 중복 생성되는 걸 막는 게
// 목적이라, 조회 자체가 실패하면(권한 문제 등) 최악의 경우 중복 PR 하나 더 생기는
// 정도로 끝나게 — 막지 않고 그냥 계속 진행한다(fail-open).
function getOpenSelfImprovePr() {
  try {
    const out = shOut(`gh pr list --repo "${REPO}" --state open --json headRefName,url`);
    const prs = JSON.parse(out);
    const found = prs.find((pr) => pr.headRefName.startsWith('self-improve/'));
    return found ?? null;
  } catch (e) {
    console.error('열려있는 PR 조회 실패 — 안전하게 계속 진행한다:', e instanceof Error ? e.message : e);
    return null;
  }
}

// 구조 가드 — 모델이 형식은 지켰지만 내용을 이상하게 바꿨을 가능성을 걸러낸다.
function structuralGuardOk(fileContent) {
  const checks = [
    fileContent.includes('export function hintSystem(round: 1 | 2, category: string, hintCount: number): string {'),
    fileContent.includes('"banned"'),
    fileContent.includes('"hints"'),
    fileContent.includes('"text"'),
    fileContent.includes('"angle"'),
    !fileContent.includes('\nimport '),
    fileContent.length > 300,
    fileContent.length < 8000,
  ];
  return checks.every(Boolean);
}

async function main() {
  if (!DRY) {
    const openPr = getOpenSelfImprovePr();
    if (openPr) {
      console.log(`이미 열려있는 자가개선 PR이 있다 — 병합되거나 닫힐 때까지 새로 안 연다: ${openPr.url}`);
      return;
    }
  }

  const feedback = await loadFeedback();
  if (feedback.length === 0) {
    console.log('처리할 피드백이 없다 — 종료.');
    return;
  }

  const currentFile = await readFile(PROMPT_FILE, 'utf8');
  const feedbackSummary = summarizeForPrompt(feedback);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(currentFile, feedbackSummary);

  let raw;
  if (DRY) {
    console.log('--- DRY: 아래 프롬프트로 LLM을 호출했을 것 ---');
    console.log(user.slice(0, 500) + (user.length > 500 ? '\n...(생략)' : ''));
    raw =
      `===SUMMARY===\n피드백에 "무쓸모" 표시가 겹친 패턴이 없어 DRY 실행에서는 변경하지 않았다.\n` +
      `===FILE===\n${currentFile.trim()}\n===END===`;
  } else {
    if (!API_KEY) {
      console.error('BOT_API_KEY(또는 SELFIMPROVE_BOT_API_KEY)가 없다.');
      process.exitCode = 1;
      return;
    }
    raw = await callLlm(system, user);
  }

  const parsed = parseLlmResponse(raw);
  if (!parsed) {
    console.error('LLM 응답 형식이 깨졌다(===SUMMARY===/===FILE===/===END=== 마커를 못 찾음). 원문:');
    console.error(raw.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  if (!structuralGuardOk(parsed.file)) {
    console.error('구조 가드 실패 — 함수 시그니처나 JSON 스키마 키가 바뀌었거나 크기가 비정상이다. PR을 열지 않는다.');
    process.exitCode = 1;
    return;
  }

  if (parsed.file.trim() === currentFile.trim()) {
    console.log('LLM이 변경 없음으로 판단했다(또는 내용이 동일하다) — PR 생략.');
    console.log(`이유: ${parsed.summary}`);
    return;
  }

  await writeFile(PROMPT_FILE, parsed.file);

  // tsc 통과 여부로 최종 게이트를 건다 — 실패하면 되돌리고 끝낸다(PR 없음).
  try {
    if (DRY) {
      console.log('DRY 모드 — tsc 검증은 건너뛴다(로컬에 backend node_modules 없을 수 있음).');
    } else {
      sh('cd apps/backend && npx tsc --noEmit');
    }
  } catch {
    console.error('tsc 검증 실패 — hintPrompt.ts 를 원래대로 되돌리고 PR을 열지 않는다.');
    await writeFile(PROMPT_FILE, currentFile);
    process.exitCode = 1;
    return;
  }

  if (DRY) {
    console.log('DRY 모드 — 여기서 git/PR 단계는 건너뛴다. hintPrompt.ts 는 실제로 덮어썼다(diff로 확인할 것).');
    console.log(`요약: ${parsed.summary}`);
    return;
  }

  const usedNumbers = feedback.slice(0, MAX_FEEDBACK_FOR_PROMPT).map((f) => f.number);
  const branch = `self-improve/${Date.now()}`;
  const prTitle = `자가개선: 출제자 프롬프트 문구 조정 (피드백 ${usedNumbers.length}건)`;
  // nickname 을 같이 보여준다 — "AI자동플레이"(scripts/self-improve/autoPlay와 짝인
  // apps/backend/src/bot/autoPlay.ts가 매기는 고정 닉네임)와 실제 플레이어 피드백을
  // 리뷰할 때 한눈에 구분하려는 것. LLM에 보내는 프롬프트 쪽(summarizeForPrompt)엔
  // 안 넣는다 — "이건 AI가 낸 피드백이니 무시해도 된다"는 식으로 모델이 편향되지
  // 않게, 내용만으로 판단하게 둔다.
  const feedbackLines = feedback
    .slice(0, MAX_FEEDBACK_FOR_PROMPT)
    .map(({ number, data }) => `- #${number} "${data.word}"(${data.category}) · ${data.outcome} · ${data.nickname || '익명'}`)
    .join('\n');
  const prBody =
    `이 PR은 \`scripts/self-improve/propose.mjs\` 가 \`feedback\` 라벨 이슈 ${usedNumbers.length}건을 바탕으로 ` +
    `\`${PROMPT_FILE}\` 을 다시 쓴 결과다. 자동 생성이지만 **병합은 사람이 한다**(tsc 통과는 확인했지만 ` +
    `실제 난이도 체감은 확인하지 않았다).\n\n` +
    `### 모델이 밝힌 변경 이유\n> ${parsed.summary.replace(/\n/g, '\n> ')}\n\n` +
    `### 반영한 피드백(${usedNumbers.length}건)\n${feedbackLines}\n\n` +
    `### 병합 전 확인할 것\n` +
    `- [ ] \`${PROMPT_FILE}\` diff를 직접 읽고 문구가 합리적인지 확인\n` +
    `- [ ] 가능하면 \`node scripts/spectate.mjs\` 로 몇 판 돌려서 체감 난이도 확인\n` +
    `- [ ] 이상하면 그냥 이 PR을 닫는다 — 다음 자가개선 실행 때 새 PR이 다시 열린다\n\n` +
    `머지하면 아래 이슈들이 자동으로 닫힌다.\n\n` +
    usedNumbers.map((n) => `Closes #${n}`).join('\n');

  sh('git config user.name "self-improve-bot"');
  sh('git config user.email "actions@users.noreply.github.com"');
  sh(`git checkout -b ${branch}`);
  sh(`git add ${PROMPT_FILE}`);
  sh(`git commit -m "자가개선: 출제자 프롬프트 문구 조정 (피드백 ${usedNumbers.length}건)"`);
  sh(`git push origin ${branch}`);

  const tmpBodyFile = 'data/self-improve/pr-body.txt';
  await writeFile(tmpBodyFile, prBody);
  const prUrl = shOut(
    `gh pr create --repo "${REPO}" --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${tmpBodyFile}" --base main --head ${branch}`,
  );
  console.log(`PR 생성 완료: ${prUrl}`);
}

if (!DRY && (!GH_TOKEN || !REPO)) {
  console.error('GH_TOKEN 또는 GITHUB_REPOSITORY 가 없다.');
  process.exitCode = 1;
} else {
  await main();
}
