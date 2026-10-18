'use strict';

/*
 * 注釈。タグ・メモ・文言へのメモ・区切り・括弧書き・吹き出し。
 *
 * 分割前の app.js の次の節を、順を変えずに集めたものである。3つのまとまりに分かれる。
 *
 *   文言の位置（範囲注釈） / メモの遅延保存
 *   注釈のポップアップ / タグ・メモの描画
 *   マークとタグ一覧 / 文言へのメモ（範囲） / 区切りの印 / 括弧書き / 吹き出し
 *
 * 「文言の位置」をここに置いたのは、文字の数え方（textMapOf）と、その位置へ
 * 印を置く処理（placeRange）を一緒に見たいからである。どちらかを直すときは
 * 必ずもう一方を見ることになる。描画側に置いても動くが、離すと見落とす。
 *
 * トップレベルで組み立てているのは saveFailures（空の Set）だけ。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */
/* ------------------------------------------------- 文言の位置（範囲注釈） */

/*
 * 文言へのメモは、条項号より細かい位置を指す。
 * ただし素の文字位置だけで持つと、改正で一文字変わった瞬間に全部ずれる。
 * そこで「どの条項号の中の、どの文言の、何番目の出現か」で持つ。
 *   { anchor: "M/709/1", text: "故意又は過失", nth: 1 }
 * 取り込み直したときは文言を探し直す。見つからなければ捨てずに「要確認」にする。
 *
 * ただし探し直すのは、いま描画している法令だけである。開いていない法令の
 * 文言メモは、開くまで見失ったことが分からない。件数の横にその旨を添えてある。
 * 全法令をまとめて調べるには、全法令を描画し直す必要がある。
 */

/**
 * 条文ブロックの中の文字列と、その文字が属するテキストノードの対応表を作る。
 * 入れ子の別アンカー（号など）、ルビの読み、注釈の付属表示は数に入れない。
 */
function textMapOf(el) {
  const nodes = [];
  let text = '';
  /*
   * 要素も見せてもらい、要らない塊は部分木ごと飛ばす。
   *
   * 前は文字だけを見て、一つひとつ closest で「この文字は自分のものか」を
   * 確かめていた。下位の号の文字も全部たどってから捨てるうえ、文字ごとに
   * 先祖を遡ることになる。会社法2条のように号が38ある項では、これを
   * 何度も払う。入口で切れば、たどりもしないし遡りもしない。
   */
  const SKIP_EL = '.memo-inline, .inline-tags, .note-summary, .slash';
  const walk = document.createTreeWalker(el,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        // 自分で書いた文字は本文ではない。数に入れると文言メモの位置がずれる。
        if (n.matches(SKIP_EL)) return NodeFilter.FILTER_REJECT;
        if (n.tagName === 'RT') return NodeFilter.FILTER_REJECT;
        // 下位の条項号は、その条項号自身のもの。ここでは数えない
        if (n.dataset && n.dataset.anchor) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;        // この要素自身は要らないが、中は見る
      },
    });
  let n;
  while ((n = walk.nextNode())) {
    const v = n.nodeValue || '';
    if (!v) continue;
    nodes.push({ node: n, start: text.length, end: text.length + v.length });
    text += v;
  }
  return { nodes, text };
}

/** 対応表の中で (node, offset) が何文字目にあたるか */
function posInMap(map, node, offset) {
  for (const seg of map.nodes) if (seg.node === node) return seg.start + offset;
  return -1;
}

/** text の nth 番目（1始まり）の出現位置。無ければ -1。 */
function nthIndexOf(hay, needle, nth) {
  let i = -1;
  for (let k = 0; k < nth; k++) {
    i = hay.indexOf(needle, i + 1);
    if (i < 0) return -1;
  }
  return i;
}

/**
 * [s, e) を包む。要素をまたぐ場合はテキストノードごとに分けて包む。
 * tag を変えられるようにしてあるのは、文言メモ（mark）と括弧書き（span）を
 * 別物として扱い、片方の塗り直しでもう片方を巻き込まないようにするため。
 */
/*
 * el の中の s〜e 文字目を包む。
 *
 * map を渡さなければ毎回作り直す。渡す場合は、呼ぶ側が後ろから順に
 * 当てていること。前から当てると、包んだ拍子に後ろの位置がずれる。
 * 作り直しが効くのは、同じ条文に何十回も当てるとき（検索の強調・括弧）。
 */
function wrapInMap(el, s, e, cls, id, tag, map0) {
  const map = map0 || textMapOf(el);
  const hits = map.nodes.filter(seg => Math.max(s, seg.start) < Math.min(e, seg.end));
  for (const seg of hits) {
    const a = Math.max(s, seg.start), b = Math.min(e, seg.end);
    let node = seg.node;
    if (b < seg.end) node.splitText(b - seg.start);
    if (a > seg.start) node = node.splitText(a - seg.start);
    const m = document.createElement(tag || 'mark');
    m.className = cls;
    if (tag) m.dataset.mark = id; else m.dataset.rangeId = id;
    node.parentNode.insertBefore(m, node);
    m.appendChild(node);
  }
  return hits.length > 0;
}

/* ------------------------------------------- メモの遅延保存（取りこぼし防止） */

let pendingSave = null;      // 条項号のメモ { note, timer }
let pendingRange = null;     // 文言メモ { rec, timer }
/*
 * 保存に失敗したものの鍵。
 *
 * 遅延保存は時計から呼ばれるので、失敗しても受け取る相手がいない。
 * ここに残しておいて、書き出しや同期の前に見る。保存できていないのに
 * 送ると、まだDBに無いものが「無い」として相手に伝わる。
 *
 * 真偽値ひとつにすると、一度失敗したら以後ずっと書き出せなくなる。
 * 対象ごとに覚えて、同じものが保存できたら消す。空になれば止めない。
 */
const saveFailures = new Set();

/*
 * 走り出した保存。終わるまでここに入れておく。
 *
 * 遅延保存が時計から始まると、pendingSave は空になる。前はそこで追うのを
 * やめていたので、書き込みの最中に呼ばれた flushSave はその保存を待たず、
 * savesAreClean も「きれい」と答えた。メモ欄から更新ボタンへ移る blur が
 * まさにこれで、保存の途中でも読み込み直しを許していた（Codex の指摘4）。
 *
 * 成否も持ち帰らなければならない。待てても、失敗したことが分からなければ
 * 同じ判断を誤る。例外は false に直して受け止める（呼び手のいない保存が
 * 投げると、誰も受け取らない拒否になる）。
 */
const running = new Set();

/** 保存を走らせ、終わるまで running に入れておく。返すのは成否。 */
function runSave(p) {
  const job = Promise.resolve(p)
    .then(r => r !== false, () => false)
    .then(okSaved => { running.delete(job); return okSaved; });
  running.add(job);
  return job;
}

function scheduleSave(note) {
  if (pendingSave && pendingSave.note !== note) flushSave();
  if (pendingSave) clearTimeout(pendingSave.timer);
  pendingSave = { note, timer: setTimeout(() => { const n = pendingSave.note; pendingSave = null; runSave(saveNote(n)); }, 500) };
}

function scheduleRangeSave(rec) {
  if (pendingRange && pendingRange.rec !== rec) flushSave();
  if (pendingRange) clearTimeout(pendingRange.timer);
  pendingRange = {
    rec,
    timer: setTimeout(() => { const r = pendingRange.rec; pendingRange = null; runSave(saveRange(r)); }, 500),
  };
}

/**
 * 保留中の保存を今すぐ行う。条文や法令を切り替える前、離脱の前に必ず呼ぶ。
 * 条項号のメモと文言メモは別々に遅延させているので、両方をここで面倒を見る。
 * 片方だけ見ていると、見ていない側の書きかけが消える。
 */
