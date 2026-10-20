'use strict';

/* =========================================================================
   六法 — e-Gov 法令API を直接読む、端末内完結の法令ビューア

   アンカー（注釈の位置識別子）の形:
     <scope>/<条>/<項>/<号>       末尾の空要素は省略する
     scope は本則が "M"、附則が "S1" "S2" …
     条番号は e-Gov の Article@Num をそのまま使う（枝番は "3_2" = 第三条の二）
   例: M/709      民法709条
       M/709/1    同1項
       M/398_2/2/3  第三百九十八条の二 第2項 第3号
       S1//3      附則1 第3項（条を介さず項が並ぶ場合は条の位置を空にする）
   ========================================================================= */

const API = 'https://laws.e-gov.go.jp/api/2';

/*
 * いま動いている版。sw.js の VERSION と同じ値を入れる。
 *
 * 不具合を追うたびに「手元はどの版か」が分からず、何度も回り道をした。
 * 画面に出しておけば一目で分かる。publish.js が sw.js と食い違っていないかを
 * 確かめるので、片方だけ上げ忘れることはない。
 */
const APP_VERSION = 'v108';


/*
 * 分割の覚え書き。
 *
 * ここは 分割前の app.js の次の節を、順を変えずに集めたものである。
 *
 *   小道具 / IndexedDB / e-Gov API / アプリ状態 / 消した印
 *   同期：運ぶ形と検証 / 同期：版 / 同期：マージの核
 *
 * 後ろ3つは見出しが「同期」だが、置き場所はここである。墓石・版番形・
 * 検証・マージは同期だけのものではなく、注釈の保存と改正の引き継ぎからも
 * 呼ばれる。sync.js に入れると、同期でない機能が同期に依存することになる。
 * （厳密な層分けができたわけではない。records 層を作るのは別の変更）
 *
 * このファイルが最初に読み込まれる。ここから後ろのファイルの関数を呼ぶ
 * ものはあるが、すべて関数の中なので、読み込み時には走らない。
 * トップレベルで値を組み立てているのは store(applyBulk) と state だけで、
 * どちらも参照先を同じファイルに持っている。
 */
/* ---------------------------------------------------------------- 小道具 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** 検索用の正規化。全角・半角や大小の違いを吸収する。 */
function normalize(s) {
  return String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

const KANJI_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT = { 十: 10, 百: 100, 千: 1000 };
const NUM_SRC = '(\\d+|[〇零一二三四五六七八九十百千]+)';

/** 漢数字を算用数字に。「七百九」も「七〇九」も通す。 */
function kanjiToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!s || [...s].some(c => !(c in KANJI_DIGIT) && !(c in KANJI_UNIT))) return NaN;
  if (![...s].some(c => c in KANJI_UNIT)) {
    let n = 0;                       // 位取り表記（七〇九）
    for (const c of s) n = n * 10 + KANJI_DIGIT[c];
    return n;
  }
  let total = 0, cur = 0;
  for (const c of s) {
    if (c in KANJI_DIGIT) cur = cur * 10 + KANJI_DIGIT[c];
    else { total += (cur || 1) * KANJI_UNIT[c]; cur = 0; }
  }
  return total + cur;
}

/**
 * 枝番は「第398条の2」の語順にする（「第398の2条」では読みにくい）。
 * e-Gov は削除された条の範囲を "170:174" の形で表すので、それも展開する。
 */
function numLabel(num, unit) {
  const s = String(num);
  if (s.includes(':')) return s.split(':').map(x => numLabel(x, unit)).join('〜');
  const parts = s.split('_');
  return '第' + parts[0] + unit + parts.slice(1).map(p => 'の' + p).join('');
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';
const toFullWidth = n => String(n).replace(/\d/g, d => FULLWIDTH_DIGITS[+d]);

/** ①〜㊿。範囲外は null。 */
function circledNum(n) {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCharCode(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCharCode(0x32b1 + n - 36);
  return null;
}

/**
 * 項番号の表示文字を決める。第1項は表示しないのが慣例。
 *
 * e-Gov の <ParagraphNum> は法令によって空になる。空になるのは Paragraph@OldNum="true"
 * が付いた古い法令で、その場合の正式な表記は丸数字（②③④）である。
 * 公的機関が配布している法令集の印刷物と突き合わせて確認した：
 *   刑訴220条・憲法9条・労基法32条 → ②③④
 *   民法715条・刑法36条・会社法423条 → ２３４（ParagraphNum に文字が入っている）
 * <ParagraphNum> に文字がある場合は常に全角数字で、丸数字が入ることはない。
 */
function paragraphNumLabel(pnumText, num, oldNum) {
  if (pnumText) return pnumText;
  const n = parseInt(num, 10);
  if (!Number.isFinite(n) || n < 2) return '';
  return oldNum ? (circledNum(n) || toFullWidth(n)) : toFullWidth(n);
}

/**
 * "170:174" のような範囲に n が含まれるか。
 * 枝番（"174_2"）は範囲に含めない。parseInt だと "174_2" が 174 になり、
 * 存在しない第174条の2を「削除された範囲」へ誤って案内してしまう。
 */
function numInRange(num, n) {
  const parts = String(num).split(':');
  if (parts.length !== 2) return false;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(String(n))) return false;
  const v = Number(n);
  return v >= Number(parts[0]) && v <= Number(parts[1]);
}

function anchorLabel(anchor) {
  const parts = anchor.split('/');
  const units = ['条', '項', '号'];
  if (/^AP\d+$/.test(parts[0])) return '別表' + parts[0].slice(2);
  if (parts[0] === 'M/前文' || anchor === 'M/前文') return '前文';
  let s = parts[0] === 'M' ? '' : '附則' + parts[0].slice(1) + ' ';
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i]) continue;
    s += numLabel(parts[i], units[i - 1] || '');
  }
  return s;
}

/* ------------------------------------------------------------ IndexedDB */

