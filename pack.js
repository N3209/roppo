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
async function fetchPackManifest() {
  let res;
  try {
    res = await fetch(PACK_MANIFEST, { cache: 'no-store' });
  } catch (e) {
    throw new Error('規則パックが読めません（通信できませんでした）');
  }
  if (!res.ok) {
    // 404 は「まだ置いていない」である。壊れているのとは言い方を分ける
    throw new Error(res.status === 404
      ? 'この配布には規則パックが入っていません'
      : '規則パックが読めません（' + res.status + '）');
  }
  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error('pack.json が読めません（形が違います）'); }
  const rules = (json && json.rules) || [];
  if (!rules.length) throw new Error('pack.json に規則が1本も入っていません');
  return { packVersion: json.packVersion || '', note: json.note || '', rules };
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
 * 検める順に意味がある。安いものから、そして「名乗りと違う」を先に出す。
 *
 *   1  バイト数    pack.json の bytes と合うか
 *   2  sha256      pack.json の sha256 と合うか
 *   3  BOM と改行  LF のみ・BOM なしか（配信の経路で書き換わっていないか）
 *   4  XML として読めるか
 *   5  題名が pack.json と合うか
 *   6  条文が読めるか（描いてみる）
 *
 * 3は2と重なるが、理由を言い分けるために別に見る。sha256 が合わないときに
 * 「CRLF が混じっている」と言えれば、.gitattributes を直せばよいと分かる。
 * 「ハッシュが違う」だけでは、中身が差し替わったのかと疑うことになる。
 */
async function packRecordFrom(entry, buf) {
  // ArrayBuffer でも Uint8Array でも受ける。以下はこの1つの見方だけを使う
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  if (entry.bytes !== undefined && u8.length !== entry.bytes) {
    throw new Error('バイト数が合いません（一覧 ' + entry.bytes
      + ' / 実物 ' + u8.length + '）');
  }

  const sum = await sha256Hex(u8);
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
      + '配信の経路で書き換わっています（dist/.gitattributes の *.xml -text）');
  }
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
  catch (e) { throw new Error('取りに行けませんでした（通信）'); }
  if (!res.ok) throw new Error('取りに行けませんでした（' + res.status + '）');
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
async function takePack(l) {
  const sum = String(l.lawId || '').startsWith(PACK_PREFIX)
    ? String(l.lawId).slice(PACK_PREFIX.length) : '';
  if (!sum) throw new Error('パックの住所ではありません');
  const { rules } = await fetchPackManifest();
  const entry = rules.find(r => r.sha256 === sum);
  if (!entry) {
    throw new Error('この配布の規則パックに見つかりません'
      + (l.workId ? '（' + l.workId + '）' : '')
      + '。パックが新しくなって、その版が外れた可能性があります');
  }
  return takePackRule(entry, { defer: true });
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
      + (got.packVersion ? '　パック版 ' + got.packVersion : '');
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
    d.innerHTML = '<div class="info"><div class="name">' + esc(r.lawTitle || r.workId)
      + '</div><div class="sub">' + esc(r.lawNum || '')
      + (kind ? '　' + esc(kind) : '')
      + (nyf ? '　未施行の改正あり' : '')
      + '</div></div>'
      + '<button ' + (owned ? 'disabled' : '') + '>'
      + (owned ? '取込済' : '取り込む') + '</button>';
    const btn = d.querySelector('button');
    if (!owned) {
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