async function flushSave() {
  if (pendingSave) {
    clearTimeout(pendingSave.timer);
    const note = pendingSave.note;
    pendingSave = null;
    runSave(saveNote(note));
  }
  if (pendingRange) {
    clearTimeout(pendingRange.timer);
    const rec = pendingRange.rec;
    pendingRange = null;
    runSave(saveRange(rec));
  }

  /*
   * 走り出している保存も待つ。待っている間に時計が別の保存を始めることが
   * あるので、空になるまで繰り返す。
   *
   * 回数を区切るのは、万一終わらないものがあったときに固まらないため。
   * 区切りに達したら false を返す。待ち切れていないのに「保存できた」と
   * 答えると、呼び手がその先へ進んでしまう。
   */
  const rs = [];
  for (let round = 0; running.size && round < 10; round++) {
    rs.push(...await Promise.all([...running]));
  }
  if (running.size) return false;
  return rs.every(r => r !== false);          // 全部保存できたか
}

/*
 * 書き込み中のものが無いか。flushSave を呼べば解消する。
 *
 * 「保存に失敗したものがある」ことで止めはしない。失敗した内容はその時点で
 * もう失われているので、書き出しを止めても取り戻せない。止めるより、
 * 書き出せたものを残して、失敗があったことを添える方が役に立つ。
 * 外へ送る同期では、そこを厳しく見る（savesAreClean）。
 */
function savesArePending() { return !!(pendingSave || pendingRange || running.size); }

/** 書き込み中も無く、失敗も無いか。外へ送る前（同期）はここまで見る。 */
function savesAreClean() { return !savesArePending() && saveFailures.size === 0; }

/** 保存できなかったものの数。知らせるときに使う。 */
function unsavedCount() { return saveFailures.size; }

/*
 * 読み込み直してよいか。書きかけを保存してから答える。
 *
 * 新しい殻に入れ替えるときは、このタブを読み込み直すことになる。読み込み
 * 直せば画面上の編集欄は消えるので、保存できていない編集はその場で失われる。
 * だから「保存できたか」を見てから進まなければならない。
 *
 * 更新ボタンは flushSave を await するだけで、戻り値を見ていなかった
 * （Codex の指摘）。保存に失敗しても、そのまま読み込み直していた。
 * 前に失敗して残っているもの（saveFailures）も同じなので、そこも見る。
 *
 * 戻り値を見るだけでは足りなかった。走り出した保存を誰も持っていなかったので、
 * 書き込みの最中に呼ばれると flushSave がそれを待てなかった（running を
 * 入れて塞いだ）。メモ欄から更新ボタンへ移る blur が現にその経路だった。
 *
 * 書き出し（バックアップ）とは判断が違う。あちらは止めても取り戻せないので
 * 「書き出せたものを残して、失敗を添える」。こちらは止めれば失われない。
 */
async function okToReload() {
  const saved = await flushSave();
  return saved && savesAreClean();
}

/* ------------------------------------------------- 注釈のポップアップ */

/*
 * 選んだ条項号を本文で囲むか（表示設定。端末ごと）。
 *
 * 大事なのは「規則を抑える」のではなく「印を付けない」ことである。
 * 実機で速いと確かめたのは、付けない動作の方だった。規則だけ抑えても、
 * 印を付け替えた時点でブラウザは作り直しの必要を記録する（Codex の指摘）。
 */
const selBoxOn = () => (document.documentElement.dataset.selbox || 'on') !== 'off';

/** 枠を出している番号の要素。ポップアップはこれに寄せて開く。 */
function numberElOf(el) {
  return el.querySelector(':scope > .para-num, :scope > .item-title, :scope > .article-title, :scope > .article-caption')
    || el.querySelector(':scope > .para > .article-title')
    || el;
}

function positionPopover() {
  const pop = $('#popover');
  if (pop.hidden || !state.selected) return;
  if (window.innerWidth <= 640) { pop.style.left = ''; pop.style.top = ''; return; }

  const block = $(`[data-anchor="${CSS.escape(state.selected)}"]`, P().el);
  if (!block) return;
  const r = numberElOf(block).getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const pad = 12;

  let left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad);
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - pad) {
    const above = r.top - h - 8;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad);
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openPopover() {
  const pop = $('#popover');
  if (!P().current || !state.selected) { closePopover(); return; }
  $('#pop-anchor').textContent = anchorLabel(state.selected);
  pop.hidden = false;
  renderNotePane();
  positionPopover();
}

/** 文言メモの編集。条項号の注釈とは別の内容を同じパネルに出す。 */
function openRangePopover(id) {
  // id を渡すのが本筋だが、レコードを渡す呼び方を一度取り違えたので受ける
  const rec = state.ranges.get(typeof id === 'string' ? id : (id && id.id));
  if (!rec) return;
  state.selected = rec.anchor;
  $$('.sel').forEach(e => e.classList.remove('sel'));

  const pop = $('#popover');
  $('#pop-anchor').textContent = anchorLabel(rec.anchor) + '　の文言';
  pop.hidden = false;

  const body = $('#notes-body');
  body.innerHTML = `
    ${conflictHtml(rec)}
    <div class="note-quote">${esc(rec.text)}</div>
    <p class="note-label">色</p>
    <div class="palette" id="palette"></div>
    <p class="note-label">メモ</p>
    <textarea id="memo-input" placeholder="この文言についてのメモ"></textarea>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <button type="button" id="range-del" class="mini">削除</button>
      <span class="saved-at" id="saved-at"></span>
    </div>
  `;

  wireConflict(body, rec, async solved => {
    if (isTomb(solved)) {
      await store.tombRange(solved);
      state.ranges.delete(solved.id);
      paintRanges();
      renderMarkList();
      closePopover();
      return;                          // 消したものの画面は開き直さない
    }
    await store.putRange(solved);
    state.ranges.set(solved.id, solved);
    paintRanges();
    renderMarkList();
    openRangePopover(solved.id);
  });

  const palette = $('#palette');
  const paint = () => {
    palette.innerHTML = '';
    for (const c of RANGE_STYLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      // 下線は色を敷かない。見本も下線で示す。
      if (c.key === 'ul') b.className = 'ul';
      else b.style.background = `var(--mk-${c.key})`;
      if (rec.color === c.key) b.classList.add('on');
      b.onclick = async () => { rec.color = c.key; await saveRange(rec); paint(); };
      palette.appendChild(b);
    }
  };
  paint();

  const memo = $('#memo-input');
  memo.value = rec.memo || '';
  memo.oninput = () => { rec.memo = memo.value; scheduleRangeSave(rec); };
  memo.onblur = () => flushSave();

  $('#range-del').onclick = async () => {
    if (!confirm('この文言のメモを削除します。よろしいですか？')) return;
    // 保留中の保存を先に止めないと、削除したあとに書き戻されて復活する
    if (pendingRange) { clearTimeout(pendingRange.timer); pendingRange = null; }
    await deleteRange(rec.id);
  };
  $('#saved-at').textContent = rec.updatedAt
    ? '最終更新 ' + new Date(rec.updatedAt).toLocaleString('ja-JP') : '';

  const el = $(`mark[data-range-id="${CSS.escape(rec.id)}"]`, P().el);
  if (el) {
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, pad = 12;
    pop.style.left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad) + 'px';
    const top = r.bottom + 8;
    pop.style.top = (top + h > window.innerHeight - pad
      ? Math.max(pad, r.top - h - 8) : top) + 'px';
  }
}

function closePopover() {
  closePopoverKeepSelection();
  $$('.sel').forEach(e => e.classList.remove('sel'));
  state.selected = null;
}

/** パネルだけ畳む。枠（選択）は残す。ジャンプ直後はこちらを使う。 */
function closePopoverKeepSelection() {
  const pop = $('#popover');
  if (pop.hidden) return;
  flushSave();
  pop.hidden = true;
}

/* ------------------------------------------------------ タグ・メモの描画 */

async function loadNotes() {
  /*
   * 読めない形のものがDBに残っていても、起動はできるようにする。
   *
   * 検証を通り抜けて入ってしまったものがあると、ここで例外になり、以後は
   * 起動するたびに同じ場所で止まる。画面が出ないので消すこともできない。
   * DBからは消さず（後で直せるように）、画面に出すものからだけ外す。
   */
  const rows = await store.allNotes();
  const bad = rows.filter(n => noteProblem(n, true));
  const all = livingOnly(rows.filter(n => !noteProblem(n, true)));
  if (bad.length) toast('読めない注釈が ' + bad.length + '件あります（表示していません）');
  state.notes = new Map(all.map(n => [n.key, n]));
  renderMarkList();
  renderFilterPicker();
}