const DB_NAME = 'roppo';
const DB_VER = 4;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('laws')) {
        db.createObjectStore('laws', { keyPath: 'lawId' });
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'key' });
        s.createIndex('lawId', 'lawId', { unique: false });
        s.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
      // v2: 文言そのものに付ける注釈
      if (!db.objectStoreNames.contains('ranges')) {
        const s = db.createObjectStore('ranges', { keyPath: 'id' });
        s.createIndex('lawId', 'lawId', { unique: false });
      }
      /*
       * v3: 法令の見出しだけを別に持つ。
       *
       * 一覧を作るために getAll('laws') を使っていたが、これは XML 込みで
       * 全レコードを読む。名前を並べるためだけに、民法1.6MB・会社法2.2MB
       * …と数MBを読み出して捨てていた。法令を足すほど起動が遅くなる。
       * 見出しだけの小さな記録を別に置き、一覧はそちらを読む。
       */
      /*
       * v4: 同期の対象になるものを IndexedDB に集める。
       *
       * 法令の並び順は localStorage にあった。しかし同期では、注釈と並び順を
       * 「まとめて確定する」必要がある（片方だけ入った状態を残さない）。
       * localStorage は IndexedDB のトランザクションに入れられないので、
       * 同じ入れ物に移す。localStorage に残るのは表示設定だけになる。
       *
       * キーと値の1対だけの単純な置き場所にしておく。同期の覚え書き
       * （端末ID・世代番号など）も、ここに置けるようにするため。
       */
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('lawMeta')) {
        db.createObjectStore('lawMeta', { keyPath: 'lawId' });
        // すでにある法令から見出しを作る。ここは版を上げるときの1回だけ。
        if (db.objectStoreNames.contains('laws') && req.transaction) {
          const laws = req.transaction.objectStore('laws');
          const meta = req.transaction.objectStore('lawMeta');
          const cur = laws.openCursor();
          cur.onsuccess = ev => {
            const c = ev.target.result;
            if (!c) return;
            const { xml, ...rest } = c.value;
            meta.put(rest);
            c.continue();
          };
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function idbReq(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error || new Error('保存が中断されました'));
  });
}

async function read(name, fn) {
  const db = await openDB();
  return idbReq(fn(db.transaction(name, 'readonly').objectStore(name)));
}

/** 書き込みはトランザクションの完了まで待つ。リクエスト成功だけでは確定ではない。 */
async function write(name, fn) {
  const db = await openDB();
  const t = db.transaction(name, 'readwrite');
  const r = fn(t.objectStore(name));
  const [val] = await Promise.all([idbReq(r), txDone(t)]);
  return val;
}

/*
 * 法令の本体と見出しは、必ず一緒に書く。片方だけ残ると、一覧に出るのに
 * 開けない、あるいはその逆になる。同じトランザクションで書く。
 */
async function putLawAndMeta(rec) {
  const db = await openDB();
  const t = db.transaction(['laws', 'lawMeta'], 'readwrite');
  const { xml, ...meta } = rec;
  t.objectStore('laws').put(rec);
  t.objectStore('lawMeta').put(meta);
  await txDone(t);
}

async function delLawAndMeta(id) {
  const db = await openDB();
  const t = db.transaction(['laws', 'lawMeta'], 'readwrite');
  t.objectStore('laws').delete(id);
  t.objectStore('lawMeta').delete(id);
  await txDone(t);
}

/*
 * 注釈を書いた回数。
 *
 * 同期は「DBを読む → 突き合わせる → 書き戻す」の順で動く。この間に保存が
 * 挟まると、その編集を古い値で潰してしまう（しかも同期は成功と出る）。
 * 読む前と書く前でこの数が変わっていないことを確かめて、変わっていたら
 * 読み直す。呼ばれた時点で増やすので、書き込みの最中も取りこぼさない。
 */
let localWrites = 0;

/*
 * 復元・同期の反映を、一度のトランザクションで書く。
 *
 * 以前は法令・注釈・文言注釈を1件ずつ別のトランザクションで書いていた。
 * 途中で失敗すると、半分入った状態が残る。どこまで入ったのかも分からない。
 * 注釈は取り返せないので、ここは「全部入るか、何も入らないか」にする。
 *
 * トランザクションの中で IndexedDB 以外の待ちを入れてはいけない（自動で閉じる）。
 * だから、渡すものは呼び側で全部そろえてから来ること。ここでは put を並べて、
 * 最後に完了を待つだけにする。
 */
async function applyBulk({ laws, notes, ranges, lawOrder: order, meta, local }) {
  /*
   * 手元の編集として書くなら、先に数を増やす（local: true）。
   *
   * 同期は localWrites の変化で「読んでいる間に書かれた」ことを知る。
   * putNote などは増やすのに、applyBulk は増やしていなかった。改正後の版へ
   * 写す画面・改正の追従・復元はここで書くので、同期の読み取り中に取り消すと、
   * 同期が先に読んだ生存レコードで墓石を上書きし、消したはずの注釈が
   * 復活した（しかも同期は成功と出る。Codex の指摘1）。
   *
   * 同期自身の反映では渡さない。渡すと、自分の書き込みを「割り込み」と
   * 見て次の同期が止まる。書く前の確認はもう済んでいる。
   */
  if (local) localWrites++;

  const db = await openDB();
  const names = ['laws', 'lawMeta', 'notes', 'ranges', 'meta'];
  const t = db.transaction(names, 'readwrite');
  const os = {};
  for (const n of names) os[n] = t.objectStore(n);

  /*
   * put() は不正な値だと「その場で」例外を投げる（鍵が無いなど）。
   * 受け止めずに抜けると、それまでに並べた書き込みだけが確定してしまう。
   * 半分入った状態を残さないために、必ず中止してから投げ直す。
   */
  try {
    for (const rec of laws || []) {
      const { xml, ...m } = rec;
      os.laws.put(rec);
      os.lawMeta.put(m);
    }
    for (const n of notes || []) os.notes.put(n);
    for (const r of ranges || []) os.ranges.put(r);
    if (Array.isArray(order)) {
    os.meta.put({ key: LAW_ORDER_KEY,
      value: { ids: order, updatedAt: Date.now(), version: lawOrderRec.version || {} } });
  }
    for (const [k, v] of Object.entries(meta || {})) os.meta.put({ key: k, value: v });
  } catch (err) {
    try { t.abort(); } catch (e) { /* すでに終わっているなら、そのまま */ }
    throw err;
  }

  await txDone(t);
}

