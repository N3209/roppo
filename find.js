'use strict';

/*
 * 探して移る。住所を打って飛ぶのと、全文検索。
 *
 * 分割前の app.js の次の節を、順を変えずに集めたものである。
 *
 *   ジャンプ / 全文検索
 *
 * トップレベルで組み立てているのは法令名の略称表（LAW_ALIASES）と
 * 検索の状態（find）で、どちらも字と数だけの表である。読み込み時に外の
 * 宣言を要るものは無い。
 *
 * 突き合わせ（version-migration.js）がここの anchorSortKey と cmpKey を
 * 使っている。だから version-migration.js はこのファイルより後に読み込む。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */
/* ------------------------------------------------------------ ジャンプ */

/*
 * 法令名の略称。e-Gov も Abbrev を持っている（国賠法など）が、
 * 「民訴」「刑訴」のような普段使いの呼び方は入っていないので足しておく。
 */
const LAW_ALIASES = {
  民訴: '民事訴訟法', 刑訴: '刑事訴訟法', 民執: '民事執行法', 民保: '民事保全法',
  行訴: '行政事件訴訟法', 行手: '行政手続法', 行審: '行政不服審査法',
  労基: '労働基準法', 労基法: '労働基準法', 労契法: '労働契約法',
  国賠: '国家賠償法', 独禁法: '私的独占の禁止及び公正取引の確保に関する法律',
  不競法: '不正競争防止法', 地自法: '地方自治法', 会更: '会社更生法', 民再: '民事再生法',
  憲法: '日本国憲法',
};

/**
 * 入力の先頭から法令名を切り出す。「民法709」「刑訴220条2項」の形に対応する。
 * 取込済みの法令名・略称と、上の対応表の両方を見る。長い名前を優先する。
 */
function splitLawPrefix(input) {
  const s = String(input).normalize('NFKC').replace(/\s/g, '');
  const names = [];
  for (const l of state.laws) {
    if (l.lawTitle) names.push([l.lawTitle, l]);
    if (l.abbrev) names.push([l.abbrev, l]);
  }
  for (const [alias, title] of Object.entries(LAW_ALIASES)) {
    const l = state.laws.find(x => x.lawTitle === title);
    if (l) names.push([alias, l]);
  }
  names.sort((a, b) => b[0].length - a[0].length);

  for (const [name, law] of names) {
    if (s.length > name.length && s.startsWith(name)) {
      return { law, rest: s.slice(name.length) };
    }
  }
  return { law: null, rest: s };
}

/**
 * 「709」「709条2項」「第三条の二」「3の2の3」「709条3号」などを解釈する。
 * 枝番は「条」の前でも後でも、何段でも受け付ける。
 */
function parseJump(input) {
  let s = String(input).normalize('NFKC').replace(/\s/g, '');
  if (!s) return null;

  const head = s.match(new RegExp('^第?' + NUM_SRC));
  if (!head) return null;
  const parts = [kanjiToNum(head[1])];
  s = s.slice(head[0].length);

  const eatBranches = () => {
    let m;
    while ((m = s.match(new RegExp('^[のノ_-]' + NUM_SRC)))) {
      parts.push(kanjiToNum(m[1]));
      s = s.slice(m[0].length);
    }
  };
  eatBranches();
  if (s.startsWith('条')) { s = s.slice(1); eatBranches(); }
  if (parts.some(isNaN)) return null;

  let par = null, item = null;
  let m = s.match(new RegExp('^第?' + NUM_SRC + '項'));
  if (m) { par = kanjiToNum(m[1]); s = s.slice(m[0].length); }
  m = s.match(new RegExp('^第?' + NUM_SRC + '号'));
  if (m) { item = kanjiToNum(m[1]); s = s.slice(m[0].length); }

  if (s) return null;                                  // 余りがあれば解釈失敗
  if ((par !== null && isNaN(par)) || (item !== null && isNaN(item))) return null;

  return {
    art: parts.join('_'),
    par: par === null ? null : String(par),
    item: item === null ? null : String(item),
  };
}