function paintNotes() {
  for (const pane of livePanes()) paintNotesIn(pane);
}

function paintNotesIn(pane) {
  /*
   * 前に塗ったものを外す。全アンカー（会社法で6,318件）を舐めるのではなく、
   * 実際に塗ってあるものだけを外す。注釈が1件も無ければ何も起きない。
   */
  for (const el of $$('.mk', pane.el)) {
    el.classList.remove('mk');
    MARK_COLORS.forEach(c => el.classList.remove('mk-' + c.key));
  }
  for (const el of $$('.inline-tags, .memo-inline, .note-summary', pane.el)) el.remove();

  if (!pane.current) return;

  // 塗る先も、注釈のある場所だけを引く。本文を端から見ない。
  for (const n of state.notes.values()) {
    if (n.lawId !== pane.current.lawId) continue;
    const el = findAnchorEl(n.anchor, pane);
    if (!el) continue;
    applyNoteTo(el, n);
  }
}

/** その注釈が持っている差し込みだけを外す（入れ子の中に入っていても引ける）。 */
function dropOwned(el, cls, anchor) {
  for (const x of el.querySelectorAll(cls + '[data-for="' + attrEsc(anchor) + '"]')) x.remove();
}

/**
 * 1つの条項号に、その注釈の見た目を当てる。n が無ければ外す。
 * paintNotesIn と repaintNote が同じ道を通るように、ここに集めておく。
 */
function applyNoteTo(el, n) {
  const anchor = el.dataset.anchor || '';

  el.classList.remove('mk');
  for (const c of MARK_COLORS) el.classList.remove('mk-' + c.key);
  if (n && n.color) el.classList.add('mk', 'mk-' + n.color);

  if (n && (n.tags || []).length) insertTags(el, n.tags);
  else dropOwned(el, '.inline-tags', anchor);

  /*
   * 前メモは insertSummary が必ず新しく作るので、すでにあるものは中身だけ
   * 書き換える。外して付け直すと、打っている途中に差し込み位置が飛ぶ。
   */
  const sum = String((n && n.summary) || '').trim();
  const had = el.querySelector(':scope > .note-summary');
  if (sum) { if (had) had.textContent = sum; else insertSummary(el, sum); }
  else if (had) had.remove();

  const memo = String((n && n.memo) || '').trim();
  if (memo) insertMemo(el, memo);
  else dropOwned(el, '.memo-inline', anchor);
}

/*
 * 1つの条項号ぶんだけ塗り直す。
 *
 * タグを1つ付けるたびに、開いている法令の注釈を全部外して付け直していた。
 * 外す量そのものより、そのあとに配置を計算し直す量が効く。会社法は要素が
 * 2万・文字が75万あり、iPhone では一手に数秒かかっていた。触ったところだけ
 * 触る。ほかの条項号の見た目は、そもそも変わっていない。
 */
function repaintNote(lawId, anchor) {
  for (const pane of livePanes()) {
    if (!pane.current || pane.current.lawId !== lawId) continue;
    const el = findAnchorEl(anchor, pane);
    if (el) applyNoteTo(el, state.notes.get(noteKey(lawId, anchor)));
  }
}

/**
 * 要約を本文の前に差し込む。条文番号のすぐ後ろ、本文の手前に置く。
 * 自分で書いた言葉が条文本文に紛れないよう、書体と色で明確に分ける。
 */
function insertSummary(el, text) {
  const span = document.createElement('span');
  span.className = 'note-summary';
  span.textContent = text;
  const num = el.querySelector(':scope > .para-num, :scope > .item-title, :scope > .article-title');
  if (num) { num.after(span); return span; }
  // 条に付けた場合。条番号は第1項の中にあるので直下には無い。法令の見出しの後ろに置く。
  const cap = el.querySelector(':scope > .article-caption');
  if (cap) cap.after(span);
  else el.prepend(span);
  return span;
}

/*
 * 後メモを入れる位置を決める。下位の条項号があれば、その直前を返す。
 *
 * 刑訴60条1項のように号を持つ項では、末尾に足すと第三号の下に出てしまう。
 * 号にもそれぞれのアンカーがあるので、項に付けたメモと第三号に付けたメモが
 * 見分けられない。会社法2条1項なら38号ぶん流れた先に出る。
 *
 * ただし自分の文を持たない要素は末尾のままにする。条は本文を持たず項を
 * 並べるだけなので、前に入れると見出しの直後、つまり前メモと同じ場所になり、
 * 「前」「後」の区別が消える。番号と見出しは自分の文には数えない。
 */
/*
 * 「自分の文」に数えないもの。番号・見出し・自分で書いた注釈。
 *
 * h-section は編章節款目の見出しで、renderBlock が出す。別記のように
 * 本文を持たない容器の中に見出しと項が並ぶと、これを本文と数えてしまい
 * 「見出し → 後メモ → 第1項」の順になる（Codex の指摘）。
 * 本文を落とす向きの誤りを避けるため、除くのは見出しだけに限る。
 */
const NOT_BODY = ['article-title', 'para-num', 'item-title', 'article-caption',
  'h-section', 'suppl-label', 'note-dup',
  'note-summary', 'inline-tags', 'memo-inline'];

/** el が「自分の文」を持っているか。番号・見出し・自分で書いた注釈は数えない。 */
function hasOwnBody(el, until) {
  for (let n = el.firstChild; n && n !== until; n = n.nextSibling) {
    if (n.nodeType === 3) {                       // 素のテキスト。本文はここに出る
      if (n.nodeValue.trim()) return true;
      continue;
    }
    if (n.nodeType !== 1) continue;
    if (NOT_BODY.some(c => n.classList.contains(c))) continue;
    if (n.textContent.trim()) return true;        // 括弧書き・ルビ・印なども本文
  }
  return false;
}

/*
 * 後メモを置く場所。親と、その直前に入れる要素を返す。
 *
 * 自分の文があれば、その直後（＝下位の条項号の直前）に置く。
 *
 * 条は自分の文を持たず、項を並べるだけである。しかし **項が1つだけの条** では、
 * その項の中身が「この条の本文」そのものなので、中に入って柱書の直後に置く。
 * ここを末尾のままにすると、号を持つ条で号の後ろへ回ってしまう。
 * 刑訴89条（号6個）で末尾、会社法2条なら38号ぶん離れた先に出ていた。
 *
 * 項が2つ以上ある条は末尾のままにする。どの項に付けたのか紛れるし、
 * 「この条について」のメモは最後にある方が自然である。
 */
function memoSlot(el) {
  const first = [...el.children].find(c => c.dataset && c.dataset.anchor);
  if (!first) return { parent: el, before: null };      // 下位が無い。末尾でよい
  if (hasOwnBody(el, first)) return { parent: el, before: first };

  if (el.classList.contains('article')) {
    const paras = [...el.children]
      .filter(c => c.classList.contains('para') && c.dataset && c.dataset.anchor);
    if (paras.length === 1) return memoSlot(paras[0]);   // 項1つ＝この条の本文
  }
  return { parent: el, before: null };
}

/** 後方互換のための薄い包み（試験と、以前の呼び出しのため）。 */
function memoInsertPoint(el) {
  const slot = memoSlot(el);
  return slot.parent === el ? slot.before : slot.before;
}

/*
 * 文字タグを本文に置く。
 *
 * 以前は要素の末尾に足していた。すると号を持つ項では、号を全部飛び越えて
 * 一番後ろに出る。刑訴89条（号6個）や会社法2条（号38個）で、タグだけが
 * 遠くに離れていた。後メモと同じ場所（自分の文の直後）に置く。
 *
 * タグは短い札なので、後メモ（塊）より前に出す。paintNotesIn がタグ→後メモの
 * 順に呼ぶので、同じ差し込み位置を指定すれば、その順に並ぶ。
 */