const store = {
  applyBulk,
  allLaws: () => read('laws', s => s.getAll()),      // XML 込み。書き出しでだけ使う
  allLawMeta: () => read('lawMeta', s => s.getAll()),
  getLaw: id => read('laws', s => s.get(id)),
  putLaw: rec => putLawAndMeta(rec),
  delLaw: id => delLawAndMeta(id),
  getMeta: key => read('meta', s => s.get(key)),
  putMeta: (key, value) => write('meta', s => s.put({ key, value })),
  allNotes: () => read('notes', s => s.getAll()),
  getNote: key => read('notes', s => s.get(key)),   // 墓石も返る。版を継ぐのに要る
  putNote: rec => { localWrites++; return write('notes', s => s.put(rec)); },
  delNote: key => { localWrites++; return write('notes', s => s.delete(key)); },
  tombNote: rec => { localWrites++; return write('notes', s => s.put(rec)); },
  allRanges: () => read('ranges', s => s.getAll()),
  getRange: id => read('ranges', s => s.get(id)),   // 墓石も返る。版を継ぐのに要る
  putRange: rec => { localWrites++; return write('ranges', s => s.put(rec)); },
  delRange: id => { localWrites++; return write('ranges', s => s.delete(id)); },
  tombRange: rec => { localWrites++; return write('ranges', s => s.put(rec)); },
};

/* -------------------------------------------------------------- e-Gov API */

/*
 * e-Gov を叩く。繋がらなかったときに、何が起きているかを言う。
 *
 * メンテナンス中の e-Gov は 403 とHTMLを返すが、その応答には
 * Access-Control-Allow-Origin が付いていない。するとブラウザは状態を
 * 読む前に CORS の検査で弾くので、こちらには status すら届かない。
 * Safari はそれを「Load failed」とだけ言う。生のまま出していたので、
 * 自分のアプリが壊れたようにしか見えなかった（実際そう受け取られた）。
 *
 * 向こうのメンテナンスか、こちらの回線かは、ブラウザからは区別できない。
 * 決められないので両方を挙げる。navigator.onLine は「繋がっていない」
 * ことだけは当てになるので、はっきりしているときはそう言う。
 * あわせて「取り込んだ法令はそのまま読める」ことを必ず添える。
 * 読めると分かっていれば、慌てずに済む。
 */
async function apiGet(url, what) {
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('この端末が通信できていません。'
        + '（取り込んだ法令はそのまま読めます）');
    }
    throw new Error('e-Gov に繋がりません。向こうがメンテナンス中か、'
      + '通信が届いていません。（取り込んだ法令はそのまま読めます）');
  }
  if (r.status === 403 || r.status === 503) {
    throw new Error('e-Gov が応じません（' + r.status + '）。'
      + 'メンテナンス中かもしれません。（取り込んだ法令はそのまま読めます）');
  }
  if (!r.ok) throw new Error(what + 'に失敗しました (' + r.status + ')');
  return r;
}

async function apiSearchLaws(title) {
  const r = await apiGet(`${API}/laws?law_title=${encodeURIComponent(title)}&limit=50`,
    '検索');
  const d = await r.json();
  return (d.laws || d.items || []).map(it => ({
    lawId: (it.law_info || {}).law_id,
    lawNum: (it.law_info || {}).law_num,
    promulgationDate: (it.law_info || {}).promulgation_date,
    lawTitle: (it.revision_info || {}).law_title,
    lawTitleKana: (it.revision_info || {}).law_title_kana,
    abbrev: (it.revision_info || {}).abbrev,
    category: (it.revision_info || {}).category,
    updated: (it.revision_info || {}).updated,
    enforcementDate: (it.revision_info || {}).amendment_enforcement_date,
    lawRevisionId: (it.revision_info || {}).law_revision_id,
  })).filter(x => x.lawId);
}

/*
 * その法令の版の一覧。まだ施行されていない改正も入っている。
 * 例：民法は 2029-06-23 施行予定の改正が、いまの時点で返ってくる。
 */
async function apiRevisions(lawId) {
  const r = await apiGet(`${API}/law_revisions/${encodeURIComponent(lawId)}`,
    '版の一覧の取得');
  const d = await r.json();
  return d.revisions || [];
}

async function apiFetchLaw(lawId) {
  const r = await apiGet(
    `${API}/law_data/${encodeURIComponent(lawId)}?response_format=xml`, '取得');
  return await r.text();
}

function parseXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XMLを解釈できませんでした');
  return doc;
}

function textOf(el, tag) {
  const c = el ? el.querySelector(':scope > ' + tag) : null;
  return c ? c.textContent.trim() : '';
}

/* ------------------------------------------------------------- アプリ状態 */

/*
 * 表示面（ペイン）。法令を並べて見比べられるように2つ持つ。
 * 操作の対象は「いま触っている面」で、P() で取る。
 */
function makePane(idx) {
  const root = $(`.lawpane[data-pane="${idx}"]`);
  return {
    idx, root,
    el: $('.content', root),
    header: $('.law-header', root),
    title: $('.law-title', root),
    meta: $('.law-meta', root),
    crumb: $('.crumb', root),
    current: null,
    filter: null,          // { tag } か { marked: true }。保存しない（下の注記を見よ）
    index: [],
    toc: [],
    headOffsets: [],
    articleOffsets: [],
  };
}

