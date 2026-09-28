import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.GAME_TOKEN_SECRET = crypto.randomBytes(32).toString('base64');

import { encodeSession, decodeSession, InvalidSessionError, SessionExpiredError } from './gameToken';

test('암호화한 값을 그대로 되돌린다', () => {
  const token = encodeSession({ word: '카메라', n: 1 });
  assert.deepEqual(decodeSession(token), { word: '카메라', n: 1 });
  assert.equal(token.includes('카메라'), false);
});

test('글자 하나만 바꿔도 위조로 거부한다', () => {
  const token = encodeSession({ word: '카메라' });
  const i = token.length - 5;
  const tampered = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
  assert.throws(() => decodeSession(tampered), InvalidSessionError);
  assert.throws(() => decodeSession('짧음'), InvalidSessionError);
});

test('유효 시간이 지나면 만료로 거부한다', () => {
  const token = encodeSession({ word: '카메라' });
  assert.throws(() => decodeSession(token, -1), SessionExpiredError);
  assert.deepEqual(decodeSession(token, 60_000), { word: '카메라' });
});