function insertTags(el, tags) {
  const anchor = el.dataset.anchor || '';
  const sel = '.inline-tags[data-for="' + attrEsc(anchor) + '"]';
  let span = el.querySelector(sel);
  if (!span) {
    span = document.createElement('span');
    span.className = 'inline-tags';
    span.dataset.for = anchor;
  }
  span.innerHTML = tags.map(t => `<span class="t">${esc(t)}</span>`).join('');
  const { parent, before } = memoSlot(el);
  if (span.parentNode !== parent || span.nextSibling !== before) {
    parent.insertBefore(span, before);
  }
  return span;
}

/*
 * 後メモを本文に置く。すでにあるものは、必要なときだけ動かす。
 *
 * 置き場所が入れ子の中（項の中）になることがあるので、どのアンカーのメモかを
 * data-for に書いておく。直下だけを探すと、中に入れたものを見つけられず、
 * 塗り直すたびに増えてしまう。
 */
function insertMemo(el, text) {
  const anchor = el.dataset.anchor || '';
  const sel = '.memo-inline[data-for="' + attrEsc(anchor) + '"]';
  let div = el.querySelector(sel);
  if (!div) {
    div = document.createElement('div');
    div.className = 'memo-inline';
    div.dataset.for = anchor;
  }
  const { parent, before } = memoSlot(el);
  // 打っている途中に飛ばさないよう、場所が変わるときだけ動かす
  if (div.parentNode !== parent || div.nextSibling !== before) {
    parent.insertBefore(div, before);
  }
  div.textContent = text;
  return div;
}

/** 要約の打ち込みを本文側へ即時反映する */
function updateInlineSummary(anchor, text, pane) {
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, (pane || P()).el);
  if (!el) return;
  const old = el.querySelector(':scope > .note-summary');
  if (!String(text).trim()) { if (old) old.remove(); return; }
  if (old) old.textContent = text;
  else insertSummary(el, text);
}

/** 本文に置いているメモを、打ち込みに合わせて即時更新する */
function updateInlineMemo(anchor, text, pane) {
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, (pane || P()).el);
  if (!el) return;
  if (!String(text).trim()) {
    const old = el.querySelector('.memo-inline[data-for="'
      + attrEsc(el.dataset.anchor || '') + '"]');
    if (old) old.remove();
    return;
  }
  insertMemo(el, text);
}

/* ------------------------------------------------------- マークとタグ一覧 */

/**
 * 位置を見つけられなかった文言メモを画面に出す。
 * 出さないと、消えていないのに消えたようにしか見えない。
 * 「黙って消さない」方針は、利用者が気づける形になって初めて満たされる。
 */
function renderOrphans() {
  const box = $('#orphan-box');
  const ul = $('#orphan-list');
  const list = state.orphanRanges;
  box.hidden = !list.length;
  ul.innerHTML = '';
  if (!list.length) return;
  $('#orphan-count').textContent = list.length + '件';

  for (const r of list) {
    const law = state.laws.find(l => l.lawId === r.lawId);
    const li = document.createElement('li');
    li.innerHTML = `<div class="phrase">${esc(r.text)}</div>`
      + `<div class="where">${esc(law ? law.lawTitle : r.lawId)}　${esc(anchorLabel(r.anchor))}`
      + '　本文に見つかりません</div>'
      + (r.memo ? `<div class="where">${esc(r.memo.slice(0, 60))}</div>` : '')
      + '<div class="acts"><button class="mini go">その条文へ</button>'
      + '<button class="mini del">削除</button></div>';
    li.querySelector('.go').onclick = () => navigate(r.lawId, r.anchor);
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`「${r.text}」の文言メモを削除します。よろしいですか？`)) return;
      await deleteRange(r.id);
    };
    ul.appendChild(li);
  }
}

/*
 * 自分で書いたものを1つの形に揃える。
 *
 * 条項号への注釈（state.notes）と、文言への注釈（state.ranges）は
 * 保存先も指す場所も違うが、「あとで引きたい」という点では同じである。
 * 一覧が片方しか集めていないと、色もタグも付けずにメモだけ書いた場所や、
 * 文言に塗った色が、どこからも辿れなくなる。語を覚えていないと探せない。
 */
function allMarks() {
  const out = [];
  for (const n of state.notes.values()) {
    out.push({
      kind: 'note', lawId: n.lawId, anchor: n.anchor, at: n.updatedAt || 0,
      color: n.color || '', tags: n.tags || [],
      memo: [n.summary, n.memo].map(t => String(t || '').trim()).filter(Boolean).join('　'),
      phrase: '',
    });
  }
  for (const r of state.ranges.values()) {
    out.push({
      kind: isSlash(r) ? 'slash' : 'range', id: r.id, lawId: r.lawId, anchor: r.anchor,
      at: r.updatedAt || 0,
      slash: SLASH_KINDS[r.kind] || '',
      color: r.color || '', tags: [],
      memo: String(r.memo || '').trim(),
      phrase: r.text || '',
    });
  }
  return out;
}

