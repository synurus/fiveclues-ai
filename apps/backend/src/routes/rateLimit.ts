/**
 * 접속 주소(IP)별 요청 횟수 제한(2026-09-28). 게임 API는 로그인 없이 누구나 부를 수
 * 있어서, 스크립트로 /game/start를 반복 호출하면 무료 AI 한도(Groq 하루 토큰, 제미나이
 * 하루 요청 수)가 바닥나 실제 플레이어의 게임이 멈춘다.
 *
 * DB를 안 쓰는 구조라 카운터는 함수 인스턴스 메모리에만 있다 — 서버리스 인스턴스가
 * 여러 개 뜨거나 새로 뜨면 따로 센다. 그래서 완벽한 차단이 아니라 "한 곳에서 몰아치는
 * 호출"을 늦추는 1차 방어다. 더 강하게 막으려면 Vercel 방화벽 규칙을 같이 쓸 것.
 * IP는 1분 창 동안 횟수를 세는 데만 쓰고 어디에도 저장·기록하지 않는다.
 */

import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

// Vercel은 x-forwarded-for를 실제 접속 주소로 덮어쓴다(클라이언트가 보낸 값을 믿지 않음).
// 로컬 개발에선 헤더가 없어서 소켓 주소를 쓴다.
function clientKey(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function sweep(now: number): void {
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  // 그래도 넘치면(짧은 시간에 주소가 아주 많이 몰림) 통째로 비운다 — 메모리를 지키는 게 우선.
  if (buckets.size > MAX_BUCKETS) buckets.clear();
}

/** name별로 따로 센다 — 창(windowMs) 안에서 limit번을 넘으면 429. */
export function rateLimit(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > MAX_BUCKETS / 2) sweep(now);
    const key = `${name}:${clientKey(req)}`;
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    b.count += 1;
    if (b.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', code: 'rate_limited' });
      return;
    }
    next();
  };
}

/** 테스트용 — 카운터를 비운다. */
export function resetRateLimits(): void {
  buckets.clear();
}