const state = {
  laws: [],
  panes: [],
  active: 0,
  split: false,
  indexCache: new Map(),
  notes: new Map(),
  ranges: new Map(),
  orphanRanges: [],
  selected: null,
};

/** 要素がどの面にあるか */
function paneOf(el) {
  const root = el && el.closest && el.closest('.lawpane');
  return root ? state.panes[Number(root.dataset.pane)] : null;
}

/** いま操作している面 */
const P = () => state.panes[state.active];
/** 表示中の面すべて */
const livePanes = () => state.panes.filter(p => state.split || p.idx === 0);

const noteKey = (lawId, anchor) => lawId + ':' + anchor;

/*
 * 属性セレクタに埋める文字。
 *
 * CSS.escape は古い環境と、試験のように差し替えを忘れた場面で無いことがある。
 * 実際に、後メモの置き場所を探すのに使ったところで落ちた。アンカーは
 * 英数字と / _ : だけなので、引用符と逆斜線だけ避ければ足りる。
 */
function attrEsc(v) {
  const s = String(v == null ? '' : v);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, ch => '\\' + ch);
}

/* ------------------------------------------------------------ 消した印 */

/*
 * 消したことを記録して残す（墓石）。本当に消さない。
 *
 * 消すたびに本当に削除していたので、「消した」という事実がどこにも残らなかった。
 * すると古いバックアップを読み込んだときに、消したものが復活する。端末を
 * 行き来させるなら、これは必ず起きる。
 *
 * 期限は付けない。「全端末が受け取ったら消してよい」と考えても、昔の
 * バックアップを後から読めば復活の入口になる。2〜3台・数十KBの規模では、
 * 墓石の容量より「消してよい条件」を実装する方が高くつく。
 *
 * 中身は小さくする。タグやメモの文面は残さない。消したのに文面が残るのは
 * 筋が違う。復旧のためのバックアップには残るが、それは別の話である。
 *
 * updatedAt を deletedAt と同じ値にしておく。マージは updatedAt の新しい方を
 * 残すので、こうすれば「消した」も「書いた」と同じ物差しで比べられる。
 */
const isTomb = r => !!(r && r.deletedAt);

function noteTomb(note, now, version) {
  return { key: note.key, lawId: note.lawId, anchor: note.anchor,
    deletedAt: now, updatedAt: now,
    // 「消した」も1つの編集。版を持たせないと前後が決められない
    version: version || note.version || {} };
}

function rangeTomb(rec, now, version) {
  // 消す相手は id で決める。text や nth が同じでも別の注釈は消さない
  return { id: rec.id, lawId: rec.lawId, anchor: rec.anchor,
    deletedAt: now, updatedAt: now,
    version: version || rec.version || {} };
}

/** 墓石を除いたものだけ。画面に出すのはこちら。 */
const livingOnly = list => list.filter(r => !isTomb(r));

/* ------------------------------------------------- 同期：運ぶ形と検証 */

/*
 * 同期で置くファイルの形。バックアップの形とは分ける。
 *
 *   端末ごとに全量を1つ置く。他の端末のファイルは読むだけで、書き換えない。
 *   共有の1ファイルを皆で上書きすると、別々のレコードを直しただけで
 *   片方の変更が消える。
 *
 *   {
 *     format: 'roppo-sync',
 *     schemaVersion: 1,     この JSON の読み方
 *     datasetId: '...',     別の同期のかたまりを混ぜないための印
 *     writerId: '...',      どの端末が出したか（＝端末ID）
 *     generation: 12,       その端末が何回目に出したか。時計を使わずに順を決める
 *     records: { notes: [], ranges: [], lawOrder: {...} }
 *   }
 *
 * 墓石も未解決の衝突（alts）も、records にそのまま入れる。入れないと
 * 相手の端末で復活したり、衝突が片方だけ消えたりする。
 */
const SYNC_FORMAT = 'roppo-sync';
const SYNC_SCHEMA = 1;
const DATASET_KEY = 'roppo.datasetId';
const GENERATION_KEY = 'roppo.generation';
const LAST_SEEN_KEY = 'roppo.lastSeen';
// ほかの端末が持っている法令の目録。writerId → { at, laws }
const LAW_INV_KEY = 'lawInventory';
const LAST_SYNC_KEY = 'roppo.lastSyncAt';

/*
 * 同期のかたまりの印。
 *
 * 最初に同期した端末が決め、後から来た端末はそれに合わせる。端末ごとに
 * 勝手に作ると、互いを「別のかたまり」として飛ばし合い、いつまでも
 * 揃わない。実際にそうなった。
 *
 * まだ一度も置いていないうちは、印を作らない。置いてあるものを見てから
 * 決める（adoptDatasetId）。
 */
async function loadDatasetId() {
  try {
    const rec = await store.getMeta(DATASET_KEY);
    if (rec && rec.value) return rec.value;
  } catch (e) { /* まだ無い */ }
  return '';
}

/*
 * 置いてあるものを見て、かたまりの印を決める。
 *
 *   手元に印がある        そのまま使う（もう仲間に入っている）
 *   置いてあるものがある   その印に合わせる（先に居た方に揃える）
 *   どちらも無い          新しく作る（自分が最初）
 *
 * 置いてあるものの印が2種類以上あるときは、勝手に決めない。混ぜてはいけない
 * ものを混ぜる恐れがあるので、言って止める。
 */
async function adoptDatasetId(foreign) {
  const mine = await loadDatasetId();
  if (mine) return { id: mine, why: '' };

  const found = [...new Set(foreign.map(f => f && f.datasetId).filter(Boolean))];
  if (found.length > 1) {
    return { id: '', why: '置いてあるものが ' + found.length + '種類あります。混ぜません' };
  }
  const id = found.length === 1 ? found[0] : newDeviceId().replace(/^d/, 's');
  try { await store.putMeta(DATASET_KEY, id); } catch (e) { /* 次回また決める */ }
  return { id, why: '' };
}

