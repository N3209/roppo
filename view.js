'use strict';

/*
 * 分割の覚え書き。
 *
 * もとは1本だった。小道具・DB・API・状態・墓石・版番形・検証・マージは
 * core.js へ、起動は boot.js へ、改正の引き継ぎの核は
 * version-migration.js へ出してある。読み込む順は index.html にある。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */
/* --------------------------------------------------------------- 法令一覧 */


/*
 * つまんで並べ替える。
 *
 * ブラウザの drag-and-drop は iOS の Safari で動かないので使わない。
 * pointer の事象だけで組む。指でもマウスでも同じ道を通る。
 *
 * 取っ手（⠿）からしか始まらない。行そのものをつまめるようにすると、
 * 読むために押したつもりが動いてしまう。
 */
let dragRow = null;        // つまんでいる行
let dragPointer = null;    // つまんでいる指（マウス）

/*
 * つまむのをやめる。覚えた順は書かない。
 * 一覧を作り直すときは、必ずこれを先に呼ぶ。作り直すと、つまんでいた行は
 * 画面から外れるが、こちらは古い要素を握ったままになる。次に指が動くと、
 * 外れたはずの行を一覧へ挿し直して、同じ法令が二重に並ぶ。
 */
function cancelLawDrag() {
  if (!dragRow) return;
  dragRow.classList.remove('dragging');
  const ul = $('#law-list');
  if (ul) ul.classList.remove('dragging');
  dragRow = null;
  dragPointer = null;
}

function wireLawDrag() {
  const ul = $('#law-list');

  const rowsBelow = y => [...ul.querySelectorAll('li[data-law-id]')]
    .find(el => el !== dragRow && y < el.getBoundingClientRect().top + el.offsetHeight / 2);

  ul.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip) return;
    // 絞り込み中は並びが一部しか出ていない。動かすと全体の順が壊れる。
    if ($('#law-filter').value.trim()) { toast('絞り込みを消してから並べ替えてください'); return; }

    const row = grip.closest('li[data-law-id]');
    if (!row) return;
    e.preventDefault();
    cancelLawDrag();
    /*
     * capture は一覧そのものに付ける。取っ手に付けると、行を動かしたときに
     * 取っ手も一緒に DOM の中を移動する。Safari はそこで capture を手放す
     * ことがあり、掴んだ直後に終わってしまう（iPhone で並べ替えられない
     * 症状の原因）。一覧は動かないので、掴んでいる間ずっと受け取れる。
     */
    try { ul.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動く */ }
    dragRow = row;
    dragPointer = e.pointerId;
    row.classList.add('dragging');
    ul.classList.add('dragging');      // 周りを薄くして、つまんだことを示す
  });

  ul.addEventListener('pointermove', e => {
    if (!dragRow || e.pointerId !== dragPointer) return;
    // 一覧が作り直されて、握っている行が画面から外れていたらやめる
    if (!dragRow.isConnected) { cancelLawDrag(); return; }
    e.preventDefault();
    const before = rowsBelow(e.clientY);
    if (before) ul.insertBefore(dragRow, before);
    else ul.appendChild(dragRow);
  });

  const finish = e => {
    if (!dragRow || (e && e.pointerId !== dragPointer)) return;
    const ok = dragRow.isConnected;
    if (e && e.pointerId !== undefined) {
      try { ul.releasePointerCapture(e.pointerId); } catch (err) { /* すでに外れている */ }
    }
    cancelLawDrag();
    if (!ok) return;                 // 外れていたら、順は書かない

    // 画面の並びを、そのまま順として覚える
    const shown = [...ul.querySelectorAll('li[data-law-id]')].map(el => el.dataset.lawId);
    const seen = new Set();
    const uniq = shown.filter(id => !seen.has(id) && seen.add(id));
    // 絞り込みで隠れているものは、いまの順のまま後ろに残す
    const rest = state.laws.map(l => l.lawId).filter(id => !seen.has(id));
    saveLawOrder(uniq.concat(rest));
    state.laws = sortLaws(state.laws);
    renderLawList();
  };
  ul.addEventListener('pointerup', finish);
  ul.addEventListener('pointercancel', finish);
  ul.addEventListener('lostpointercapture', finish);
}

/*
 * 法令の並び順。
 *
 * 既定は名前順だが、よく引くものを上に置きたい。順番は法令そのものでは
 * なく「並べ方」なので、XML を抱えた記録は書き換えず、別に持つ。
 * 1.6MB の XML を並べ替えのたびに書き直すのは無駄でもある。
 */
const LAW_ORDER_KEY = 'roppo.lawOrder';
let lawOrder = [];
/*
 * 並び順も同期の対象なので、注釈と同じ形（版と時刻を持つレコード）で持つ。
 * 中身は法令IDの配列ひとつなので、レコードは1件だけである。
 */
let lawOrderRec = { ids: [], updatedAt: 0, version: {} };

/*
 * 並び順を IndexedDB から読む。
 *
 * 以前は localStorage に置いていた。同期では注釈と並び順をまとめて確定したいので、
 * IndexedDB へ移した。移す前の端末には localStorage にしか無いので、
 * 一度だけ拾い上げて書き移す。拾ったあとも localStorage の値は消さない
 * （古い版のアプリで開いたときに並びが失われないように）。
 */
async function loadLawOrder() {
  let rec = null;
  try {
    const got = await store.getMeta(LAW_ORDER_KEY);
    if (got) rec = got.value;
  } catch (e) { /* 読めなければ下で localStorage を見る */ }

  /*
   * 3つの形を受ける。
   *   {ids, updatedAt, version}  いまの形
   *   [ ... ]                    版を入れる前の形（配列だけ）
   *   無い                       localStorage から拾う（さらに前の形）
   */
  if (rec && Array.isArray(rec.ids)) {
    lawOrderRec = { ids: rec.ids, updatedAt: rec.updatedAt || 0, version: rec.version || {} };
  } else if (Array.isArray(rec)) {
    lawOrderRec = { ids: rec, updatedAt: 0, version: {} };
    try { await store.putMeta(LAW_ORDER_KEY, lawOrderRec); } catch (e) { /* 次回また */ }
  } else {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(LAW_ORDER_KEY) || '[]'); }
    catch (e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    lawOrderRec = { ids, updatedAt: 0, version: {} };
    // 移し替えは一度だけ。空でも書いておかないと、毎回ここを通る
    try { await store.putMeta(LAW_ORDER_KEY, lawOrderRec); } catch (e) { /* 書けなくても読める */ }
  }
  const ids = lawOrderRec.ids;
  lawOrder = ids;
}