function renderMarkList() {
  const marks = allMarks();
  const byColor = new Map();
  const byTag = new Map();
  let memoCount = 0;
  for (const m of marks) {
    if (m.color) byColor.set(m.color, (byColor.get(m.color) || 0) + 1);
    for (const t of m.tags) byTag.set(t, (byTag.get(t) || 0) + 1);
    if (m.memo) memoCount++;
  }

  const ml = $('#mark-list');
  ml.innerHTML = '';
  const used = RANGE_STYLES.filter(c => byColor.get(c.key));
  const anySlash = marks.some(m => m.kind === 'slash');
  if (!used.length && !memoCount && !anySlash) {
    ml.innerHTML = '<li style="color:var(--fg-faint);cursor:default">まだありません</li>';
  }
  for (const c of used) {
    const li = document.createElement('li');
    li.innerHTML = (c.key === 'ul'
      ? '<span class="sw ul"></span>'
      : `<span class="sw" style="background:var(--mk-${c.key})"></span>`)
      + `<span>${esc(c.label)}</span><span class="n">${byColor.get(c.key)}</span>`;
    li.onclick = () => showMarkResults(m => m.color === c.key,
      c.key === 'ul' ? '下線' : `${c.label}のマーク`);
    ml.appendChild(li);
  }
  /*
   * 固定した版に付けた注釈は、元の法令とは別の住所になる。端末ごとに片方
   * しか持っていないと揃わないので、移せることを知らせる。
   */
  const rev = countRevisionNotes();
  const revBox = $('#rev-move-box');
  if (revBox) {
    revBox.hidden = !rev.moved;
    const body = $('#rev-move-body');
    const btn = $('#btn-rev-move');
    if (rev.moved && body) {
      body.textContent = '固定した版に付けた注釈が ' + rev.moved + '件あります。'
        + '元の法令とは別のものとして扱われるため、ほかの端末と揃いません。'
        + (rev.missing.length
          ? '（移した先の ' + rev.missing.join('、')
            + ' はこの端末にありません。同期すれば、持っている端末で揃います。）'
          : '');
    }
    if (btn) btn.hidden = !rev.moved;
  }

  /*
   * 別々に直したものは、放っておくと気づけない。専用の行で数を出す。
   * 押せばその一覧が出るので、そこから開いて決められる。
   */
  const cfCount = [...state.notes.values()].filter(hasConflict).length
    + [...state.ranges.values()].filter(hasConflict).length;
  if (cfCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--mk-red-b,#c00)"></span>'
      + `<span>別の編集があるもの</span><span class="n">${cfCount}</span>`;
    li.onclick = () => showMarkResults(m => {
      const r = m.kind === 'note'
        ? state.notes.get(m.lawId + ':' + m.anchor) : state.ranges.get(m.id);
      return hasConflict(r);
    }, '別の編集があるもの');
    ml.appendChild(li);
  }

  // 区切りは色もメモも持たないので、専用の行が無いと一覧から辿れない
  const slashCount = marks.filter(m => m.kind === 'slash').length;
  if (slashCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--ink)"></span>'
      + `<span>区切りの印</span><span class="n">${slashCount}</span>`;
    li.onclick = () => showMarkResults(m => m.kind === 'slash', '区切りの印');
    ml.appendChild(li);
  }

  if (memoCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--ink)"></span>'
      + `<span>メモのあるもの</span><span class="n">${memoCount}</span>`;
    li.onclick = () => showMarkResults(m => !!m.memo, 'メモ');
    ml.appendChild(li);
  }

  const tl = $('#tag-list');
  tl.innerHTML = '';
  if (!byTag.size) {
    tl.innerHTML = '<li style="color:var(--fg-faint);cursor:default">まだありません</li>';
    return;
  }
  for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(tag)}</span><span class="n">${n}</span>`;
    li.onclick = () => showMarkResults(m => m.tags.includes(tag), `タグ「${tag}」`);
    tl.appendChild(li);
  }
}

function renderNotePane() {
  const body = $('#notes-body');
  if (!P().current || !state.selected) return;
  const pane = P();
  const lawId = pane.current.lawId;
  const anchor = state.selected;
  const key = noteKey(lawId, anchor);
  const note = state.notes.get(key)
    || { key, lawId, anchor, tags: [], summary: '', memo: '', color: '' };
  const entry = P().index.find(e => e.anchor === anchor);

  /*
   * いま選んでいる位置が、取り込んだデータの中で他と重なっているなら、
   * そのときに言う。付けても「どちらに付けたのか」が決まらない。
   */
  const dupHere = (pane.current.dupAnchors || []).includes(anchor);

  body.innerHTML = `
    ${dupHere ? '<div class="note-dup">この位置は、同じ番号の別の条項と重なっています。'
      + 'ここに付けた注釈は、どちらを指すか決まりません。</div>' : ''}
    ${conflictHtml(note)}
    <div class="note-quote">${esc(entry ? entry.text : '')}</div>
    <p class="note-label">マーク</p>
    <div class="palette" id="palette"></div>
    <p class="note-label">前メモ</p>
    <input id="summary-input" type="text" placeholder="この条文を一言でいうと" autocomplete="off">
    <p class="note-label">文字タグ</p>
    <div class="note-tags" id="tag-chips"></div>
    <input id="tag-input" type="text" placeholder="タグを入力して Enter" autocomplete="off">
    <div class="tag-known" id="tag-known"></div>
    <p class="note-label">後メモ</p>
    <textarea id="memo-input" placeholder="詳しく書き足したいこと"></textarea>
    <div class="saved-at" id="saved-at"></div>
  `;

  wireConflict(body, note, async solved => {
    // 選んだ中身で置き換える。版は resolveConflict が組んである
    if (isTomb(solved)) {
      // 「消した方」を選んだ。消した印として書き、画面からは外す
      await store.tombNote(solved);
      state.notes.delete(solved.key);
      closePopover();
    } else {
      await store.putNote(solved);
      state.notes.set(solved.key, solved);
    }
    paintNotes();
    renderMarkList();
    renderNotePane();
  });

  const palette = $('#palette');
  const paintPalette = () => {
    palette.innerHTML = '';
    for (const c of MARK_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.style.background = `var(--mk-${c.key})`;
      if (note.color === c.key) b.classList.add('on');
      b.onclick = async () => {
        note.color = note.color === c.key ? '' : c.key;   // 同じ色を押したら外す
        await saveNote(note);
        paintPalette();
      };
      palette.appendChild(b);
    }
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'none';
    none.title = 'マークなし';
    none.textContent = '／';
    if (!note.color) none.classList.add('on');
    none.onclick = async () => { note.color = ''; await saveNote(note); paintPalette(); };
    palette.appendChild(none);
  };
  paintPalette();

  let paintKnownRef = () => {};      // 下で定義する（タグを外したときも候補を出し直す）

  const chips = $('#tag-chips');
  const paintChips = () => {
    chips.innerHTML = '';
    for (const t of note.tags) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${esc(t)}<button title="外す">×</button>`;
      c.querySelector('button').onclick = async () => {
        note.tags = note.tags.filter(x => x !== t);
        await saveNote(note);
        paintChips();
        if ($('#tag-known')) paintKnownRef();
      };
      chips.appendChild(c);
    }
  };
  paintChips();

  /*
   * 使ったことのあるタグを押して付けられるようにする。
   * 同じタグを続けて付けるとき、毎回同じ文字を打つのは無駄である。
   * 打ち込みも残す。新しいタグはそちらで足す。
   */
  const known = $('#tag-known');
  const paintKnown = () => {
    const count = new Map();
    for (const n of state.notes.values()) {
      for (const t of (n.tags || [])) count.set(t, (count.get(t) || 0) + 1);
    }
    const list = [...count]
      .filter(([t]) => !note.tags.includes(t))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
      .slice(0, 12);
    known.innerHTML = '';
    for (const [t] of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-known-btn';
      b.textContent = t;
      b.onclick = async ev => {
        note.tags.push(t);
        await saveNote(note);
        paintChips();
        paintKnown();
      };
      known.appendChild(b);
    }
  };

  const addTag = async (v, ev) => {
    if (!v || note.tags.includes(v)) return;
    note.tags.push(v);
    await saveNote(note);
    paintChips();
    paintKnown();
  };

  const tagInput = $('#tag-input');
  tagInput.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = tagInput.value.trim();
    tagInput.value = '';
    await addTag(v, e);
  };
  /*
   * 外したタグを候補に戻せるよう、チップ側からも呼べるようにしておく。
   * この代入が「候補を押したとき」の中に紛れ込んでいたため、一度も候補を
   * 押していないうちはチップを外しても候補が出し直されなかった。
   */
  paintKnownRef = paintKnown;
  paintKnown();

  const summary = $('#summary-input');
  summary.value = note.summary || '';
  summary.oninput = () => {
    note.summary = summary.value;
    updateInlineSummary(anchor, summary.value, pane);
    scheduleSave(note);
  };
  summary.onblur = () => flushSave();

  const memo = $('#memo-input');
  memo.value = note.memo || '';
  // 入力は即座に note へ反映し、DB 書き込みだけを遅らせる。
  // こうしないと、500ms 以内に条文を切り替えたときに古い状態で上書きされる。
  memo.oninput = () => {
    note.memo = memo.value;
    updateInlineMemo(anchor, memo.value, pane);   // 本文側のぶら下げ表示は即座に追従させる
    scheduleSave(note);
  };
  memo.onblur = () => flushSave();

  $('#saved-at').textContent = note.updatedAt
    ? '最終更新 ' + new Date(note.updatedAt).toLocaleString('ja-JP') : '';
}

/*
 * 保存できたかどうかを返す（true / false）。
 *
 * 以前は失敗しても toast を出して正常に返っていたので、呼び側が成否を
 * 区別できなかった。同期では「保存できていないのに送る」ことになる。
 * 例外にはしない。打っている最中の自動保存が失敗したときに、操作全体を
 * 止めてしまうため。
 */
