'use strict';

/*
 * 規則パックから取り込む。
 *
 * 最高裁判所規則は e-Gov に1件も入っていない。裁判所のサイトに掲載PDFがある
 * だけで、XMLは誰も配っていない。だから別の工程がPDFからXMLを起こし、
 * pack/ に置いて配っている。
 *
 * ファイル取り込み（view.js の importLawFile）との決定的な違いは、
 * パックが自分の正しさを名乗っていることである。
 *
 *   pack.json   規則ごとに file / sha256 / bytes と、照合の記録
 *   pack/*.xml  ファイル名に sha256 が入っている
 *
 * だから取り込むたびに検められる。ファイルから取り込むときは、渡されたXMLを
 * 信じるしかない。ここでは信じない。バイトが名乗りと合わなければ取り込まない。
 *
 * 検めが働くには、配信の経路で1バイトも変わらないことが要る。git は既定で
 * 改行を書き換えるので、dist/.gitattributes に *.xml -text を入れてある
 * （publish.js の SITE_FILES）。公開の前に publish.js の checkPack が
 * sha256 を照合して、狂っていれば止める。
 *
 * 住所は pack-<sha256> にする。訂正版は必ず別の sha256 になるので、新旧は
 * 別の法令として並ぶ。同じ住所に上書きすると、注釈が黙って新しい本文に
 * 付き直す（アンカーがずれていれば別の条に付く）。同じ規則の版だと分かる
 * 札は workId で、版をまたいで注釈を写すときにそれで束ねる
 * （version-migration-view.js の versionPeers）。
 */

const PACK_DIR = 'pack/';
const PACK_MANIFEST = PACK_DIR + 'pack.json';
const PACK_PREFIX = 'pack-';

/*
 * 一覧を出すたびに読み直す。
 *
 * 持ち回すと、パックを差し替えたあとも古い一覧を出す。103本ぶんの見出しでも
 * 500KB ほどで、押すのは人なので、読み直す方がよい。
 */
/*
 * 通信できなかったことを、数字ではなく言葉で言う。
 *
 * Service Worker が入っていると、通信の失敗は catch に来ない。殻のキャッシュに
 * 無いものは素通しするが、その fetch が失敗すると sw.js が 504 のレスポンスに
 * 化けさせる（sw.js の fetch の末尾）。だから res.ok が false で status が 504
 * になり、「規則パックが読めません（504）」と出ていた。504 は読む人に何も
 * 言わない。
 *
 * これは jsdom の試験では出ない経路である（Service Worker が動かないので、
 * fetch の失敗はそのまま catch に来る）。実ブラウザで見つけた。
 *
 * 503 は sw.js が画面遷移のときに返す値、502 は中継が落ちているときに来る。
 * どれも「こちらから届かない」であって、パックの話ではない。
 */
const OFFLINE_STATUS = new Set([502, 503, 504]);

async function fetchPackManifest() {
  let res;
  try {
    res = await fetch(PACK_MANIFEST, { cache: 'no-store' });
  } catch (e) {
    throw new Error('規則パックが読めません（通信できませんでした）');
  }
  if (!res.ok) {
    // 404 は「まだ置いていない」である。壊れているのとは言い方を分ける
    if (res.status === 404) throw new Error('この配布には規則パックが入っていません');
    if (OFFLINE_STATUS.has(res.status)) {
      throw new Error('規則パックが読めません（通信できませんでした）。'
        + 'オフラインのときは取り込めません');
    }
    throw new Error('規則パックが読めません（' + res.status + '）');
  }
  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error('pack.json が読めません（形が違います）'); }
  const rules = (json && json.rules) || [];
  if (!rules.length) throw new Error('pack.json に規則が1本も入っていません');
  return {
    superseded: supersededMap(rules),
    packVersion: json.packVersion || '',
    /*
     * パックを組んだ日。版の番号だけでは、どのくらい前のものか分からない。
     * 規則ごとの「取得」（PDFを取った日）とは別で、こちらは全体の鮮度である。
     */
    builtAt: json.builtAt || '',
    note: json.note || '',
    rules,
  };
}