function saveLawOrder(ids) {
  lawOrder = ids;
  // 並べ替えも1つの編集。版を進めて、前後を時計で決めなくて済むようにする
  lawOrderRec = { ids, updatedAt: Date.now(), version: vvBump(lawOrderRec.version, deviceId) };
  // IndexedDB を正本にする。localStorage にも書いて、古い版のアプリでも読めるようにする
  store.putMeta(LAW_ORDER_KEY, lawOrderRec).catch(() => { /* 下の localStorage が残る */ });
  try { localStorage.setItem(LAW_ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* 任意 */ }
}

/* 覚えた順を先に、知らないものは名前順で後ろに。 */
function sortLaws(list) {
  const at = new Map(lawOrder.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => {
    const ia = at.has(a.lawId) ? at.get(a.lawId) : Infinity;
    const ib = at.has(b.lawId) ? at.get(b.lawId) : Infinity;
    if (ia !== ib) return ia - ib;
    return (a.lawTitle || '').localeCompare(b.lawTitle || '', 'ja');
  });
}

async function refreshLawList() {
  /*
   * 一覧は見出しだけを読む。XML 込みで全部読むと、法令を足すほど
   * 起動が遅くなる（数MBの読み出しを、名前を並べるためだけに行う）。
   */
  state.laws = sortLaws(await store.allLawMeta());
  renderLawList();
  /*
   * 印とメモの一覧は法令名を引くし、「元の法令へ移す」の知らせは法令を
   * 持っているかどうかで変わる。法令を足しても作り直していなかったので、
   * 取り込んだのに「先に取り込んでください」と出たままになっていた。
   */
  renderMarkList();
}

function renderLawList() {
  cancelLawDrag();          // 作り直すと、つまんでいた行は画面から外れる
  const kw = normalize($('#law-filter').value || '');
  const ul = $('#law-list');
  ul.innerHTML = '';
  const list = state.laws.filter(l => !kw ||
    normalize(l.lawTitle || '').includes(kw) ||
    normalize(l.lawTitleKana || '').includes(kw) ||
    normalize(l.abbrev || '').includes(kw));

  if (!list.length) {
    /*
     * 「1本も無い」と「絞り込みに合うものが無い」は別である。
     * 両方に「該当なし」と出していたので、まだ何も取り込んでいない人には
     * 何に該当しないのか分からなかった。本文の面に出す誘いとも噛み合わない。
     */
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">'
      + (state.laws.length ? '該当なし' : 'まだ法令がありません') + '</li>';
    return;
  }
  for (const l of list) {
    const li = document.createElement('li');
    li.className = P().current && P().current.lawId === l.lawId ? 'active' : '';
    const a = amendOf(l);
    li.dataset.lawId = l.lawId;
    li.innerHTML = '<span class="grip" title="つまんで並べ替え">⠿</span>'
      + `<span class="law-name" title="${esc(l.lawTitle)}">${esc(l.lawTitle)}</span>`
      /*
       * 出どころの印。e-Gov のものには付けない（それが既定だから）。
       * パックにも付ける。103本のうち何本かを入れると一覧に混ざるので、
       * 出典が違うものがどれかは見えていた方がよい。
       */
      + (lawOrigin(l) === 'file' ? '<span class="src-badge">取り込み</span>'
        : lawOrigin(l) === 'pack' ? '<span class="src-badge">規則パック</span>'
          : lawOrigin(l) === 'unknown' ? '<span class="src-badge">出どころ不明</span>' : '')
      + (isUnenforced(l) ? '<span class="rev-badge">未施行</span>' : '')
      + (a ? `<span class="amend-dot ${a.kind === 'upcoming' ? 'upcoming' : ''}" title="${esc(amendTitle(a))}　押すと版を選べます"></span>` : '')
      + `<button class="del" title="削除">×</button>`;
    li.querySelector('.law-name').onclick = () => navigate(l.lawId);
    const dotEl = li.querySelector('.amend-dot');
    if (dotEl) dotEl.onclick = e => { e.stopPropagation(); openRevisions(l.lawId); };
    li.querySelector('.del').onclick = async e => {
      e.stopPropagation();
      if (!confirm(`「${l.lawTitle}」を削除します。\nこの法令に付けたタグ・メモは残ります。よろしいですか？`)) return;
      await flushSave();
      await store.delLaw(l.lawId);
      state.indexCache.delete(l.lawId);
      /*
       * 知らせを描くのは refreshLawList のあとにする。state.laws が
       * 更新されるのはその中なので、先に描くと「消す前の本数」で文を選ぶ。
       * 最後の1本を消したのに「法令を選択してください」と出る経路だった。
       *
       * 面は掴んでおく。await をまたぐ間に操作対象が変わっても、消した
       * 法令を映していた面に描きたい。
       */
      const pane = P();
      const wasOpen = !!(pane.current && pane.current.lawId === l.lawId);
      if (wasOpen) {
        pane.current = null;
        state.selected = null;
        pane.header.hidden = true;
        pane.el.innerHTML = '';            // 消した法令の本文を残さない
        closePopover();
      }
      await refreshLawList();
      if (wasOpen) pane.el.innerHTML = emptyPaneHTML();
      toast('削除しました');
    };
    ul.appendChild(li);
  }
}

/*
 * 法令を開いていない面に出す知らせ。3通りある。
 *
 *   ・1本も無い        取り込みへ誘う
 *   ・あるが選んでいない  選べと言う
 *   ・1本も無く、通信もできない  押しても取れないので、そう言う
 *
 * 0本のときに「法令を選択してください」と出していた。選ぶものが無いのに
 * 選べと言うことになる。最後の1本を削除した直後がその経路だった。
 *
 * 通信の判断は navigator.onLine が false のときだけに留める。繋がって
 * いないことだけは当てになるが、その逆は当てにならない（apiGet の注記と同じ）。
 * 当てにならない方に賭けて「取り込めます」と言い切ると、押して失敗する。
 */
function emptyPaneHTML() {
  if (state.laws.length) return '<div class="empty"><p>法令を選択してください。</p></div>';
  if (navigator.onLine === false) {
    return '<div class="empty">'
      + '<p class="empty-lead">まだ法令がありません</p>'
      + '<p class="hint">いまは通信できていません。繋がったら、法令名で検索して'
      + '取り込めます。取り込んだ法令は端末の中に保存されるので、次からは'
      + '通信がなくても読めます。</p>'
      + '</div>';
  }
  return '<div class="empty">'
    + '<p class="empty-lead">法令を追加してみましょう</p>'
    + '<p><button id="btn-add-law-2" class="primary">法令を追加する</button></p>'
    + '<p class="hint">「民法」「刑法」など、法令名で検索して取り込みます。'
    + '取り込んだ法令は端末の中に保存されるので、次からは通信がなくても読めます。</p>'
    + '</div>';
}

/*
 * 何も開いていない面の知らせを、いまの状態に合わせて描き直す。
 *
 * 1面目だけを見る。2面目の「左の一覧から法令を選ぶと…」は、法令があっても
 * 無くても、通信できてもできなくても変わらない知らせなので触らない。
 *
 * 法令を開いている面には何もしない。開いている本文を知らせで潰すのが
 * 一番まずい。
 */
function refreshEmptyPane() {
  const p = state.panes && state.panes[0];
  if (!p || p.current) return;
  p.el.innerHTML = emptyPaneHTML();
}

/*
 * 本文の末尾に出す出典。
 *
 * e-Gov の公共データ利用規約（第1.0版）は、コンテンツを利用するときに出典を、
 * 編集・加工したときはその旨と主体を記載することを求めている。このアプリは
 * XML を画面の形に組み替えているので、後者にも当たる。
 *
 * ファイルから取り込んだものの出典は、こちらには分からない。XML のコメントに
 * 来歴（PROV_KEYS）が書いてあればヘッダーの帯に出しているので、ここでは
 * 繰り返さず、出典を把握しているのが誰かだけを言う。
 */
/*
 * 規則パックの出典。
 *
 * e-Gov のものと違って、加工が2段ある。
 *
 *   裁判所の公示物（掲載PDF／掲載ページ）
 *     → PDFからXMLに起こす（個人による加工。裁判所による提供・検証ではない）
 *     → このアプリが条・項・号を組み替えて表示する
 *
 * 1段目を言わないと、裁判所が配ったXMLをこのアプリが組み替えただけに読める。
 *
 * 文はパックが持っているものをそのまま出す。言い換えない。照合の文
 * （verification.state）は「差分なし」と「文言は未照合」と「目視照合は未実施」が
 * 1つに同居していて、どれかを落とすと読み方が変わる。要約したくなるが、
 * 要約は「照合していない範囲を照合したように読ませる」方向にしか働かない。
 *
 * 持っていない値の行は出さない。空の見出しを並べると、何が分かっていないのかが
 * かえって見えなくなる。
 */
function packNoteHTML(rec) {
  const p = rec.provenance || {};
  const line = [];

  const src = p['出典'] || '最高裁判所規則（裁判所ウェブサイトの掲載）';
  line.push('出典：' + esc(src) + (rec.sourceKind ? '　' + esc(rec.sourceKind) : ''));

  /*
   * URL は http(s) のときだけリンクにする。それ以外は字のまま出す。
   * 取り込むファイルの中身をそのままリンクにしてはいけない。
   */
  const url = p['URL'] || '';
  if (/^https?:\/\//.test(url)) {
    line.push('<a href="' + esc(url) + '" target="_blank" rel="noopener">'
      + esc(url) + '</a>');
  } else if (url) {
    line.push(esc(url));
  }

  if (p['取得']) line.push(esc(p['取得']) + ' に取得したものです。');

  // 加工の主体。パックが書いた文をそのまま出す（PDL1.0 が求めるのはこれ）
  if (p['変換']) line.push(esc(p['変換']) + '。');
  /*
   * 2段目の加工。
   *
   * 「組み替えています」と書いていたら、並び順を変えたように読めると言われた。
   * 法令で一番やってはいけないことなので、まさにそう読まれると困る語だった。
   * 変えていないこと（文字と並び順）を先に言い、していること（組み立て）を
   * 具体で挙げる。「加工しています」だけでは、読む人は最悪を想像する。
   */
  line.push('さらにこのアプリが、画面に出すための組み立てをしています'
    + '（段落の分け方・項番号の体裁・括弧の見せ方・目次）。'
    + '条文の文字と並び順はXMLのままです。');

  if (p['反映']) line.push('反映：' + esc(p['反映']));
  if (p['範囲']) line.push('範囲：' + esc(p['範囲']));

  /*
   * 未施行の改正。読み方が変わるので、照合より先に出す。
   *
   * e-Gov のものは固定版と施行日から未施行の帯を出せるが、パックは施行日を
   * 持たない（PDFで確かめていない施行日を推測で書かない方針）。だから
   * ここで言うしかない。言わなければ、読む人はこれが現行で全部だと思う。
   */
  const nyf = rec.notYetInForce || [];
  for (const a of nyf) line.push('未施行の改正があります：' + esc(a));

  if (rec.packState) line.push('照合：' + esc(rec.packState));

  /*
   * 照合の一部を適用できていない規則は、そう言う。
   *
   * 103本に同じ文を出すと、この2本が違うことが画面から消える。出典と免責を
   * 作ったときの原則（照合していない範囲を照合したように読ませない）が、
   * ここでそのまま効く。
   */
  for (const e of (rec.packExcluded || [])) {
    line.push('この規則では、照合の一部を適用できていません：'
      + esc([e.check, e.where].filter(Boolean).join('　')));
  }

  line.push('官報に掲載された内容と異なる場合は、官報が優先します。'
    + ' <button type="button" class="about-link" data-about="1">このアプリについて</button>');

  return '<div class="source-note">' + line.join('<br>') + '</div>';
}

function sourceNoteHTML(rec) {
  /*
   * 出どころは lawOrigin で見る（core.js）。
   *
   * 前は「pack → file → それ以外は e-Gov」と書いていたので、知らない出どころが
   * e-Gov の出典になっていた。lawOrigin で「unknown を e-Gov に寄せない」と
   * 決めたのに、表示側に届いていなかった（Codex の指摘3）。
   * 出どころを偽るのは、このアプリで一番やってはいけないことである。
   */
  const origin = lawOrigin(rec);
  if (origin === 'pack') return packNoteHTML(rec);
  if (origin === 'unknown') {
    return '<div class="source-note">'
      + '出どころが分かりません（この版では扱えない形で記録されています）。'
      + 'アプリを更新してから開き直してください。'
      + ' <button type="button" class="about-link" data-about="1">このアプリについて</button>'
      + '</div>';
  }
  if (origin === 'file') {
    return '<div class="source-note">ファイルから取り込んだものです。'
      + '出典は取り込んだ人が把握してください。'
    + ' <button type="button" class="about-link" data-about="1">このアプリについて</button>'
    + '</div>';
  }
  const at = rec.savedAt ? ymdOf(rec.savedAt) : '';
  return '<div class="source-note">'
    + '出典：e-Gov法令検索（デジタル庁） '
    + '<a href="https://laws.e-gov.go.jp/" target="_blank" rel="noopener">'
    + 'https://laws.e-gov.go.jp/</a>'
    + (at ? '<br>' + at + ' にこの端末へ取り込んだ版です。' : '')
    + '<br>条文の文字と並び順は、取り込んだXMLのままです。'
    + 'このアプリがしているのは画面に出すための組み立てで、段落の分け方・'
    + '項番号の体裁・括弧の見せ方・目次がそれに当たります。'
    + ' <button type="button" class="about-link" data-about="1">このアプリについて</button>'
    + '</div>';
}

/* ------------------------------------------------------------- 法令の表示 */

async function openLaw(lawId, anchor, scrollTop, pane) {
  pane = pane || P();
  await flushSave();
  const rec = await store.getLaw(lawId);
  /*
   * 開けなかったことを、呼び側が確かめられるようにする。
   *
   * 前は知らせるだけで何も返さなかったので、呼び側は「開けたつもり」で
   * 先へ進んでいた。同期で届いた未取込み法令の注釈を一覧から開くと、
   * いま表示している別法令の同じ住所の編集欄が出て、打つとそちらへ
   * 保存された（レビューの指摘 R20）。
   */
  if (!rec) { toast('法令が見つかりません'); return null; }

  const doc = parseXML(rec.xml);
  const lawEl = doc.querySelector('Law');
  if (!lawEl) { toast('法令本体が見つかりません'); return; }

  const { html, index, toc } = renderLaw(lawEl);
  pane.current = rec;
  pane.index = index;
  pane.toc = toc;
  buildJumpTables(pane, index);
  state.indexCache.set(lawId, index);
  state.selected = null;                 // 前の法令の選択を持ち越さない

  pane.title.textContent = rec.lawTitle;
  // 分類と条文の件数は読むのに要らない。名前と、いつの版かだけ残す。
  /*
   * 自分で起こしたデータ（ファイル・パック）は施行日を持たない。
   * 来歴があれば「施行日は不明」より具体的なことが言える。
   */
  const org = lawOrigin(rec);
  if (org === 'file' || org === 'pack') {
    const prov0 = rec.provenance || {};
    pane.meta.textContent = [rec.lawNum, prov0['反映'] || '']
      .filter(Boolean).join('　/　')
      || (org === 'pack' ? '規則パック　施行日は不明'
        : '取り込んだデータ　施行日は不明');
  } else {
    pane.meta.textContent = [
      rec.lawNum,
      rec.enforcementDate ? '施行: ' + rec.enforcementDate : '',
    ].filter(Boolean).join('　/　');
  }
  const warn = $('.law-warn', pane.root);
  const unenforced = isUnenforced(rec);
  warn.hidden = !unenforced;
  /*
   * 改正法の名前は「改正法: 」を付けて出す。括弧に裸で入れていたときは、
   * 刑法の未施行版に「（情報通信技術の進展等に対応するための刑事訴訟法等の
   * 一部を改正する法律）」と出るので、別の法令を開いたように見えた。
   */
  warn.textContent = unenforced
    ? '未施行　' + rec.enforcementDate + ' 施行予定'
      + (rec.amendLawTitle ? '　改正法: ' + rec.amendLawTitle : '')
    : '';

  const note = $('.law-note', pane.root);
  if (org === 'file') {
    note.hidden = false;
    /*
     * 帯は短くする。重なりの詳しい話が要るのは、その位置に注釈を付けようと
     * したときだけである。読んでいる間ずっと出し続ける理由がない。
     * 詳細は触れたときに出す（下の dupNote）。
     */
    const dups = rec.dupAnchors || [];
    const where = dups.length && dups.every(a => /^S/.test(a)) ? '附則に' : '';
    /*
     * 来歴があるなら「施行日は不明」ではなく、分かっていることを出す。
     * 特に「附則は含まない」は読むときに要る。書いていないと、附則が無いのを
     * 法令の側の話だと思ってしまう。
     * 帯は短くするので、全部は title に入れて触ったときに出す。
     */
    const prov = rec.provenance;
    const head = prov && (prov['反映'] || prov['範囲'])
      ? [prov['反映'] ? prov['反映'] + ' 反映' : '', prov['範囲']].filter(Boolean).join('　')
      : '施行日は不明';
    const band = '取り込んだデータ　' + esc(head) + '　'
      + esc(rec.importedAt || '') + ' 取り込み';
    /*
     * 残りの来歴（出典・URL・変換の条件）は details で畳む。
     *
     * 以前は title に入れていたが、title はマウスを載せたときにしか出ない。
     * スマホでは読む手立てが無く、キーボードでも辿れない（Codex の指摘）。
     * details なら押して開けるし、読み上げも拾う。
     */
    const rest = prov ? PROV_KEYS.filter(k => prov[k] && !['反映', '範囲'].includes(k)) : [];
    note.innerHTML = (rest.length
      ? '<details class="prov"><summary>' + band + '</summary>'
        + rest.map(k => '<div><b>' + esc(k) + '</b> ' + esc(prov[k]) + '</div>').join('')
        + '</details>'
      : '<span>' + band + '</span>')
      + (dups.length
        ? '<span class="warn" title="' + esc(dups.join('、')) + '">'
          + where + '位置の重なりが ' + dups.length + '件</span>'
        : '');
  } else if (org === 'pack') {
    /*
     * パックの帯は、読み方が変わることだけ出す。
     *
     * 出典・加工の2段・照合の範囲と限界は、本文の末尾（packNoteHTML）が持つ。
     * ヘッダーは開くたびに目に入る一等地で、前にここへ「このアプリについて」を
     * 置いて絞り込みの入力欄を 38px 狭めた。常に要るものだけを置く。
     *
     * 未施行の改正だけは別である。あるのに言わなければ、読む人はこれが現行で
     * 全部だと思う。パックは施行日を持たないので（PDFで確かめていない施行日を
     * 推測で書かない方針）、未施行の帯（law-warn）が出る経路が無い。
     */
    const nyf = rec.notYetInForce || [];
    const warn = nyf.length
      ? '<span class="warn" title="' + esc(nyf.join('　')) + '">未施行の改正があります'
        + (nyf.length > 1 ? '（' + nyf.length + '件）' : '')
        + '　本文の末尾に書いています</span>'
      : '';
    /*
     * 注釈を写す入口も、ここから出す。
     *
     * パックの住所は pack-<sha256> で、訂正版は別の住所になる。新旧が別の法令
     * として並ぶので、固定版と同じように注釈を写す必要がある。
     *
     * versionPeers は workId で束ねられるようにしてあったが、呼ぶ場所を作って
     * いなかった。固定版の枝（下の rec.revisionOf）でしか
     * paintVersionMigrationNote を呼んでおらず、パックの記録は revisionOf を
     * 持たないので、画面から辿れる場所がどこにも無かった。関数の試験は通って
     * いたが押せなかった（Codex の指摘2）。
     *
     * quiet にしてあるので、写せるものが無く未施行でもないときは帯が出ない。
     */
    paintVersionMigrationNote(note, rec, {
      quiet: true, prefix: warn, lead: 'パックの版です。',
    });
  } else if (rec.revisionOf) {
    /*
     * 固定版を開いている。注釈を別の版へ写す入口を出す。
     *
     * 未施行の帯（上の law-warn）とは別に出す。改正前の版は施行日が過ぎて
     * いるので未施行の帯が出ない。出ない帯にボタンを足しても押せない。
     *
     * 実体は version-migration-view.js にある。このファイルより後に読むが、
     * 呼ぶのは関数の中なので読み込みの時点では要らない。
     */
    paintVersionMigrationNote(note, rec);
  } else {
    note.hidden = true;
    note.innerHTML = '';
  }

  pane.header.hidden = false;
  pane.el.innerHTML = html + sourceNoteHTML(rec);
  syncTopbarLaw();
  syncFindPlaceholder();
  indexAnchorEls(pane);

  renderLawList();
  renderToc();
  resolveRefs(pane);
  paintParens(pane);
  paintNotesIn(pane);
  paintRangesIn(pane);
  closePopover();                        // 前の法令の注釈パネルは閉じる
  hideSlashBar();                        // 別の法令に印を付けてしまわないように
  hideRefBar();                          // 行き先を選ぶバーも、前の法令のもの
  // 絞り込みは法令をまたいでも保つ。同じタグを別の法令で続けて見たいため。
  applyFilter(pane);
  renderFilterPicker();
  paintFindHits();          // 移った先の法令にも、検索の色を塗り直す
  pane._crumbSig = null;     // 別の法令でも見出しIDは h1 から振り直される
  measureHeadings(pane);

  if (anchor) scrollToAnchor(anchor, false, pane);
  else if (typeof scrollTop === 'number') pane.el.scrollTop = scrollTop;
  else pane.el.scrollTop = lastPos.get(lawId) || 0;   // 前回の続きから

  updateCrumb(pane);
  // 「この法令」を対象にしているなら、結果も新しい法令のものに入れ替える
  if (find.q && find.where === 'law' && find.scopeLawId !== lawId) doFind();
  else renderFindList();
  try { localStorage.setItem('roppo.last', lawId); } catch (e) { /* 使えなくても支障ない */ }
  return lawId;
}

/* ------------------------------------------------- 条文参照の行き先を決める */

function unwrapRef(a) {
  const parent = a.parentNode;
  while (a.firstChild) parent.insertBefore(a.firstChild, a);
  a.remove();
  parent.normalize();
}

/**
 * 参照に書かれた法令名から取込済みの法令を探す。
 * 「において準用する商業登記法」のように前に文がくっつくので、末尾一致も見る。
 * ただし「新民法」「旧法」は改正前後の別の版を指すので、一致とみなさない。
 */
function lawByName(name) {
  if (!name) return null;
  // 別の版として取り込んだものは、名前で引く対象にしない。
  // 本文に「民法」と書いてあるリンクが未施行の版へ飛んだら、取り違えに気づけない。
  const pool = state.laws.filter(l => !l.revisionOf);
  /*
   * 同じ名前の法令が複数あるとき（e-Gov から取ったものと、ファイルから
   * 取り込んだもの）、先に並んでいる方を選ぶと、一覧の並べ替えだけで
   * リンクの行き先が変わる。決め手が無いならリンクを張らない。
   */
  const exact = pool.filter(l => l.lawTitle === name || l.abbrev === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  let best = null, ties = 1;
  for (const l of pool) {
    if (!l.lawTitle || !name.endsWith(l.lawTitle)) continue;
    const before = name.slice(0, name.length - l.lawTitle.length);
    // 「地方法人税法」を「法人税法」と取り違えないよう、直前が漢字・カタカナなら採らない。
    // 「において準用する商業登記法」のように、ひらがなや記号で切れている場合だけ許す。
    if (before && /[一-鿿゠-ヿ]$/.test(before)) continue;
    if (!best) { best = l; continue; }
    if (l.lawTitle.length > best.lawTitle.length) { best = l; ties = 1; continue; }
    if (l.lawTitle.length === best.lawTitle.length) ties++;
  }
  return ties > 1 ? null : best;     // 同じ長さで並ぶなら決め手が無い
}

/** 参照に書かれた法令名のうち、実際の法令名にあたる部分だけを返す */
function trimLawName(name) {
  const law = lawByName(name);
  if (!law) return name;
  for (const t of [law.lawTitle, law.abbrev]) {
    if (t && name.endsWith(t)) return t;
  }
  return name;
}

/**
 * 指定の条項号に一番近い、実在するアンカーを返す。
 * 号だけ指定されて項が無い場合は、その条の下から号を探す。
 */
/*
 * 索引から引きやすい形を一度だけ作って覚えておく。
 *
 * 参照リンクは会社法で4,800本あり、1本ごとに索引6,318件を端から見ていた。
 * 掛け算になるので、開くたびに数百万回の照合が走っていた。
 */
const indexTables = new WeakMap();

function tableOf(index) {
  let t = indexTables.get(index);
  if (t) return t;
  t = { has: new Set(), item: new Map(), arts: new Map() };
  for (const e of index) {
    t.has.add(e.anchor);
    const p = e.anchor.split('/');
    if (p.length === 2) {
      if (!t.arts.has(p[0])) t.arts.set(p[0], []);
      t.arts.get(p[0]).push(p[1]);
    }
    if (p.length === 4) {
      // 項を書かずに号だけ指す書き方のため。複数あるなら決め手が無いので null。
      const k = p[0] + '/' + p[1] + '/' + p[3];
      t.item.set(k, t.item.has(k) ? null : e.anchor);
    }
  }
  indexTables.set(index, t);
  return t;
}

/*
 * 参照の行き先を決める。書いてあるとおりの場所が無ければ諦める。
 * 「第99号」と書いてあるのに条へ飛ばす、という黙った読み替えをしない。
 * 飛んだ先が違うことには、読んでいる側は気づけない。
 */
function bestAnchor(index, scope, art, par, item) {
  const t = tableOf(index);
  const has = a => t.has.has(a);
  if (par && item && has(`${scope}/${art}/${par}/${item}`)) return `${scope}/${art}/${par}/${item}`;
  if (!par && item) {
    // 項を書かずに号だけ指す書き方。同じ号が複数の項にあると決め手が無い。
    // 最初の1件を選ぶと、黙って別の項へ連れて行くことになる。
    return t.item.get(`${scope}/${art}/${item}`) || null;
  }
  if (item) return null;
  if (par && has(`${scope}/${art}/${par}`)) return `${scope}/${art}/${par}`;
  if (par) return null;
  if (has(`${scope}/${art}`)) return `${scope}/${art}`;
  return null;
}

/**
 * 条番号を伴わない参照を、いまの位置から解く。
 *   前条 / 次条 / 前項 / 次項 / 第N項 と、それに付く項・号
 */
function resolveRelative(a, pane) {
  const from = a.dataset.from;
  if (!from) return null;
  const rel = a.dataset.rel;
  const [scope, art, par] = from.split('/');
  const wantPar = a.dataset.par || '';
  const wantItem = a.dataset.item || '';

  let targetArt = art;
  if (rel === '前条' || rel === '次条') {
    // 条は枝番があるので番号の足し算では解けない。並び順で隣を取る。
    const arts = tableOf(pane.index).arts.get(scope) || [];
    const i = arts.indexOf(art);
    if (i < 0) return null;
    targetArt = arts[i + (rel === '前条' ? -1 : 1)];
    if (!targetArt) return null;
  }

  let targetPar = wantPar;
  if (rel === '前項' || rel === '次項') {
    const n = Number(par) + (rel === '前項' ? -1 : 1);
    if (!Number.isFinite(n) || n < 1) return null;
    targetPar = String(n);
  }

  return bestAnchor(pane.index, scope, targetArt, targetPar, wantItem);
}

/**
 * 描画後に参照の行き先を確定する。
 * 実在を確かめられなかったものはリンクを外し、ただの文字に戻す。
 */
function resolveRefs(pane) {
  if (!pane.current) return;
  let live = 0, dropped = 0;

  for (const a of $$('a.ref', pane.el)) {
    let lawId = pane.current.lawId;
    let target = null;

    if (a.dataset.rel) {
      target = resolveRelative(a, pane);
    } else if (a.dataset.law) {
      // 他法令。取り込んでいないものは行き先を確かめられないのでリンクにしない。
      const law = lawByName(a.dataset.law);
      const idx = law && state.indexCache.get(law.lawId);
      if (law && idx) {
        // 附則の番号は法令をまたいで対応しない。他法令の参照は必ず本則で探す。
        const [, art, par, item] = a.dataset.ref.split('/');
        target = bestAnchor(idx, 'M', art, par, item);
        lawId = law.lawId;
      }
    } else {
      const [scope, art, par, item] = a.dataset.ref.split('/');
      target = bestAnchor(pane.index, scope, art, par, item);
      if (scope !== 'M') {
        // 附則の中の裸の「第七百三十八条」は、その附則の条とも本則の条とも読める。
        // 両方にあるなら決め手が無いのでリンクしない。片方だけならそれを指す。
        const inMain = bestAnchor(pane.index, 'M', art, par, item);
        if (target && inMain) target = null;
        else target = target || inMain;
      }
    }

    if (!target) { unwrapRef(a); dropped++; continue; }
    a.dataset.target = lawId + '|' + target;
    a.title = (lawId === pane.current.lawId ? '' : (lawByName(a.dataset.law) || {}).lawTitle + ' ')
      + anchorLabel(target) + '　（Ctrl+クリックで隣の面に開く）';
    live++;
  }
  if (dropped) console.debug(`参照リンク: ${live}件を有効化、${dropped}件は行き先不明のため解除`);
}

/** 参照をたどる。Ctrl/⌘ を押していればもう一方の面に開く。 */
async function followRef(a, toOtherPane) {
  const [lawId, anchor] = (a.dataset.target || '').split('|');
  if (!lawId || !anchor) return;

  if (toOtherPane) {
    if (!state.split) setSplit(true);
    const other = state.panes[P().idx === 0 ? 1 : 0];
    setActivePane(other.idx);
  }
  if (!(await navigate(lawId, anchor))) return;
}

/* ----------------------------------------------------------- 2面の操作 */

/* 狭い画面では上段に ☰ と法令名を並べる。面を切り替えたら name も入れ替える。 */
function syncTopbarLaw() {
  const el = $('#topbar-law');
  if (!el) return;
  const rec = P().current;
  $('.tl-name', el).textContent = (rec && rec.lawTitle) || '';
  /*
   * 施行日。e-Gov のものだけが持つ。
   * 自分で起こしたデータ（ファイル・パック）は「不明」と出す。空欄にすると
   * 「無い」のか「分からない」のか区別が付かない。
   */
  $('.tl-date', el).textContent = !rec ? ''
    : lawOrigin(rec) !== 'egov' ? '施行日不明'
    : rec.enforcementDate ? '施行 ' + rec.enforcementDate : '';

  const dot = $('.tl-dot', el);
  const a = rec && amendOf(rec);
  dot.hidden = !a;
  dot.className = 'tl-dot amend-dot' + (a && a.kind === 'upcoming' ? ' upcoming' : '');
  dot.title = a ? amendTitle(a) : '';
}

function setActivePane(idx) {
  if (!state.split) idx = 0;
  state.active = idx;
  for (const p of state.panes) p.root.classList.toggle('active', p.idx === idx);
  hideSlashBar();
  syncTopbarLaw();
  syncFindPlaceholder();
  renderLawList();
  renderToc();
  // 「この法令」の指す先が変わるので、結果を出し直す。
  // 表示だけ更新すると、別の法令の結果を今の法令のものとして見せてしまう。
  if (find.q && find.where === 'law') doFind();
  else renderFindList();
}

function setSplit(on) {
  state.split = !!on;
  const second = state.panes[1];
  second.root.hidden = !on;
  $('#split-panes').hidden = !on;
  $('#panes').classList.toggle('split', !!on);
  $('#btn-split').classList.toggle('on', !!on);
  if (!on) setActivePane(0);
  try { localStorage.setItem('roppo.split', on ? '1' : '0'); } catch (e) { /* 任意 */ }
  for (const p of livePanes()) { measureHeadings(p); updateCrumb(p); }
}

/** 仕切りをドラッグして幅を変える */
function wireSplitter(el, onMove) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = ev => onMove(ev.clientX);
    const up = ev => {
      el.releasePointerCapture(ev.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      for (const p of livePanes()) { measureHeadings(p); updateCrumb(p); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function wirePanes() {
  state.panes = [makePane(0), makePane(1)];

  // 触った面を操作対象にする
  for (const p of state.panes) {
    /*
      * 打ち消さないことを宣言しておく。
      *
      * スクロールを止めるかどうかは touch-action で決まるので、これを
      * 付けたから速くなる、という類のものではない（そう書いていたが誤り）。
      * 実際に打ち消さない監視は、そう宣言しておくのが素直というだけ。
      */
    p.root.addEventListener('pointerdown', () => {
      if (state.split && P() !== p) setActivePane(p.idx);
    }, { passive: true });
    /*
     * スクロールは指を滑らせている間ずっと飛んでくる（iOS で毎秒60回ほど）。
     * そのたびに帯を作り直し、目次を全部舐めていたので、長い法令ほど
     * 指に付いてこなくなっていた。1フレームに1回までにする。
     */
    p.el.addEventListener('scroll', () => {
      hideTip();
      if (p === P()) { clearTimeout(p._t); p._t = setTimeout(rememberPos, 300); }
      if (p._raf) return;
      p._raf = requestAnimationFrame(() => {
        p._raf = 0;
        positionPopover();
        updateCrumb(p);
      });
    }, { passive: true });
  }

  $('#btn-split').onclick = () => setSplit(!state.split);

  // 左ペインの幅
  const side = $('#pane-laws');
  let sideW = 268;
  try { sideW = Number(localStorage.getItem('roppo.sideWidth')) || 268; } catch (e) { /* 任意 */ }
  const setSideWidth = w => {
    sideW = Math.max(180, Math.min(520, w));
    document.documentElement.style.setProperty('--side-width', sideW + 'px');
    try { localStorage.setItem('roppo.sideWidth', String(sideW)); } catch (e) { /* 任意 */ }
  };
  setSideWidth(sideW);
  wireSplitter($('#split-side'), x => setSideWidth(x - side.getBoundingClientRect().left));

  // 2面の配分
  let ratio = 50;
  try { ratio = Number(localStorage.getItem('roppo.paneRatio')) || 50; } catch (e) { /* 任意 */ }
  const setRatio = r => {
    ratio = Math.max(20, Math.min(80, r));
    state.panes[0].root.style.flex = `${ratio} 1 0`;
    state.panes[1].root.style.flex = `${100 - ratio} 1 0`;
    try { localStorage.setItem('roppo.paneRatio', String(ratio)); } catch (e) { /* 任意 */ }
  };
  setRatio(ratio);
  wireSplitter($('#split-panes'), x => {
    const box = $('#panes').getBoundingClientRect();
    setRatio(((x - box.left) / box.width) * 100);
  });

  let wantSplit = false;
  try { wantSplit = localStorage.getItem('roppo.split') === '1'; } catch (e) { /* 任意 */ }
  // 狭い画面では2面に割るボタンを隠している。記憶した状態を復元すると、
  // 戻す手段が無いまま2面のままになる。
  if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) wantSplit = false;
  setSplit(wantSplit);
}

/* ------------------------------------------------------------ 絞り込み */

/*
 * 印を付けたところだけを、本文の形のまま残す。
 *
 * 抜粋を別画面に並べるより、条文の順に、前後の見出しごと読める方がよい。
 * ただし二つ、譲れないことがある。
 *
 *   1. 絞り込み中はそれと分かる帯を必ず出す。法令の一部しか出ていないのに
 *      全部だと思って読むのが、この道具で起こりうる一番まずいことである。
 *   2. 次に開いたときは全文に戻す。書体や文字の大きさと違って、これを
 *      持ち越すと、気づかないまま欠けた法令を読むことになる。
 *      だから view（localStorage に残る設定）には入れない。
 *
 * 隠す単位は「条」にしてある。条番号は第1項の中に置かれているので、
 * 項だけを残すと番号が消えて、何条か分からない条文が並ぶ。
 */

/** その絞り込みに合う注釈のアンカーを集める。 */
function filterAnchors(pane) {
  const f = pane.filter;
  const lawId = pane.current && pane.current.lawId;
  const out = new Set();
  if (!f || !lawId) return out;

  for (const n of state.notes.values()) {
    if (n.lawId !== lawId) continue;
    const hit = f.tag
      ? (n.tags || []).includes(f.tag)
      : !!(n.color || (n.tags || []).length
        || String(n.summary || '').trim() || String(n.memo || '').trim());
    if (hit) out.add(n.anchor);
  }
  // 文言に付けたものは、タグを持たない。「印のあるもの」のときだけ数える。
  if (!f.tag) {
    for (const r of state.ranges.values()) {
      if (r.lawId === lawId) out.add(r.anchor);
    }
  }
  return out;
}

function applyFilter(pane) {
  pane = pane || P();
  const banner = $('.law-filter', pane.root);
  const kids = [...pane.el.children];
  for (const el of kids) el.classList.remove('filtered-out');

  if (!pane.filter || !pane.current) {
    banner.hidden = true;
    return 0;                 // 見出しの測り直しは呼ぶ側でする（openLaw で二度走っていた）
  }

  /*
   * 注釈のアンカーから、それを含む塊のアンカーを先に作っておく。
   * 塊ごとに注釈を全部見比べると、条数 × 注釈数の掛け算になる。
   */
  const want = new Set();
  for (const a of filterAnchors(pane)) {
    const p2 = a.split('/');
    for (let i = 1; i <= p2.length; i++) want.add(p2.slice(0, i).join('/'));
  }
  const levelOf = new Map(pane.toc.map(e => [e.id, e.level]));

  // 条・前文・別表・附則直下の項など、本文の塊ごとに見せるかを決める
  const show = new Map();
  let shown = 0;
  for (const el of kids) {
    const a = el.dataset && el.dataset.anchor;
    if (!a) { show.set(el, false); continue; }
    const hit = want.has(a);
    show.set(el, hit);
    if (hit) shown++;
  }

  // 見出しは、その下に残るものがあるときだけ出す。
  // 見出しだけが並ぶのも、見出しが消えて文脈が切れるのも困る。
  const stack = [];
  for (const el of kids) {
    if (levelOf.has(el.id)) {
      const lv = levelOf.get(el.id);
      while (stack.length && levelOf.get(stack[stack.length - 1].id) >= lv) stack.pop();
      stack.push(el);
    } else if (show.get(el)) {
      for (const h of stack) show.set(h, true);
    }
  }

  for (const el of kids) if (!show.get(el)) el.classList.add('filtered-out');

  const name = pane.filter.tag ? `タグ「${pane.filter.tag}」` : '印のあるもの';
  banner.hidden = false;
  banner.innerHTML = `<span>${esc(name)}で絞り込み中　${shown}件</span>`;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '全文に戻す';
  b.onclick = () => setFilter(null, pane);
  banner.appendChild(b);
  return shown;
}

function setFilter(f, pane) {
  pane = pane || P();
  pane.filter = f;
  applyFilter(pane);
  measureHeadings(pane);      // 隠すと位置が変わる
  pane.el.scrollTop = 0;      // 絞ると並びが変わる。前の位置に意味がない。
  updateCrumb(pane);
  renderFilterPicker();
}

/** 表示設定の中の選び口。いま開いている法令に実際にあるタグだけ出す。 */
function renderFilterPicker() {
  const box = $('#filter-picker');
  if (!box) return;
  const pane = P();
  box.innerHTML = '';

  const add = (label, f, on) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (on) b.classList.add('on');
    b.onclick = () => setFilter(f, pane);
    box.appendChild(b);
  };

  add('すべて', null, !pane.filter);
  if (!pane.current) return;

  const lawId = pane.current.lawId;
  let marked = 0;
  const tags = new Map();
  for (const n of state.notes.values()) {
    if (n.lawId !== lawId) continue;
    if (n.color || (n.tags || []).length
      || String(n.summary || '').trim() || String(n.memo || '').trim()) marked++;
    for (const t of (n.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);
  }
  for (const r of state.ranges.values()) if (r.lawId === lawId) marked++;

  if (marked) add('印のあるもの', { marked: true }, !!(pane.filter && !pane.filter.tag));
  for (const [t] of [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))) {
    add(t, { tag: t }, !!(pane.filter && pane.filter.tag === t));
  }
}

/* ------------------------------------------------- 移動の履歴と読書位置 */

const lastPos = new Map();      // lawId -> scrollTop
let hist = [];                  // { lawId, anchor, scrollTop }
let hi = -1;                    // hist の現在位置
let navigating = false;         // 履歴を辿っている最中は記録しない

function loadLastPos() {
  try {
    const o = JSON.parse(localStorage.getItem('roppo.pos') || '{}');
    for (const [k, v] of Object.entries(o)) lastPos.set(k, v);
  } catch (e) { /* 任意 */ }
}

function rememberPos() {
  if (!P().current) return;
  // 絞り込み中の位置は、全文で開き直したときには別の場所を指す。覚えない。
  if (P().filter) return;
  const top = P().el.scrollTop;
  lastPos.set(P().current.lawId, top);
  // 履歴は面をまたいで1本なので、同じ法令・同じ面のときだけ書き戻す。
  // これを見ないと、片方の面の位置がもう片方の履歴に入る。
  const e = hi >= 0 ? hist[hi] : null;
  if (e && e.lawId === P().current.lawId && e.pane === P().idx) e.scrollTop = top;
  try {
    localStorage.setItem('roppo.pos', JSON.stringify(Object.fromEntries(lastPos)));
  } catch (e) { /* 任意 */ }
}

function pushHist(entry) {
  if (entry.pane === undefined) entry.pane = P().idx;
  hist = hist.slice(0, hi + 1);
  const prev = hist[hi];
  // 同じ場所を連続して積まない
  if (prev && prev.lawId === entry.lawId && prev.anchor === entry.anchor
    && prev.pane === entry.pane) return;
  hist.push(entry);
  hi = hist.length - 1;
  updateNavButtons();
}

function updateNavButtons() {
  $('#btn-back').disabled = hi <= 0;
  $('#btn-fwd').disabled = hi < 0 || hi >= hist.length - 1;
}

/*
 * 狭い画面では左ペインが画面を覆うドロワーになる。開いている間は
 * ☰ も条文も隠れるので、行き先を選んだら閉じる。
 */
function setDrawer(open) {
  $('#pane-laws').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}

/* 画面が狭いかどうか。検索欄の置き場所とドロワーの扱いがここで変わる。 */
const narrowMQ = window.matchMedia ? window.matchMedia('(max-width: 800px)') : null;
function narrow() { return !!(narrowMQ && narrowMQ.matches); }

/* シートの中のどちらを出すか。番号で引くのが既定。 */
function switchSheetTab(name) {
  for (const b of $$('#sheet-tabs button')) b.classList.toggle('on', b.dataset.sheet === name);
  $('#sheet-jump').hidden = name !== 'jump';
  $('#sheet-find').hidden = name !== 'find';
  try { localStorage.setItem('roppo.sheetTab', name); } catch (e) { /* 任意 */ }
}

function setSheet(open, which) {
  if (which) switchSheetTab(which);
  $('#lookup-sheet').hidden = !open;
  $('#btn-lookup-fab').classList.toggle('on', open);
  if (!open) return;
  const jump = !$('#sheet-jump').hidden;
  if (jump) updateJumpPreview();
  $(jump ? '#jump-input' : '#find-input').focus();
}

/*
 * 狭い画面には上段に全部を並べる余地がない。片手で持つと上段は遠いので、
 * よく使うものを下へ移す。
 *
 *   上段   ☰ と法令名だけ
 *   下段   戻る・進む／表示設定／引く
 *   シート 番号の欄（テンキー）と検索の欄
 *
 * 作りを二重に持たない。同じ入力欄やボタンが2つあると、どちらを押したかで
 * 挙動が変わる。要素そのものを動かす。
 */
function placeControls() {
  const jump = $('.jump'), find = $('.find'), panel = $('#panel-find');
  const nav = $('.nav'), view = $('.view'), bar = $('#bottombar');
  const pad = $('#keypad'), input = $('#jump-input');

  bar.hidden = !narrow();

  if (narrow()) {
    if (nav.parentElement !== bar) {
      bar.prepend(nav);                       // 左端に戻る・進む
      bar.insertBefore(view, $('#btn-lookup-fab'));   // 右端の「引く」の手前
    }
    if (jump.parentElement !== $('#sheet-jump')) {
      $('#sheet-jump').append(jump);
      $('#sheet-find').append(panel, find);
    }
    pad.hidden = false;           // シートでは盤を常に出す。切替ボタンは隠してある
    input.inputMode = 'none';     // 盤が目の前にあるので、端末のキーボードは出さない
    panel.hidden = false;         // シートの中では常に中身を出す
    $('#tab-find').hidden = true;
    if ($('#tab-find').classList.contains('on')) switchTab('laws');
  } else {
    if (jump.parentElement !== $('.topbar')) {
      // 上段の並びは ← → / 番号 / 2面 / 表示 の順に戻す
      $('.topbar').insertBefore(jump, $('#btn-split'));
      $('.topbar-head').appendChild(nav);     // 戻る・進むは左ゾーンへ
      $('.topbar').appendChild(view);
      $('#pane-laws').insertBefore(panel, $('#panel-marks'));
    }
    // ことばの欄は、結果と同じ場所（検索タブの中）に置く
    if (find.parentElement !== panel) panel.insertBefore(find, panel.firstChild);
    input.inputMode = 'numeric';
    try { pad.hidden = localStorage.getItem('roppo.pad') !== '1'; } catch (e) { pad.hidden = true; }
    $('#tab-find').hidden = false;
    setSheet(false);
    setDrawer(false);       // 覆いが残ると、広い画面では画面全体を塞ぐ
    const on = $('.tabs button[data-tab].on');
    switchTab(on ? on.dataset.tab : 'laws');
  }
}

/* 行き先が決まったら、覆っているものをどける。 */
function closeDrawerAfterJump() {
  if (!narrow()) return;
  setDrawer(false);
  setSheet(false);
}

/** 移動の入口。法令内でも法令をまたいでも、ここを通れば履歴に残る。 */
/**
 * 法令へ移る。**着いた法令IDを返す。開けなければ null。**
 *
 * 返り値を見ずに編集を開くと、開けなかったときに別の法令を触ることになる
 * （理由は openLaw の注記）。移った先で何かするなら、必ず確かめる。
 */
async function navigate(lawId, anchor) {
  rememberPos();
  closeDrawerAfterJump();
  if (!P().current || P().current.lawId !== lawId) {
    if (!(await openLaw(lawId, anchor))) return null;
  } else if (anchor) scrollToAnchor(anchor, false);
  if (!navigating) pushHist({ lawId, anchor: anchor || null, scrollTop: P().el.scrollTop });
  return lawId;
}

async function goHistory(delta) {
  const to = hi + delta;
  if (to < 0 || to >= hist.length) return;
  rememberPos();
  navigating = true;
  hi = to;
  const e = hist[hi];
  try {
    // 記録したときの面に戻す
    if (state.split && e.pane !== undefined && e.pane !== state.active) setActivePane(e.pane);
    if (!P().current || P().current.lawId !== e.lawId) await openLaw(e.lawId, e.anchor, e.scrollTop);
    else if (e.anchor) scrollToAnchor(e.anchor, false);
    else P().el.scrollTop = e.scrollTop || 0;
    if (!e.anchor && typeof e.scrollTop === 'number') P().el.scrollTop = e.scrollTop;
  } finally {
    navigating = false;
  }
  updateNavButtons();
  updateCrumb();
}

/* --------------------------------------------------------- 現在位置の表示 */

function measureHeadings(pane) {
  pane = pane || P();
  pane.headOffsets = pane.toc.map(e => {
    const el = $('#' + e.id, pane.el);
    return el ? { ...e, top: el.offsetTop } : null;
  }).filter(Boolean);
  pane.articleOffsets = $$('.article[data-anchor]', pane.el)
    .map(el => ({ anchor: el.dataset.anchor, top: el.offsetTop }));
}

function lastAtOrBefore(list, y) {
  let lo = 0, hi2 = list.length - 1, found = null;
  while (lo <= hi2) {
    const mid = (lo + hi2) >> 1;
    if (list[mid].top <= y) { found = list[mid]; lo = mid + 1; }
    else hi2 = mid - 1;
  }
  return found;
}

let tocCurrent = null;      // 目次でいま光っている項目

function updateCrumb(pane) {
  pane = pane || P();
  const crumb = pane.crumb;
  const heads = pane.headOffsets;
  if (!pane.current || !heads.length) { crumb.hidden = true; return; }
  const y = pane.el.scrollTop + 24;

  const here = lastAtOrBefore(heads, y);
  if (!here) { crumb.hidden = true; return; }

  // 自分より浅い見出しを遡って親を集める
  const chain = [here];
  let need = here.level;
  for (let i = heads.indexOf(here) - 1; i >= 0 && need > 1; i--) {
    const e = heads[i];
    if (e.level && e.level < need) { chain.unshift(e); need = e.level; }
  }

  const art = lastAtOrBefore(pane.articleOffsets, y);

  /*
   * 指を滑らせている間、ほとんどのフレームでは同じ見出し・同じ条のままである。
   * 変わっていないなら何もしない。作り直しと目次の塗り替えが丸ごと消える。
   */
  const sig = here.id + '|' + (art ? art.anchor : '');
  if (pane._crumbSig === sig && !crumb.hidden) return;
  pane._crumbSig = sig;
  const parts = chain.map((e, i) =>
    `<span class="${i === chain.length - 1 && !art ? 'here' : ''}">${esc(e.title)}</span>`);

  /*
   * 編・章・節の道筋と、いまの条を分けて包む。
   * 狭い画面では二段にして、条を必ず下の段に出す。まとめて一行にすると、
   * あふれたときに右端＝いまの条が切れる。一番知りたいものが消える。
   */

  crumb.innerHTML = `<span class="crumb-path">${parts.join('<span class="sep">›</span>')}</span>`
    + (art ? `<span class="crumb-art here">${esc(anchorLabel(art.anchor))}</span>` : '');
  crumb.hidden = false;

  /*
   * 目次の現在位置は、操作している面にだけ追随させる。
   * 全部を舐めると、民法で384件・会社法で592件を毎回触ることになる。
   * 外す1件と付ける1件だけを触る。
   */
  if (pane === P()) {
    if (tocCurrent && tocCurrent.isConnected) tocCurrent.classList.remove('current');
    tocCurrent = $(`#toc-list li[data-id="${CSS.escape(here.id)}"]`);
    if (tocCurrent) tocCurrent.classList.add('current');
  }
}

/**
 * 指定の条文へ移動する。
 * edit:false のときは枠を出すだけで注釈パネルを開かない。
 * 条文を引いた直後に見たいのは本文であって、編集欄ではないため。
 */
/*
 * 滑らせるか、瞬間で移るか。
 *
 * 近い先へ滑らせるのは役に立つ。どちらへどれだけ動いたかが目で追えるので、
 * いま条文のどこにいるかの見当が保てる。
 *
 * しかし1条から709条のような距離を滑らせると、700条ぶんの本文がただ流れる
 * だけで、そこから何も読み取れない。時間もかかり、目も疲れる。1画面半より
 * 遠ければ瞬間で移る。番号で引くときはほとんどこちらになる。
 *
 * 端末で「動きを控える」を選んでいる人には、距離を問わず瞬間で移る。
 */
const SMOOTH_LIMIT = 1.5;               // 面の高さの何倍まで滑らせるか

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function behaviorForDistance(dist, viewH) {
  if (reducedMotion()) return 'auto';
  if (!viewH) return 'smooth';          // 高さが取れない場面では今までどおり
  return dist > viewH * SMOOTH_LIMIT ? 'auto' : 'smooth';
}

/*
 * 飛び先を画面のどこに置くか。
 *
 * 前は scrollIntoView({ block: 'center' }) を使い、「要素の真ん中」を画面の
 * 真ん中に合わせていた。しかし前メモ・後メモ・タグはその要素の中に入るので、
 * メモを書くほど要素が縦に伸び、真ん中が下がる。そのぶん条番号は上へずれる。
 * メモが画面より長くなると、条番号は画面の外へ出てしまう。
 *
 * 狙うのは要素の真ん中ではなく、その塊の先頭である。上端を面の高さの 22% の
 * ところに置く。上に少し残すのは、直前の条文が見えている方が位置の見当が
 * 付くからで、上端ぴったりに付けるとマークの●（left:-.95em）も窮屈になる。
 *
 * 後メモを何行書いても飛び先は動かない。ただし「条番号がいつも同じ高さ」では
 * ない。条に付けた前メモは第1項より前に入るので、そこが長い条では条番号は
 * そのぶん下に来る（Codex の指摘）。動かないのは塊の上端である。
 */
const JUMP_LEAD = 0.22;        // 飛び先の上端を、面の高さの何割のところに置くか

/** 飛び先の上端 y を、面のどこに置くか。負にはしない。 */
function jumpTopFor(y, viewH) {
  return Math.max(0, y - viewH * JUMP_LEAD);
}

/** 面の中で、その要素まで何 px 送ればよいか */
function scrollTopFor(el, pane) {
  const box = pane.el.getBoundingClientRect();
  const to = el.getBoundingClientRect();
  // いまの送り量に、面の上端から要素の上端までの差を足すと、要素の絶対位置になる
  return jumpTopFor(pane.el.scrollTop + (to.top - box.top), box.height);
}

/** 飛ぶ。滑らせるかどうかは、実際に送る距離で決める。 */
function scrollPaneTo(top, pane) {
  pane.el.scrollTo({
    top,
    behavior: behaviorForDistance(Math.abs(top - pane.el.scrollTop), pane.el.clientHeight),
  });
}

function scrollToAnchor(anchor, edit, pane) {
  pane = pane || P();
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, pane.el);
  if (!el) return false;
  // 絞り込みで隠れている先へ飛ぶときは、黙ってではなく全文に戻してから飛ぶ。
  // 隠れたままスクロールしても、画面は何も起きていないように見える。
  if (pane.filter && el.closest('.filtered-out')) {
    setFilter(null, pane);
    toast('全文に戻しました');
  }
  scrollPaneTo(scrollTopFor(el, pane), pane);
  selectAnchor(anchor, edit, pane);
  return true;
}

async function selectAnchor(anchor, edit, pane) {
  pane = pane || P();
  if (pane !== P()) setActivePane(pane.idx);
  await flushSave();
  $$('.sel').forEach(e => e.classList.remove('sel'));
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, pane.el);
  if (el && selBoxOn()) el.classList.add('sel');
  state.selected = anchor;
  if (edit) openPopover();
  else closePopoverKeepSelection();
}

/* ---------------------------------------------- ファイルから取り込む */

/*
 * e-Gov に無い法令を、法令標準XMLのファイルから取り込む。
 *
 * 最高裁判所規則（民事訴訟規則・刑事訴訟規則など）と議院規則は、e-Gov に
 * 1件も入っていない。内閣が公布するものではないためと思われるが、e-Gov 自身の
 * 法令種別の説明にはこれらのコードがあるので、理由は確かめられていない。
 *
 * 取り込んだものは e-Gov 由来と同じようには扱わない。いつの版なのか、
 * 公布済みの改正がどこまで入っているのかが、こちらからは分からないからである。
 *   ・一覧と本文に「取り込み」の印を出す
 *   ・改正の確認（e-Gov への問い合わせ）の対象から外す
 *   ・施行日は空にせず「不明」と出す。空欄は「無い」のか「分からない」のか
 *     区別が付かない
 */

const LOCAL_PREFIX = 'LOCAL_';

/*
 * 取り込むXMLの先頭のコメントから、来歴を読む。
 *
 * e-Gov から取ったものは、いつの版かが API の返す値で分かる。しかし自分で
 * 起こしたデータは、どこから作ったのか・どの改正まで入っているのか・何を
 * 含んでいないのかが、ファイルの外にしか無い。外に置くと必ず失われる。
 * ファイルの中のコメントに書いておけば、書き出しても復元しても一緒に残る。
 *
 *   <!--
 *     出典: 公的機関の法令データベース（日本語版）
 *     反映: 令和七年最高裁判所規則第一一号 まで
 *     範囲: 本則のみ（316条）。附則は含まない
 *   -->
 *
 * 「行頭のラベル: 中身」の形だけを読む。決めた名前以外は拾わない。
 * 取り込むファイルの中身を、そのまま画面に出すことになるからである。
 */
const PROV_KEYS = ['出典', 'URL', '取得', '反映', '範囲', '変換'];

function readProvenance(doc) {
  const out = {};
  const scan = parent => {
    for (const n of parent.childNodes) {
      if (n.nodeType !== 8) continue;                  // コメント以外は見ない
      for (const line of String(n.nodeValue).split('\n')) {
        const m = line.match(/^\s*([^\s:：]+)\s*[:：]\s*(.+?)\s*$/);
        if (m && PROV_KEYS.includes(m[1]) && !out[m[1]]) out[m[1]] = m[2].slice(0, 200);
      }
    }
  };
  scan(doc);
  const law = doc.querySelector('Law');
  if (law) scan(law);
  return Object.keys(out).length ? out : null;
}

/*
 * 取り込むXMLの LawNum は、そのまま信じられない。市販アプリの書き出しは
 * ここにアプリ内部のIDを入れている。法令番号の形をしているときだけ使う。
 */
/*
 * 「令和元年」のように、元号の最初の年は「元」と書く（「一年」とは書かない）。
 * 令和元年最高裁判所規則も実在するので、年のところだけ「元」を許す。
 * これは法令番号の真正性を保証するものではなく、市販アプリが入れてくる
 * 内部IDを除くための形の検査である。
 */
const LAW_NUM_RE = /^(明治|大正|昭和|平成|令和)(?:元|[〇一二三四五六七八九十百千]+)年.{1,14}第[〇一二三四五六七八九十百千]+号$/;

function lawNumOf(doc) {
  const el = doc.querySelector('LawNum');
  const t = el ? el.textContent.trim() : '';
  return LAW_NUM_RE.test(t) ? t : '';
}

/*
 * 市販アプリの書き出しには、注釈付きだと妥当な XML にならないものがある。
 * 既知の壊れ方は2つで、どちらも直せば標準のパーサで読める。
 *   ・XML 宣言が `?>` ではなく `>` で終わる
 *   ・notes 属性が単引用で始まり二重引用で閉じる
 */
function repairExportXml(text) {
  let t = String(text).replace(/^\uFEFF/, '');
  t = t.replace(/^<\?xml([^>]*?)\??>/, '<?xml$1?>');
  t = t.replace(/notes='([^'"]*)"/g, 'notes="$1"');
  return t;
}

/** アプリ独自の注釈要素を外す。条文だけを残す。 */
function stripAppElements(doc) {
  let n = 0;
  for (const tag of ['Highlight', 'HighlightEnd', 'Bookmark', 'BookmarkNotes']) {
    for (const el of [...doc.getElementsByTagName(tag)]) { el.remove(); n++; }
  }
  return n;
}

/*
 * 法令標準XMLのファイルを1本取り込む。
 *
 * opts.defer を渡すと、一覧の作り直しと画面の開き直しをしない。まとめて
 * 取り込むときに、1本ごとに7回描き直すのを避けるためである（importLawFiles）。
 */
async function importLawFile(file, opts) {
  const raw = await file.text();
  let doc;
  try {
    doc = parseXML(repairExportXml(raw));
  } catch (e) {
    throw new Error('XML として読めません（法令標準XMLのファイルを選んでください）');
  }

  const lawEl = doc.querySelector('Law');
  if (!lawEl) throw new Error('Law 要素がありません');
  const stripped = stripAppElements(doc);

  const titleEl = lawEl.querySelector('LawTitle');
  const lawTitle = titleEl ? titleEl.textContent.trim() : '';
  if (!lawTitle) throw new Error('法令名（LawTitle）がありません');

  // 描いてみて、中身を確かめてから取り込む。読めないものを抱え込まない。
  const { index } = renderLaw(lawEl);
  if (!index.length) throw new Error('条文が1件も読み取れません');

  /*
   * 同じアンカーを指す場所が複数ないか調べる。
   *
   * 注釈の位置はアンカーで持つので、重なっていると「どちらに付けたのか」が
   * 決まらない。黙って取り込むと、あとで別の条に付いているように見える。
   *
   * 元データを直して重なりを解くことはしない。たとえば民事訴訟規則の附則には、
   * 見出し（（施行期日）など）が独立した項として入っていて、本物の項と番号が
   * 重なっている。これを推測で畳むのは、法令を正確に表すという原則を一番
   * 危うくする。見つけたことを知らせるだけにする。
   */
  const seen = new Map();
  for (const e of index) seen.set(e.anchor, (seen.get(e.anchor) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([a]) => a);

  const rec = {
    lawId: LOCAL_PREFIX + lawTitle,
    lawTitle,
    lawNum: lawNumOf(doc),         // 法令番号の形をしているときだけ使う（上の LAW_NUM_RE）
    source: 'file',
    importedAt: today(),
    provenance: readProvenance(doc),
    dupAnchors: dup,
    xml: new XMLSerializer().serializeToString(doc),
    savedAt: Date.now(),
  };
  await store.putLaw(rec);
  /*
   * 同じ名前で取り込み直したとき、lawId が同じなので navigate は
   * 開き直さない。DBだけ新しくなって画面は古いまま、という状態になる。
   * 「取り込みました」と出るので、新しい本文だと思い込む。
   */
  state.indexCache.delete(rec.lawId);
  rec.strippedMarks = stripped;        // 通知でまとめて数えるため、記録に残す
  /*
   * ここで返すと、一覧の作り直しと画面の開き直しは呼び側がやる。
   * まとめて取り込むとき、1本ごとに描き直すのを避けるため（importLawFiles）。
   * 渡されなければ、下で1本ぶんの後始末をする。
   */
  if (opts && opts.defer) return rec;

  await finishImport([rec], []);
  return rec;
}

/*
 * 取り込んだあとの後始末と通知。1本でもまとめてでも、ここだけを通る。
 *
 * 前は単体とまとめで同じ処理を二重に書いていた。文言が違うので、片方だけ
 * 直して気づかない、という形になりやすい（Codex の指摘）。
 *
 * 保存はもう終わっている。ここから先で失敗しても、保存できた件数と
 * 読めなかったファイル名は必ず知らせる。以前はここで例外が出ると報告ごと
 * 失われ、何件入ったのか分からなくなっていた。
 */
async function finishImport(done, failed) {
  let refreshFailed = '';
  try {
    await refreshLawList();
    // 開いている面が取り込み直した法令を見ているなら、新しい本文に入れ替える
    for (const pane of livePanes()) {
      if (pane.current && done.some(r => r.lawId === pane.current.lawId)) {
        await openLaw(pane.current.lawId, null, 0, pane);
      }
    }
    if (done.length) await navigate(done[done.length - 1].lawId);
  } catch (err) {
    refreshFailed = err && err.message ? err.message : String(err);
  }

  /*
   * 知らせることは4つ。取り込めたもの、読めなかったもの、外した注釈の印、
   * 位置の重なり。重なりは法令名を挙げる。件数だけでは、どれを気にすべきか
   * 分からない。
   */
  const dup = done.filter(r => (r.dupAnchors || []).length);
  const marks = done.reduce((n, r) => n + (r.strippedMarks || 0), 0);
  const parts = [];
  if (done.length) {
    parts.push(done.length === 1
      ? '「' + done[0].lawTitle + '」を取り込みました'
      : done.length + '件を取り込みました');
  }
  if (failed.length) parts.push('読めなかったもの: ' + failed.join('、'));
  if (marks) parts.push('注釈の印 ' + marks + '件は外しました');
  if (dup.length) {
    parts.push(done.length === 1
      ? '同じ位置を指す条項が ' + dup[0].dupAnchors.length + '件あります'
      : '位置の重なりあり: ' + dup.map(r => r.lawTitle).join('、'));
  }
  // 保存はできている。画面が追いついていないだけだと分かるように書く
  if (refreshFailed) parts.push('保存はできましたが画面の更新に失敗しました（' + refreshFailed + '）');
  if (!parts.length) parts.push('取り込めるものがありませんでした');
  toast(parts.join('　/　'));
  return refreshFailed;
}

/*
 * まとめて取り込む。
 *
 * 規則のように、何本かを一度に用意することがある。1本ずつ選ばせると
 * その回数だけ操作させることになる。
 *
 * 1本ごとに一覧を作り直したり画面を開き直したりはしない。7本なら7回
 * 描き直すことになる。最後に一度だけまとめてやる。
 *
 * 途中で読めないものがあっても、残りは続ける。1本のために他を捨てる理由がない。
 * 読めなかったものは名前を挙げて知らせる。黙って数を減らさない。
 */
async function importLawFiles(files) {
  const list = [...files];
  const done = [], failed = [];
  for (const f of list) {
    try {
      done.push(await importLawFile(f, { defer: true }));
    } catch (err) {
      failed.push((f.name || 'ファイル') + '（' + err.message + '）');
    }
  }

  const refreshFailed = await finishImport(done, failed);
  return { done, failed, refreshFailed };
}

/* -------------------------------------------------------------- 改正の追従 */

/*
 * 手元の法令に改正が出ていないかを e-Gov に問い合わせ、名前の横に印を出す。
 *
 *   塗りつぶし  手元より新しい版がすでに施行されている
 *   輪郭だけ    改正は公布されたが、まだ施行されていない
 *
 * 未施行のものも出すのは、読んでいる条文が近く変わると分かっていることに
 * 意味があるからである。改正を知らずに古い条文で考えるのが一番まずい。
 *
 * 結果は localStorage に置く。法令そのものではなく、問い合わせて分かった
 * ことに過ぎないので、消えても取り直せる。バックアップにも入れない。
 */
const AMEND_KEY = 'roppo.amend';
let amendState = {};

function loadAmendState() {
  try { amendState = JSON.parse(localStorage.getItem(AMEND_KEY) || '{}'); }
  catch (e) { amendState = {}; }
}

function saveAmendState() {
  try { localStorage.setItem(AMEND_KEY, JSON.stringify(amendState)); } catch (e) { /* 任意 */ }
}

function ymdOf(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function today() { return ymdOf(Date.now()); }

/* 1法令ぶんの判定。通信できないときは何も言わない（黙って古い印を残す）。 */
async function checkAmendment(law) {
  const revs = await apiRevisions(law.lawId);
  if (!revs.length) return null;

  const now = today();
  const enforced = revs.filter(r => r.amendment_enforcement_date && r.amendment_enforcement_date <= now);
  const future = revs.filter(r => r.amendment_enforcement_date && r.amendment_enforcement_date > now);

  // 施行済みのうち一番新しいもの＝いま効いている版
  enforced.sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? -1 : 1));
  const latest = enforced[enforced.length - 1];

  // 取り込んだときの版が分からない古い記録は、施行日で見比べる
  const behind = latest && (law.lawRevisionId
    ? latest.law_revision_id !== law.lawRevisionId
    : !!(law.enforcementDate && latest.amendment_enforcement_date > law.enforcementDate));

  const rev = law.lawRevisionId || '';           // どの版について調べたか
  if (behind) {
    return {
      kind: 'behind', rev,
      date: latest.amendment_enforcement_date,
      title: latest.amendment_law_title || '',
      at: Date.now(),
    };
  }

  future.sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? -1 : 1));
  if (future.length) {
    return {
      kind: 'upcoming', rev,
      date: future[0].amendment_enforcement_date,
      title: future[0].amendment_law_title || '',
      at: Date.now(),
    };
  }
  return { kind: 'none', rev, at: Date.now() };
}