async function saveNote(note) {
  note.updatedAt = Date.now();

  let old = null;
  try { old = await store.getNote(note.key); }
  catch (e) { /* 読めなくても保存は続ける */ }

  /*
   * 版の継ぎ方は、相手が墓石か、生きている記録かで分ける。
   *
   * 墓石なら継ぐ。消した印は state.notes に載せていないので、同じ場所に
   * 書き直すと版が 1 から数え直しになる。他の端末には進んだ版の墓石が
   * 残っているため、同期すると「消した」が勝ち、書き直した中身が消える。
   * 墓石には中身が無いので、継いでも失うものがない。
   *
   * 生きている記録は継がない。継ぐと、こちらが見ていない中身を
   * 「承知したうえで書き換えた」ことになり、相手の編集を黙って消す。
   * これを継いでいたため、同期で受け取ったメモが、開いたままの古い編集欄から
   * 色を1つ変えるだけで消えていた（衝突の候補も残らない）。
   */
  const base = (old && isTomb(old)) ? vvMerge(note.version, old.version) : note.version;
  note.version = vvBump(base, deviceId);

  const empty = !note.tags.length && !(note.memo || '').trim()
    && !(note.summary || '').trim() && !note.color;
  // 消した印を残す。本当に消すと、古いバックアップから復活する
  let out = empty ? noteTomb(note, note.updatedAt) : note;

  /*
   * こちらの版が相手を含んでいないなら、相手を見ていない。
   * 片方を捨てず、両方残す。
   *
   * 表に出すのは、いま打った方にする。時計の前後で決めると、打った文字が
   * 候補に回って画面から消える（相手の時計が進んでいれば現に起きる）。
   * 版は相手のぶんを取り込まない。取り込むと「承知した」ことになり、
   * 次の突き合わせで相手の候補が落とされる。そこが①の副作用の正体だった。
   *
   * ただし、こちらが空にした（墓石）ときは同期と同じ決まりに任せる。
   * 墓石を表に出すと、相手の生きた中身が画面から消えてしまう。
   */
  let merged = false;
  if (old && !isTomb(old) && !vvDominates(note.version, old.version)) {
    if (isTomb(out)) {
      out = mergeRecord(old, out);
    } else {
      const { alts: _mine, ...mineClean } = out;
      const { alts: _old, ...oldClean } = old;
      const alts = pruneAlts([oldClean, ...collectAlts(old, out)], mineClean);
      out = alts.length ? { ...mineClean, alts } : mineClean;
    }
    merged = true;
  }

  try {
    if (isTomb(out)) {
      await store.tombNote(out);
      state.notes.delete(note.key);
    } else {
      await store.putNote(out);
      state.notes.set(note.key, out);
    }
    saveFailures.delete('note:' + note.key);      // 保存できたので、前の失敗は解く
  } catch (err) {
    saveFailures.add('note:' + note.key);
    toast('保存できませんでした: ' + err.message);
    return false;
  }
  renderMarkList();
  renderFilterPicker();
  /*
   * 触った条項号だけを塗り直す。
   *
   * 文言注釈（paintRanges）はここでは触らない。条項号のタグ・メモは
   * textMapOf が本文から外しているので、文言注釈の位置に影響しない。
   * 毎回すべての印を外して包み直していたが、まるごと無駄だった。
   */
  repaintNote(note.lawId, note.anchor);
  /*
   * 突き合わせが起きたなら、編集欄を作り直す。
   *
   * 作り直さないと、欄はこちらの古いオブジェクトを掴んだままなので、
   * 打つたびに同じ突き合わせを繰り返す。作り直せば、相手の版まで取り込んだ
   * 記録を掴み直すので、次からは普通の編集に戻る。
   * 表に出るのはこちらの中身なので、打ったものが消えることはない。
   */
  if (merged && state.selected === note.anchor
    && P().current && P().current.lawId === note.lawId) {
    toast('別の端末でも直されていました。両方残しました');
    renderNotePane();
  }
  if (state.selected) {
    const el = $(`[data-anchor="${CSS.escape(state.selected)}"]`, P().el);
    if (el && selBoxOn()) el.classList.add('sel');   // 設定で切れる（上の注記）
  }
  const at = $('#saved-at');
  if (at && state.selected === note.anchor && P().current && P().current.lawId === note.lawId) {
    at.textContent = '最終更新 ' + new Date(note.updatedAt).toLocaleString('ja-JP');
  }
  return true;
}

/* ------------------------------------------------------ 文言へのメモ（範囲） */


async function loadRanges() {
  // 墓石は画面に出さない。読めない形のものも外す（loadNotes と同じ理由）
  const rows = await store.allRanges();
  const bad = rows.filter(r => rangeProblem(r, true));
  if (bad.length) toast('読めない文言注釈が ' + bad.length + '件あります（表示していません）');
  state.ranges = new Map(
    livingOnly(rows.filter(r => !rangeProblem(r, true))).map(r => [r.id, r]));
}

/** 現在の法令の範囲注釈を本文に塗る。位置が見つからないものは印を付けて残す。 */
function paintRanges() {
  state.orphanRanges = [];
  for (const pane of livePanes()) paintRangesIn(pane);
  renderOrphans();
}

/** 包んである印を、その場所から外して元の文に戻す。 */
function stripRangeMarks(root) {
  for (const m of $$('mark[data-range-id]', root)) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  }
  // 区切りの印は中身を持たないので、そのまま外す。片付けを忘れると重なって増える。
  for (const m of $$('span[data-slash-id]', root)) {
    const parent = m.parentNode;
    m.remove();
    parent.normalize();
  }
}

/** 文言注釈を1件、その条項号の中に置く。置けなければ false（要確認行き）。 */
function placeRange(el, r) {
  const map = textMapOf(el);
  // 指定の出現が無いときに最初の一致へ寄せると、別の文言に注釈が移ってしまう。
  // 「黙って別の場所に付けない」方針のとおり、見つからなければ要確認にする。
  const at = nthIndexOf(map.text, r.text, r.nth || 1);
  if (at < 0) return false;
  if (isSlash(r)) {
    // 「。」の直後に置く。文言そのものは包まない。
    placePointInMap(el, at + r.text.length,
      'slash' + (r.kind === 'dslash' ? ' dslash' : ''), r.id, map);
  } else {
    wrapInMap(el, at, at + r.text.length,
      'rng' + (r.color ? ' rng-' + r.color : '') + (r.memo ? ' has-memo' : ''), r.id);
  }
  return true;
}

function paintRangesIn(pane) {
  stripRangeMarks(pane.el);
  if (!pane.current) return;

  for (const r of state.ranges.values()) {
    if (r.lawId !== pane.current.lawId) continue;
    const el = findAnchorEl(r.anchor, pane);
    if (!el || !placeRange(el, r)) state.orphanRanges.push(r);
  }
}

/*
 * 1つの条項号ぶんの文言注釈だけを塗り直す（repaintNote と同じ理由）。
 *
 * 要確認の一覧は全体を見て作るので、この条項号ぶんだけ入れ替える。
 */
function repaintRangesAt(lawId, anchor) {
  const panes = livePanes().filter(p => p.current && p.current.lawId === lawId);
  if (!panes.length) return;          // 開いていない法令。要確認の一覧も動かさない

  state.orphanRanges = state.orphanRanges
    .filter(r => !(r.lawId === lawId && r.anchor === anchor));
  for (const pane of panes) {
    const el = findAnchorEl(anchor, pane);
    if (el) stripRangeMarks(el);          // 先に外してから置く。順を逆にすると消える
    for (const r of state.ranges.values()) {
      if (r.lawId !== lawId || r.anchor !== anchor) continue;
      if (!el || !placeRange(el, r)) state.orphanRanges.push(r);
    }
  }
  renderOrphans();
}


/* ------------------------------------------------------- 区切りの印（/ //） */

/*
 * 紙の六法に手で引く「/」と同じもの。本文とただし書、前段と後段の境目に
 * 自分で引く。自動では引かない。
 *
 * 法令標準XMLは、ただし書を Sentence@Function="proviso" として持っているし、
 * 前段後段も Sentence が分かれている（民法339組・会社法339組など実測）。
 * それを読んで自動で出すこともできるが、そうしない。民法だけで339箇所に
 * 一斉に出ても、ほとんどは線を引きたい場所ではない。印を付ける行為そのものが
 * 読むことの一部であり、自動で出たものは自分が引いた線ではない。
 * 加えて、取り込んだデータには構造が無いことがある（民事訴訟規則は Function
 * ゼロ・文の分割もゼロ）。手で引く形なら、データの質に左右されない。
 *
 * 位置の持ち方は文言メモと同じ。「。」までの数文字と、その条項号の中で
 * 何番目の出現かで持つ。文字の位置では持たない。改正で一字変われば全部ずれる。
 *
 * 本文に「/」の文字は入れない。条文に無い文字なので、検索・コピー・書き出し・
 * 他の注釈の位置計算に混ざる。幅ゼロの印を置いて CSS で描く。
 */

const SLASH_KINDS = { slash: '/', dslash: '//' };

/** 区切りか。kind を持たない古い記録は、これまでどおり文言メモ。 */
function isSlash(r) { return !!(r && SLASH_KINDS[r.kind]); }

/**
 * el の中の pos 文字目に、幅ゼロの印を置く。
 * wrapInMap は正の長さが無いと何も作らないので、こちらは別に用意する。
 */