/*
 * 置き換えの鎖を組み、同時に検める。
 *
 * パックの住所は中身のハッシュから作るので、同じ規則の新旧は別の法令として
 * 並ぶ。workId は「同じ規則の版だ」と言うだけで、どちらが新しいかは言わない。
 * 順番を与えるのが supersedes（この版はあの版を置き換えた）である。
 *
 * 鎖が壊れていると、どの版が現行かが決められない。だから一覧を出す前に検める。
 * 落ちたら一覧を出さない。「ほかは大丈夫」と言える根拠が無い状態で103本を
 * 並べると、間違った版を取り込ませることになる。
 *
 * 作る側（build_pack.py と verify_pack.py）も同じことを検めている。重なって
 * いるが無駄ではない。片方の道具が壊れたときに、もう片方で気づける。
 *
 * 検める順に意味がある。**原因が分かる検査を、症状が出る検査より先に置く。**
 * 「同じ版を2つが置き換えている」を先に見ないと、「置き換えられていない版が
 * 2本ある」という症状だけが出て、何が起きたのか分からない。
 */
function supersededMap(rules) {
  const bySha = new Map();
  for (const r of rules) if (r.sha256) bySha.set(r.sha256, r);

  const out = new Map();                 // 置き換えられた sha256 → 置き換えた行
  const name = r => (r && (r.lawTitle || r.workId)) || '?';
  const cut = s => String(s || '').slice(0, 12) + '…';

  for (const r of rules) {
    if (!r.supersedes) continue;
    const old = bySha.get(r.supersedes);

    // 1 指す先が目録にある（旧版の記載は消さない取り決めなので、無ければ壊れ）
    if (!old) {
      throw new Error('規則パックの目録が壊れています：'
        + name(r) + ' が置き換えたとする版（' + cut(r.supersedes)
        + '）が目録にありません');
    }
    // 2 指された行の workId が同じ（違えば別の規則を置き換えている）
    if ((old.workId || '') !== (r.workId || '')) {
      throw new Error('規則パックの目録が壊れています：'
        + name(r) + ' が別の規則の版を置き換えています（'
        + (r.workId || '?') + ' → ' + (old.workId || '?') + '）');
    }
    // 3 同じ版を2つが置き換えていない（枝分かれ。症状より原因を先に言う）
    if (out.has(r.supersedes)) {
      throw new Error('規則パックの目録が壊れています：'
        + (r.workId || '?') + ' で、同じ版（' + cut(r.supersedes)
        + '）を2つが置き換えています');
    }
    /*
     * 4 法改正なら施行日がある。
     *
     * 「法改正の版は施行日を過ぎてから出す。訂正には enforcedOn を書かない」
     * という取り決めがある。無いものが来たら、取り決めが変わったか目録が
     * 壊れたかである。画面の言い方がこの欄で決まるので、黙って通さない。
     */
    const c = r.correction || {};
    if (c.kind === '法改正' && !c.enforcedOn) {
      throw new Error('規則パックの目録が壊れています：'
        + name(r) + ' が法改正の版なのに施行日（enforcedOn）がありません');
    }
    if (c.kind === '訂正' && c.enforcedOn) {
      throw new Error('規則パックの目録が壊れています：'
        + name(r) + ' が訂正なのに施行日（enforcedOn）を持っています');
    }

    out.set(r.supersedes, r);
  }

  /*
   * 4 workId ごとに、置き換えられていない版がちょうど1本。
   *
   * 0本なら鎖が輪になっている。2本以上なら、上の3を通り抜けた形の枝分かれ
   * （別々の版から分かれた）である。
   */
  const byWork = new Map();
  for (const r of rules) {
    const w = r.workId || '';
    if (!byWork.has(w)) byWork.set(w, []);
    byWork.get(w).push(r);
  }
  for (const [w, list] of byWork) {
    const tips = list.filter(r => !out.has(r.sha256));
    if (tips.length !== 1) {
      throw new Error('規則パックの目録が壊れています：' + (w || '?')
        + ' で、置き換えられていない版が ' + tips.length + '本あります'
        + '（1本であるべきです）');
    }
  }
  return out;
}

