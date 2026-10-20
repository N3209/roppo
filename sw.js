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

const VERSION = 'v107';
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

// 無くても読める。取れなくてもこの版は入れる。
const OPTIONAL = [
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

    // 画面遷移。この版の index.html を返す。
    if (req.mode === 'navigate') {
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