/*
 * アンカーから要素を引く。描画のときに作った対応表を先に見る。
 * 属性セレクタは要素を端から見ていくので、会社法のように6,000件あると
 * 一回引くだけで数十ミリ秒かかる。下見は打つたびに引くので、そこが響く。
 * 表が古くなっている場合（差し替えられた要素）は、従来どおり探し直す。
 */
function findAnchorEl(anchor, pane) {
  const pn = pane || P();
  const hit = pn.elOf && pn.elOf.get(anchor);
  if (hit && hit.isConnected) return hit;
  return $(`[data-anchor="${CSS.escape(anchor)}"]`, pn.el);
}

function indexAnchorEls(pane) {
  pane.elOf = new Map();
  for (const el of pane.el.querySelectorAll('[data-anchor]')) {
    if (!pane.elOf.has(el.dataset.anchor)) pane.elOf.set(el.dataset.anchor, el);
  }
}

/*
 * 番号から行き先を探すための表を、描画のときに一度だけ作る。
 *
 * 作る前は、打つたびに scope の数だけ DOM を引き、さらに索引を端から端まで
 * 走査していた。会社法は索引が6,000件あり scope も30を超えるので、下見を
 * 出すたびにそれが繰り返される。外れの番号ほど重くなり、打っている手が止まる。
 */
function buildJumpTables(pane, index) {
  pane.anchors = new Set();
  pane.itemOfArt = new Map();     // 「scope/条/号」→ その号のアンカー
  pane.rangedOf = new Map();      // scope → 削除条の範囲アンカー（170:174 の形）

  for (const e of index) {
    const a = e.anchor.split('/');
    pane.anchors.add(e.anchor);
    if (a.length === 4) {
      const key = a[0] + '/' + a[1] + '/' + a[3];
      if (!pane.itemOfArt.has(key)) pane.itemOfArt.set(key, e.anchor);   // 先に出てくる項を優先
    }
    if (a.length === 2 && a[1].includes(':')) {
      if (!pane.rangedOf.has(a[0])) pane.rangedOf.set(a[0], []);
      pane.rangedOf.get(a[0]).push(e.anchor);
    }
  }
  // 本則を先に、次に附則・別表を現れた順で
  pane.scopes = ['M', ...new Set(index.map(e => e.anchor.split('/')[0]).filter(s => s !== 'M'))];
}

async function doJump() {
  const raw = $('#jump-input').value.trim();
  if (!raw) return;

  // 「民法709」のように法令名が前に付いていれば、その法令に切り替えてから引く
  const { law, rest } = splitLawPrefix(raw);
  if (law && (!P().current || P().current.lawId !== law.lawId)) {
    await navigate(law.lawId);
  }
  if (!P().current) { toast('先に法令を開いてください'); return; }

  const p = parseJump(law ? rest : raw);
  if (!p) { toast('条文番号として読み取れません'); return; }

  const r = resolveJump(p);
  if (!r) { toast(`${numLabel(p.art, '条')}は見つかりません`); return; }
  if (r.note) toast(r.note);

  endFind();                // 引いた先を読むので、前の検索の色は消す

  closeDrawerAfterJump();   // 同じ法令の中で引くときは navigate を通らない
  rememberPos();
  if (scrollToAnchor(r.anchor, false)) {
    pushHist({ lawId: P().current.lawId, anchor: r.anchor, scrollTop: 0 });
  }
}

/*
 * 打たれた番号が、いま開いている法令のどこを指すのかを決める。飛ばしはしない。
 * 引くときと、打ちかけの下見（updateJumpPreview）の両方がここを通る。
 * 二つに分けて書くと、下見と実際の行き先がずれる。
 */
