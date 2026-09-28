/**
 * 턴제 게임의 라운드 사이 상태를 담는 세션 토큰.
 *
 * 이 프로젝트는 DB를 쓰지 않는다(CLAUDE.md — 2026-09-16 확정). 제시어를 서버가 들고
 * 있어야 하는데 서버는 매 요청마다 새로 뜨는 걸 전제해야 한다(Vercel 서버리스) —
 * 그래서 클라이언트가 상태를 들고 다니되, 제시어가 보이면 안 되니 서명이 아니라
 * **암호화**한다(AES-256-GCM).
 *
 * 발급 시각(iat)을 같이 넣고 decodeSession()이 유효 시간을 검사한다(2026-09-28) —
 * 만료가 없으면 1라운드 토큰 하나로 /guess를 끝없이 보내 매번 2라운드 묘사(LLM
 * 호출)를 새로 만들게 할 수 있어서, 무료 한도를 소진시키는 통로가 됐다.
 */

import crypto from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/** 게임 진행용 세션 토큰의 기본 유효 시간. 한 판은 길어야 몇 분이다. */
export const SESSION_TTL_MS = 30 * 60_000;

function loadKey(): Buffer {
  const secret = process.env.GAME_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      '환경변수 GAME_TOKEN_SECRET 이(가) 없습니다.\n' +
        '  openssl rand -base64 32   로 만든 값을 apps/backend/.env 에 넣으세요.',
    );
  }
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) {
    throw new Error('GAME_TOKEN_SECRET 은 base64로 인코딩된 32바이트여야 합니다 (openssl rand -base64 32).');
  }
  return key;
}

export class InvalidSessionError extends Error {}
export class SessionExpiredError extends InvalidSessionError {}

export function encodeSession<T>(payload: T): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const plain = JSON.stringify({ v: payload, iat: Date.now() });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

export function decodeSession<T>(token: string, maxAgeMs: number = SESSION_TTL_MS): T {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new InvalidSessionError('세션이 손상됐습니다.');
  }
  const iv = raw.subarray(0, IV_LEN);
  const authTag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  let parsed: { v?: T; iat?: unknown };
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    parsed = JSON.parse(plain.toString('utf8')) as { v?: T; iat?: unknown };
  } catch {
    throw new InvalidSessionError('세션이 손상됐거나 위조됐습니다.');
  }
  // iat가 없는 건 이 형식 이전(2026-09-28 전)에 발급된 토큰 — 만료로 본다.
  if (typeof parsed.iat !== 'number' || parsed.v === undefined || Date.now() - parsed.iat > maxAgeMs) {
    throw new SessionExpiredError('세션이 만료됐습니다.');
  }
  return parsed.v;
}