/** バイト列の sha256 を16進で。crypto.subtle は https と localhost で使える。 */
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/*
 * バイト列から記録を作る。取り込みの判断は全部ここにある。
 *
 * 通信を含めていないのは、ここが検めの中身だからである。通信を混ぜると、
 * 検めを試すのに偽の通信先が要る。バイト列を渡せば試せる形にしておく。
 *
 * 検める順に意味がある。**理由を言い分けられるものを先に見る。**
 *
 *   1  BOM と改行  LF のみ・BOM なしか（配信の経路で書き換わっていないか）
 *   2  バイト数    pack.json の bytes と合うか
 *   3  sha256      pack.json の sha256 と合うか
 *   4  XML として読めるか
 *   5  題名が pack.json と合うか
 *   6  条文が読めるか（描いてみる）
 *
 * はじめは安い順（バイト数 → sha256 → BOM と改行）にしていた。これは誤り
 * だった。改行が書き換わるとバイト数も増えるので、必ず「バイト数が合いません」
 * で止まり、用意した「改行が CRLF です」に辿り着けない。一番起きやすい故障の
 * 案内が、一番出ない順番になっていた。
 *
 * 1と3は同じ狂いを別の角度から見ている。どちらでも気づけるが、直し方が違う。
 *
 *   「改行が CRLF です」      .gitattributes を確かめればよいと分かる
 *   「ハッシュが合いません」   中身が差し替わったのかと疑うことになる
 */
async function packRecordFrom(entry, buf) {
  // ArrayBuffer でも Uint8Array でも受ける。以下はこの1つの見方だけを使う
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const text = new TextDecoder('utf-8').decode(u8);

  /*
   * BOM はバイトで見る。復号した文字列では見つからない。
   *
   * TextDecoder は既定で BOM を取り除く（ignoreBOM が false のとき「無視せず
   * 処理する」＝落とす、という紛らわしい名前である）。だから
   * text.charCodeAt(0) === 0xFEFF は永久に成り立たず、この検査は素通りして
   * いた。試験が捕まえた。
   */
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    throw new Error('BOM が付いています（配信の経路で書き換わっています）');
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf) {
    throw new Error('改行が CRLF です（' + crlf + '箇所）。'
      + '配信の経路で書き換わっています（dist/.gitattributes の pack/** -text）');
  }

  if (entry.bytes !== undefined && u8.length !== entry.bytes) {
    throw new Error('バイト数が合いません（一覧 ' + entry.bytes
      + ' / 実物 ' + u8.length + '）');
  }

  const sum = await sha256Hex(u8);
  if (sum !== entry.sha256) {
    throw new Error('ハッシュが合いません（一覧 ' + String(entry.sha256).slice(0, 12)
      + '… / 実物 ' + sum.slice(0, 12) + '…）');
  }

  let doc;
  try { doc = parseXML(text); }
  catch (e) { throw new Error('XML として読めません'); }
  const lawEl = doc.querySelector('Law');
  if (!lawEl) throw new Error('Law 要素がありません');

  const titleEl = lawEl.querySelector('LawTitle');
  const lawTitle = titleEl ? titleEl.textContent.trim() : '';
  if (!lawTitle) throw new Error('法令名（LawTitle）がありません');
  /*
   * 題名が一覧と合うか。
   *
   * sha256 は「このファイルが壊れていないか」しか言わない。一覧の行が別の
   * 規則を指していても、その行の sha256 と一致すれば通ってしまう。題名を
   * 突き合わせれば、組み立てを間違えた一覧を捕まえられる。
   */
  if (entry.lawTitle && entry.lawTitle !== lawTitle) {
    throw new Error('一覧と題名が違います（一覧「' + entry.lawTitle
      + '」/ XML「' + lawTitle + '」）');
  }

  // 描いてみて、中身を確かめてから取り込む。読めないものを抱え込まない
  const { index } = renderLaw(lawEl);
  if (!index.length) throw new Error('条文が1件も読み取れません');

  // 同じアンカーを指す場所の重なり。注釈の位置が決まらなくなる（importLawFile と同じ）
  const seen = new Map();
  for (const e of index) seen.set(e.anchor, (seen.get(e.anchor) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([a]) => a);

  const lv = entry.legalVersion || {};
  const ver = entry.verification || {};
  const nyf = lv.amendmentsNotYetInForce || [];
  const ex = ver.excluded || [];

  return {
    lawId: PACK_PREFIX + sum,
    lawTitle,
    lawNum: entry.lawNum || '',
    source: 'pack',
    workId: entry.workId || '',
    packSha256: sum,
    sourceKind: (entry.source && entry.source.kind) || '',
    packState: ver.state || '',
    /*
     * 空なら欄を作らない。
     *
     * 記録は lawMeta にも入り、起動のたびに全件読む。103本に空の配列を
     * 持たせるのは、読む量を増やすだけで何も言わない。
     */
    ...(ex.length ? { packExcluded: ex } : {}),
    ...(nyf.length ? { notYetInForce: nyf } : {}),
    /*
     * 来歴は XML のコメントから読む。pack.json にも同じ文があるが、XML の中に
     * あるものを使う。書き出して復元しても一緒に残るのがコメントの方である
     * （view.js の readProvenance の冒頭）。
     */
    provenance: readProvenance(doc),
    importedAt: today(),
    dupAnchors: dup,
    xml: text,
    savedAt: Date.now(),
  };
}

