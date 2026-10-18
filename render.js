'use strict';

/*
 * 法令XMLを画面に描く。参照のリンクも、アンカーから要素を引くのもここ。
 *
 * 分割前の app.js の次の節を、順を変えずに集めたものである。
 *
 *   本文の描画 / 条文参照のリンク / アンカー → XML要素
 *
 * core.js のあとに読み込む。トップレベルで組み立てているのは参照を見つける
 * 正規表現（REF_RE など）と色の表（MARK_COLORS・RANGE_STYLES）で、どちらも
 * 材料（KN・LAWNAME_SRC）を同じファイルに持っている。読み込み時に外の
 * 宣言を要るものは無い。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */
/* ------------------------------------------------------------ 本文の描画 */

/** ルビの読み(Rt)を除いた素のテキスト。索引はHTMLからではなくXMLから作る。 */
function plainText(node, skip) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { s += n.nodeValue; continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    if (n.tagName === 'Rt') continue;
    if (skip && skip.has(n.tagName)) continue;
    s += plainText(n, skip);
  }
  return s;
}

/* ------------------------------------------------------- 条文参照のリンク */

/*
 * 本文中の「第七百九条」などをリンクにする。
 * 間違ったリンクは、黙って違う条文へ飛ばすぶん、リンクが無いより有害である。
 * そこでここでは候補に印を付けるだけにして、実在の確認と行き先の決定は
 * 描画後の resolveRefs() で行う。解決できなかったものはリンクを外す。
 *
 * 「同条」「同法」「同項」は直前の文脈に依存し、取り違えの危険が大きいので扱わない。
 */
const KN = '[〇零一二三四五六七八九十百千]';
// 法令名らしき並び。これが直前にあれば他法令への参照とみなす（「同法」もここに入る）
// 「〜に関する法律」が最も多い形。法律 を先に置かないと「法」で切れて名前を取り逃す。
const LAWNAME_SRC = '[一-龥ぁ-んァ-ヶー々]{1,40}?(?:法律|法|政令|勅令|省令|府令|令|規則|条例|憲法)';
// 法令名と条番号のあいだには「（昭和五十四年法律第四号）」のような法令番号が入る。
// これを読み飛ばさないと、他法令への参照を自法令の条だと取り違える。
const REF_RE = new RegExp(
  `(${LAWNAME_SRC})?(（[^（）]{0,48}）)?第(${KN}+)条(?:の(${KN}+))?(?:の(${KN}+))?`
  + `(?:第(${KN}+)項)?(?:第(${KN}+)号)?`, 'g');
/*
 * 条番号を伴わない参照。
 *   前条第二項 / 前項第二号 / 第一項 / 第一項第二号
 * 「第二号」単独は入れない。「昭和五十四年法律第四号」のような法令番号に当たるため。
 */
/*
 * 文脈に依存して行き先を決められない参照。ここに当たる範囲は、
 * 条だけでなく後続の項・号まで丸ごとリンクの対象から外す。
 * 「附則第三条第二項」の「第二項」だけを拾って現在の条に結び付けてしまうため。
 */
const BLOCK_RE = new RegExp(
  `(?:附則|同条|同項|同号|同法|同令|同規則)`
  + `(?:第${KN}+条(?:の${KN}+)*)?(?:第${KN}+項)?(?:第${KN}+号)?`, 'g');

const DOUJOU_RE = new RegExp(`同条(?:第(${KN}+)項)?(?:第(${KN}+)号)?`, 'g');

/** 各文字が括弧の何重目にあるか。引用や括弧の出入りを見るのに使う。 */
function quoteDepth(text, open, close) {
  const d = new Array(text.length).fill(0);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) n++;
    d[i] = n;
    if (text[i] === close) n = Math.max(0, n - 1);
  }
  return d;
}

const REL_RE = new RegExp(
  `(前条|次条)(?:第(${KN}+)項)?(?:第(${KN}+)号)?`
  + `|(前項|次項)(?:第(${KN}+)号)?`
  + `|第(${KN}+)項(?:第(${KN}+)号)?`, 'g');