/* 全法令ぶん。1日に1度でよいので、呼び出し側で間隔を見る。 */
async function checkAmendments(loud) {
  /*
   * 固定版（`<法令ID>@<版ID>`）は e-Gov の法令IDではないので問い合わせない。
   * その版はその版として固定したものなので、新しい版を知らせる意味もない。
   *
   * 出どころが e-Gov のものだけに問い合わせる。前は「file でなければ」と
   * 書いていたので、規則パックのものが pack-<sha256> を e-Gov に投げていた。
   * 「取り込んだものは e-Gov に無いので答えが返らない」という理由がそのまま
   * パックにも当てはまるのに、条件がそれを拾えていなかった（Codex の指摘3）。
   */
  const targets = state.laws.filter(l => !l.revisionOf && lawOrigin(l) === 'egov');
  if (!targets.length) { if (loud) toast('取り込んだ法令がありません'); return; }
  let behind = 0, upcoming = 0, failed = 0;

  for (const law of targets) {
    try {
      const r = await checkAmendment(law);
      // 問い合わせている間に消された・取り込み直された場合は書き戻さない
      const now = state.laws.find(l => l.lawId === law.lawId);
      if (!now || (now.lawRevisionId || '') !== (law.lawRevisionId || '')) continue;
      if (r) {
        amendState[law.lawId] = r;
        if (r.kind === 'behind') behind++;
        if (r.kind === 'upcoming') upcoming++;
      }
    } catch (e) {
      failed++;                    // 圏外・通信断。黙って前の印を残す
    }
  }
  // 手元に無くなった法令の判定は捨てる
  for (const id of Object.keys(amendState)) {
    if (!state.laws.some(l => l.lawId === id)) delete amendState[id];
  }
  saveAmendState();
  try { localStorage.setItem('roppo.amendCheckedAt', String(Date.now())); } catch (e) { /* 任意 */ }
  renderLawList();
  syncTopbarLaw();

  if (!loud) return;
  if (failed === targets.length) { toast('e-Gov に問い合わせできませんでした'); return; }
  const parts = [];
  if (behind) parts.push(`新しい版が出ている法令 ${behind}件`);
  if (upcoming) parts.push(`未施行の改正がある法令 ${upcoming}件`);
  // 確かめられなかったものがあるのに「すべて最新」と言ってはいけない。
  // 調べていないものを、調べて問題なかったことにしてしまう。
  if (failed) parts.push(`確かめられなかった法令 ${failed}件`);
  toast(parts.length ? parts.join('　/　') : '手元の法令はすべて最新です');
}

