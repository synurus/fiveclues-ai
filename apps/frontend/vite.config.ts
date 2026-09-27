import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 게임(index.html) 말고 정적 콘텐츠 페이지들(2026-09-27, 애드센스 "가치가 별로 없는
// 콘텐츠" 대응). 자바스크립트 없이도 글이 읽혀야 해서 React 라우트가 아니라 HTML
// 파일 자체로 둔다(Vite 멀티 페이지). 새 페이지를 추가하면 여기, public/sitemap.xml,
// 루트 vercel.json의 rewrites(guides/·en/ 아래는 패턴으로 이미 처리됨)를 같이 볼 것.
const CONTENT_PAGES = [
  'how-to-play',
  'about',
  'privacy',
  'terms',
  'contact',
  'guides',
  'guides/category-tips',
  'guides/puzzle-review-1',
  'guides/puzzle-review-2',
  'guides/dev-copied-examples',
  'guides/dev-answer-judging',
  'guides/dev-free-tier',
  'en/how-to-play',
  'en/about',
  'en/privacy',
  'en/terms',
  'en/contact',
];

const root = fileURLToPath(new URL('.', import.meta.url));

// /about → /about.html. 배포(Vercel)에선 vercel.json의 rewrites가 같은 일을 한다 —
// 이건 로컬 vite dev/preview에서도 같은 주소로 열리게 하려는 것. (vercel.json의
// cleanUrls는 안 쓴다 — 모든 .html을 확장자 없는 주소로 리다이렉트해서, 그대로
// 열려야 하는 Search Console 인증 파일 public/google*.html까지 리다이렉트된다.)
function cleanUrls(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const [pathname, query] = (req.url ?? '').split('?');
    const page = pathname.replace(/^\/|\/$/g, '');
    if (CONTENT_PAGES.includes(page)) req.url = `/${page}.html${query ? `?${query}` : ''}`;
    next();
  };
  return {
    name: 'fiveclues-clean-urls',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

// 페이지마다 똑같이 반복되는 머리말·상단 바·푸터를 partials/*.html 한 곳에 두고,
// HTML 안의 <!-- @이름 --> 자리에 빌드(와 dev) 때 끼워 넣는다. 끼워 넣은 뒤 그
// 페이지 자신을 가리키는 메뉴 링크엔 aria-current="page"를 붙인다(현재 위치 강조).
// order: 'pre'라 끼워 넣은 <link href="/src/...css">도 Vite가 평소처럼 번들한다.
function sitePartials(): Plugin {
  const partialsDir = path.join(root, 'partials');
  return {
    name: 'fiveclues-partials',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const rel = path.relative(root, ctx.filename).replace(/\\/g, '/').replace(/\.html$/, '');
        const here = rel === 'index' ? '/' : `/${rel}`;
        return html.replace(/<!--\s*@([\w-]+)\s*-->/g, (_, name: string) => {
          const partial = fs.readFileSync(path.join(partialsDir, `${name}.html`), 'utf8').trimEnd();
          return here === '/' ? partial : partial.replace(`href="${here}"`, `href="${here}" aria-current="page"`);
        });
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cleanUrls(), sitePartials()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([
        ['main', `${root}index.html`],
        ...CONTENT_PAGES.map((p) => [p.replace(/\//g, '-'), `${root}${p}.html`]),
      ]),
    },
  },
  server: {
    proxy: {
      // 턴제 게임 API(apps/backend/src/server.ts, 기본 3000번). Vercel 배포에서는
      // /game/* 요청이 vercel.json의 rewrites로 서버리스 함수(api/index.ts)로
      // 바로 가므로 이 프록시가 필요 없다 — 로컬 개발(vite dev + npm run dev:api)
      // 전용이다.
      '/game': { target: 'http://localhost:3000' },
    },
  },
});