function resolveJump(p, pane) {
  const pn = pane || P();
  if (!pn.anchors) return null;               // まだ描画していない
  const has = a => pn.anchors.has(a);

  for (const sc of pn.scopes) {
    // 項と号の両方が指定されている
    const full = `${sc}/${p.art}/${p.par}/${p.item}`;
    if (p.par && p.item && has(full)) return { anchor: full };

    // 項を省いた号指定（例: 709条3号）
    if (!p.par && p.item) {
      const hit = pn.itemOfArt.get(`${sc}/${p.art}/${p.item}`);
      if (hit) return { anchor: hit };
    }

    const par = `${sc}/${p.art}/${p.par}`;
    if (p.par && has(par)) {
      return {
        anchor: par,
        note: p.item ? `第${p.item}号は見つからないため、項までで止めました` : '',
      };
    }

    const art = `${sc}/${p.art}`;
    if (has(art)) {
      return {
        anchor: art,
        note: (p.par || p.item) ? '指定の項・号は見つからないため、条までで止めました' : '',
      };
    }

    // 削除された条は "170:174" のような範囲でまとめられている
    for (const a of (pn.rangedOf.get(sc) || [])) {
      if (numInRange(a.split('/')[1], p.art)) {
        return {
          anchor: a,
          note: `${numLabel(p.art, '条')}は${numLabel(a.split('/')[1], '条')}にまとめられています`,
        };
      }
    }
  }
  return null;
}

/*
 * 打ちかけの番号が指す条文の頭を出す。
 * 番号を打っても、それが目当ての条文かどうかは飛んでみるまで分からない。
 * 先に頭の一文が見えれば、引く前に気づける。打ち間違いにも気づける。
 *
 * 当たりが出ている下見は、そこを押しても引ける（doJump へ）。目で確かめた直後に
 * 視線を「引く」へ戻さずに済む。「引く」はそのまま残してある。
 */
function updateJumpPreview() {
  const box = $('#jump-preview');
  if (!box) return;
  const raw = $('#jump-input').value.trim();
  if (!raw || !P().current) { box.hidden = true; return; }

  const show = (label, body, miss, go) => {
    box.hidden = false;
    box.classList.toggle('miss', !!miss);
    // 引ける下見だけを押せるようにする。「見つかりません」は押しても何も起きない。
    box.classList.toggle('go', !!go);
    if (go) { box.setAttribute('role', 'button'); box.tabIndex = 0; }
    else { box.removeAttribute('role'); box.removeAttribute('tabindex'); }
    box.innerHTML = `<span class="pv-label">${esc(label)}</span>`
      + `<span class="pv-text">${esc(body)}</span>`;
  };

  const { law, rest } = splitLawPrefix(raw);
  // 別の法令を指しているときは、開いてみないと中身が読めない
  if (law && law.lawId !== P().current.lawId) {
    show(law.lawTitle, '押すと開きます', true, true);
    return;
  }

  const p = parseJump(law ? rest : raw);
  const r = p && resolveJump(p);
  if (!r) { show(raw, '見つかりません', true, false); return; }

  const el = findAnchorEl(r.anchor);
  if (!el) { box.hidden = true; return; }
  show(anchorLabel(r.anchor), previewTextOf(el), false, true);
}

/** 下見に出す文字。自分で書いたメモ・タグ・ルビの読みは混ぜない。 */
function previewTextOf(el) {
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll('.memo-inline, .inline-tags, .note-summary, rt')) n.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/* -------------------------------------------------------------- 全文検索 */

async function indexFor(lawId) {
  if (state.indexCache.has(lawId)) return state.indexCache.get(lawId);
  const rec = await store.getLaw(lawId);
  if (!rec) return [];
  const { index } = renderLaw(parseXML(rec.xml).querySelector('Law'));
  state.indexCache.set(lawId, index);
  return index;
}

const FIND_LIMIT = 500;

/*
 * 検索。2面にしてから「どちらの法令を探しているのか」が分からなくなったので、
 * 範囲を明示して選べるようにし、結果は左ペインに残す。
 */
const find = {
  q: '', where: 'law', inText: true, inNotes: true, busy: false,
  results: [], at: -1, truncated: false, scopeLawId: null,
};

