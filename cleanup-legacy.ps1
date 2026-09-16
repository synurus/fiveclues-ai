# 팀 프로젝트(실시간 라이어게임) 시절 코드/문서를 삭제하는 일회성 스크립트.
# 리포 루트에서 실행: powershell -ExecutionPolicy Bypass -File .\cleanup-legacy.ps1
# 다 지우고 나면 이 파일 자체도 지워도 된다.

$root = $PSScriptRoot

$paths = @(
  # apps/backend — 옛 실시간 서버·봇·DB 코드
  "apps\backend\src\index.ts",
  "apps\backend\src\room.ts",
  "apps\backend\src\stateMachine.ts",
  "apps\backend\src\timer.ts",
  "apps\backend\src\view.ts",
  "apps\backend\src\vote.ts",
  "apps\backend\src\turnServer.ts",
  "apps\backend\src\bot\admin-route.ts",
  "apps\backend\src\bot\index.ts",
  "apps\backend\src\bot\llm.ts",
  "apps\backend\src\bot\playground.ts",
  "apps\backend\src\bot\prompts.ts",
  "apps\backend\src\bot\refine-log.json",
  "apps\backend\src\bot\replay.ts",
  "apps\backend\src\bot\set-provider.ts",
  "apps\backend\src\bot\talk.ts",
  "apps\backend\src\db",
  "apps\backend\src\data",

  # apps/frontend — 옛 실시간 게임 화면·컴포넌트·훅
  "apps\frontend\src\App.tsx",
  "apps\frontend\src\LandingScreen.tsx",
  "apps\frontend\src\LobbyScreen.tsx",
  "apps\frontend\src\ResultScreen.tsx",
  "apps\frontend\src\RoomListScreen.tsx",
  "apps\frontend\src\SurveyScreen.tsx",
  "apps\frontend\src\types.ts",
  "apps\frontend\src\roomConfig.ts",
  "apps\frontend\src\components\Ambience.tsx",
  "apps\frontend\src\components\Avatar.tsx",
  "apps\frontend\src\components\avatarInitial.ts",
  "apps\frontend\src\components\Chat.tsx",
  "apps\frontend\src\components\FullscreenButton.tsx",
  "apps\frontend\src\components\Modal.tsx",
  "apps\frontend\src\components\ParticleTrail.tsx",
  "apps\frontend\src\components\Timer.tsx",
  "apps\frontend\src\components\VotePanel.tsx",
  "apps\frontend\src\hooks",
  "apps\frontend\src\mock",
  "apps\frontend\src\net",
  "apps\frontend\src\screens",
  "apps\frontend\src\styles\ambience.css",
  "apps\frontend\src\styles\roomList.css",

  # apps/frontend/public — 팀(Zeteo) 브랜딩·AdSense 잔재
  "apps\frontend\public\about.html",
  "apps\frontend\public\ads.txt",
  "apps\frontend\public\privacy.html",
  "apps\frontend\public\zeteo-logo.png",
  "apps\frontend\public\zeteo-o.png",

  # 루트 — 안 쓰는 패키지/DB 스키마/API 테스트 컬렉션
  "packages",
  "db_setup",
  "postman",

  # docs — v1 기획서, 팀 인수인계 문서, 옛 DB ERD
  "docs\게임기획서.md",
  "docs\기획서",
  "docs\파트B_인수인계.md",
  "docs\DB_ERD.html"
)

$removed = 0
$missing = 0
foreach ($p in $paths) {
  $full = Join-Path $root $p
  if (Test-Path $full) {
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host "삭제: $p"
    $removed++
  } else {
    Write-Host "(이미 없음) $p"
    $missing++
  }
}

Write-Host ""
Write-Host "완료 — 삭제 $removed, 이미 없던 것 $missing"
Write-Host "package.json이 바뀌었으니 'npm install'을 한 번 더 실행해 lockfile을 갱신하세요."