/* 1日に1度だけ、静かに確かめる。圏外なら何も起きない。 */
function checkAmendmentsIfStale() {
  let at = 0;
  try { at = Number(localStorage.getItem('roppo.amendCheckedAt')) || 0; } catch (e) { /* 任意 */ }
  if (Date.now() - at < 24 * 60 * 60 * 1000) return;
  checkAmendments(false).catch(() => { /* 圏外なら黙って諦める */ });
}

/*
 * まだ施行されていない版か。取り込んだ時点の判定を持ち続けると、
 * 施行日を過ぎても「未施行」と出したままになる。日付から毎回決める。
 */
function isUnenforced(rec) {
  return !!(rec && rec.revisionOf && rec.enforcementDate && rec.enforcementDate > today());
}

/*
 * 改正の印。どの版について確かめた結果かを併せて持つ。
 * 法令を削除して取り込み直すと、前の版についての判定が残って
 * 「新しい版があります」と言い続ける。版が食い違うときは印を出さない。
 */
function amendOf(law) {
  const rec = typeof law === 'string' ? state.laws.find(l => l.lawId === law) : law;
  // 固定版と、e-Gov 以外から来たものには出さない（問い合わせていないので判定が無い）
  if (!rec || rec.revisionOf || lawOrigin(rec) !== 'egov') return null;
  const a = amendState[rec.lawId];
  if (!a || !a.kind || a.kind === 'none') return null;
  if ((a.rev || '') !== (rec.lawRevisionId || '')) return null;   // 確かめた版と違う
  return a;
}