/*
 * 検索欄そのものに、何を対象にしているかを出す。
 *
 * 2面にしていると「どちらの法令を検索するのか」が欄からは分からなかった。
 * 欄を面ごとに2つ置くと、結果の一覧の置き場所が無くなる（左ペインは1つしか
 * ない）。欄は1つのまま、対象を欄に書く。面を切り替えれば文言も変わる。
 */
function syncFindPlaceholder() {
  const el = $('#find-input');
  if (!el) return;
  if (find.where === 'all') {
    el.placeholder = `全法令（${state.laws.length}件）を検索`;
    return;
  }
  const t = P().current && P().current.lawTitle;
  if (!t) { el.placeholder = '本文・メモを検索'; return; }
  // 長い法令名は詰める。欄からあふれると、かえって読めない。
  el.placeholder = (t.length > 12 ? t.slice(0, 12) + '…' : t) + 'を検索';
}
let findToken = 0;      // 検索が重なったとき、古い実行の結果を捨てるための印

async function doFind() {
  const raw = $('#find-input').value.trim();
  find.q = raw;
  if (!raw) { clearFind(); return; }
  const q = normalize(raw);
  if (!q) { clearFind(); return; }

  const laws = find.where === 'law'
    ? (P().current ? [state.laws.find(l => l.lawId === P().current.lawId)].filter(Boolean) : [])
    : state.laws;

  const token = ++findToken;
  /*
   * 探している間、古い結果が残っていると、新しい語で探しているのか
   * 分からない。特にスマホのシートでは結果が上に積まれるので、状態の行が
   * 流れて見えなくなる。先に古い結果を消して「探しています」を出す。
   */
  find.busy = true;
  find.results = [];
  find.truncated = false;
  renderFindList();

  const results = [];
  let truncated = false;

  if (find.inText) {
    for (const law of laws) {
      const idx = await indexFor(law.lawId);
      if (token !== findToken) return;       // 新しい検索が始まっていたら捨てる
      for (const e of idx) {
        const at = e.norm.indexOf(q);
        if (at < 0) continue;
        if (results.length >= FIND_LIMIT) { truncated = true; break; }
        results.push({
          kind: '本文', lawId: law.lawId, lawTitle: law.lawTitle,
          anchor: e.anchor, text: e.text, at,
        });
      }
      if (truncated) break;
    }
  }

  if (find.inNotes) {
    const ids = new Set(laws.map(l => l.lawId));
    for (const n of state.notes.values()) {
      if (!ids.has(n.lawId)) continue;
      if (!normalize((n.summary || '') + ' ' + (n.memo || '') + ' ' + (n.tags || []).join(' ')).includes(q)) continue;
      const law = state.laws.find(l => l.lawId === n.lawId);
      results.push({
        kind: 'メモ', lawId: n.lawId, lawTitle: law ? law.lawTitle : n.lawId,
        anchor: n.anchor,
        text: [n.summary, n.memo, (n.tags || []).join(' ')].filter(Boolean).join('　'), at: 0,
      });
    }
    for (const r of state.ranges.values()) {
      if (isSlash(r)) continue;   // 区切りは位置決めの文字列を持つだけ。メモではない
      if (!ids.has(r.lawId)) continue;
      if (!normalize((r.memo || '') + ' ' + r.text).includes(q)) continue;
      const law = state.laws.find(l => l.lawId === r.lawId);
      results.push({
        kind: '文言', lawId: r.lawId, lawTitle: law ? law.lawTitle : r.lawId,
        anchor: r.anchor, text: r.text + (r.memo ? '　' + r.memo : ''), at: 0,
      });
    }
  }

  if (token !== findToken) return;
  find.busy = false;
  find.results = results;
  find.truncated = truncated;
  find.at = -1;
  find.scopeLawId = find.where === 'law' && P().current ? P().current.lawId : null;

  if (!narrow()) switchTab('find');   // 狭い画面では結果はシートの中。左ペインは触らない
  renderFindList();
  paintFindHits();
}