function placePointInMap(el, pos, cls, id, map0) {
  const map = map0 || textMapOf(el);
  const seg = map.nodes.find(x => pos >= x.start && pos <= x.end);
  if (!seg) return false;
  const node = seg.node;
  const off = pos - seg.start;
  const mark = document.createElement('span');
  mark.className = cls;
  mark.dataset.slashId = id;

  if (off <= 0) {
    node.parentNode.insertBefore(mark, node);
  } else if (off >= node.nodeValue.length) {
    // その文字ノードの末尾。親の末尾ではなく、この文字ノードのすぐ後ろに置く。
    // 親の末尾に付けると、後ろにぶら下がるメモより外に出てしまう。
    node.parentNode.insertBefore(mark, node.nextSibling);
  } else {
    const rest = node.splitText(off);
    rest.parentNode.insertBefore(mark, rest);
  }
  return true;
}

/*
 * 押した場所の近くにある「。」を探す。
 *
 * 「。」を一つずつ要素で包むことはしない。民法だけで3,000個を超えるので、
 * 読むための本文がそのぶん重くなる。押された座標から文字の位置を割り出し、
 * その前後だけを見る。
 */
function sentenceEndNear(x, y) {
  let node = null, off = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const r = document.caretPositionFromPoint(x, y);
    if (r) { node = r.offsetNode; off = r.offset; }
  }
  if (!node || node.nodeType !== 3) return null;

  const el = node.parentElement && node.parentElement.closest('[data-anchor]');
  if (!el) return null;

  const map = textMapOf(el);
  const seg = map.nodes.find(s2 => s2.node === node);
  if (!seg) return null;
  const at = seg.start + off;

  // 押した位置の前後3文字だけを見る。離れた「。」には反応しない。
  const NEAR = 3;
  let best = -1;
  for (let d = 0; d <= NEAR; d++) {
    for (const i of [at + d, at - d]) {
      if (i < 0 || i >= map.text.length) continue;
      if (map.text[i] === '。') { best = i; break; }
    }
    if (best >= 0) break;
  }
  if (best < 0) return null;

  // 「。」までの数文字を覚える。これが位置決めの手がかりになる。
  const from = Math.max(0, best - 7);
  const text = map.text.slice(from, best + 1);
  let nth = 0;
  for (let i = 0; i + text.length <= best + 1; i++) {
    if (map.text.startsWith(text, i)) nth++;
  }
  // どの法令のどの面で押したかを一緒に持つ。バーを開いたまま別の法令へ
  // 移って押すと、この文言を別の法令に付けてしまう。
  const pane = P();
  return {
    anchor: el.dataset.anchor, text, nth, at: best + 1,
    lawId: pane.current && pane.current.lawId, paneIdx: pane.idx,
  };
}

/*
 * その場所にすでに区切りが付いているか。
 *
 * 印は幅ゼロなので、指で直接押すことはできない。「。」を押したときに、
 * 同じ場所の印を探して、種類の変更と削除の入口にする。
 */
function existingSlash(lawId, anchor, text, nth) {
  for (const r of state.ranges.values()) {
    if (!isSlash(r)) continue;
    if (r.lawId === lawId && r.anchor === anchor && r.text === text && (r.nth || 1) === nth) return r;
  }
  return null;
}

let slashPending = null;      // これから付ける位置、または付いている印

function showSlashBar(atRect, current) {
  const bar = $('#slashbar');
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight, pad = 12;
  bar.style.left = Math.min(Math.max(pad, atRect.left + atRect.width / 2 - w / 2),
    window.innerWidth - w - pad) + 'px';
  // 選択の色バーと同じ考え方で、下に出す。iOS の「コピー・調べる」と重ならない。
  const barEl = $('#bottombar');
  const floor = window.innerHeight - pad - (barEl && !barEl.hidden ? barEl.offsetHeight : 0);
  let top = atRect.bottom + 10;
  if (top + h > floor) top = atRect.top - h - 10;
  bar.style.top = Math.max(pad, top) + 'px';

  for (const b of $$('#slashbar button')) {
    b.classList.toggle('on', !!current && b.dataset.slash === current.kind);
  }
}

function hideSlashBar() { $('#slashbar').hidden = true; slashPending = null; }

/*
 * 印を付けた参照リンクを押したときに出すバー。
 * 置き方は区切りの印のバーと同じ（下に出し、入らなければ上へ回す）。
 */
let refPending = null;

function showRefBar(atRect) {
  const bar = $('#refbar');
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight, pad = 12;
  bar.style.left = Math.min(Math.max(pad, atRect.left + atRect.width / 2 - w / 2),
    window.innerWidth - w - pad) + 'px';
  const barEl = $('#bottombar');
  const floor = window.innerHeight - pad - (barEl && !barEl.hidden ? barEl.offsetHeight : 0);
  let top = atRect.bottom + 10;
  if (top + h > floor) top = atRect.top - h - 10;
  bar.style.top = Math.max(pad, top) + 'px';
}

function hideRefBar() { $('#refbar').hidden = true; refPending = null; }

function applyRefPick(kind) {
  const p = refPending;
  hideRefBar();
  if (!p) return;
  /*
   * 開いたときと同じ法令・同じ面でなければ何もしない。
   * バーを出したまま別の法令へ移ると、別の条文を指すことになる。
   */
  if (p.lawId && (!P().current || p.lawId !== P().current.lawId || p.paneIdx !== P().idx)) return;
  if (kind === 'go') { if (p.target.isConnected) followRef(p.target, false); return; }
  openRangePopover(p.id);
}

async function applySlash(kind) {
  const p = slashPending;
  hideSlashBar();
  if (!p || !P().current) return;

  // 開いたときと同じ法令・同じ面でなければ、何もしない。
  if (p.lawId && (p.lawId !== P().current.lawId || p.paneIdx !== P().idx)) return;

  if (p.id) {                                   // すでに付いている印を押した
    if (kind === 'none') { await deleteRange(p.id); return; }
    const rec = state.ranges.get(p.id);
    if (!rec) return;
    rec.kind = kind;
    await saveRange(rec);
    return;
  }
  if (kind === 'none') return;

  await saveRange({
    id: newRangeId(),
    lawId: P().current.lawId,
    anchor: p.anchor,
    kind,
    text: p.text,
    nth: p.nth,
    color: '', memo: '',
  });
}

/** 選択範囲から範囲注釈を作る。単一の条項号の中に収まっている場合だけ。 */
function rangeFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const el = r.startContainer.parentElement && r.startContainer.parentElement.closest('[data-anchor]');
  if (!el) return null;
  if (!el.contains(r.endContainer)) return null;            // 条文をまたぐ選択は受けない
  const endEl = r.endContainer.parentElement && r.endContainer.parentElement.closest('[data-anchor]');
  if (endEl !== el) return null;

  const map = textMapOf(el);
  const s = posInMap(map, r.startContainer, r.startOffset);
  const e = posInMap(map, r.endContainer, r.endOffset);
  if (s < 0 || e < 0 || e <= s) return null;

  // 前後の空白を落とすときは、数える基準の位置も一緒にずらす。
  // ずらさないと「甲、 甲」の後半を選んでも1番目の甲に付いてしまう。
  const picked = map.text.slice(s, e);
  const lead = picked.length - picked.replace(/^\s+/, '').length;
  const trail = picked.length - picked.replace(/\s+$/, '').length;
  const s2 = s + lead;
  const text = map.text.slice(s2, e - trail);
  if (!text) return null;

  // 同じ文言が何度も出る条文があるので、何番目の出現かを数えておく
  let nth = 0;
  for (let i = map.text.indexOf(text); i >= 0 && i <= s2; i = map.text.indexOf(text, i + 1)) nth++;

  return { anchor: el.dataset.anchor, text, nth: Math.max(1, nth), el };
}

/** 保存できたかを返す。理由は saveNote の注記を見よ。 */
/*
 * 文言メモを保存する。条項号の注釈（saveNote）と同じ約束で動かす。
 *
 * 前はDBの現状を見ずに、編集欄が掴んでいるレコードをそのまま書いていた。
 * 欄を開いたあとに同期で別の編集が入ると、色を1つ変えるだけで相手の
 * メモ本文が古い内容に戻り、衝突の候補も残らなかった。
 * saveNote には入れた仕組みが、こちらには無かった（レビューの指摘 R05）。
 */