/** 参照らしき箇所に印を付けた HTML を返す。ctx は描画中の位置。 */
function linkifyText(raw, ctx) {
  const out = [];
  let last = 0;

  const marks = [];

  // 先に「触らない範囲」を決めておく
  const blocked = [];
  BLOCK_RE.lastIndex = 0;
  for (let m; (m = BLOCK_RE.exec(raw));) {
    blocked.push([m.index, m.index + m[0].length]);
  }
  const isBlocked = (a, b) => blocked.some(([s2, e2]) => a < e2 && s2 < b);

  REF_RE.lastIndex = 0;
  for (let m; (m = REF_RE.exec(raw));) {
    const [all, law, , art, br1, br2, par, item] = m;
    const parts = [kanjiToNum(art), br1 && kanjiToNum(br1), br2 && kanjiToNum(br2)]
      .filter(x => Number.isFinite(x));
    if (!parts.length) continue;
    if (!law && isBlocked(m.index, m.index + all.length)) continue;
    // 「において準用する商業登記法」から法令名の部分だけを切り出す
    const name = law ? trimLawName(law) : '';
    const cut = law ? law.length - name.length : 0;
    marks.push({
      start: m.index + cut, end: m.index + all.length, text: all.slice(cut),
      law: name,
      ref: [ctx.scope || 'M', parts.join('_'),
        par ? kanjiToNum(par) : '', item ? kanjiToNum(item) : ''].join('/'),
    });
  }
  REL_RE.lastIndex = 0;
  for (let m; (m = REL_RE.exec(raw));) {
    // 条番号の一部として既に拾っている箇所、文脈依存で外した箇所とは重ねない
    if (marks.some(k => m.index < k.end && k.start < m.index + m[0].length)) continue;
    if (isBlocked(m.index, m.index + m[0].length)) continue;
    let rel, par = '', item = '';
    if (m[1]) { rel = m[1]; par = m[2] ? kanjiToNum(m[2]) : ''; item = m[3] ? kanjiToNum(m[3]) : ''; }
    else if (m[4]) { rel = m[4]; item = m[5] ? kanjiToNum(m[5]) : ''; }
    else { rel = '項'; par = kanjiToNum(m[6]); item = m[7] ? kanjiToNum(m[7]) : ''; }
    marks.push({ start: m.index, end: m.index + m[0].length, text: m[0], rel, par, item });
  }
  if (!marks.length) return esc(raw);

  marks.sort((a, b) => a.start - b.start);

  /*
   * 列挙では2件目以降の条番号も省略される。
   *
   *   「第四百四十六条第二項及び第三項」→ 後ろも446条の第三項
   *
   * 引き継がないと、裸の「第三項」を描画中の条の第3項と読む。民法465条の2
   * 第3項では、自分自身へ飛ぶリンクになっていた。それらしく見えるだけに
   * 悪い（レビューの指摘 R15）。
   *
   * 引き継ぐのは、あいだに区切りらしい文字しか無いあいだだけにする。
   * 同じ一文の後ろにある「第一項に規定する極度額」の「第一項」は、
   * あいだに「の規定は、個人根保証契約における」が挟まるので引き継がない。
   * あれは本当に自条の第1項を指している。確かめられないものは触らない。
   *
   * 法令名の引き継ぎより先に置く。ここで条を引き継いだ印が、続く印への
   * 法令名の引き継ぎ元にもなるため。
   */
  const JOIN_RE = /^[、，及びならびに又はもしくは若しくは並びに・からまで乃至\s]*$/;
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i], prev = marks[i - 1];
    if (cur.rel !== '項' || !cur.par) continue;        // 裸の「第N項」だけが対象
    if (!prev.ref || prev.rel) continue;               // 直前が条の参照でなければ触らない
    if (!JOIN_RE.test(raw.slice(prev.end, cur.start))) continue;
    const [scope, art] = String(prev.ref).split('/');
    if (!art) continue;
    cur.ref = [scope, art, cur.par, cur.item || ''].join('/');
    if (prev.law) cur.law = prev.law;
    delete cur.rel;
    delete cur.par;
    delete cur.item;
  }

  /*
   * 列挙では2件目以降の法令名が省略される。
   *   「刑法第百三条、第百四条若しくは第百五条の二」→ 後ろ2つも刑法
   * これを引き継がないと、自法令に同じ番号があった場合に黙って別の法律へ飛ばす。
   * 引き継ぐのは、あいだに区切りらしい文字しか無いあいだだけにする。
   */
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i], prev = marks[i - 1];
    if (cur.rel || cur.law || !prev.law) continue;
    const between = raw.slice(prev.end, cur.start);
    if (!JOIN_RE.test(between)) continue;
    cur.law = prev.law;
    cur.inherited = true;
  }


  /*
   * 「同条」を、本則に限って解決する。
   *
   *   第三十一条の二第一項の申出を受けた弁護士会は、同条第三項の…  → 31条の2
   *
   * 次のときは解決しない。誤って別の条へ飛ばすより出さない方がよい。
   *   ・附則の中（改正規定の裸の条番号は、改正対象の別法令を指す）
   *   ・直前の参照が他法令、または文脈依存で外した範囲（さらに前には戻らない）
   *   ・先行参照が引用「…」の中（読み替え規定は初版では扱わない）
   *   ・同じ Sentence の中に先行参照が無い
   */
  if ((ctx.scope || 'M') === 'M') {
    const qd = quoteDepth(raw, '「', '」');
    const pd = quoteDepth(raw, '（', '）');
    DOUJOU_RE.lastIndex = 0;
    for (let m; (m = DOUJOU_RE.exec(raw));) {
      const [all, par, item] = m;
      const pos = m.index;

      // 直前の条参照（法令名の引き継ぎ後の判定を使う）
      let ante = null;
      for (const k of marks) if (!k.rel && k.end <= pos && (!ante || k.end > ante.end)) ante = k;
      // 直前の「触らない範囲」。前条・次条も、解決先が別なので障壁として扱う。
      let bar = null;
      const raise = e => { if (e <= pos && (bar === null || e > bar)) bar = e; };
      for (const [, b1] of blocked) raise(b1);
      for (const k of marks) if (k.rel) raise(k.end);

      let src = ante;
      if (src && src.law) src = null;                       // 他法令を引き継いだ列挙
      if (src && bar !== null && bar > src.end) src = null;  // あいだに附則・前条などがある
      if (src && qd[src.start]) src = null;                  // 引用の中の条は使わない
      // 括弧の中で閉じた参照は外へ持ち出さない。外から中へ入るのは許す。
      if (src && pd[src.start] > pd[pos]) src = null;
      if (!src) continue;

      const art = String(src.ref || '').split('/')[1];
      if (!art) continue;
      marks.push({
        start: pos, end: pos + all.length, text: all, doujou: true,
        ref: ['M', art, par ? kanjiToNum(par) : '', item ? kanjiToNum(item) : ''].join('/'),
      });
    }
  }

  marks.sort((a, b) => a.start - b.start);

  for (const k of marks) {
    if (k.start < last) continue;
    out.push(esc(raw.slice(last, k.start)));
    const attrs = k.rel
      ? ` data-rel="${esc(k.rel)}" data-from="${esc(ctx.self || '')}"`
        + (k.par ? ` data-par="${k.par}"` : '') + (k.item ? ` data-item="${k.item}"` : '')
      : ` data-ref="${esc(k.ref)}"${k.law ? ` data-law="${esc(k.law)}"` : ''}`;
    out.push(`<a class="ref"${attrs}>${esc(k.text)}</a>`);
    last = k.end;
  }
  out.push(esc(raw.slice(last)));
  return out.join('');
}