/** いま持っているものを、そのまま1つの塊にする。DBは読むだけ。 */
/*
 * その端末が持っている法令の目録。XMLは入れない。
 *
 * 法令XMLは同期しない（数MBあるし、e-Gov から取り直せる）。しかし
 * 「どの端末に何が入っているか」を知る手段がどこにも無かったので、
 * 端末ごとに突き合わせるのが手作業になっていた。名前と住所だけなら軽い。
 *
 * これは注釈と違って、突き合わせる記録ではない。「いまこの端末はこれを
 * 持っている」という、その時点の事実である。だから版も墓石も持たない。
 * 端末ごとに最新の塊のものを見ればよい。
 */
/*
 * 法令の出どころ。
 *
 * 1か所に出してあるのは、出どころによって「もう一度手に入るか」が変わり、
 * それが画面の文とボタンを決めるからである。
 *
 *   egov     法令の住所を投げれば取り直せる
 *   file     手元のファイルから入れたもの。ほかの端末からは取り直せない
 *   pack     規則パックから入れたもの。pack/ にあるので取り直せる
 *   unknown  知らない値。新しい版が書いたものを古い版が読んだとき
 *
 * 記録に source が無いものは e-Gov である（e-Gov から取るときは付けていない）。
 * 知らない値を e-Gov に寄せてはいけない。取れない住所を e-Gov に投げることに
 * なる。取れない側に寄せれば、画面には出るが押せない、で済む。
 *
 * ここを散らしておくと、出どころを増やしたときに「file ではない＝e-Gov」と
 * 決めている箇所が取り残される。実際に renderMissing がそうなっていた。
 */
function lawOrigin(rec) {
  const s = rec && rec.source;
  if (s === 'file' || s === 'pack') return s;
  if (!s || s === 'egov') return 'egov';
  return 'unknown';
}

function lawInventory(laws) {
  return (laws || []).map(l => ({
    lawId: l.lawId,
    lawTitle: l.lawTitle || '',
    lawNum: l.lawNum || '',
    source: lawOrigin(l),
    /*
     * 版をまたいで束ねる札。パックのものだけが持つ。
     *
     * パックの住所は pack-<sha256> で、訂正版は別の sha256 になる。つまり
     * 新旧は別の法令として並ぶ。同じ規則の版だと分かるのは workId だけなので、
     * 目録にも載せる。無ければ入れない（e-Gov のものに空の欄を増やさない）。
     */
    ...(l.workId ? { workId: l.workId } : {}),
  })).filter(x => x.lawId);
}

function buildSnapshot({ notes, ranges, order, laws, datasetId, writerId, generation }) {
  return {
    format: SYNC_FORMAT,
    schemaVersion: SYNC_SCHEMA,
    datasetId,
    writerId,
    generation,
    records: {
      notes: notes || [],
      ranges: ranges || [],
      lawOrder: order || { ids: [], updatedAt: 0, version: {} },
      /*
       * 目録。古い版のアプリはこの欄を読まないので、足しても壊れない
       * （schemaVersion は上げない）。
       */
      laws: lawInventory(laws),
    },
  };
}

/*
 * 注釈1件の形を検める。おかしければ理由を、問題なければ '' を返す。
 *
 * 前は鍵の有無しか見ていなかった。そのため tags が配列でないような記録も
 * 検証を通り、DBに入り、以後は起動のたびに loadNotes が同じ場所で落ちる。
 * 一度入ると消す手立てが画面に無いので、入る前に弾く。
 */
const okStr = s => s === undefined || typeof s === 'string';
const okNum = n => n === undefined || (typeof n === 'number' && Number.isFinite(n));
const okTags = t => t === undefined
  || (Array.isArray(t) && t.every(x => typeof x === 'string'));
/*
 * 写した元（copiedFrom）。版をまたいで注釈を写したときに付く。
 * 無くてもよい（写していない記録には付かない）。
 */
const okCopy = c => {
  if (c === undefined) return true;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  return okStr(c.lawId) && okStr(c.anchor) && okStr(c.id) && okStr(c.op);
};
const okVv = v => {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every(n => Number.isInteger(n) && n > 0);
};

/** deep が false のものは候補（alts）を持てない。候補の入れ子は作らない。 */
function noteProblem(n, deep) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return '中身がない';
  if (typeof n.key !== 'string' || !n.key) return '鍵が無い';
  if (!okStr(n.lawId) || !okStr(n.anchor)) return '法令や条項号の指し方が違う';
  if (!okTags(n.tags)) return 'タグが配列でない';
  if (!okStr(n.color) || !okStr(n.summary) || !okStr(n.memo)) return '中身が文字列でない';
  if (!okNum(n.updatedAt) || !okNum(n.deletedAt)) return '時刻が数でない';
  if (!okVv(n.version)) return '版の形が違う';
  if (!okCopy(n.copiedFrom)) return '写した元の形が違う';
  if (!okVv(n.copiedVersion)) return '写した時の版の形が違う';
  if (n.alts !== undefined) {
    if (!deep) return '候補が入れ子になっている';
    if (!Array.isArray(n.alts)) return '候補が配列でない';
    for (const a of n.alts) { const w = noteProblem(a, false); if (w) return '候補の' + w; }
  }
  return '';
}

function rangeProblem(r, deep) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return '中身がない';
  if (typeof r.id !== 'string' || !r.id) return 'id が無い';
  if (!okStr(r.lawId) || !okStr(r.anchor)) return '法令や条項号の指し方が違う';
  if (!okStr(r.text) || !okStr(r.color) || !okStr(r.memo)) return '中身が文字列でない';
  if (!okNum(r.nth)) return '何番目かが数でない';
  if (!okNum(r.updatedAt) || !okNum(r.deletedAt)) return '時刻が数でない';
  if (!okVv(r.version)) return '版の形が違う';
  if (!okCopy(r.copiedFrom)) return '写した元の形が違う';
  if (!okVv(r.copiedVersion)) return '写した時の版の形が違う';
  if (r.alts !== undefined) {
    if (!deep) return '候補が入れ子になっている';
    if (!Array.isArray(r.alts)) return '候補が配列でない';
    for (const a of r.alts) { const w = rangeProblem(a, false); if (w) return '候補の' + w; }
  }
  return '';
}