/*
 * 版の一覧を出して、選んだ版を取り込む。
 *
 * 選んだ版は「別の法令」として持つ。いま読んでいる版を置き換えない。
 * 未施行の条文を覗いたせいで、いま効いている条文が手元から消えるのが
 * 一番まずい。圏外なら取り直せない。
 *
 * そのぶん、注釈は版ごとに別になる。同じ条文に見えても中身が違うので、
 * これは正しい分かれ方である。
 */
let revToken = 0;      // 開き直したとき、前の応答で上書きしないための印

async function openRevisions(lawId) {
  /*
   * 版の一覧は e-Gov に問い合わせる。それ以外の出どころでは開かない。
   *
   * 狭い画面では題名を押すとここへ来るので、規則パックを読んでいるときに
   * 押すと pack-<sha256> を e-Gov に投げていた（Codex の指摘3）。
   */
  {
    const r0 = state.laws.find(l => l.lawId === lawId);
    if (r0 && lawOrigin(r0) !== 'egov') {
      toast(lawOrigin(r0) === 'pack'
        ? '規則パックのものは e-Gov に版がありません。新しい版はパックの一覧から取り込みます'
        : '取り込んだものは e-Gov に無いので、版を選べません');
      return;
    }
  }
  const law = state.laws.find(l => l.lawId === lawId);
  if (!law) return;

  // 固定版から開いたときも、問い合わせ先は必ず正規の法令IDにする。
  // `<法令ID>@<版ID>` を渡すと e-Gov に無いIDを送ることになる。
  const base = law.revisionOf || law.lawId;
  const baseLaw = state.laws.find(l => l.lawId === base);
  const baseTitle = (baseLaw && baseLaw.lawTitle) || law.baseTitle || law.lawTitle || '';

  const token = ++revToken;
  $('#rev-law').textContent = baseTitle;
  const box = $('#rev-list');
  box.innerHTML = '<p class="hint">e-Gov に問い合わせています…</p>';
  $('#dlg-revisions').showModal();

  let revs;
  try {
    revs = await apiRevisions(base);
  } catch (e) {
    if (token !== revToken) return;
    box.innerHTML = '<p class="hint">版の一覧を取得できませんでした。通信を確かめてください。</p>';
    return;
  }
  if (token !== revToken) return;   // 別の法令の一覧に切り替わっている

  // 新しい順。施行日が入っていないものは出しようがないので外す。
  revs = revs.filter(r => r.amendment_enforcement_date)
    .sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? 1 : -1));
  if (!revs.length) { box.innerHTML = '<p class="hint">版の情報がありません。</p>'; return; }

  const now = today();
  const held = new Set(state.laws.map(l => l.lawRevisionId).filter(Boolean));

  box.innerHTML = '';
  for (const r of revs) {
    const future = r.amendment_enforcement_date > now;
    const mine = held.has(r.law_revision_id);
    /*
     * 行の主役は「この法令の版」にする。改正法の名前を主役にしていたときは、
     * 刑法の版に「日本国の自衛隊と…協定の実施に関する法律」が並ぶので、
     * 別の法令の情報が混ざっているようにしか見えなかった。
     *
     * 法令名は版ごとに e-Gov が返す（改正で題名が変わることがあるため）。
     * 入っていなければ元の法令名を使う。
     */
    const name = r.law_title || baseTitle;
    const b = document.createElement('button');
    b.type = 'button';
    // 名前は長いと省略されるので、ホバーで全体が読めるようにする
    b.title = name + (r.amendment_law_title ? '\n改正法: ' + r.amendment_law_title : '');
    b.innerHTML = `<span class="rv-date">${esc(r.amendment_enforcement_date)}</span>`
      + '<span class="rv-title">'
      + `<span class="rv-name">${esc(name)}</span>`
      // 改正法の名前が入っていない版もある。空欄にすると行の高さがずれて見える
      + `<span class="rv-amend">${r.amendment_law_title
          ? '改正法: ' + esc(r.amendment_law_title) : '改正法の名前なし'}</span>`
      + '</span>'
      + `<span class="rv-state ${mine ? 'now' : future ? 'future' : 'past'}">`
      + (mine ? '手元にある' : future ? '未施行' : '施行済み') + '</span>';
    if (mine) b.disabled = true;
    else b.onclick = () => takeRevision(base, baseTitle, baseLaw, r);
    box.appendChild(b);
  }
}