/** インライン要素を HTML 化する。Line などの入れ子でもルビ・上付きを保つ。 */
function inlineHTML(node, ctx) {
  let html = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      html += ctx ? linkifyText(n.nodeValue, ctx) : esc(n.nodeValue);
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    switch (n.tagName) {
      case 'Ruby': {
        const rt = n.querySelector('Rt');
        const base = Array.from(n.childNodes)
          .filter(x => x.nodeType === Node.TEXT_NODE).map(x => x.nodeValue).join('');
        html += '<ruby>' + esc(base) + '<rt>' + esc(rt ? rt.textContent : '') + '</rt></ruby>';
        break;
      }
      case 'Rt': break;
      case 'Sup': html += '<sup>' + inlineHTML(n, ctx) + '</sup>'; break;
      case 'Sub': html += '<sub>' + inlineHTML(n, ctx) + '</sub>'; break;
      case 'Fig': html += `<span class="fig">［図: ${esc(n.getAttribute('src') || '')}］</span>`; break;
      case 'Sentence':
        html += n.getAttribute('Function') === 'proviso'
          ? '<span class="proviso">' + inlineHTML(n, ctx) + '</span>' : inlineHTML(n, ctx);
        break;
      case 'Column': html += '<span class="column">' + inlineHTML(n, ctx) + '</span>'; break;
      default: html += inlineHTML(n, ctx);
    }
  }
  return html;
}