/*
 * 受け取った塊を検める。読めないものは読まない。
 *
 * JSON として読めるかだけでは足りない。形・版・型・鍵の重なりまで見る。
 * 壊れたものを「空の同期データ」として扱ってはいけない。空と間違えると、
 * こちらの墓石が相手を消しに行く。
 *
 * 返すのは { ok, why, snapshot }。ok が false なら触らない。
 */
function validateSnapshot(o) {
  const no = why => ({ ok: false, why, snapshot: null });
  if (!o || typeof o !== 'object') return no('中身がない');
  if (o.format !== SYNC_FORMAT) return no('別の形式のファイル');
  const sv = Number(o.schemaVersion);
  if (!Number.isFinite(sv) || sv < 1) return no('版が読み取れない');
  if (sv > SYNC_SCHEMA) return no('新しい版（' + sv + '）。このアプリでは読めない');
  if (typeof o.writerId !== 'string' || !o.writerId) return no('発行元が無い');
  const gen = Number(o.generation);
  if (!Number.isFinite(gen) || gen < 0) return no('世代番号が読み取れない');
  const r = o.records;
  if (!r || typeof r !== 'object') return no('records が無い');
  if (!Array.isArray(r.notes) || !Array.isArray(r.ranges)) return no('records の形が違う');

  const seenN = new Set();
  for (const n of r.notes) {
    const w = noteProblem(n, true);
    if (w) return no('読めない注釈がある（' + w + '）'
      + (n && n.key ? ': ' + n.key : ''));
    if (seenN.has(n.key)) return no('同じ鍵の注釈が2つある: ' + n.key);
    seenN.add(n.key);
  }
  const seenR = new Set();
  for (const x of r.ranges) {
    const w = rangeProblem(x, true);
    if (w) return no('読めない文言注釈がある（' + w + '）'
      + (x && x.id ? ': ' + x.id : ''));
    if (seenR.has(x.id)) return no('同じ id の文言注釈が2つある: ' + x.id);
    seenR.add(x.id);
  }
  if (r.lawOrder) {
    if (!Array.isArray(r.lawOrder.ids)) return no('並び順の形が違う');
    if (!r.lawOrder.ids.every(x => typeof x === 'string')) return no('並び順に法令でないものがある');
    if (!okVv(r.lawOrder.version)) return no('並び順の版の形が違う');
  }
  /*
   * 法令の目録。無くてもよい（この欄を持たない版が置いた塊も読む）。
   * あるなら形を検める。ここが壊れていても注釈は読めるので、弾かずに
   * 落とす方が親切……ではない。読めないものを黙って無視すると、
   * 「ほかの端末に無い」と嘘を言うことになる。弾く。
   */
  if (r.laws !== undefined) {
    if (!Array.isArray(r.laws)) return no('法令の目録の形が違う');
    for (const l of r.laws) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) return no('法令の目録に中身のないものがある');
      if (typeof l.lawId !== 'string' || !l.lawId) return no('法令の目録に住所の無いものがある');
      if (!okStr(l.lawTitle) || !okStr(l.lawNum) || !okStr(l.source)) {
        return no('法令の目録の中身が文字列でない: ' + l.lawId);
      }
    }
  }
  return { ok: true, why: '', snapshot: o };
}

/*
 * 2つの塊を1つにする。マージの核を通すだけ。ここに判定を書かない。
 * 左右を入れ替えても同じ結果になる（試験で確かめている）。
 */
function mergeSnapshots(a, b) {
  const ra = (a && a.records) || {};
  const rb = (b && b.records) || {};
  const oa = ra.lawOrder || { ids: [], updatedAt: 0, version: {} };
  const ob = rb.lawOrder || { ids: [], updatedAt: 0, version: {} };
  let order;
  if (!oa.ids.length) order = ob;
  else if (!ob.ids.length) order = oa;
  else {
    const m = mergeRecord({ ...oa, key: 'lawOrder' }, { ...ob, key: 'lawOrder' });
    order = { ids: m.ids || [], updatedAt: m.updatedAt || 0, version: m.version || {} };
  }
  return {
    notes: mergeLists(ra.notes || [], rb.notes || [], r => r.key),
    ranges: mergeLists(ra.ranges || [], rb.ranges || [], r => r.id),
    lawOrder: order,
  };
}

/* ------------------------------------------------------------ 同期：版 */

/*
 * 「どちらの編集が後か」を、時計ではなく版で決める。
 *
 * updatedAt（端末の時計）で新しい方を残す形にしていたが、時計がずれると
 * 古い内容が勝ち続ける。逆に巻き戻れば新しい編集が負ける。個人の端末でも
 * 時計は狂う。
 *
 * 代わりに、レコードごとに「どの端末の何番目の編集を取り込んだか」を持つ。
 *
 *   version: { "pc-xxxx": 4, "iphone-yyyy": 2 }
 *
 * 共通の版 {PC:4, iPhone:2} から別々に編集すると
 *
 *   PC の編集      {PC:5, iPhone:2}
 *   iPhone の編集  {PC:4, iPhone:3}
 *
 * になる。片方がすべての項目で他方以上なら、それが後の編集。互いに大きい
 * 項目があるなら、互いを見ずに編集したということ＝衝突である。
 * 書かれていない項目は 0 とみなす。
 *
 * updatedAt は捨てない。「最終更新」として画面に出すのに使う。
 */

