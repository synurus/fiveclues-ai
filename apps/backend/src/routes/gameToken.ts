/**
 * 턴제 게임의 라운드 사이 상태를 담는 세션 토큰.
 *
 * Supabase 프로젝트가 아직 없어서(2026-09-15 시점) DB 없이 판을 진행할 방법이
 * 필요했다. 제시어를 서버가 들고 있어야 하는데 서버는 매 요청마다 새로 뜨는 걸
 * 전제해야 한다(Vercel Functions 배포 예정) — 그래서 클라이언트가 상태를 들고
 * 다니되, 제시어가 보이면 안 되니 서명이 아니라 **암호화**한다(AES-256-GCM).
 *
 * DB로 옮기게 되면 SessionPayload 를 games 테이블 row로 옮기고 이 파일은 세션
 * 발급을 "row id 하나 돌려주기"로 바꾸면 된다 — 호출부(routes/game.ts)는 그대로.
 */

import crypto from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

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

export function encodeSession<T>(payload: T): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

export function decodeSession<T>(token: string): T {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new InvalidSessionError('세션이 손상됐습니다.');
  }
  const iv = raw.subarray(0, IV_LEN);
  const authTag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    throw new InvalidSessionError('세션이 손상됐거나 위조됐습니다.');
  }
}
