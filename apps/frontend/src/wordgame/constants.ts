// 닉네임 최대 글자수. roomConfig.ts(옛 팀 실시간 게임, 삭제됨)에 있던 값을 옮겼다.
// 서버(routes/game.ts의 MAX_NICKNAME_LEN)는 이보다 넉넉한 상한으로 한 번 더 자른다 —
// 화면을 거치지 않은 요청이 긴 닉네임을 공개 이슈에 싣지 못하게(2026-09-28).
export const NAME_MAX_LENGTH = 6;