/*
 * この端末の名前。版の項目名になる。
 *
 * インストールごとに1つ作り、meta に置く。バックアップから復元しても
 * 引き継がない（同じ名前の端末が2つになると、版の前後が決められなくなる）。
 * 名前自体に意味は持たせない。誰の端末かも書かない。
 */
const DEVICE_KEY = 'roppo.deviceId';
let deviceId = '';

function newDeviceId() {
  const a = new Uint8Array(8);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return 'd' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadDeviceId() {
  try {
    const rec = await store.getMeta(DEVICE_KEY);
    if (rec && typeof rec.value === 'string' && rec.value) { deviceId = rec.value; return; }
  } catch (e) { /* 下で作る */ }
  deviceId = newDeviceId();
  try { await store.putMeta(DEVICE_KEY, deviceId); } catch (e) { /* 次回また作る */ }
}

/** 版の各項目を読む。無ければ0。 */
const vvAt = (v, id) => Number((v && v[id]) || 0);

/**
 * 版に出てくる端末の名前を全部。並びは決め打ちにする（下の vvKey を見よ）。
 * 空の名前は落とす。端末IDが無いまま書かれたものが混じることがある。
 */
function vvIds(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
    .filter(Boolean).sort();
}

/*
 * 版を文字列にする。鍵を並べ替えてから作る。
 *
 * JSON.stringify をそのまま使うと、鍵の順番が入力の順番で決まる。同じ版でも
 * 端末によって別の文字列になり、重複の判定と同順位の決着が端末ごとに
 * 食い違う。同期では「どの端末でも同じ結果」が要るので、ここを揃える。
 * 0 の項目は書かない（無いのと同じ意味なので）。
 */
function vvKey(v) {
  const o = v || {};
  return Object.keys(o).sort()
    .filter(k => k && Number(o[k]) > 0)
    .map(k => k + ':' + Number(o[k]))
    .join('|');
}

/** a のすべての項目が b 以上か。 */
function vvDominates(a, b) {
  return vvIds(a, b).every(id => vvAt(a, id) >= vvAt(b, id));
}

/**
 * 2つの版の関係。
 *   'same'     同じ
 *   'left'     左が後（左を採る）
 *   'right'    右が後
 *   'conflict' 互いを見ずに編集された
 */
function vvCompare(a, b) {
  const l = vvDominates(a, b);
  const r = vvDominates(b, a);
  if (l && r) return 'same';
  if (l) return 'left';
  if (r) return 'right';
  return 'conflict';
}

/** 両方を見た、という版を作る（項目ごとの大きい方）。 */
function vvMerge(a, b) {
  const out = {};
  for (const id of vvIds(a, b)) {          // vvIds は並べ替えて返す
    const n = Math.max(vvAt(a, id), vvAt(b, id));
    if (n > 0) out[id] = n;
  }
  return out;
}

/**
 * この端末の編集を1つ進めた版を返す。元の版は変えない。
 * 名前が無いときは何もしない。空の名前を項目にすると、誰の編集か分からなくなる。
 */
function vvBump(v, id) {
  const out = { ...(v || {}) };
  if (!id) return out;
  out[id] = vvAt(out, id) + 1;
  return out;
}

/* --------------------------------------------------- 同期：マージの核 */

/*
 * 衝突したとき、片方を捨てない。
 *
 * 表に出すのは1つだけ決める（画面がぶれないように）。もう片方は alts に
 * 積んでおく。alts はレコードの一部なので、同期でもバックアップでも一緒に
 * 運ばれる。利用者が選んだら、両方の版を取り込んだ新しい編集にする。
 *
 * 表に出す側は「時計が新しい方、同じなら端末の名前が小さい方」で決める。
 * 時計を信じているのではなく、どの端末でも同じ結果になるようにするため。
 */
function pickShown(a, b) {
  const ta = Number(a.updatedAt || 0);
  const tb = Number(b.updatedAt || 0);
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  const ia = vvKey(a.version);
  const ib = vvKey(b.version);
  return ia <= ib ? [a, b] : [b, a];
}

/** alts を、同じ版のものを重ねずに集める。 */
function collectAlts(...recs) {
  const seen = new Map();
  for (const r of recs) {
    if (!r) continue;
    for (const alt of r.alts || []) {
      const k = vvKey(alt.version);
      if (!seen.has(k)) seen.set(k, alt);
    }
  }
  return [...seen.values()];
}

/** alts のうち、採用したレコードより古いものは落とす。 */
function pruneAlts(alts, chosen) {
  const out = [];
  const seen = new Set();
  for (const alt of alts) {
    if (vvDominates(chosen.version, alt.version)) continue;   // もう解決済み
    const k = vvKey(alt.version);
    if (seen.has(k)) continue;
    seen.add(k);
    const { alts: _drop, ...clean } = alt;                    // alts は入れ子にしない
    out.push(clean);
  }
  return out;
}

/**
 * 同じ鍵の2つのレコードを1つにする。入力は変えない。
 *
 * 版を持たない古いレコード（版を入れる前のバックアップ）も来る。その場合は
 * 昔どおり updatedAt で比べる。因果関係の情報が無いので、それしかできない。
 */
function mergeRecord(left, right) {
  if (!left) return right ? { ...right, alts: pruneAlts(collectAlts(right), right) } : right;
  if (!right) return { ...left, alts: pruneAlts(collectAlts(left), left) };

  /*
   * 版で比べられるのは、**両方が版を持っているとき**だけである。
   *
   * 空の版（{}）は「版が無い」と同じに扱う。持たせただけで中身が無いものを
   * 「版がある」と見ると、昔の物差しに落ちずに 'same' になり、左が無条件に勝つ。
   *
   * 片方だけが版を持つ場合も版では決められない。版を入れる前に作った
   * バックアップには因果関係の情報が無いので、版を持つ手元が常に勝ってしまい、
   * 古いバックアップから戻せなくなる。そのときは時計で決める。
   */
  const hasVv = !!(vvKey(left.version) && vvKey(right.version));
  if (!hasVv) {
    // 版を持たない同士。昔の物差し（時計）で決める。同じなら左を残す
    const [win] = pickShown(left, right);
    return { ...win };
  }

  const rel = vvCompare(left.version, right.version);
  if (rel === 'same' || rel === 'left' || rel === 'right') {
    const base = rel === 'right' ? right : left;
    const other = rel === 'right' ? left : right;
    const alts = pruneAlts(collectAlts(left, right), base);
    const out = { ...base, version: vvMerge(left.version, right.version) };
    if (alts.length) out.alts = alts; else delete out.alts;
    // 'same' でも相手の alts は拾う。片方だけが衝突を抱えていることがある
    void other;
    return out;
  }

  /*
   * 衝突。表に出す方を決め、もう片方は alts に積む。
   *
   * ただし「消した」と「直した」がぶつかったときだけは、時計を見ずに
   * 生きている方を表に出す。墓石を表に出すと、その注釈は画面からも
   * 「別の編集があるもの」の一覧からも消え、alts にある生きた中身を選ぶ道が
   * どこにも無くなる。生きている方を出しておけば中身は見えるし、消し直すのは
   * 一手で済む。取り返しがつく方に倒す。
   *
   * これは衝突のときだけの決まりである。版で前後が決まる場合や、版を持たない
   * 古いバックアップとの比較にまで広げてはいけない。広げると、消したものが
   * 古いバックアップから復活する。
   */
  const [shown, hidden] = isTomb(left) !== isTomb(right)
    ? (isTomb(left) ? [right, left] : [left, right])
    : pickShown(left, right);
  const { alts: _a, ...shownClean } = shown;
  const { alts: _b, ...hiddenClean } = hidden;
  const alts = pruneAlts([hiddenClean, ...collectAlts(left, right)], shownClean);
  return alts.length ? { ...shownClean, alts } : { ...shownClean };
}

/** 衝突を抱えているか（画面に「別の編集があります」と出す判断）。 */
const hasConflict = r => !!(r && r.alts && r.alts.length);

/*
 * 衝突している中身を、一言で見せるための文字。
 *
 * 大きな比較画面は作らない。どちらを採るか決めるには、何が書いてあるかが
 * 見えれば足りる。長いメモは切って、続きがあることだけ分かるようにする。
 */
function noteBrief(r) {
  if (!r) return '';
  if (isTomb(r)) return '（削除）';
  const parts = [];
  if (r.color) {
    const c = MARK_COLORS.find(x => x.key === r.color);
    parts.push('マーク' + (c ? c.label : r.color));
  }
  if ((r.tags || []).length) parts.push('タグ ' + r.tags.join('・'));
  if (String(r.summary || '').trim()) parts.push('前メモ「' + r.summary.trim().slice(0, 30) + '」');
  if (String(r.memo || '').trim()) parts.push('メモ「' + r.memo.trim().slice(0, 40) + '」');
  if (String(r.text || '').trim() && !('key' in r)) parts.unshift('「' + r.text.trim().slice(0, 20) + '」');
  return parts.length ? parts.join('　') : '（空）';
}

/*
 * 「別の編集があります」の箱を組む。条項号の注釈でも文言の注釈でも同じ形。
 *
 * 表に出しているものと、alts に積んである候補を並べ、どれかを選ばせる。
 * 選んだら resolveConflict が両方の版を取り込んだ新しい編集を作るので、
 * 古い候補を後から受け取っても戻らない。
 */
function conflictHtml(rec) {
  if (!hasConflict(rec)) return '';
  const row = (r, i, now) =>
    '<div class="cf-row"><div class="cf-body">'
    + (now ? '<b>いま表に出ているもの</b><br>' : '')
    + esc(noteBrief(r)) + '</div>'
    + '<button type="button" class="mini" data-cf="' + i + '">これを採る</button></div>';
  return '<div class="note-conflict"><div class="cf-head">別の編集があります</div>'
    + '<div class="cf-note">同じところを、別々の端末で直したものです。'
    + 'どちらも消していません。採る方を選んでください。</div>'
    + row(rec, -1, true)
    + (rec.alts || []).map((a, i) => row(a, i, false)).join('')
    + '</div>';
}

/** 「これを採る」を押したときの配線。box の中のボタンを見る。 */
function wireConflict(box, rec, save) {
  for (const b of $$('button[data-cf]', box)) {
    b.onclick = async () => {
      const i = Number(b.dataset.cf);
      const chosen = i < 0 ? rec : (rec.alts || [])[i];
      if (!chosen) return;
      const solved = resolveConflict(rec, chosen, deviceId);
      await save(solved);
      toast('採った方に決めました');
    };
  }
}

/**
 * 鍵ごとに寄せてマージする。入力の配列も要素も変えない。
 * 順番を変えても、何度混ぜても同じ結果になること（試験で確かめている）。
 */
function mergeLists(left, right, keyOf) {
  const out = new Map();
  for (const r of left || []) {
    const k = keyOf(r);
    if (k === undefined || k === null || k === '') continue;
    out.set(k, out.has(k) ? mergeRecord(out.get(k), r) : r);
  }
  for (const r of right || []) {
    const k = keyOf(r);
    if (k === undefined || k === null || k === '') continue;
    out.set(k, out.has(k) ? mergeRecord(out.get(k), r) : r);
  }
  // 片方だけにあったものも、alts の掃除を通す
  for (const [k, r] of out) out.set(k, mergeRecord(r, null));
  return [...out.values()];
}

/** 衝突を解いて1つにする。選んだ内容に、両方の版を取り込んだ新しい編集を作る。 */
function resolveConflict(rec, chosen, deviceId) {
  let v = rec.version || {};
  for (const alt of rec.alts || []) v = vvMerge(v, alt.version);
  const { alts: _drop, ...body } = chosen;
  return { ...body, version: vvBump(v, deviceId) };
}