/** パックから1本取り込む。opts.defer なら後始末を呼び側に任せる（まとめるとき）。 */
async function takePackRule(entry, opts) {
  let res;
  try { res = await fetch(PACK_DIR + entry.file, { cache: 'no-store' }); }
  catch (e) { throw new Error('取りに行けませんでした（通信できませんでした）'); }
  if (!res.ok) {
    // 一覧と同じ理由で、504 のような数字をそのまま出さない（上の OFFLINE_STATUS）
    if (OFFLINE_STATUS.has(res.status)) {
      throw new Error('取りに行けませんでした（通信できませんでした）');
    }
    throw new Error('取りに行けませんでした（' + res.status + '）');
  }
  const buf = await res.arrayBuffer();

  const rec = await packRecordFrom(entry, buf);
  await store.putLaw(rec);
  /*
   * 同じ住所で取り込み直したとき、navigate は開き直さない。DBだけ新しくなって
   * 画面は古いまま、という状態になる（importLawFile と同じ理由）。
   */
  state.indexCache.delete(rec.lawId);
  if (opts && opts.defer) return rec;
  await finishImport([rec], []);
  return rec;
}

/*
 * 目録から1本取り込む（ほかの端末が持っているパックの規則）。
 *
 * 目録には lawId と workId しか載っていない。file と sha256 は pack.json に
 * あるので、住所から sha256 を取り出して、その行を引く。
 *
 * workId で引かないのは、同じ workId に複数の版が載っているからである
 * （訂正版を出しても旧版の記載を消さない、という取り決め）。相手が持って
 * いるのはその中の1つなので、住所で引き当てる。
 */
async function takePack(l, rules) {
  const sum = String(l.lawId || '').startsWith(PACK_PREFIX)
    ? String(l.lawId).slice(PACK_PREFIX.length) : '';
  if (!sum) throw new Error('パックの住所ではありません');
  /*
   * 一覧は呼び側から渡せる。
   *
   * pack.json は 474KB ある。まとめて取り込むときに1本ごとに取り直すと、
   * 10本で 4.7MB、103本で 48MB を重ねて取ることになる。まとめる側が1回だけ
   * 取って渡す（takeAllMissing）。
   *
   * 中に持ち回さないのは意図である。持つと、パックを差し替えたあとも古い一覧を
   * 使う。渡されたときだけ使い、渡されなければ取りに行く。
   */
  if (!rules) rules = (await fetchPackManifest()).rules;
  const entry = rules.find(r => r.sha256 === sum);
  if (!entry) {
    throw new Error('この配布の規則パックに見つかりません'
      + (l.workId ? '（' + l.workId + '）' : '')
      + '。パックが新しくなって、その版が外れた可能性があります');
  }
  return takePackRule(entry, { defer: true });
}

/*
 * パックの新しい版が出ていないか。
 *
 * 取り込んだ時点では、その版が鎖の先端である。置き換えられるのは後から
 * 新しい pack.json が届いたときなので、記録には書けない。だから確かめに行く。
 *
 * e-Gov の改正確認（checkAmendments）と同じ構えにしてある。違いは、
 * **1回の読み出しで全部分かる**ことである。e-Gov は法令ごとに問い合わせるが、
 * パックは pack.json を1枚読めば103本ぶんの鎖が揃う。
 *
 * 圏外なら黙って諦める。確かめられなかったことを「新しい版は無い」と
 * 読み替えてはいけないので、前の判定をそのまま残す。
 */
let packNewer = {};        // lawId → 置き換えた側の行