function clearFind() {
  find.busy = false;
  find.results = [];
  find.at = -1;
  renderFindList();
  paintFindHits();
}

/*
 * 検索をやめる。
 *
 * 番号で引くのと、ことばで探すのは、別のやり方で同じ場所へ行く手段である。
 * 引いた先を読もうとしているときに、前の検索の色が本文に残っていると邪魔になる。
 * 打った言葉は欄に残すので、もう一度 Enter を押せば戻せる。
 */
function endFind() {
  find.busy = false;
  find.q = '';
  find.results = [];
  find.at = -1;
  find.truncated = false;
  renderFindList();
  paintFindHits();
}

/**
 * 正規化した文字列で探し、元の文字列での範囲に戻す。
 * 索引は NFKC・空白除去・小文字化した文字列で作っているので、
 * 元の本文へそのまま indexOf すると全角半角や大小の違いで当たらない。
 */
function normalizedRanges(text, q) {
  const idx = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) idx.push(i);
    norm += n;
  }
  const out = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(q, from);
    if (at < 0) break;
    const s = idx[at];
    const last = idx[at + q.length - 1];
    out.push([s, (last === undefined ? text.length - 1 : last) + 1]);
    from = at + q.length;
  }
  return out;
}

/** 本文中の一致語を光らせる。操作対象の面の、いま開いている法令だけ。 */
function paintFindHits() {
  for (const pane of livePanes()) {
    for (const m of $$('mark.hit', pane.el)) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      m.remove();
      parent.normalize();
    }
  }
  const q = normalize(find.q);
  if (!q || !find.inText) return;

  for (const pane of livePanes()) {
    if (!pane.current) continue;
    const anchors = new Set(find.results
      .filter(r => r.lawId === pane.current.lawId && r.kind === '本文')
      .map(r => r.anchor));
    for (const anchor of anchors) {
      const el = findAnchorEl(anchor, pane);        // 本文全体を探し直さない
      if (!el) continue;
      const map = textMapOf(el);
      // 後ろから当てれば、前の位置はずれない。対応表を作り直さずに済む。
      const runs = [...normalizedRanges(map.text, q)];
      for (let i = runs.length - 1; i >= 0; i--) {
        wrapInMap(el, runs[i][0], runs[i][1], 'hit', 'find', 'mark', map);
      }
    }
  }
}

function renderFindList() {
  const ul = $('#find-list');
  const status = $('#find-status');
  ul.innerHTML = '';

  const where = find.where === 'law'
    ? (P().current ? P().current.lawTitle : '法令未選択') : `全法令（${state.laws.length}件）`;
  status.innerHTML = !find.q
    ? `${esc(where)} を対象に検索します`
    : find.busy
      ? `<span class="q">${esc(find.q)}</span> を ${esc(where)} から探しています…`
      : `<span class="q">${esc(find.q)}</span> を ${esc(where)} から　${find.results.length}件`
        + (find.truncated ? '（上限で打ち切り）' : '');

  if (!find.q) return;
  if (find.busy) return;          // 探している間は、古い一覧を出さない
  if (!find.results.length) {
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">見つかりませんでした</li>';
    return;
  }

  find.results.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === find.at) li.className = 'current';
    li.innerHTML = `<div class="where"><span class="kind">${esc(r.kind)}</span>`
      + (find.where === 'all' ? `<span class="lawname">${esc(r.lawTitle)}</span>　` : '')
      + `${esc(anchorLabel(r.anchor))}</div>`
      + `<div class="snip">${snippet(r.text, r.at, find.q.length)}</div>`;
    li.onclick = () => gotoFindResult(i);
    ul.appendChild(li);
  });
}