const CONTAINER_TITLE = {
  Part: 'PartTitle', Chapter: 'ChapterTitle', Section: 'SectionTitle',
  Subsection: 'SubsectionTitle', Division: 'DivisionTitle',
};
const CONTAINER_CLASS = {
  Part: 'h-part', Chapter: 'h-chapter', Section: 'h-section',
  Subsection: 'h-subsection', Division: 'h-division',
};
const CONTAINER_LEVEL = { Part: 1, Chapter: 2, Section: 3, Subsection: 4, Division: 5 };

/** 条・項・号に付けられる色マーク */
const MARK_COLORS = [
  { key: 'yellow', label: '黄' }, { key: 'green', label: '緑' }, { key: 'blue', label: '青' },
  { key: 'red', label: '赤' }, { key: 'orange', label: '橙' }, { key: 'purple', label: '紫' },
];

/*
 * 文言に付けられる印。色のほかに下線がある。
 *
 * 色と下線は使い分ける。色は「この文言にメモを足したい」とき、下線は
 * 「読むときに気を付けたい」ときの強調である。紙の六法でマーカーと下線を
 * 使い分けるのと同じで、色を薄くした代わりではない。
 *
 * 条項号の印（上の MARK_COLORS）には下線を入れない。下線は文字そのものに
 * 掛けるものなので、条や項の全体に掛ける意味がない。
 */
const RANGE_STYLES = [...MARK_COLORS, { key: 'ul', label: '下線' }];

/** 親が自分で描画済みの要素。renderBlocks はこれらを飛ばす。 */
const HANDLED_BY_PARENT = new Set([
  'LawTitle', 'LawNum', 'TOC',
  // 編章節款目の見出しは容器側で描くので、子の巡回では必ず飛ばす。
  // これを入れ忘れると renderBlock の /Title$/ 分岐が拾って二重描画になる。
  'PartTitle', 'ChapterTitle', 'SectionTitle', 'SubsectionTitle', 'DivisionTitle',
  'ArticleCaption', 'ArticleTitle',
  'ParagraphCaption', 'ParagraphNum', 'ParagraphSentence',
  'ItemTitle', 'ItemSentence',
  'SupplProvisionLabel',
]);

const TABLE_LIKE = new Set([
  'TableStruct', 'Table', 'AppdxTable', 'AppdxNote', 'AppdxStyle',
  'Appdx', 'AppdxFig', 'AppdxFormat', 'NoteStruct', 'StyleStruct',
  'FigStruct', 'FormatStruct', 'ArithFormula', 'List', 'Remarks', 'SupplNote',
]);

/**
 * 法令XMLを HTML と検索用インデックスに変換する。
 * 未知の要素は捨てずに再帰して本文を出す。取りこぼしは表示の正確さを直接損なう。
 */