async function checkPackVersions() {
  const mine = state.laws.filter(l => lawOrigin(l) === 'pack');
  if (!mine.length) return 0;
  const { superseded } = await fetchPackManifest();
  let found = 0;
  for (const l of mine) {
    const by = superseded.get(l.packSha256);
    if (by) { packNewer[l.lawId] = by; found++; }
    else delete packNewer[l.lawId];
  }
  // 手元に無くなった法令の判定は捨てる
  const have = new Set(mine.map(l => l.lawId));
  for (const id of Object.keys(packNewer)) if (!have.has(id)) delete packNewer[id];
  return found;
}

/* 1日に1度だけ、静かに確かめる。e-Gov の方と同じ歯止めを別に持つ。 */
function checkPackVersionsIfStale() {
  let at = 0;
  try { at = Number(localStorage.getItem('roppo.packCheckedAt')) || 0; } catch (e) { /* 任意 */ }
  if (Date.now() - at < 24 * 60 * 60 * 1000) return;
  checkPackVersions().then(found => {
    try { localStorage.setItem('roppo.packCheckedAt', String(Date.now())); } catch (e) { /* 任意 */ }
    if (!found) return;
    /*
     * 開いている面の帯を描き直す。
     *
     * 帯を描くのは openLaw の中なので、開き直して描かせる。読んでいる位置は
     * 渡して保つ（finishImport は 0 を渡すが、あちらは取り込み直した直後なので
     * 先頭に戻ってよい。こちらは読んでいる最中に起きる）。
     */
    for (const pane of livePanes()) {
      if (!pane.current || !packNewer[pane.current.lawId]) continue;
      const top = pane.el ? pane.el.scrollTop : 0;
      openLaw(pane.current.lawId, null, top, pane).catch(() => { /* 開けなければ放っておく */ });
    }
  }).catch(() => { /* 圏外なら黙って諦める。前の判定を残す */ });
}

/*
 * 新しい版について言うこと。
 *
 * 新しい版が出る理由は2つあり、**逆の行動を促す。**
 *
 *   訂正      変換の誤りを直した。旧版は誤り      → 早く入れ替えるべき
 *   法改正     法令そのものが変わった              → 施行日前の版は読んではいけない
 *
 * 見分けるのは correction.enforcedOn の有無である。文は読まない。文から
 * 判定すると、書き方が変わった日に黙って逆のことを言う。
 *
 * XML化の側が「法改正の版は施行日以後にしか出さない」と決めたので、出ている
 * ものは常に現行として扱える（未施行の版は一覧に出ない）。だから「◯◯から
 * 施行されます」ではなく「新しい版があります」で足りる。
 *
 * @param newer 置き換えた側の行
 */
function newerNote(newer) {
  const c = newer.correction || {};
  /*
   * kind を見る。無ければ enforcedOn の有無で代える。
   *
   * kind は後から足してもらった欄なので、古い pack.json にはない。
   * 「法改正には enforcedOn を必ず付け、訂正には書かない」という取り決めが
   * あるので、代えが効く。どちらにしても文は読まない。
   */
  const kind = c.kind || (c.enforcedOn ? '法改正' : '訂正');
  const parts = [];
  if (kind === '法改正') {
    parts.push('新しい版があります');
    if (c.reason) parts.push(c.reason);
    if (c.enforcedOn) parts.push(c.enforcedOn + ' 施行');
  } else {
    parts.push('訂正版があります');
    if (c.reason) parts.push(c.reason);
    if (c.where) parts.push(c.where);
    const at = c.publishedAt || (newer.verification || {}).checkedAt;
    if (at) parts.push(at + ' に直しました');
  }
  return parts.join('　');
}

/*
 * 取り込んでいる版が置き換えられていると分かっているときに出す帯。
 *
 * 分かっていないとき（まだ確かめていない・圏外）は何も出さない。確かめて
 * いないことを「新しい版は無い」と読み替えてはいけない。
 */
function packNewerNote(rec) {
  const by = packNewer[rec.lawId];
  if (!by) return '';
  const owned = state.laws.some(l => l.lawId === PACK_PREFIX + by.sha256);
  return '<span class="warn" title="' + esc(newerNote(by)) + '">'
    + esc(newerNote(by))
    + (owned ? '' : '　規則パックから取り込めます')
    + '</span>';
}

/* ------------------------------------------------------- 追加の画面の一覧 */