/* base は e-Gov の法令ID。固定版から辿ったときも、必ずこれを親にする。 */
async function takeRevision(base, baseTitle, baseLaw, rev) {
  const id = base + '@' + rev.law_revision_id;
  $('#dlg-revisions').close();

  if (!state.laws.some(l => l.lawId === id)) {
    toast('取り込んでいます…');
    let xml;
    try {
      xml = await apiFetchLaw(rev.law_revision_id);
    } catch (e) {
      toast('取り込めませんでした: ' + e.message);
      return;
    }
    await store.putLaw({
      lawId: id,
      lawTitle: baseTitle + '（' + rev.amendment_enforcement_date + ' 施行）',
      baseTitle,                          // 元法令を消しても名前を組み直せるように
      lawNum: baseLaw ? baseLaw.lawNum : '',
      abbrev: null,                       // 略称で引けると本来の法令と紛れる
      revisionOf: base,
      lawRevisionId: rev.law_revision_id,
      enforcementDate: rev.amendment_enforcement_date,
      amendLawTitle: rev.amendment_law_title || '',
      xml, savedAt: Date.now(),
    });
    await refreshLawList();
  }
  await navigate(id);
}

function amendTitle(a) {
  const head = a.kind === 'behind' ? '新しい版が出ています' : '未施行の改正があります';
  /*
   * a.title は「この法令を改正した法律」の名前である。たとえば破産法なら
   * 「民事訴訟法等の一部を改正する法律」が入る。そのまま並べると、別の法令の
   * 話をしているように見えるので、何の名前かを添える。
   */
  return head + '　施行 ' + a.date + (a.title ? '　改正法: ' + a.title : '');
}

/* ------------------------------------------------------------------ 目次 */

function renderToc() {
  const ul = $('#toc-list');
  ul.innerHTML = '';
  tocCurrent = null;         // 作り直したので、前の参照はもう繋がっていない
  if (!P().toc.length) {
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">この法令に見出しはありません</li>';
    return;
  }
  for (const e of P().toc) {
    const li = document.createElement('li');
    li.className = e.kind ? e.kind === 'suppl' ? 'suppl' : 'lv1' : 'lv' + e.level;
    li.dataset.id = e.id;
    // 範囲表記（"170:174"）は端の数字だけ使う
    const head = e.first && String(e.first).split(':')[0];
    const tail = e.last && String(e.last).split(':').pop();
    const range = (head && tail)
      ? (head === tail ? numLabel(head, '条') : `${numLabel(head, '条')}–${numLabel(tail, '条')}`)
      : '';
    li.innerHTML = `<span class="t">${esc(e.title)}</span>`
      + (range ? `<span class="range">${esc(range)}</span>` : '');
    li.onclick = () => {
      const target = $('#' + e.id, P().el);      // 両面で同じidを使うので面を限る
      if (!target) return;
      rememberPos();
      closeDrawerAfterJump();
      const top = scrollTopFor(target, P());
      scrollPaneTo(top, P());
      // 履歴には実際に送った位置を残す。目次の位置と戻ったときの位置を揃える。
      pushHist({ lawId: P().current.lawId, anchor: null, scrollTop: top });
    };
    ul.appendChild(li);
  }
}

/* ------------------------------------- 固定版の注釈を元の法令へ移す */

/*
 * 「版を選ぶ」で固定した版は、元の法令とは別の住所を持つ。
 *
 *   刑事訴訟法                    323AC0000000131
 *   刑事訴訟法（2026-08-13 施行）  323AC0000000131@<版ID>
 *
 * 版を固定するのはそのための機能なので、これ自体は正しい。しかし端末ごとに
 * 片方だけを持っていると、同じ条文なのに注釈が揃わない。同期して初めて
 * 気づいた。
 *
 * 移すかどうかは利用者が決める。固定版をわざと持っている場合もあるので、
 * 黙って動かさない。移した先に注釈があるものは触らず、数だけ知らせる。
 */

/** 固定版の住所か。`<法令ID>@<版ID>` の形をしているか。 */
const isPinnedLawId = id => typeof id === 'string' && id.includes('@');
const baseLawIdOf = id => String(id).split('@')[0];

/**
 * 移す対象を選ぶ。DBも時計も触らない。
 *
 * 元の法令をこの端末に持っているかどうかは見ない。持っていなくても住所は
 * 正しくなり、持っている端末と同期すれば揃う。持っていることを条件にすると、
 * 移す先が無い端末では何もできないまま取り残される。
 *
 * 移した先にすでに注釈があるものだけは触らない。上書きすると消える。
 */
function planRevisionNoteMove(notes, ranges, now) {
  const byKey = new Map((notes || []).map(n => [n.key, n]));
  const outNotes = [], outRanges = [];
  let moved = 0, skipped = 0;

  for (const n of notes || []) {
    if (isTomb(n) || !isPinnedLawId(n.lawId)) continue;
    const base = baseLawIdOf(n.lawId);
    const toKey = base + ':' + n.anchor;
    const there = byKey.get(toKey);
    if (there && !isTomb(there)) { skipped++; continue; }
    outNotes.push({ ...n, key: toKey, lawId: base, updatedAt: now });
    outNotes.push(noteTomb(n, now));
    moved++;
  }
  for (const r of ranges || []) {
    if (isTomb(r) || !isPinnedLawId(r.lawId)) continue;
    // 文言注釈は id で決まるので、鍵の衝突は起きない。住所だけ移す
    outRanges.push({ ...r, lawId: baseLawIdOf(r.lawId), updatedAt: now });
    moved++;
  }
  return { notes: outNotes, ranges: outRanges, moved, skipped };
}

/*
 * 固定版の注釈がいくつあり、そのうちいくつ移せるかを数える。
 *
 * 移せない理由はたいてい「元の法令を持っていない」である。そのときに
 * 黙って隠れると、利用者からは何も起きていないように見える。実際にそうなった。
 * 移せる数と、移せない数を分けて返す。
 */
function countRevisionNotes() {
  const plan = planRevisionNoteMove([...state.notes.values()],
    [...state.ranges.values()], Date.now());
  // 移した先の法令をこの端末に持っていないものは、そう言う（移せはする）
  const missing = new Map();
  const have = new Set(state.laws.map(l => l.lawId));
  const scan = rec => {
    if (isTomb(rec) || !isPinnedLawId(rec.lawId)) return;
    const base = baseLawIdOf(rec.lawId);
    if (have.has(base)) return;
    const law = state.laws.find(l => l.lawId === rec.lawId);
    missing.set(base, (law && (law.baseTitle || law.lawTitle)) || base);
  };
  for (const n of state.notes.values()) scan(n);
  for (const r of state.ranges.values()) scan(r);
  return { moved: plan.moved, skipped: plan.skipped, missing: [...missing.values()] };
}