async function gotoFindResult(i) {
  const r = find.results[i];
  if (!r) return;
  find.at = i;
  if (!(await navigate(r.lawId, r.anchor))) {
    toast('この法令はこの端末にありません。「＋ 追加」から取り込んでください');
    return;
  }
  paintFindHits();
  const el = $(`[data-anchor="${CSS.escape(r.anchor)}"] mark.hit`, P().el);
  if (el) el.classList.add('cur');
  renderFindList();
  const li = $$('#find-list li')[i];
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function stepFind(d) {
  if (!find.results.length) return;
  const n = find.at < 0 ? 0 : (find.at + d + find.results.length) % find.results.length;
  gotoFindResult(n);
}

/**
 * 抜粋を作る。一致位置は正規化後の文字列で得ているので、
 * 元の文字列へそのまま当てるとずれる。正規化しながら対応表を作って戻す。
 */
function snippet(text, normAt, qlen) {
  let acc = 0, startRaw = -1, endRaw = -1;
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    if (startRaw < 0 && acc + n.length > normAt) startRaw = i;
    acc += n.length;
    if (endRaw < 0 && acc >= normAt + qlen) { endRaw = i + 1; break; }
  }
  if (startRaw < 0) startRaw = 0;
  if (endRaw < 0) endRaw = Math.min(text.length, startRaw + qlen);
  const s = Math.max(0, startRaw - 22);
  const e = Math.min(text.length, endRaw + 34);
  return (s > 0 ? '…' : '') + esc(text.slice(s, startRaw))
    + '<mark class="hit">' + esc(text.slice(startRaw, endRaw)) + '</mark>'
    + esc(text.slice(endRaw, e)) + (e < text.length ? '…' : '');
}


/*
 * アンカーを条文の並び順で比べるための鍵。
 *
 * 文字列のままだと「第10条」が「第2条」より前に来る。本則・附則・別表の
 * 別も文字列順では出ない。数として比べられる形に直す。
 */