/*
 * 一覧を出す。
 *
 * まとめて取り込むボタンは置かない。103本を一息に入れると、途中で失敗した
 * ときに「98件入りました」としか言えない。パックは sha256 が合わないこと
 * 自体が報告すべき事実なので、取り込みの単位と検めの単位を揃える。
 *
 * ほかの端末ぶんをまとめる経路は「ほかの端末にあって、この端末に無い法令」が
 * 受け持つ。そこに出るのは自分が選んだものだけなので、103本の話にならない。
 */
/*
 * いま一覧に出しているもの。絞り込みで描き直すために持つ。
 * 画面を開くたびに読み直すので、持ち回すのはこの1回ぶんだけである。
 */
let packGot = null;
const packShown = () => packGot;

async function openPackList() {
  const box = $('#pack-results');
  if (!box) return;
  box.innerHTML = '<p class="hint" style="padding:10px">読み込み中…</p>';
  try { packGot = await fetchPackManifest(); }
  catch (err) {
    packGot = null;
    box.innerHTML = '<p class="hint" style="padding:10px">' + esc(err.message) + '</p>';
    return;
  }
  renderPackList();
}

function renderPackList() {
  const got = packGot;
  if (!got) return;
  const box = $('#pack-results');
  const kw = normalize(($('#pack-filter') && $('#pack-filter').value) || '');
  box.innerHTML = '';

  const note = $('#pack-note');
  if (note) {
    note.textContent = got.rules.length + '本'
      + (got.packVersion ? '　パック版 ' + got.packVersion : '')
      + (got.builtAt ? '　' + got.builtAt + ' 作成' : '');
  }

  const list = got.rules.filter(r => !kw
    || normalize(r.lawTitle || '').includes(kw)
    || normalize(r.lawNum || '').includes(kw));
  if (!list.length) {
    box.innerHTML = '<p class="hint" style="padding:10px">該当なし</p>';
    return;
  }

  for (const r of list) {
    const owned = state.laws.some(x => x.lawId === PACK_PREFIX + r.sha256);
    const d = document.createElement('div');
    d.className = 'r';
    /*
     * 行に出すのは題名・法令番号・掲載の種別まで。照合の文は本文の末尾に出る
     * （view.js の packNoteHTML）。ここに並べると、選ぶための一覧が読めなく
     * なる。種別だけは残す。PDFと掲載ページ（HTML）の違いは選ぶときに効く。
     */
    const kind = (r.source && r.source.kind) || '';
    const nyf = ((r.legalVersion || {}).amendmentsNotYetInForce || []).length;
    /*
     * 置き換えられた版は、隠さずに印を付けて残す。
     *
     * 隠すと、その版をすでに取り込んでいる人が「新しい版がある」と気づけない。
     * 一覧に出ているからこそ、本文の末尾で知らせたことと繋がる（XML化の側の
     * 言うとおりで、こちらの当初案より良い）。
     *
     * ただし取り込みはさせない。古い版を新しく取り込む理由が無い。
     */
    const by = (got.superseded || new Map()).get(r.sha256);
    d.innerHTML = '<div class="info"><div class="name">' + esc(r.lawTitle || r.workId)
      + '</div><div class="sub">' + esc(r.lawNum || '')
      + (kind ? '　' + esc(kind) : '')
      + (nyf ? '　未施行の改正あり' : '')
      + (by ? '<br><span class="old-ver">置き換えられた版　' + esc(newerNote(by)) + '</span>' : '')
      + '</div></div>'
      + '<button ' + (owned || by ? 'disabled' : '') + '>'
      + (by ? '古い版' : owned ? '取込済' : '取り込む') + '</button>';
    const btn = d.querySelector('button');
    if (!owned && !by) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '取得中…';
        try {
          await takePackRule(r);
          btn.textContent = '取込済';
          renderPackList();           // 取込済の印を揃える
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '再試行';
          /*
           * 理由をその行に出す。知らせ（toast）は消えるし、どの行の話か
           * 分からなくなる。sha256 が合わないのは、黙って流してよい話ではない。
           */
          const sub = d.querySelector('.sub');
          if (sub) {
            sub.innerHTML += '<br><span class="warn">' + esc(err.message) + '</span>';
          }
        }
      };
    }
    box.appendChild(d);
  }
}