async function doRevisionNoteMove() {
  const now = Date.now();
  const plan = planRevisionNoteMove([...state.notes.values()],
    [...state.ranges.values()], now);
  if (!plan.moved) { toast('移せるものがありません'); return; }
  if (!confirm('固定した版に付けた注釈 ' + plan.moved + '件を、元の法令へ移します。'
    + '\n\n移す前にバックアップを取っておくと安全です。よろしいですか？')) return;
  try {
    await store.applyBulk({ notes: plan.notes, ranges: plan.ranges, local: true });
  } catch (e) {
    toast('移せませんでした（何も変えていません）: ' + e.message);
    return;
  }
  await loadNotes();
  await loadRanges();
  paintNotes();
  paintRanges();
  renderMarkList();
  toast(plan.moved + '件を元の法令へ移しました'
    + (plan.skipped ? '（移せなかった ' + plan.skipped + '件はそのまま）' : ''));
}

/* --------------------------------------------- 条の注釈を第1項へ移す */

/*
 * 一度だけの移し替え。条の単位に付いた注釈を、第1項に付け直す。
 *
 * 以前は条番号を押すと「条」が選ばれたので、条の単位（M/709 のように項の
 * 付かない住所）に注釈が付いていた。いまは条番号を押すと第1項が選ばれる。
 * すると古い注釈は、本文に出ているのに押しても開けない。前メモだけが条見出しの
 * 直後、つまり条文番号の行より上に残る。
 *
 * 一度きりの話なので、そのために機能を足さず、起動時に一度だけ移す。
 *
 * 気をつけること
 *   ・移した先に注釈が既にあるものは触らない。勝手に混ぜない
 *   ・消すのではなく墓石を残す。消しただけだと古いバックアップから復活する
 *   ・住所の形が条に見えないもの（M/前文・別表・範囲）は触らない
 *   ・移したかどうかを meta に記録して、二度走らせない
 *   ・全部を一度のトランザクションで書く。半分だけ移った状態を残さない
 *
 * 取り消したいときはバックアップから戻す。移す前に書き出しておくのが安全。
 */
const MOVED_KEY = 'roppo.movedArticleNotes';

/** 条の単位の住所か（M/709 のように、条番号までで止まっているか）。 */
function isArticleAnchor(anchor) {
  const parts = String(anchor || '').split('/');
  if (parts.length !== 2) return false;
  // 枝番（398_2）と範囲（170:174）は条である。前文・別表は違う
  return /^\d+(_\d+)*(:\d+)?$/.test(parts[1]);
}

/** 移す対象を選ぶ。DBも時計も触らない（試験しやすくするため）。 */
function planArticleNoteMove(all, now) {
  const byKey = new Map(all.map(n => [n.key, n]));
  const move = [], skip = [];
  for (const n of all) {
    if (isTomb(n)) continue;
    if (!isArticleAnchor(n.anchor)) continue;
    const to = n.anchor + '/1';
    const toKey = (n.lawId || '') + ':' + to;
    const there = byKey.get(toKey);
    if (there && !isTomb(there)) { skip.push(n); continue; }   // 重なる。触らない
    move.push({ from: n, toKey, to });
  }
  const notes = [];
  for (const m of move) {
    notes.push({ ...m.from, key: m.toKey, anchor: m.to, updatedAt: now });
    notes.push(noteTomb(m.from, now));
  }
  return { notes, moved: move.length, skipped: skip.length, skip };
}

/** 起動時に一度だけ。移したら件数を知らせる。 */
async function moveArticleNotesOnce() {
  let done = null;
  try { done = await store.getMeta(MOVED_KEY); } catch (e) { return; }
  if (done && done.value) return;

  let all;
  try { all = await store.allNotes(); } catch (e) { return; }
  const plan = planArticleNoteMove(all, Date.now());

  try {
    await store.applyBulk({ notes: plan.notes, meta: { [MOVED_KEY]: true }, local: true });
  } catch (err) {
    // 書けなければ印も付けない。次の起動でやり直す
    toast('条の注釈を移せませんでした: ' + err.message);
    return;
  }
  if (!plan.moved && !plan.skipped) return;          // 何も無ければ黙っている
  await loadNotes();
  toast('条に付いていた注釈 ' + plan.moved + '件を第1項へ移しました'
    + (plan.skipped ? '（第1項に既にあった ' + plan.skipped + '件はそのまま）' : ''));
}


/* ---------------------------------------------------------- 法令の追加 */