async function saveRange(rec) {
  rec.updatedAt = Date.now();

  let old = null;
  try { old = await store.getRange(rec.id); }
  catch (e) { /* 読めなくても保存は続ける */ }

  /*
   * 版の継ぎ方は saveNote と同じ。墓石なら継ぎ（中身が無いので失うものがない）、
   * 生きている記録は継がない（継ぐと相手の編集を承知したことになる）。
   */
  const base = (old && isTomb(old)) ? vvMerge(rec.version, old.version) : rec.version;
  rec.version = vvBump(base, deviceId);

  let out = rec;
  let merged = false;
  if (old && !isTomb(old) && !vvDominates(rec.version, old.version)) {
    // 表に出すのは、いま触った方。相手は候補に回す（理由は saveNote の注記）
    const { alts: _mine, ...mineClean } = out;
    const { alts: _old, ...oldClean } = old;
    const alts = pruneAlts([oldClean, ...collectAlts(old, out)], mineClean);
    out = alts.length ? { ...mineClean, alts } : mineClean;
    merged = true;
  }

  try {
    await store.putRange(out);
  } catch (err) {
    saveFailures.add('range:' + rec.id);
    toast('文言メモを保存できませんでした: ' + err.message);
    return false;
  }
  saveFailures.delete('range:' + rec.id);         // 保存できたので、前の失敗は解く
  state.ranges.set(rec.id, out);
  repaintRangesAt(rec.lawId, rec.anchor);         // 触った条項号だけ（repaintNote と同じ理由）
  renderMarkList();
  renderFilterPicker();
  /*
   * 突き合わせたなら編集欄を作り直す。作り直さないと、欄が古いレコードを
   * 掴んだまま、触るたびに同じ突き合わせを繰り返す（saveNote と同じ）。
   */
  if (merged && !$('#popover').hidden
    && $('#notes-body').querySelector('#range-del')) {
    toast('別の端末でも直されていました。両方残しました');
    openRangePopover(rec.id);
  }
  return true;
}

async function deleteRange(id) {
  const rec = state.ranges.get(id) || { id };
  const now = Date.now();
  await store.tombRange(rangeTomb(rec, now, vvBump(rec.version, deviceId)));
  state.ranges.delete(id);
  if (rec.lawId && rec.anchor) repaintRangesAt(rec.lawId, rec.anchor);
  else paintRanges();                             // どこの印か分からないときは全部見る
  renderMarkList();
  renderFilterPicker();
  closePopover();
}

/* ----------------------------------------------------------- 括弧書き */

function clearParens(pane) {
  for (const el of $$('span.paren', pane.el)) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
    parent.normalize();
  }
}

/*
 * 法令の一文は括弧書きで長く伸びる。主文を追えるように、括弧の中を薄くする。
 * 括弧は入れ子になる（「（…（…）…）」）ので深さを数え、深いほど薄くする。
 *
 * 薄くするかどうかは CSS 側で切り替える。ここでは常に印を付けておき、
 * 設定を変えるたびに本文を組み直さなくて済むようにする。
 */
function paintParens(pane) {
  /*
   * まず外す。呼び直しは設定の切り替えで起きるので、外さずに包むと
   * 二重・三重に入れ子になって増えていく。clearParens はあったのに
   * どこからも呼ばれていなかった。
   */
  clearParens(pane);

  /*
   * 薄くしない設定なら、包み自体を作らない。
   *
   * 以前は常に包んでおき、薄くするかどうかはCSSだけで切り替えていた。
   * そのほうが切り替えは速いが、使わない人にも会社法で3千個ほどの
   * 包みを持たせることになる。切り替えたときにここを呼び直せば足りる。
   */
  if ((document.documentElement.dataset.paren || 'dim') !== 'dim') return;

  for (const el of $$('.para[data-anchor], .item[data-anchor]', pane.el)) {
    const map = textMapOf(el);
    const t = map.text;
    if (!t.includes('（')) continue;

    // 1文字ずつ深さを数える
    const depth = new Array(t.length).fill(0);
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '（') d++;
      depth[i] = d;                       // 括弧そのものも中身と同じ深さにする
      if (t[i] === '）') d = Math.max(0, d - 1);
    }

    // 深さが同じ区間をまとめて包む。後ろから当てて位置がずれないようにする。
    const runs = [];
    for (let i = 0; i < t.length;) {
      if (depth[i] === 0) { i++; continue; }
      let j = i;
      while (j < t.length && depth[j] === depth[i]) j++;
      runs.push({ s: i, e: j, d: depth[i] });
      i = j;
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k];
      wrapInMap(el, r.s, r.e, 'paren p' + Math.min(r.d, 3), 'paren', 'span', map);
    }
  }
}

/* --------------------------------------------------------- メモの吹き出し */

let tipTimer = null;

function showTip(el, head, body) {
  const tip = $('#tip');
  tip.innerHTML = `<div class="tip-head">${esc(head)}</div>${esc(body)}`;
  tip.hidden = false;

  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, pad = 10;
  tip.style.left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad) + 'px';
  const above = r.top - h - 8;
  tip.style.top = (above >= pad ? above : r.bottom + 8) + 'px';
}

function hideTip() {
  clearTimeout(tipTimer);
  $('#tip').hidden = true;
}

/**
 * カーソルを合わせたらメモを出す。
 * 文言メモは常に、条項号のメモは本文にぶら下げていないときだけ。
 */
function handleHover(e) {
  if (annotMode() === 'none') { hideTip(); return; }

  const mk = e.target.closest && e.target.closest('mark[data-range-id]');
  if (mk) {
    const rec = state.ranges.get(mk.dataset.rangeId);
    if (rec && rec.memo) {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(mk, anchorLabel(rec.anchor) + '　の文言', rec.memo), 150);
      return;
    }
  }

  if (annotMode() !== 'all') {
    const el = e.target.closest && e.target.closest('[data-anchor]');
    // 操作中の面ではなく、カーソルがある面の法令で引く
    const pane = el && paneOf(el);
    if (el && pane && pane.current) {
      const n = state.notes.get(noteKey(pane.current.lawId, el.dataset.anchor));
      if (n && n.memo) {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => showTip(el, anchorLabel(el.dataset.anchor), n.memo), 150);
        return;
      }
    }
  }
  hideTip();
}

const annotMode = () => document.documentElement.dataset.annot || 'all';

/** 選択直後に出る小さな色バー */
function showSelBar() {
  const bar = $('#selbar');
  const info = rangeFromSelection();
  if (!info) { bar.hidden = true; return; }

  const sel = window.getSelection();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight, pad = 12;
  bar.style.left = Math.min(Math.max(pad, rect.left + rect.width / 2 - w / 2),
    window.innerWidth - w - pad) + 'px';

  /*
   * 選択の「下」に出す。
   * iOS は選択すると「コピー・調べる」を選択の上に出してくるので、
   * こちらも上に出すと重なって押せなくなる。下なら競合しない。
   * 下に入らないときだけ上へ回す。
   */
  const barEl = $('#bottombar');
  const floor = window.innerHeight - pad
    - (barEl && !barEl.hidden ? barEl.offsetHeight : 0);
  let top = rect.bottom + 10;
  if (top + h > floor) top = rect.top - h - 10;
  bar.style.top = Math.max(pad, top) + 'px';
  bar.dataset.pending = JSON.stringify({ anchor: info.anchor, text: info.text, nth: info.nth });
}

function hideSelBar() { $('#selbar').hidden = true; }

async function createRangeFrom(color, openMemo) {
  const bar = $('#selbar');
  let pending;
  try { pending = JSON.parse(bar.dataset.pending || 'null'); } catch (e) { pending = null; }
  if (!pending || !P().current) return;

  const rec = {
    id: newRangeId(),
    lawId: P().current.lawId,
    anchor: pending.anchor,
    text: pending.text,
    nth: pending.nth,
    color: color || 'yellow',
    memo: '',
  };
  await saveRange(rec);
  window.getSelection().removeAllRanges();
  hideSelBar();
  if (openMemo) openRangePopover(rec.id);
}