function renderLaw(lawEl) {
  const out = [];
  const index = [];
  const bodies = new Map();   // アンカー → 突き合わせ用の本文（下の pushBody）
  /*
   * 附則と別表の見分け。版をまたいで突き合わせるときに使う。
   *
   * S1 / S2 や AP1 / AP2 は「XMLに出てきた順」で振っている。手前に附則が
   * 1本増えると番号がずれるので、順番を手掛かりにしてはいけない。
   * 改正法令番号（AmendLawNum）や題名を持っておき、それで対応づける。
   * どちらも無い・重なるときは「分からない」として扱う（推測しない）。
   */
  const scopes = new Map();   // scope → { kind, label, amend, title }
  const toc = [];             // { id, level, title, first, last }
  const tocStack = [];
  let hseq = 0;
  let scope = 'M';

  function pushToc(entry) {
    entry.id = 'h' + (++hseq);
    toc.push(entry);
    return entry.id;
  }

  function pushIndex(anchor, text) {
    const t = String(text).replace(/\s+/g, '');
    if (t) index.push({ anchor, text: t, norm: normalize(t) });
  }

  /*
   * 突き合わせ用の本文。版をまたいで「同じ条文か」を見るのに使う。
   *
   * 索引（検索用）とは別に持つ。索引は条には見出しと条番号しか入れておらず、
   * 号には号番号（「一」）が混ざっている。番号は改正で動くので、番号混じりの
   * 文字列で突き合わせると、第二号が第一号に繰り上がっただけで別物に見える。
   *
   *   kind     条・項・号・細分・別表のどれか
   *   caption  見出し。見出しだけの改正も拾えるように分けて持つ
   *   own      その単位自身の文。番号ラベルと、下位の単位の文を除く
   *   parts    下位の単位の sig を順に並べたもの
   *   sig      突き合わせに使う文字列
   *
   * sig は型と入れ子を保ったまま組む。前は区切り文字で平らにつないでいたので、
   * 階層をまたいで衝突した。「項の下に号X」と「第2項がX」が同じ文字列に
   * なりうる（Codex の指摘6）。構造が違えば必ず違う文字列になってほしい。
   *
   * JSON にすれば、文字列は引用符で囲まれ中の引用符は逃がされるので、
   * どこまでが一つの単位かが必ず読み取れる。入れ子のまま持てる。
   */
  const squash = t => String(t == null ? '' : t).replace(/\s+/g, '');
  const sigOf = (kind, caption, own, parts) =>
    JSON.stringify([kind, squash(caption), squash(own), parts]);

  function pushBody(anchor, kind, caption, own, parts) {
    const rec = {
      kind,
      caption: squash(caption),
      own: squash(own),
      parts,
      sig: sigOf(kind, caption, own, parts),
    };
    bodies.set(anchor, rec);
    return rec.sig;
  }

  /*
   * 別表の中身を、構造を保ったまま取り出す。
   *
   * 平らな文字列にすると、表のセルの境目・結合・図の差し替えが消える。
   * 「一つのセルに『甲乙』」と「二つのセルに『甲』『乙』」が同じ文字列に
   * なり、中身が変わっても「同じ」と言ってしまう（Codex の指摘4）。
   */
  function structOf(el) {
    const out = [];
    for (const ch of el.children) {
      const tag = ch.tagName;
      if (/(?:Title|Label)$/.test(tag)) continue;        // 題名は caption が持つ
      if (tag === 'Fig') { out.push(['Fig', ch.getAttribute('src') || '']); continue; }
      if (/Column$/.test(tag)) {
        out.push(['Column', squash(plainText(ch)),
          ch.getAttribute('colspan') || ch.getAttribute('ColSpan') || '',
          ch.getAttribute('rowspan') || ch.getAttribute('RowSpan') || '']);
        continue;
      }
      if (/(?:Row|Struct)$/.test(tag) || tag === 'Table') {
        out.push([tag, structOf(ch)]);
        continue;
      }
      const t = squash(plainText(ch));
      if (t) out.push([tag, t]);
    }
    return out;
  }

  /*
   * 細分（イ・ロ・(1)）のタグ。親自身の文からは除き、入れ子として parts に持つ。
   * スキーマは Subitem10 まであるので、数えて作る。
   */
  const SUBITEMS = new Set();
  for (let i = 1; i <= 10; i++) SUBITEMS.add('Subitem' + i);

  // 項自身の文から除くもの。項番号・項見出しと、自分のアンカーを持つ号。
  const PARA_OWN_SKIP = new Set(['ParagraphNum', 'ParagraphCaption', 'Item']);

  /* --- 表・別表・図など --- */

  function renderTable(tbl) {
    out.push('<table class="law-table"><tbody>');
    for (const row of tbl.children) {
      if (!/Row$/.test(row.tagName)) continue;
      const header = row.tagName === 'TableHeaderRow';
      out.push('<tr>');
      for (const cell of row.children) {
        if (!/Column$/.test(cell.tagName)) continue;
        const cs = cell.getAttribute('colspan') || cell.getAttribute('ColSpan');
        const rs = cell.getAttribute('rowspan') || cell.getAttribute('RowSpan');
        const tag = header || /Header/.test(cell.tagName) ? 'th' : 'td';
        out.push(`<${tag}${cs ? ` colspan="${esc(cs)}"` : ''}${rs ? ` rowspan="${esc(rs)}"` : ''}>`
          + inlineHTML(cell) + `</${tag}>`);
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }

  /**
   * 別表・別記・図・備考など。子を元の順序どおり一度ずつ描く。
   * 以前は子孫の Table をまとめて先に描いてから残りを巡回していたため、
   * 表の題名や備考が落ち、入れ子の表は二重に出ていた。
   */
  function renderTableLike(el) {
    if (el.tagName === 'Table') { renderTable(el); return; }

    let drew = false;
    for (const ch of el.children) {
      const t = ch.tagName;
      if (/(?:Title|Label)$/.test(t)) {
        const s2 = ch.textContent.trim();
        if (s2) { out.push(`<div class="h-section">${esc(s2)}</div>`); drew = true; }
        continue;
      }
      if (t === 'Table') { renderTable(ch); drew = true; continue; }
      if (t === 'Sentence') {
        out.push(`<div class="para">${inlineHTML(ch)}</div>`);
        drew = true;
        continue;
      }
      renderBlock(ch);
      drew = true;
    }
    if (!drew) {
      const t = el.textContent.trim();
      if (t) out.push(`<div class="para">${esc(t)}</div>`);
    }
  }

  /* --- 条・項・号 --- */

  /**
   * 号とその細分（イ・ロ）を描く。別表の直下など、項の外に現れる号もここを通す。
   * その場合は条項の文脈が無いのでアンカーは付けない。
   */
  function renderItemNode(el, depth, anchor) {
    const tag = el.tagName;                        // Item / Subitem1 / Subitem2 …
    const titleTag = tag + 'Title';
    const sentTag = tag + 'Sentence';
    const title = textOf(el, titleTag);
    const sent = el.querySelector(':scope > ' + sentTag);

    out.push(`<div class="item${depth ? ' subitem' + depth : ''}"`
      + `${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>`);
    if (title) out.push(`<span class="item-title">${esc(title)}</span>`);
    if (sent) out.push(inlineHTML(sent, { scope, self: anchor || '' }));
    const subs = [];
    for (const ch of el.children) {
      // 自分で描いた見出しと本文は固定リストではなく、この呼び出しの名前で除く。
      // スキーマは Subitem10 まであるので、列挙だと取りこぼす。
      if (ch.tagName === titleTag || ch.tagName === sentTag) continue;
      if (/^Subitem\d+$/.test(ch.tagName)) {
        const r = renderItemNode(ch, depth + 1, null);
        subs.push(sigOf('subitem', '', r.own, r.parts));
      } else if (!HANDLED_BY_PARENT.has(ch.tagName)) renderBlock(ch);
    }
    out.push('</div>');

    /*
     * 細分（イ・ロ・(1)）には別アンカーを与えていないので突き合わせ用の
     * 本文も持たないが、境目は親の sig に残す。平らにつなぐと、細分の
     * 区切りが動いただけの改正を見逃す（Codex の指摘6）。
     */
    return { own: plainText(el, new Set([titleTag, ...SUBITEMS])), parts: subs };
  }

  function renderItem(item, art, par) {
    const anchor = `${scope}/${art}/${par}/${item.getAttribute('Num') || ''}`;
    const r = renderItemNode(item, 0, anchor);
    // 号の索引にはイ・ロ以下の本文も含める（細分には別アンカーを与えない）
    pushIndex(anchor, plainText(item));
    // 突き合わせ用は、号番号を除き、細分は入れ子のまま持つ
    return pushBody(anchor, 'item', '', r.own, r.parts);
  }

  /**
   * 項を描画する。条の下の項も、附則直下の項も同じ経路を通す。
   * 条が無い場合は art を空にする（アンカーは "S1//3" の形）。
   */
  function renderParagraph(p, art, idx, leadHTML) {
    const par = p.getAttribute('Num') || String(idx + 1);
    const anchor = `${scope}/${art}/${par}`;
    const pnum = paragraphNumLabel(
      textOf(p, 'ParagraphNum'), par, p.getAttribute('OldNum') === 'true');
    const pcap = textOf(p, 'ParagraphCaption');
    const sent = p.querySelector(':scope > ParagraphSentence');

    out.push(`<div class="para" data-anchor="${esc(anchor)}">`);
    if (pcap) out.push(`<div class="article-caption">${esc(pcap)}</div>`);
    if (leadHTML) out.push(leadHTML);
    else if (pnum) out.push(`<span class="para-num">${esc(pnum)}</span>　`);
    if (sent) out.push(inlineHTML(sent, { scope, self: anchor }));

    const itemSigs = [];
    for (const ch of p.children) {
      if (ch.tagName === 'Item') itemSigs.push(renderItem(ch, art, par));
      else if (!HANDLED_BY_PARENT.has(ch.tagName)) renderBlock(ch, null);
    }
    out.push('</div>');

    // 項の索引には号・細分・表まで含める。項番号だけは除く。
    const text = plainText(p, new Set(['ParagraphNum']));
    pushIndex(anchor, text);
    void text;
    // 突き合わせ用は、項自身の文（柱書）と号の sig を分けて持つ
    return pushBody(anchor, 'para', pcap, plainText(p, PARA_OWN_SKIP), itemSigs);
  }

  function renderArticle(articleEl) {
    const art = articleEl.getAttribute('Num') || '';
    const caption = textOf(articleEl, 'ArticleCaption');
    const title = textOf(articleEl, 'ArticleTitle');
    const paras = Array.from(articleEl.children).filter(c => c.tagName === 'Paragraph');
    const anchor = `${scope}/${art}`;

    // 目次に条の範囲（第1条〜第10条）を記録する
    for (const e of tocStack) {
      if (e.first === null) e.first = art;
      e.last = art;
    }

    out.push(`<div class="article" data-anchor="${esc(anchor)}">`);
    if (caption) out.push(`<div class="article-caption">${esc(caption)}</div>`);

    const paraSigs = [];
    paras.forEach((p, i) => {
      const lead = (i === 0 && title) ? `<span class="article-title">${esc(title)}</span>　` : '';
      paraSigs.push(renderParagraph(p, art, i, lead));
    });

    for (const ch of articleEl.children) {
      if (ch.tagName === 'Paragraph' || HANDLED_BY_PARENT.has(ch.tagName)) continue;
      renderBlock(ch, null);
    }

    if (!paras.length) {
      const txt = plainText(articleEl, new Set(['ArticleTitle', 'ArticleCaption']));
      out.push(`<div class="para">${title ? `<span class="article-title">${esc(title)}</span>　` : ''}${esc(txt.trim())}</div>`);
      pushIndex(anchor, (caption || '') + txt);
      // 条番号（ArticleTitle）は除く。番号は改正で動く
      pushBody(anchor, 'art', caption, txt, []);
    } else {
      // 条の索引は見出しだけ。本文は項の索引が持つので重複させない。
      pushIndex(anchor, (caption || '') + (title || ''));
      // 突き合わせ用は、見出しと項の sig。条自身の文は持たない
      pushBody(anchor, 'art', caption, '', paraSigs);
    }
    out.push('</div>');
  }

  /* --- 汎用の振り分け --- */

  function renderBlock(el) {
    const tag = el.tagName;
    if (HANDLED_BY_PARENT.has(tag)) return;

    if (tag in CONTAINER_TITLE) {
      const t = textOf(el, CONTAINER_TITLE[tag]);
      let entry = null;
      if (t) {
        entry = { level: CONTAINER_LEVEL[tag], title: t, first: null, last: null };
        const id = pushToc(entry);
        tocStack.push(entry);
        out.push(`<div class="${CONTAINER_CLASS[tag]}" id="${id}">${esc(t)}</div>`);
      }
      renderBlocks(el);
      if (entry) tocStack.pop();
      return;
    }
    if (tag === 'Article') { renderArticle(el); return; }
    if (tag === 'Paragraph') { renderParagraph(el, '', 0, ''); return; }
    // 別表の直下などに現れる号。項を介さないのでアンカーは付けない。
    if (tag === 'Item' || /^Subitem\d+$/.test(tag)) { renderItemNode(el, 0, null); return; }
    // 図は本文を持たない。放っておくと文字が無いので黙って消える。
    if (tag === 'Fig') {
      out.push(`<div class="para"><span class="fig">［図: ${esc(el.getAttribute('src') || '')}］</span></div>`);
      return;
    }
    if (TABLE_LIKE.has(tag)) { renderTableLike(el); return; }
    if (/Title$/.test(tag)) {
      const t = el.textContent.trim();
      if (t) out.push(`<div class="h-section">${esc(t)}</div>`);
      return;
    }
    if (el.children.length) { renderBlocks(el); return; }
    const t = el.textContent.trim();
    if (t) out.push(`<div class="para">${esc(t)}</div>`);
  }

  function renderBlocks(el) {
    for (const ch of el.children) renderBlock(ch);
  }

  /* --- 全体 --- */

  const body = lawEl.querySelector('LawBody');
  if (!body) return { html: '', index, bodies, scopes, toc };

  let sn = 0, apn = 0;
  scopes.set('M', { kind: 'main', label: '', amend: '', title: '本則' });
  for (const ch of body.children) {
    const tag = ch.tagName;
    if (tag === 'LawTitle' || tag === 'TOC') continue;           // 題名は見出し欄、目次は省略
    if (tag === 'EnactStatement') {
      out.push(`<div class="enact">${inlineHTML(ch)}</div>`);
      continue;
    }
    if (tag === 'Preamble') {
      // 索引に載せる以上、飛び先のアンカーも付けておく（検索結果から移動できるように）
      out.push('<div class="preamble" data-anchor="M/前文">');
      for (const p of ch.querySelectorAll('Paragraph')) {
        const sent = p.querySelector(':scope > ParagraphSentence');
        out.push('<div class="para">' + (sent ? inlineHTML(sent) : '') + '</div>');
      }
      out.push('</div>');
      pushIndex('M/前文', plainText(ch));
      // 前文にも注釈を付けられる。本文を持たないと「無くなった」と言ってしまう
      pushBody('M/前文', 'preamble', '', plainText(ch), []);
      continue;
    }
    if (tag === 'SupplProvision') {
      sn += 1;
      scope = 'S' + sn;
      const label = textOf(ch, 'SupplProvisionLabel');
      const amend = ch.getAttribute('AmendLawNum');
      const title = (label || '附則') + (amend ? '（' + amend + '）' : '');
      scopes.set(scope, { kind: 'suppl', label: label || '', amend: amend || '', title });
      const id = pushToc({ level: 0, title, kind: 'suppl' });
      out.push(`<div class="suppl-label" id="${id}">${esc(label || '附則')}${amend ? '　' + esc(amend) : ''}</div>`);
      renderBlocks(ch);
      continue;
    }
    if (/^Appdx/.test(tag)) {                 // 別表・別記・別図など
      apn += 1;
      scope = 'M';
      const anchor = 'AP' + apn;
      const t = Array.from(ch.children).find(c => /Title$/.test(c.tagName));
      const aptitle = t ? t.textContent.trim() : '';
      scopes.set(anchor, { kind: 'appdx', label: aptitle, amend: '', title: aptitle || ('別表' + apn) });
      const id = pushToc({ level: 0, title: (t ? t.textContent.trim() : '別表' + apn), kind: 'appdx' });
      out.push(`<div class="appdx" id="${id}" data-anchor="${esc(anchor)}">`);
      renderBlock(ch);
      out.push('</div>');
      pushIndex(anchor, plainText(ch));
      // 題名は別に持つ（題名だけの改正も拾えるように）
      pushBody(anchor, 'appdx', aptitle,
        plainText(ch, new Set(t ? [t.tagName] : [])),
        [JSON.stringify(structOf(ch))]);
      continue;
    }
    scope = 'M';
    renderBlock(ch);                          // MainProvision はここを通る
  }

  return { html: out.join(''), index, bodies, scopes, toc };
}

/* --------------------------------------------------- アンカー → XML要素 */

/**
 * アンカー（M/709/1 など）が指す XML 要素を返す。
 * 注釈付きXMLの書き出しと、将来の文言メモの位置解決で使う。
 */
function elementForAnchor(lawEl, anchor) {
  const body = lawEl.querySelector('LawBody');
  if (!body) return null;
  const parts = String(anchor).split('/');

  if (anchor === 'M/前文') return body.querySelector(':scope > Preamble');

  if (/^AP\d+$/.test(parts[0])) {
    const list = Array.from(body.children).filter(c => /^Appdx/.test(c.tagName));
    return list[Number(parts[0].slice(2)) - 1] || null;
  }

  let root;
  if (parts[0] === 'M') {
    root = body.querySelector(':scope > MainProvision');
  } else {
    const list = Array.from(body.children).filter(c => c.tagName === 'SupplProvision');
    root = list[Number(parts[0].slice(1)) - 1];
  }
  if (!root) return null;

  const [, art, par, item] = parts;
  let cur = root;

  if (art) {
    cur = Array.from(root.querySelectorAll('Article')).find(a => a.getAttribute('Num') === art);
    if (!cur) return null;
  }
  if (par) {
    const paras = art
      ? Array.from(cur.children).filter(c => c.tagName === 'Paragraph')
      : Array.from(root.children).filter(c => c.tagName === 'Paragraph');
    cur = paras.find(p => (p.getAttribute('Num') || '') === par);
    if (!cur) return null;
  }
  if (item) {
    cur = Array.from(cur.children).filter(c => c.tagName === 'Item')
      .find(i => (i.getAttribute('Num') || '') === item);
    if (!cur) return null;
  }
  return cur;
}