async function searchAndShow() {
  const q = $('#add-query').value.trim();
  if (!q) return;
  const box = $('#add-results');
  box.innerHTML = '<p class="hint" style="padding:10px">検索中…</p>';
  try {
    const list = await apiSearchLaws(q);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="hint" style="padding:10px">見つかりませんでした。</p>'; return; }
    for (const l of list) {
      const owned = state.laws.some(x => x.lawId === l.lawId);
      const d = document.createElement('div');
      d.className = 'r';
      d.innerHTML = `<div class="info"><div class="name">${esc(l.lawTitle)}</div>`
        + `<div class="sub">${esc(l.lawNum || '')}${l.category ? '　' + esc(l.category) : ''}</div></div>`
        + `<button ${owned ? 'disabled' : ''}>${owned ? '取込済' : '取り込む'}</button>`;
      const btn = d.querySelector('button');
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '取得中…';
        try {
          const xml = await apiFetchLaw(l.lawId);
          await store.putLaw({ ...l, xml, savedAt: Date.now() });
          state.indexCache.delete(l.lawId);
          await refreshLawList();
          btn.textContent = '取込済';
          toast(`「${l.lawTitle}」を取り込みました`);
        } catch (err) {
          btn.disabled = false; btn.textContent = '再試行';
          toast(err.message);
        }
      };
      box.appendChild(d);
    }
  } catch (err) {
    box.innerHTML = `<p class="hint" style="padding:10px">${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ 起動 */

/* ------------------------------------------------------------- 表示設定 */

/** 条文本文の書体。Windows と macOS の両方で狙いどおりになるよう並べてある。 */
const FONT_STACKS = {
  mincho: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", "Noto Serif JP", serif',
  gothic: '"Hiragino Sans", "Yu Gothic UI", "Yu Gothic", "MS PGothic", sans-serif',
  meiryo: '"Meiryo", "Hiragino Sans", sans-serif',
  ud: '"BIZ UDPGothic", "Meiryo", "Hiragino Sans", sans-serif',
};
// leading は 1/10 倍、measure は em 単位（0 は幅いっぱい）で持つ
const VIEW_DEFAULT = {
  font: 'mincho', size: 16, leading: 19, measure: 46,
  annot: 'all', ink: '#1558b8', paren: 'dim',
  /*
   * 選んだ条項号を本文で囲むか。
   *
   * 出すのが既定である。どこを選んでいるかは分かった方がよい。
   * ただし本文の大きい法令では、この枠を付け外しするだけで端末が
   * 数秒詰まることがある（iPhone で会社法。枠の描き方を替えても変わらず、
   * 付けなければ速い、というところまで確かめた）。
   * 選んでいる条項号は注釈欄の見出しにも出るので、切れる方が親切である。
   * 表示設定は端末ごとに保存するので、重い端末だけ切れる。
   */
  selbox: 'on',
};

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('roppo.view') || '{}');
    return { ...VIEW_DEFAULT, ...v };
  } catch (e) { return { ...VIEW_DEFAULT }; }
}

function applyView(v) {
  const root = document.documentElement;
  root.style.setProperty('--font-body', FONT_STACKS[v.font] || FONT_STACKS.mincho);
  root.style.setProperty('--text-size', v.size + 'px');
  root.style.setProperty('--text-leading', (v.leading / 10).toFixed(1));
  root.style.setProperty('--measure', v.measure ? v.measure + 'em' : '100%');
  root.dataset.annot = v.annot || 'all';
  root.style.setProperty('--ink', v.ink || VIEW_DEFAULT.ink);
  root.dataset.paren = v.paren || 'dim';
  root.dataset.selbox = v.selbox || 'on';
  // 出さない設定に変えたなら、いま出ている枠も外す
  if (!selBoxOn()) $$('.sel').forEach(e => e.classList.remove('sel'));

  for (const b of $$('#font-picker button')) b.classList.toggle('on', b.dataset.font === v.font);
  for (const b of $$('#measure-picker button')) b.classList.toggle('on', Number(b.dataset.measure) === v.measure);
  for (const b of $$('#annot-picker button')) b.classList.toggle('on', b.dataset.annot === (v.annot || 'all'));
  for (const b of $$('#ink-picker button')) b.classList.toggle('on', b.dataset.ink === (v.ink || VIEW_DEFAULT.ink));
  for (const b of $$('#paren-picker button')) b.classList.toggle('on', b.dataset.paren === (v.paren || 'dim'));
  for (const b of $$('#selbox-picker button')) {
    b.classList.toggle('on', b.dataset.selbox === (v.selbox || 'on'));
  }
  $('#size-range').value = v.size;
  $('#leading-range').value = v.leading;
  $('#size-val').textContent = v.size + 'px';
  $('#leading-val').textContent = (v.leading / 10).toFixed(1);

  try { localStorage.setItem('roppo.view', JSON.stringify(v)); } catch (e) { /* 任意 */ }
  // 字組みが変われば要素の位置も変わる。現在位置の判定をやり直す。
  measureHeadings();
  updateCrumb();
  positionPopover();
}

function wireView() {
  const pad = $('#viewpad');
  const btn = $('#btn-view');
  let view = loadView();

  btn.onclick = () => {
    pad.hidden = !pad.hidden;
    btn.classList.toggle('on', !pad.hidden);
  };
  // 打ち消さない監視なので、そう宣言しておく（理由は面の監視の注記を見よ）
  document.addEventListener('pointerdown', e => {
    if (pad.hidden || e.target.closest('.view')) return;
    pad.hidden = true;
    btn.classList.remove('on');
  }, { passive: true });

  $('#font-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-font]');
    if (!b) return;
    view.font = b.dataset.font;
    applyView(view);
  });
  /*
   * 枠を出さない設定にしたら、いま出ている枠も消す。
   * 設定を変えたのに画面が変わらないと、効いていないように見える。
   */
  $('#selbox-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-selbox]');
    if (!b) return;
    view.selbox = b.dataset.selbox;
    applyView(view);
  });
  $('#paren-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-paren]');
    if (!b) return;
    view.paren = b.dataset.paren;
    applyView(view);
    for (const pane of livePanes()) paintParens(pane);   // 作る／外すはここで
  });
  $('#ink-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-ink]');
    if (!b) return;
    view.ink = b.dataset.ink;
    applyView(view);
  });
  $('#annot-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-annot]');
    if (!b) return;
    view.annot = b.dataset.annot;
    applyView(view);
    hideTip();
  });
  $('#measure-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-measure]');
    if (!b) return;
    view.measure = Number(b.dataset.measure);
    applyView(view);
  });
  $('#size-range').oninput = e => { view.size = Number(e.target.value); applyView(view); };
  $('#leading-range').oninput = e => { view.leading = Number(e.target.value); applyView(view); };
  $('#view-reset').onclick = () => { view = { ...VIEW_DEFAULT }; applyView(view); };

  applyView(view);
}

function switchTab(name) {
  for (const b of $$('.tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  for (const id of ['laws', 'toc', 'find', 'marks']) {
    if (id === 'find' && narrow()) continue;    // シートの中にあるので隠さない
    $('#panel-' + id).hidden = id !== name;
  }
  try { localStorage.setItem('roppo.tab', name); } catch (e) { /* 使えなくても支障ない */ }
}

/** テンキー。条文番号は数字と「条項号の」だけで打てるので、専用の盤を出す。 */
function wireKeypad() {
  const pad = $('#keypad');
  const input = $('#jump-input');
  const btn = $('#btn-pad');

  const setOpen = open => {
    pad.hidden = !open;
    btn.classList.toggle('on', open);
    try { localStorage.setItem('roppo.pad', open ? '1' : '0'); } catch (e) { /* 任意 */ }
  };
  btn.onclick = () => setOpen(pad.hidden);

  pad.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === '⌫') input.value = input.value.slice(0, -1);
    else if (k === '✓') { doJump(); return; }
    else input.value += k;
    input.focus();
    updateJumpPreview();     // 盤からは input イベントが飛ばない
  });

  // 盤の外を押したら閉じる（入力欄と盤自身は除く）
  document.addEventListener('pointerdown', e => {
    if (narrow()) return;           // シートの中では出しっぱなしにする
    if (pad.hidden) return;
    if (e.target.closest('.jump')) return;
    setOpen(false);
  }, { passive: true });          // 理由は上の注記を見よ

  let open = false;
  try { open = localStorage.getItem('roppo.pad') === '1'; } catch (e) { /* 任意 */ }
  setOpen(open);
}

function wire() {
  $('#jump-input').onkeydown = e => { if (e.key === 'Enter') doJump(); };
  $('#find-input').onkeydown = e => {
    if (e.key !== 'Enter') return;
    // 同じ語で続けて押したら次の一致へ送る
    if (find.q === $('#find-input').value.trim() && find.results.length) stepFind(e.shiftKey ? -1 : 1);
    else doFind();
  };
  $('#law-filter').oninput = renderLawList;

  for (const b of $$('.tabs button')) b.onclick = () => switchTab(b.dataset.tab);

  $('#mark-sort').addEventListener('click', e => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    for (const x of $$('#mark-sort button')) x.classList.toggle('on', x === b);
    renderMarkResults();
  });

  $('#find-where').addEventListener('click', e => {
    const b = e.target.closest('button[data-where]');
    if (!b) return;
    find.where = b.dataset.where;
    for (const x of $$('#find-where button')) x.classList.toggle('on', x === b);
    syncFindPlaceholder();
    doFind();
  });
  $('#find-in-text').onchange = e => { find.inText = e.target.checked; doFind(); };
  $('#find-in-notes').onchange = e => { find.inNotes = e.target.checked; doFind(); };
  wireKeypad();
  wireLawDrag();
  wireView();

  const openAdd = () => {
    $('#dlg-add').showModal();
    $('#add-query').focus();
    renderMissing();                    // 同期で分かった目録から、足りないものを出す
  };
  $('#missing-all').onclick = () => takeAllMissing();
  $('#btn-add-law').onclick = openAdd;
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'btn-add-law-2') openAdd();
  });
  // 通信の状態が変わったら、何も開いていない面の知らせを書き直す
  window.addEventListener('online', refreshEmptyPane);
  window.addEventListener('offline', refreshEmptyPane);

  $('#btn-sync').onclick = () => doSync();
  $('#btn-peek').onclick = () => peekRemote();
  $('#btn-rev-move').onclick = () => doRevisionNoteMove();
  // 改正後の版へ注釈を写す画面。実体は version-migration-view.js にある
  wireVersionMigration();
  $('#btn-join').onclick = () => doJoin();
  $('#btn-pick').onclick = () => {
    gToken = null;                       // いまのを捨ててから選び直す
    toast('アカウントを選んでください…');
    gGo('peek', true);
  };
  $('#sync-account').value = gAccount();
  $('#sync-account-save').onclick = () => {
    setGAccount($('#sync-account').value);
    toast(gAccount() ? 'アカウントを覚えました' : 'アカウントの指定を外しました');
  };

  $('#btn-export').onclick = openExportDialog;
  $('#btn-about').onclick = () => $('#dlg-about').showModal();
  document.addEventListener('click', e => {
    if (e.target && e.target.dataset && e.target.dataset.about) {
      $('#dlg-about').showModal();
    }
  });
  $('#exp-backup').onclick = exportBackup;
  $('#exp-restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';                       // 同じファイルを選び直せるように
    if (!f) return;
    if (!confirm('バックアップから復元します。\n同じ条文の注釈は、新しい方を残します。よろしいですか？')) return;
    try { await importBackup(f); } catch (err) { toast('復元できませんでした: ' + err.message); }
  };

  for (const b of $$('#slashbar button')) {
    b.onclick = () => applySlash(b.dataset.slash);
  }

  /*
   * 規則パックの一覧。押すまで読みに行かない。
   *
   * 追加の画面を開くたびに pack.json を取りに行くと、規則を入れる気が無い
   * ときにも通信する。実体は pack.js にある（このファイルより後に読むが、
   * 呼ぶのは押されたときなので読み込みの時点では要らない）。
   */
  $('#pack-open').onclick = async () => {
    $('#pack-open').hidden = true;
    $('#pack-filter').hidden = false;
    await openPackList();
  };
  $('#pack-filter').oninput = () => { if (packShown()) renderPackList(); };

  $('#btn-import-law').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';                       // 同じファイルを選び直せるように
    if (!files.length) return;
    // まとめ取り込みの中で捕まえきれなかったものも、ここで受ける
    let done = [];
    try { ({ done } = await importLawFiles(files)); }
    catch (err) { toast('取り込めませんでした: ' + err.message); return; }
    if (done.length) $('#dlg-add').close();    // 1本も入らなければ開いたままにする
  };

  const addSearchBtn = $('#add-search');
  addSearchBtn.type = 'button';
  addSearchBtn.onclick = searchAndShow;
  $('#add-query').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); searchAndShow(); } };

  for (const pane of state.panes) bindPaneEvents(pane);
  wireGlobal();
}

function bindPaneEvents(pane) {
  pane.el.addEventListener('click', e => {
    const ref = e.target.closest('a.ref[data-target]');
    const mk = e.target.closest('mark[data-range-id]');

    /*
     * 参照リンクの文字に文言の印を付けると、押す先が二つになる。
     *
     * 前はリンクを先に見ていたので、印を付けた参照は永久に押せなかった。
     * 消すこともできない（付けた本人の印に届かないのが一番まずい）。
     * かといってリンクを捨てるのも違う。どちらかを選ばせる。
     *
     * 印の無い参照リンクは、これまでどおり押せばすぐ飛ぶ。迷いが無いので
     * 選ばせる必要もない。バーが出るのは、印を付けた参照だけである。
     */
    if (ref && mk) {
      e.preventDefault();
      hideSlashBar();
      refPending = { target: ref, id: mk.dataset.rangeId,
        lawId: P().current && P().current.lawId, paneIdx: pane.idx };
      showRefBar(mk.getBoundingClientRect());
      return;
    }
    hideRefBar();

    if (ref) {
      e.preventDefault();
      followRef(ref, e.ctrlKey || e.metaKey || e.shiftKey);
      return;
    }
    if (mk) { openRangePopover(mk.dataset.rangeId); return; }

    // すでに付いている区切りの印を押した
    const sl = e.target.closest && e.target.closest('span[data-slash-id]');
    if (sl) {
      const rec = state.ranges.get(sl.dataset.slashId);
      slashPending = { id: sl.dataset.slashId };
      showSlashBar(sl.getBoundingClientRect(), rec);
      return;
    }
    hideSlashBar();

    // 文字を選択している最中は編集を開かない（範囲注釈を付けたいだけのことが多い）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    /*
     * 番号を押したのなら、ここで決める。
     *
     * これより下の「。」さがしは、押した座標から文字位置を割り出し、その
     * 条項号の文字を端から並べ直す。番号を押したときには要らない仕事である。
     * 前は句点さがしを先に通していたので、注釈欄を開くたびに毎回それを
     * 払っていた。順序としても、番号を押したなら番号の意図が優先される。
     */
    {
      /*
       * 取っ手は「番号」だけにする。見出し（（損害賠償）など）は本文の一部で、
       * 押すものには見えない。番号だけでも全部の単位に届く。
       *
       * 番号を押したら、その番号が属する単位を選ぶ。条番号なら第1項である。
       * 条番号は第1項の本文の頭に置かれている（第1項だけ番号を出さないのが
       * 慣例）。以前はここで .article まで上がって「条」を選んでいたが、
       * それだと第1項を指す取っ手がどこにも無くなる。刑訴280条のように
       * 3項あって、どの項も番号を持たない法令では、第1項に注釈を付けられない。
       *
       * 注釈の単位は項に寄せる。読むときも「280条1項」と引くのであって、
       * 「280条」と「280条1項」を別に印を付けたい場面は、まず無い。
       * 条の単位に付いた古い注釈は、本文には出るし、印とメモの一覧から選べる。
       */
      const num = e.target.closest('.article-title, .para-num, .item-title');
      if (num) {
        const host = num.closest('[data-anchor]');
        if (host && host.dataset.anchor) selectAnchor(host.dataset.anchor, true, pane);
        return;
      }
    }

    /*
     * 「。」の近くを押したら、区切りの印を出す入口を開く。
     * 本文のそれ以外の場所は、これまでどおり何も起きない。
     */
    const near = sentenceEndNear(e.clientX, e.clientY);
    if (near) {
      // すでに印が付いていれば、その印の編集として開く
      const cur = P().current && existingSlash(P().current.lawId, near.anchor, near.text, near.nth);
      slashPending = cur
        ? { id: cur.id, lawId: P().current.lawId, paneIdx: P().idx }
        : near;
      const r = document.createRange();
      const map = textMapOf(findAnchorEl(near.anchor, pane) || pane.el);
      const seg = map.nodes.find(x => near.at >= x.start && near.at <= x.end);
      if (seg) {
        r.setStart(seg.node, Math.max(0, near.at - seg.start - 1));
        r.setEnd(seg.node, Math.min(seg.node.nodeValue.length, near.at - seg.start));
        showSlashBar(r.getBoundingClientRect(), cur);
        return;
      }
    }

    /*
     * 注釈欄を開くのは、条・項・号の「番号」を押したときだけにする（上で済み）。
     * 本文のどこを触っても開くと、読んでいるだけで欄が出てきて邪魔になる。
     *
     * 番号を持たない単位は、本文そのものが取っ手になる。
     *   ・前文
     *   ・別表・別記・別図
     * 番号を持つ単位（②③…、号のイロハ、条）は番号を押してもらう。
     * 取っ手が二つあると、どちらに付いたのか分からなくなる。
     */
    const host = e.target.closest('[data-anchor]');
    if (!host || !host.dataset.anchor) return;
    /*
     * 条は条番号が取っ手。
     * 手元の7法令4,540条を数えたところ ArticleTitle の無い条は0件だったが、
     * 全法令を確かめたわけではない。無ければ取っ手が消えて選べなくなるので、
     * そのときだけ本文で選べるようにしておく。あっても害はない。
     */
    if (host.classList.contains('article') && host.querySelector('.article-title')) return;
    if (host.querySelector(':scope > .para-num, :scope > .item-title')) return;
    /*
     * 第1項は条番号が取っ手。本文を押しても同じ第1項が選ばれるので、どちらでも
     * 構わない。取っ手が二つあって困るのは、押す先が違うときだけである。
     * いまはどちらを押しても項が選ばれるので、そのままにしておく。
     */
    selectAnchor(host.dataset.anchor, true, pane);
  });

  pane.el.addEventListener('auxclick', e => {
    const ref = e.button === 1 && e.target.closest('a.ref[data-target]');
    if (ref) { e.preventDefault(); followRef(ref, true); }
  });
  pane.el.addEventListener('mouseover', handleHover);
  pane.el.addEventListener('mouseleave', hideTip);

  // 選択したら色バーを出す
  pane.el.addEventListener('mouseup', () => setTimeout(showSelBar, 0));
  pane.el.addEventListener('touchend', () => setTimeout(showSelBar, 0), { passive: true });
}

/** 面によらず1回だけ掛ける配線 */
function wireGlobal() {
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideSelBar();
  });
  $('#refbar').addEventListener('click', e => {
    const b = e.target.closest('button[data-ref]');
    if (b) applyRefPick(b.dataset.ref);
  });

  $('#selbar').addEventListener('pointerdown', e => e.preventDefault());   // 選択を保つ
  $('#selbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'selbar-memo') createRangeFrom('yellow', true);
    else if (b.dataset.color) createRangeFrom(b.dataset.color, false);
  });

  $('#pop-close').onclick = closePopover;

  // 外を押したら閉じる。別の条文を押したときは選択し直しに任せる。
  document.addEventListener('pointerdown', e => {
    if ($('#popover').hidden) return;
    if (e.target.closest('#popover') || e.target.closest('[data-anchor]')) return;
    closePopover();
  }, { passive: true });          // 理由は上の注記を見よ

  // 行き先を選ぶバーは、よそを押したら引っ込める
  document.addEventListener('pointerdown', e => {
    if ($('#refbar').hidden) return;
    if (e.target.closest('#refbar') || e.target.closest('a.ref')) return;
    hideRefBar();
  }, { passive: true });
  window.addEventListener('resize', positionPopover);

  $('#btn-back').onclick = () => goHistory(-1);
  $('#btn-fwd').onclick = () => goHistory(1);

  $('#btn-menu').onclick = () => setDrawer(!$('#pane-laws').classList.contains('open'));
  $('#btn-drawer-close').onclick = () => setDrawer(false);
  $('#scrim').onclick = () => setDrawer(false);

  $('#btn-check').onclick = () => checkAmendments(true);
  $('#topbar-law').onclick = () => { if (P().current) openRevisions(P().current.lawId); };
  $('#jump-input').addEventListener('input', updateJumpPreview);
  // 下見そのものを押しても引ける。当たりが出ているときだけ効く。
  const pv = $('#jump-preview');
  pv.onclick = () => { if (pv.classList.contains('go')) doJump(); };
  pv.onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && pv.classList.contains('go')) {
      e.preventDefault();
      doJump();
    }
  };
  $('#btn-lookup-fab').onclick = () => setSheet($('#lookup-sheet').hidden);
  $('#lookup-sheet-close').onclick = () => setSheet(false);
  for (const b of $$('#sheet-tabs button')) {
    b.onclick = () => setSheet(true, b.dataset.sheet);
  }
  if (narrowMQ && narrowMQ.addEventListener) narrowMQ.addEventListener('change', placeControls);

  /*
   * 2面のまま狭くすると、解除ボタンが隠れて1面に戻せなくなる。
   * この幅で割ってもどちらも読めないので、そのときは1面へ戻す。
   */
  const phoneMQ = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
  if (phoneMQ && phoneMQ.addEventListener) {
    phoneMQ.addEventListener('change', () => { if (phoneMQ.matches && state.split) setSplit(false); });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      setDrawer(false);
      setSheet(false);
      closePopover();
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHistory(-1); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHistory(1); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (narrow()) { setSheet(true, 'jump'); return; }   // 欄はシートの中にある
      $('#jump-input').focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (narrow()) { setSheet(true, 'find'); return; }
      switchTab('find');          // 欄は検索タブの中にある
      $('#find-input').select();
    }
    if (e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  });

  // 離脱時の取りこぼしを防ぐ
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

/* ------------------------------------------------------ Service Worker */

/*
 * アプリ本体をキャッシュして、サーバーなしで起動できるようにする。
 * 新しい版が来ても勝手には切り替えない。書きかけのメモを抱えたまま
 * 読み込み直すことになるため、利用者に断ってから切り替える。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  let approved = false;                       // このタブが切り替えを承認したか

  /*
   * 読み込み直す前の関門。
   *
   * 保存できていない編集があるなら進まない。読み込み直せば画面の編集欄は
   * 消えるので、その編集はそこで失われる（Codex の指摘1）。
   *
   * 止めたあとは、同じ操作をやり直せるように押し直す口を出しておく。保存が
   * 失敗する理由は容量不足や別タブとの競合など、あとで解消することがある。
   * 知らせだけ出して口を閉じると、更新する手立てが無くなる。
   */
  const guarded = (label, go) => {
    const run = async () => {
      if (await okToReload()) { go(); return; }
      const el = $('#toast');
      el.innerHTML = '';
      el.append('保存できていない編集があります。読み込み直すと消えるので、'
        + 'やめました　');
      const again = document.createElement('button');
      again.className = 'mini';
      again.textContent = 'もう一度' + label;
      again.onclick = run;
      el.appendChild(again);
      el.hidden = false;
      clearTimeout(toastTimer);
    };
    return run;
  };

  // 別のタブが先に切り替えたときの知らせ。押したときだけ読み込み直す。
  const offerReload = () => {
    const el = $('#toast');
    el.innerHTML = '';
    el.append('新しい版に入れ替わりました　');
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = '読み込み直す';
    b.onclick = guarded('読み込み直す', () => { reloading = true; location.reload(); });
    el.appendChild(b);
    el.hidden = false;
    clearTimeout(toastTimer);
  };

  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = worker => {
      if (!worker) return;
      const el = $('#toast');
      el.innerHTML = '';
      el.append('新しい版があります　');
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = '読み込み直す';
      // 書きかけを保存してから。保存できなければ進まない（guarded の注記）
      b.onclick = guarded('読み込み直す', () => {
        approved = true;                      // このタブは読み込み直してよい
        worker.postMessage('skip-waiting');
      });
      el.appendChild(b);
      el.hidden = false;
      clearTimeout(toastTimer);               // これは自動で消さない
    };

    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        // 初回の導入では知らせない。入れ替えのときだけ。
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(err => console.warn('Service Worker を登録できませんでした', err));

  // 読み込み直すのは、このタブで「読み込み直す」を押したときだけ。
  // controllerchange は初回の導入（clients.claim）でも飛ぶし、別のタブが
  // 承認したときにも飛ぶ。そこで読み込み直すと、こちらの書きかけが消える。
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    if (!approved) {
      // 別のタブが切り替えた。こちらは古い殻のまま動いている。
      // 勝手に読み込み直すと書きかけが消えるので、知らせるだけにする。
      if (navigator.serviceWorker.controller) offerReload();
      return;
    }
    reloading = true;
    location.reload();
  });
}

