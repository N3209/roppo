'use strict';

/*
 * アプリ本体をキャッシュして、サーバーが無くても起動できるようにする。
 *
 * 法令そのものはここでは扱わない。取り込んだ法令は IndexedDB にあるので、
 * すでにオフラインで読める。ここで面倒を見るのは「アプリの殻」だけである。
 *
 * e-Gov API への通信には一切触らない。キャッシュすると、取り込んだつもりで
 * 古い条文が返る事故が起きる。法令の鮮度はアプリ側が責任を持つ。
 *
 * 殻は版ごと丸ごと入れ替える。これが一番大事な決めごとである。
 *
 *   ・版ごとに別のキャッシュを作り、そこから「だけ」返す
 *   ・有効な版のキャッシュを裏で書き換えない
 *   ・必須のファイルが1つでも取れなければ、その版は入れない
 *
 * 裏で書き換えると、新しい index.html と古い view.js のような組み合わせが
 * できる。HTML の構造と JS の期待がずれると、起動そのものが壊れる。
 * 必須ファイルの取りこぼしを許すと、中途半端な版が有効になり、
 * activate が動いていた古い版を消してしまう。オフラインで開けなくなる。
 *
 * 切り替えの合図はページから来る。勝手に切り替えると、書きかけのメモを
 * 抱えたまま読み込み直すことになるため、断りなしには行わない。
 */

const VERSION = 'v124';
const CACHE = 'roppo-shell-' + VERSION;

// 欠けると起動しないもの。全部そろって初めてこの版を入れる。
const REQUIRED = [
  './',
  './index.html',
  './core.js',
  './render.js',
  './annot.js',
  './find.js',
  './sync.js',
  './view.js',
  './pack.js',
  './version-migration.js',
  './version-migration-view.js',
  './boot.js',
  './style.css',
  './manifest.webmanifest',
];

/*
 * アプリとは別に立っているページ。同意画面から直接来る。
 *
 * **キャッシュに無ければ、網から取る。** 取れなくても起動させる（下の
 * OPTIONAL に入れてある）ので、入れ損なうことがある。そのとき画面遷移の枝が
 * index.html に落とすと、**網が繋がっていてもアプリの画面が出る**
 * （Codex の指摘 P2-3）。ポリシーを読もうとした人に別のものを見せることに
 * なるので、この2本だけは網を先に試す。
 *
 * **下の OPTIONAL にも同じものを並べてある。** 一本化して展開（spread）で
 * 書いたら、manifest-check の listOf は綴りをそのまま拾う作りなので、
 * **この2本が配布一覧との照合から外れた。** 二度書いて、揃っていることを
 * test.js で検める方にした。
 */
const PAGES = [
  './privacy.html',
  './terms.html',
];

// 無くても読める。取れなくてもこの版は入れる。
const OPTIONAL = [
  /*
   * ポリシーと規約。取れなくても起動する（アプリは読み込まない）。
   * ただし圏外でも読めた方がよいので、入れておく。
   */
  './privacy.html',
  './terms.html',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // 1つでも欠けたらここで例外を投げる。install が失敗すればこの版は
    // 有効にならず、いま動いている版がそのまま残る。
    await Promise.all(REQUIRED.map(async url => {
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error('必須ファイルを取得できません: ' + url + ' (' + res.status + ')');
      await cache.put(url, res);
    }));

    await Promise.all(OPTIONAL.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (err) {
        console.warn('キャッシュできませんでした', url, err);
      }
    }));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('roppo-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  // ページから「切り替えてよい」と言われたときだけ待機を解く
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // e-Gov API には触らない

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    /*
     * 画面遷移。
     *
     * **その住所そのものが殻に入っていれば、それを返す。** 以前は住所を見ずに
     * 必ず index.html を返していたので、プライバシーポリシーと利用規約を開くと
     * アプリの画面に飛ばされた。配信は正しいのに、端末の中で差し替えられていた
     * （curl は Service Worker を通らないので、配信を見ても気づけない）。
     *
     * 見つからないときだけ index.html に落とす。打ち間違いで 404 を見せるより、
     * アプリが開く方がよい。
     */
    if (req.mode === 'navigate') {
      const here = await cache.match(req, { ignoreSearch: true });
      if (here) return here;

      /*
       * **独り立ちしたページは、アプリに落とさない。** 入れ損なっていても
       * 網から取れるなら取る。取れなければ、アプリを出すより素直に断る。
       */
      const isPage = PAGES.some(u => url.pathname.endsWith(u.replace('./', '/')));
      if (isPage) {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            try { await cache.put(req, res.clone()); } catch (err) { /* 置けなくても返す */ }
            return res;
          }
        } catch (err) { /* 下で断る */ }
        return new Response(
          'このページをいま表示できません。オンラインでもう一度お試しください。',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      const hit = (await cache.match('./index.html')) || (await cache.match('./'));
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        return new Response('オフラインです', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }

    // 殻のファイル。この版のキャッシュからだけ返す。裏で取り直さない。
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    // この版に含まれていないもの（後から足したファイルなど）は素通しする。
    // 有効な版のキャッシュには入れない。新旧が混ざるのを避けるためである。
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('', { status: 504 });
    }
  })());
});