function anchorSortKey(anchor) {
  const p = String(anchor).split('/');
  const scope = p[0] || '';
  let rank;
  if (scope === 'M') rank = 0;
  else if (/^S(\d+)$/.test(scope)) rank = 1000 + Number(RegExp.$1);
  else if (/^AP(\d+)$/.test(scope)) rank = 2000 + Number(RegExp.$1);
  else rank = 3000;

  // 前文は本則の先頭より前
  if (p[1] === '前文') return [rank, -1, 0, 0, 0];

  /*
   * 枝番は何段にもなる。労働基準法に「第三十二条の三の二」（32_3_2）が実在する。
   * 1段しか読まないと、32_3_2 が 32_3 の項より前に来てしまう。
   * 段の数をそろえるため、足りない分は 0 で埋める。
   */
  const DEPTH = 3;
  const num = t => {
    if (t === undefined || t === '') return new Array(DEPTH).fill(0);
    const parts = String(t).split(/[_:]/).map(x => {
      const m = String(x).match(/^(\d+)/);
      return m ? Number(m[1]) : Infinity;
    });
    while (parts.length < DEPTH) parts.push(0);
    return parts.slice(0, DEPTH);
  };
  return [rank].concat(num(p[1]), num(p[2]), num(p[3]));
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

let markView = null;      // いま出している一覧（並べ替えで作り直すため）

function showMarkResults(pred, title) {
  markView = { pred, title };
  renderMarkResults();
  $('#dlg-find').showModal();
}

/*
 * 法令ごとにまとめて出す。
 *
 * 印が増えると、一列に並べただけでは何がどこにあるのか分からない。
 * 法令の並びは、法令タブで自分が並べた順に合わせる。
 */
function renderMarkResults() {
  if (!markView) return;
  const box = $('#find-results');
  const hits = allMarks().filter(markView.pred);
  $('#find-count').textContent = `${markView.title}　${hits.length}件`;

  const sortBtn = $('#mark-sort');
  sortBtn.hidden = hits.length < 2;
  const order = ($('#mark-sort button.on') || {}).dataset
    ? $('#mark-sort button.on').dataset.sort : 'doc';

  const byLaw = new Map();
  for (const m of hits) {
    if (!byLaw.has(m.lawId)) byLaw.set(m.lawId, []);
    byLaw.get(m.lawId).push(m);
  }
  // 法令タブで並べた順に合わせる。知らないものは後ろ。
  const rank = new Map(state.laws.map((l, i) => [l.lawId, i]));
  const laws = [...byLaw.keys()].sort((a, b) =>
    (rank.has(a) ? rank.get(a) : Infinity) - (rank.has(b) ? rank.get(b) : Infinity));

  box.innerHTML = '';
  for (const lawId of laws) {
    const list = byLaw.get(lawId);
    list.sort((a, b) => order === 'time'
      ? (b.at || 0) - (a.at || 0)
      : cmpKey(anchorSortKey(a.anchor), anchorSortKey(b.anchor)));

    const law = state.laws.find(l => l.lawId === lawId);
    const head = document.createElement('div');
    head.className = 'law-head';
    /*
     * 手元に無い法令の注釈も一覧に出る（同期で他の端末から来たもの）。
     * lawId をそのまま見出しにすると、英数字の羅列にしか見えない。
     * 無いことを言って、住所は小さく添える。
     */
    head.innerHTML = law
      ? `${esc(law.lawTitle)}<span class="n">${list.length}件</span>`
      : `この端末に無い法令<span class="sub" style="font-size:11px;color:var(--fg-faint);`
        + `margin-left:6px">${esc(lawId)}</span><span class="n">${list.length}件</span>`;
    box.appendChild(head);

    const idx = state.indexCache.get(lawId);
    for (const m of list) {
      const entry = idx && idx.find(e => e.anchor === m.anchor);
      const d = document.createElement('div');
      d.className = 'r';
      d.innerHTML = '<div class="sub">'
        // 下線は色を敷かない印なので、var(--mk-ul) は無い。見本も下線で示す
        + (m.color === 'ul'
          ? '<span class="sw ul" style="display:inline-block;width:10px;height:10px;vertical-align:-1px;margin-right:6px"></span>'
          : m.color ? `<span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--mk-${m.color});vertical-align:-1px;margin-right:6px"></span>` : '')
        + esc(anchorLabel(m.anchor))
        + (m.kind === 'range' ? '　<span style="color:var(--fg-faint)">文言</span>' : '')
        + (m.kind === 'slash' ? `　<span style="color:var(--ink);font-weight:700">${esc(m.slash)}</span>` : '')
        + '</div>'
        // 文言に付けたものは、その文言そのものを出す。条文の頭だけでは見分けられない。
        + (m.phrase ? `<div class="snippet">「${esc(m.phrase.slice(0, 60))}」</div>`
          : entry ? `<div class="snippet">${esc(entry.text.slice(0, 110))}</div>` : '')
        + (m.memo ? `<div class="snippet" style="color:var(--fg-dim)">📝 ${esc(m.memo.slice(0, 80))}</div>` : '');
      /*
       * 押したものをそのまま開く。
       *
       * navigate は選ぶだけ（edit:false）なので、一覧から辿っても注釈欄が
       * 開かなかった。本文が取っ手でない場所（項が1つの条の第1項など）だと、
       * 開く道がどこにも無くなる。押したのだから開くのが素直でもある。
       */
      d.onclick = async () => {
        $('#dlg-find').close();
        /*
         * 着けなかったら、そこで止める。
         *
         * 同期で届いた「この端末に無い法令」の注釈も一覧に出る。前はここで
         * 構わず編集を開いていたので、いま表示している別法令の同じ住所の
         * 編集欄が出て、打つとそちらへ保存された（レビューの指摘 R20）。
         */
        if (!(await navigate(m.lawId, m.anchor))) {
          toast('この法令はこの端末にありません。「＋ 追加」から取り込んでください');
          return;
        }
        if (m.kind === 'note') { await selectAnchor(m.anchor, true); return; }
        // 文言に付けたものは、その印のパネルを開く（条項号の注釈欄とは別）
        const rec = state.ranges.get(m.id);
        // 渡すのは id。レコードを渡していたので、一覧から開けなかった
        if (rec && !isSlash(rec)) openRangePopover(rec.id);
      };
      box.appendChild(d);
    }
  }
}


