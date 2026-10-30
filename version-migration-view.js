'use strict';

/*
 * 改正後の版へ注釈を写す。その画面。
 *
 * 判定の規則は version-migration.js にある。こちらは「選ばせる」ことと
 * 「書く」ことだけを受け持つ。規則をここに書くと、核と食い違ったときに
 * どちらが正しいか分からなくなる。
 *
 * 守っていること（Codex の助言）
 *
 *   ・トップレベルで何も走らせない。DBも読まない。読み込み順に依存しない
 *   ・画面を開いた時点の計画をそのまま書かない。確定の直前に読み直す。
 *     写し先の注釈だけでなく、計画の元になった法令XMLと、写す元の注釈
 *     （指紋を控えてある）も確かめ直す
 *   ・読み直してから書くまでに、無防備な await を挟まない。読んでいる間に
 *     書かれていたら（localWrites が動いていたら）読み直す
 *   ・書くのは一度に一つ（vmBusy）。待っている間に開き直されたら中止する
 *   ・保存できていない編集があるなら、写しも取り消しも始めない
 *   ・文言の位置を自前で数え直さない。dispByAnchor（＝textMapOf）を共有する
 *   ・既存の「固定版→元法令」「条→第1項」の移し替えには手を付けない
 *
 * view.js より後、boot.js より前に読む。view.js からは showLaw の中で
 * paintVersionMigrationNote を呼ぶだけで、どちらも関数の中なので
 * 読み込み時には走らない。
 */

/* ------------------------------------------------------------ 画面の状態 */

/*
 * 立てた計画。画面の中だけのもので、保存しない。
 *
 * 保存して後から使うと、その間に法令を取り込み直されていても気づけない。
 * 開き直すたびに作り直し、確定の直前にもう一度確かめる。
 */
let vm = null;

/* 問い合わせている間に開き直したとき、前の応答で上書きしないための印 */
let vmToken = 0;

/*
 * 写し・取り消しの最中か。
 *
 * 実行中の印もボタンの無効化も無かったので、「写す」を二度押せば二度走った。
 * 同じ文言注釈が別ID・別opで2件でき、控えは後の op だけになって、
 * 片方は取り消せなくなる（Codex の指摘3）。「読み直してから書くまでに
 * await を挟まない」は一本の流れの中の守りで、並行して走る読み取りは
 * それでは防げない。最初の await より前に立て、finally で必ず下ろす。
 */
let vmBusy = false;

/** 実行中の見せ方。押せるボタンを閉じる。下ろすときは選択に応じて戻す。 */
function vmSetBusy(on) {
  vmBusy = on;
  const go = $('#vmig-go');
  if (go) go.disabled = on;
  for (const b of [...$$('#dlg-vmig .vmig-undo'), $('#vmig-result-undo')]) {
    if (b) b.disabled = on;
  }
  // 「写す」の押せる・押せないは選択で決まる。下ろすときは描き直して任せる
  if (!on && vm && !$('#vmig-step2').hidden) renderVersionSummary();
}

/*
 * 直前に写した操作の控え。取り消しに使う。
 *
 * localStorage ではなく meta に置く。写した注釈と同じ入れ物に入れておけば、
 * 注釈を書いたトランザクションの中で一緒に確定できる。控えだけ残って
 * 写せていない、あるいはその逆が起きない。
 */
const VM_LAST_KEY = 'roppo.lastVersionCopy';

/*
 * 入れ替えの控え。写しとは別の鍵にする。
 *
 * 同じ鍵に入れると、入れ替えたあとに注釈を1件写しただけで、本文を戻す
 * 手立てが消える。取り返しの付き方が違うものを同じ場所に置かない。
 */
const SWAP_LAST_KEY = 'roppo.lastVersionSwap';

/*
 * 判定の見せ方。核が返す6通りに言葉を与える。
 *
 * auto が true のものは既定で選ぶ（defaultPicks と揃えてある）。
 * pickable が true のものは、利用者が選べば写せる。
 */
const VM_KINDS = {
  same: { label: 'そのまま', why: '同じ位置にあります', auto: true, pickable: true },
  moved: { label: '動いた', why: '番号が変わっています', auto: true, pickable: true },
  ambiguous: { label: '要確認', why: '同じ本文が新しい版に複数あります。選んでください',
    auto: false, pickable: true },
  changed: { label: '本文が違う',
    why: '同じ番号の条文はありますが、本文が変わっています', auto: false, pickable: true },
  gone: { label: '無くなった', why: '新しい版に見つかりません', auto: false, pickable: false },
  unknown: { label: '分からない', why: '附則や別表の対応が付きません',
    auto: false, pickable: false },
};

/* ------------------------------------------------------------ 入口 */

/*
 * 固定版を開いているときに出す帯。view.js の showLaw から呼ぶ。
 *
 * 「未施行」の帯とは別に出す。改正前の版は施行日が過ぎているので未施行の
 * 帯が出ない。出ない帯にボタンを足しても押せない。
 */
function paintVersionMigrationNote(note, rec, opts) {
  const o = opts || {};
  const peers = versionPeers(rec.lawId);
  const n = countVersionNotes(rec.lawId);
  /*
   * 写す入口を出すか（o.copy === false なら出さない）。
   *
   * 元の法令の帯では出さない。そこから写せる先は同じ法令の固定版しかなく、
   * 入れ替えができた以上その向きはほぼ使わない。それなのに「入れ替える」と
   * 並べていたので、**作った本人が間違えて 481件を固定版へ写した。**
   *
   * 写しなので元は残り、取り消せる。危なくはない。しかし危なくないことと
   * 間違えにくいことは別である。一等地に、ほぼ使わない道と、いつも使う道を
   * 並べて置かない。
   */
  const canCopy = o.copy !== false && n && peers.length;
  const canMove = canCopy;
  /*
   * 「新しい版に入れ替える」のボタンを出すか（o.swap に法令IDを渡す）。
   *
   * これだけでは帯を開かない。e-Gov から取った法令はどれも入れ替えられる
   * ので、開く条件にすると全部の法令にいつも帯が出る。ヘッダーは開くたびに
   * 目に入る一等地なので、言うことがあるときだけ使う。
   */
  const swapId = o.swap || '';

  /*
   * 黙っていてよいときは帯を出さない（quiet）。
   *
   * 固定版は「固定した版です」自体が読む人に要る情報なので、いつでも出す。
   * パックは普段読む版なので、写せるものがあるときだけ出す。ヘッダーは開く
   * たびに目に入る一等地で、前にここへ「このアプリについて」を置いて絞り込みの
   * 入力欄を 38px 狭めた。
   */
  if (o.quiet && !canMove && !o.prefix) {
    note.hidden = true;
    note.innerHTML = '';
    return;
  }
  note.hidden = false;
  const head = o.head !== undefined ? o.head
    : canCopy ? 'この版に付けた注釈 ' + n + '件を、別の版の正しい位置へ写せます'
    : n ? 'この版に付けた注釈は ' + n + '件です'
    : 'この版に注釈はまだありません';
  note.innerHTML = (o.prefix || '')
    + '<span>' + esc(o.lead || '固定した版です。') + esc(head) + '</span>'
    + (canCopy
      ? '<button type="button" class="mini vmig-open">注釈を写す</button>'
      : n && !swapId ? '<span class="warn">写し先になる版が手元にありません</span>' : '')
    + (swapId
      ? '<button type="button" class="mini vmig-swap-open">新しい版に入れ替える</button>'
      : '');
  const b = note.querySelector('.vmig-open');
  if (b) b.onclick = () => openVersionMigration(rec.lawId);
  const sb = note.querySelector('.vmig-swap-open');
  if (sb) sb.onclick = () => openVersionSwap(swapId);
}

/** その法令に付いている、生きている注釈の数。 */
function countVersionNotes(lawId) {
  let n = 0;
  for (const r of state.notes.values()) if (!isTomb(r) && r.lawId === lawId) n++;
  for (const r of state.ranges.values()) if (!isTomb(r) && r.lawId === lawId) n++;
  return n;
}

/*
 * 写し先の候補。
 *
 * 同じ元法令に属するもの、つまり元の法令そのものと、ほかの固定版である。
 * 取り込んだデータ（source: 'file'）は版の関係を持たないので入れない。
 *
 * パックのものは、住所の形では束ねられない。
 *
 *   e-Gov    元の法令 123AC… と固定版 123AC…@…_20270623_… が @ で繋がる
 *   パック    pack-<sha256A> と pack-<sha256B>。どちらも @ を持たない別の法令
 *
 * 訂正版は必ず別の sha256 になるので、住所だけ見ると他人である。同じ規則の
 * 版だと分かるのは workId だけなので、それでも束ねる。住所を分けているのは
 * わざとで（同じ住所で上書きすると注釈が黙って新しい本文に付き直す）、
 * 束ねる手段を別に持つのが筋である。
 *
 * 施行日の新しい順。元の法令は施行日を持たないことがあるので、
 * 持たないものは先頭に置く（たいてい最新である）。パックのものは施行日を
 * 持たない（pack.json の enforcedOn が全件 null。PDFで確かめていない施行日を
 * 推測で書かない方針）ため、全部が先頭に並ぶ。並び順は付けられない。
 */
function versionPeers(lawId) {
  const base = baseLawIdOf(lawId);
  const self = state.laws.find(l => l.lawId === lawId);
  const workId = self && self.workId;
  // 出どころは lawOrigin で見る。ファイルから入れたものは版の関係を保証できない
  const list = state.laws.filter(l => l.lawId !== lawId && lawOrigin(l) !== 'file'
    && (l.lawId === base || l.revisionOf === base
      || (!!workId && l.workId === workId)));
  return list.sort((a, b) => {
    const x = a.enforcementDate || '9999-99-99';
    const y = b.enforcementDate || '9999-99-99';
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

/* ------------------------------------------------------------ 段1：写し先を選ぶ */

async function openVersionMigration(lawId) {
  const rec = state.laws.find(l => l.lawId === lawId);
  if (!rec) { toast('法令が見つかりません'); return; }

  vm = null;
  vmToken++;
  $('#vmig-law').textContent = rec.lawTitle;
  vmStep(1);
  $('#dlg-vmig').showModal();

  const box = $('#vmig-peers');
  box.innerHTML = '';
  const peers = versionPeers(lawId);
  if (!peers.length) {
    box.innerHTML = '<p class="hint">写し先になる版が手元にありません。'
      + '「版を選ぶ」で改正後の版を取り込むか、元の法令を取り込んでください。</p>';
  }
  for (const p of peers) {
    const b = document.createElement('button');
    b.type = 'button';
    const when = p.enforcementDate ? '施行 ' + p.enforcementDate : '施行日の記録なし';
    b.innerHTML = `<span class="vmig-peer-name">${esc(p.lawTitle)}</span>`
      + `<span class="vmig-peer-date">${esc(when)}</span>`
      + `<span class="vmig-peer-kind">${p.revisionOf ? '固定した版' : 'いまの版'}</span>`;
    b.onclick = () => showVersionPlan(lawId, p.lawId);
    box.appendChild(b);
  }

  await paintVersionUndoBox();
}

/*
 * 「直前の写しを取り消す」の箱。控えがあるときだけ出す。
 *
 * 写した直後の画面にも出すが、閉じたあとで気が変わることもあるので
 * 入口にも置く。控えは1回ぶんだけ持つ。
 */
async function paintVersionUndoBox() {
  const box = $('#vmig-undo-box');
  let last = null, sw = null;
  try { last = await store.getMeta(VM_LAST_KEY); } catch (e) { /* 読めなければ出さない */ }
  try { sw = await store.getMeta(SWAP_LAST_KEY); } catch (e) { /* 同じ */ }
  const v = last && last.value;
  const s = sw && sw.value;

  /*
   * 入れ替えの控えが先。本文を戻す操作なので、注釈の写しより影響が大きい。
   * 両方あるときは両方出す（別の箱に入れると場所が増えるので、同じ箱に並べる）。
   */
  const sbox = $('#vmig-swap-undo-box');
  if (s && s.op) {
    const law = state.laws.find(l => l.lawId === s.lawId);
    sbox.hidden = false;
    sbox.innerHTML = '<div>直前に入れ替えた本文　'
      + esc((law ? law.lawTitle : s.lawId)
        + '　' + (s.next && s.next.enforced ? s.next.enforced + ' 施行の版へ' : ''))
      + '　動かした ' + ((s.moves || []).length + (s.rangeMoves || []).length)
      + '件 / 退避 ' + ((s.parked || []).length) + '件</div>'
      + '<button type="button" class="mini vmig-swap-undo">この入れ替えを取り消す</button>';
    sbox.querySelector('.vmig-swap-undo').onclick = () => undoVersionSwap(s);
  } else {
    sbox.hidden = true;
    sbox.innerHTML = '';
  }

  if (!v || !v.op) { box.hidden = true; box.innerHTML = ''; return; }

  const from = state.laws.find(l => l.lawId === v.fromLawId);
  const to = state.laws.find(l => l.lawId === v.toLawId);
  box.hidden = false;
  box.innerHTML = '<div>直前に写したもの　'
    + esc((from ? from.lawTitle : v.fromLawId) + ' → ' + (to ? to.lawTitle : v.toLawId))
    + '　注釈 ' + (v.notes || 0) + '件 / 文言 ' + (v.ranges || 0) + '件</div>'
    + '<button type="button" class="mini vmig-undo">この写しを取り消す</button>';
  box.querySelector('.vmig-undo').onclick = () => undoVersionCopy(v);
}

/* ------------------------------------------------------------ 材料をそろえる */

/*
 * 突き合わせに使う材料。
 *
 *   bodies  突き合わせ用の本文（番号ラベルを除き、空白を落としたもの）
 *   scopes  附則・別表の手掛かり（改正法令番号や題名）
 *   disp    画面に出るのと同じ文字列。文言注釈の「何番目」を数えるのに使う
 *   savedAt この材料がいつの中身から作られたか。確定の直前に照合する
 *
 * 会社法で数百msかかる。開いたときと、書く直前の2回だけ走らせる。
 */
function versionMaterialsFromXml(xml, what) {
  const doc = parseXML(xml);
  const lawEl = doc.querySelector('Law');
  if (!lawEl) throw new Error('法令本体が見つかりません: ' + (what || ''));
  const { html, bodies, scopes, index } = renderLaw(lawEl);
  return { bodies, scopes, index, disp: dispByAnchor(html) };
}

async function versionMaterials(lawId) {
  const rec = await store.getLaw(lawId);
  if (!rec) throw new Error('法令が見つかりません: ' + lawId);
  return { ...versionMaterialsFromXml(rec.xml, lawId), savedAt: rec.savedAt || 0 };
}

/* ------------------------------------------------------------ 段2：計画 */

async function showVersionPlan(fromLawId, toLawId) {
  const token = ++vmToken;
  vmStep(2);
  $('#vmig-sum').innerHTML = '<p class="hint">両方の版を読んで、突き合わせています…</p>';
  $('#vmig-list').innerHTML = '';
  $('#vmig-go').hidden = true;

  let from, to;
  try {
    [from, to] = await Promise.all([
      versionMaterials(fromLawId), versionMaterials(toLawId),
    ]);
  } catch (e) {
    if (token !== vmToken) return;
    $('#vmig-sum').innerHTML = '<p class="hint">'
      + esc('調べられませんでした: ' + e.message) + '</p>';
    return;
  }
  if (token !== vmToken) return;      // 開き直されている

  /*
   * 注釈は画面の写し（state）から渡す。墓石は核が落とす。
   *
   * 確定の直前には DB を読み直すが、読み直したものは写し先の重複・墓石の
   * 判定にしか使っていなかった。写す中身は計画に載ったまま（この時点の
   * もの）なので、計画を出したあとに元のメモを直すと古い内容が写り、
   * 元を消しても写ってしまった（Codex の指摘5）。
   * 法令XMLは savedAt で照合していたのに、注釈の方は見ていなかった。
   * 指紋を控えて、書く直前に突き合わせる。
   */
  const notes = [...state.notes.values()];
  const ranges = [...state.ranges.values()];
  const plan = planVersionMigration({
    fromBodies: from.bodies, toBodies: to.bodies,
    fromScopes: from.scopes, toScopes: to.scopes,
    fromDisp: from.disp, toDisp: to.disp,
    notes, ranges,
    fromLawId, toLawId,
  });

  vm = {
    mode: 'copy',
    fromLawId, toLawId, from, to, plan, picks: defaultPicks(plan),
    stamp: vmNoteStamp(notes, ranges, fromLawId),
  };
  renderVersionPlan();
}

/*
 * この版に付いている注釈の指紋。計画を立てたときと、書く直前で比べる。
 *
 * 版（version）は保存のたびに必ず進むので、中身を全部並べる必要はない。
 * 候補（alts）の数も入れる。同期で候補が増えても、見せた内容とは違う。
 *
 * 渡すのは state と同じふるい（読めない形のものを外したもの）を通した
 * 一覧にする。片方だけ素のDBにすると、読めない記録が1つ残っている人は
 * いつまでも「変わっています」になって、一度も写せなくなる。
 */
function vmNoteStamp(notes, ranges, lawId) {
  const vv = v => Object.keys(v || {}).sort().map(k => k + '=' + v[k]).join(',');
  const out = [];
  for (const n of notes || []) {
    if (n.lawId !== lawId || isTomb(n)) continue;
    out.push('n\t' + n.key + '\t' + vv(n.version) + '\t' + (n.alts || []).length);
  }
  for (const r of ranges || []) {
    if (r.lawId !== lawId || isTomb(r)) continue;
    out.push('r\t' + r.id + '\t' + vv(r.version) + '\t' + (r.alts || []).length);
  }
  return out.sort().join('\n');
}

/** 件数の要約と一覧を描く。選択を変えるたびに要約だけ描き直す。 */
function renderVersionPlan() {
  if (!vm) return;
  const fromLaw = state.laws.find(l => l.lawId === vm.fromLawId);
  const toLaw = state.laws.find(l => l.lawId === vm.toLawId);
  const lead = $('#vmig-lead');
  if (vm.mode === 'swap') {
    $('#vmig-law').textContent = (fromLaw ? fromLaw.lawTitle : vm.fromLawId);
    lead.hidden = false;
    lead.innerHTML = '<p class="hint" style="margin:0 0 10px">'
      + 'この法令の本文を、<strong>' + esc(vm.swap.enforcedOn) + ' 施行</strong>の版に'
      + '差し替えます。注釈はこの法令に付いたまま、新しい本文の正しい位置へ動きます。'
      + '<br>いまの本文は<strong>' + esc(vm.swap.keptTitle) + '</strong>として手元に残り、'
      + '行き先が決まらなかった注釈はそちらへ移します（消しません）。'
      + '<br>この入れ替えは、あとで取り消せます。</p>';
  } else {
    $('#vmig-law').textContent = (fromLaw ? fromLaw.lawTitle : vm.fromLawId)
      + ' → ' + (toLaw ? toLaw.lawTitle : vm.toLawId);
    lead.hidden = true;
    lead.innerHTML = '';
  }

  renderVersionSummary();

  const list = $('#vmig-list');
  list.innerHTML = '';
  if (!vm.plan.items.length) {
    list.innerHTML = vm.mode === 'swap'
      ? '<p class="hint">この法令に注釈はありません。本文の差し替えだけを行います。</p>'
      : '<p class="hint">この版に写せる注釈がありません。</p>';
    return;
  }
  for (const it of vm.plan.items) list.appendChild(vmRow(it));
}

function renderVersionSummary() {
  const c = vm.plan.counts;
  const parts = [];
  for (const [kind, k] of Object.entries(VM_KINDS)) {
    if (c[kind]) parts.push(k.label + ' ' + c[kind]);
  }
  const picked = [...vm.picks.values()].filter(Boolean).length;
  const total = vm.plan.items.length;
  const swap = vm.mode === 'swap';
  $('#vmig-sum').innerHTML = '<div class="vmig-counts">' + esc(parts.join('　/　')) + '</div>'
    + (swap
      ? '<div class="vmig-picked">新しい本文へ動かす <b>' + picked + '</b> 件'
        + ' / 退避させた版へ移す <b>' + (total - picked) + '</b> 件</div>'
      : '<div class="vmig-picked">写すもの <b>' + picked + '</b> 件'
        + '（全 ' + total + ' 件）</div>');
  $('#vmig-go').hidden = false;
  /*
   * 走っている最中は押せない（選択を変えても戻さない）。
   *
   * 入れ替えは1件も選ばれていなくても押せる。本文の差し替えそのものが
   * 目的で、注釈は全部が退避先へ移るだけである。写しは「写すものが無い」
   * なら何も起きないので押せない。
   */
  $('#vmig-go').disabled = vmBusy || (!swap && picked === 0);
  $('#vmig-go').textContent = swap
    ? '入れ替える' + (total ? '（動かす ' + picked + '件）' : '')
    : picked ? '写す（' + picked + '件）' : '写す';
}

/*
 * 1件ぶんの行。
 *
 * 判定によって選び方が変わる。
 *   same / moved    写し先が決まっている。チェックで入れ外しする（既定は入る）
 *   changed         写し先はあるが本文が違う。チェックは外してある
 *   ambiguous       候補から選ぶ。選ぶまで写さない
 *   gone / unknown  写し先が無い。選べない
 */
function vmRow(it) {
  const k = VM_KINDS[it.kind] || { label: it.kind, why: '', pickable: false };
  const li = document.createElement('div');
  li.className = 'vmig-row k-' + it.kind;

  const to = vm.picks.get(it.anchor) || '';
  const head = `<div class="vmig-head">`
    + `<span class="vmig-anchor">${esc(anchorLabel(it.anchor))}</span>`
    + `<span class="vmig-kind">${esc(k.label)}</span></div>`;

  // 注釈の中身。何を写すのかが分からないと選べない
  const body = [];
  for (const n of it.notes) {
    const bits = [];
    if (n.tags && n.tags.length) bits.push('タグ: ' + n.tags.join('、'));
    if (n.color) bits.push('色: ' + n.color);
    if (n.summary) bits.push('前メモ: ' + n.summary);
    if (n.memo) bits.push('メモ: ' + n.memo.replace(/\s+/g, ' ').slice(0, 60));
    body.push('<div class="vmig-what">' + esc(bits.join('　') || '（中身なし）') + '</div>');
  }
  for (const g of it.ranges) {
    body.push('<div class="vmig-what">'
      + esc('文言「' + g.rec.text + '」'
        + (g.rec.memo ? '　' + g.rec.memo.replace(/\s+/g, ' ').slice(0, 40) : ''))
      + '</div>');
  }

  li.innerHTML = head
    + `<div class="vmig-why">${esc(k.why)}</div>`
    + body.join('')
    + '<div class="vmig-pick"></div>'
    + '<div class="vmig-ranges"></div>';

  const pick = li.querySelector('.vmig-pick');

  if (!k.pickable) {
    pick.innerHTML = '<span class="vmig-none">写せません</span>';
    return li;
  }

  if (it.kind === 'ambiguous') {
    /*
     * 候補から選ばせる。既定は「写さない」。
     * 候補が多いときもあるので select にする。
     */
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">写さない</option>'
      + it.cands.map(a => `<option value="${esc(a)}">${esc(anchorLabel(a))} へ写す</option>`).join('');
    sel.value = to;
    sel.onchange = () => {
      if (sel.value) vm.picks.set(it.anchor, sel.value);
      else vm.picks.delete(it.anchor);
      paintVmRanges(li, it);
      renderVersionSummary();
    };
    pick.appendChild(document.createTextNode('写し先: '));
    pick.appendChild(sel);
  } else {
    /*
     * label で input を包むので、id は振らない。
     *
     * 住所から id を作ると、枝番の M/3_2 と M/3/2 が同じ名前になる
     * （記号を _ に替えるため）。使わない id のために衝突を作る必要はない。
     */
    const label = document.createElement('label');
    label.className = 'vmig-check';
    label.innerHTML = `<input type="checkbox"${to ? ' checked' : ''}>`
      + `<span>${esc(anchorLabel(it.to) + ' へ写す')}</span>`;
    const box = label.querySelector('input');
    box.onchange = () => {
      if (box.checked) vm.picks.set(it.anchor, it.to);
      else vm.picks.delete(it.anchor);
      paintVmRanges(li, it);
      renderVersionSummary();
    };
    pick.appendChild(label);
  }

  paintVmRanges(li, it);
  return li;
}

/*
 * 文言注釈の行き先を出す。選択を変えたら数え直す。
 *
 * 計画に載っている判定は、計画を立てたときの写し先についてのものである。
 * 候補から別の先を選んだら、その先で確かめ直さないと「よその先で確かめた
 * 何番目」を見せることになる。確定のときも核が同じ関数で数え直す。
 */
function paintVmRanges(li, it) {
  const box = li.querySelector('.vmig-ranges');
  const to = vm.picks.get(it.anchor) || '';
  if (!it.ranges.length) { box.innerHTML = ''; return; }
  if (!to) {
    box.innerHTML = '<div class="vmig-rmove">文言の行き先は、写し先を決めてから確かめます</div>';
    return;
  }
  const out = [];
  for (const g of it.ranges) {
    const mv = planRangeMove(vm.from.disp.get(it.anchor), vm.to.disp.get(to), g.rec);
    out.push('<div class="vmig-rmove ' + (mv.ok ? 'ok' : 'ng') + '">'
      + esc('文言「' + g.rec.text + '」　'
        + (mv.ok ? '写せます' : '写せません（' + (mv.why || '') + '）'))
      + '</div>');
  }
  box.innerHTML = out.join('');
}

/* ------------------------------------------------------------ 段3：確定 */

async function doVersionCopy() {
  if (!vm || vmBusy) return;
  const picked = [...vm.picks.values()].filter(Boolean).length;
  if (!picked) { toast('写すものを選んでください'); return; }

  const toLaw = state.laws.find(l => l.lawId === vm.toLawId);
  if (!confirm('注釈 ' + picked + '件を「'
    + ((toLaw && toLaw.lawTitle) || vm.toLawId) + '」へ写します。'
    + '\n\nこの版の注釈はそのまま残ります。写したあとで取り消せます。'
    + '\nよろしいですか？')) return;

  /*
   * 走るのは一度に一つ。待っている間に開き直されたら中止する。
   *
   * 計画そのもの（job）と印（token）を掴んでおく。掴まずに vm を見続けると、
   * 待っている間に別の版の計画に入れ替わっていても気づけない。
   */
  const job = vm;
  const token = vmToken;
  vmSetBusy(true);
  try {
    /*
     * 書きかけのメモを先に確定させる。保存できなければ進まない。
     *
     * 前は await するだけで戻り値を見ていなかった。写した注釈を直して保存が
     * 失敗していても、そのまま写し・取り消しへ進んでいた（Codex の指摘2）。
     */
    if (!(await flushSave()) || !savesAreClean()) {
      toast('保存できていない編集があります'
        + (unsavedCount() ? '（' + unsavedCount() + '件）' : '')
        + '。保存できてからもう一度どうぞ');
      return;
    }
    if (token !== vmToken || vm !== job) return;      // 開き直された

    /*
     * 元データを確かめ直す。
     *
     * 画面を開いてから法令を取り込み直されていたら、計画はもう古い。そのまま
     * 書くと、一度も見ていない本文へ写すことになる。注釈も、別の端末から
     * 同期で届いているかもしれないので読み直す（核が nowNotes で使う）。
     *
     * 4つを一度に読む。ここから applyBulk までの間に await を挟まない。
     * 挟むと、その隙に入った編集を見ないまま書くことになる。読んでいる間に
     * 書かれた場合は localWrites が動くので、読み直す（同期と同じ守り）。
     */
    /*
     * 4つを1つのトランザクションで読む。
     *
     * 前は Promise.all で別々に読んでいた。その隙に同期の書き込みが
     * 挟まると、片方が書き込みの前・片方が後の中身になり、指紋の照合も
     * 通ってしまう（同期は localWrites を動かさない。Codex の指摘5）。
     * 写しも入れ替えも同じ穴だったので、同じ読みに載せる。
     */
    let fromRec, toRec, nowNotes, nowRanges;
    for (let tries = 0; ; tries++) {
      const before = localWrites;
      try {
        const got = await store.readForMigration([job.fromLawId, job.toLawId]);
        fromRec = got.laws[0];
        toRec = got.laws[1];
        nowNotes = got.notes;
        nowRanges = got.ranges;
      } catch (e) {
        toast('読み直せませんでした（何も変えていません）: ' + e.message);
        return;
      }
      if (localWrites === before) break;
      if (tries >= 2) {
        toast('編集中のため写せません。少し待ってからもう一度どうぞ');
        return;
      }
    }
    if (token !== vmToken || vm !== job) return;

    if (!fromRec || !toRec) {
      toast('法令が見つかりません（何も変えていません）');
      return;
    }
    if ((fromRec.savedAt || 0) !== job.from.savedAt
      || (toRec.savedAt || 0) !== job.to.savedAt) {
      toast('法令が取り込み直されています。もう一度調べます');
      await showVersionPlan(job.fromLawId, job.toLawId);
      return;
    }
    /*
     * 写す中身は計画に載っているものである。元の注釈が変わっていたら、
     * 古い内容を写すことになるので書かずに作り直す（Codex の指摘5）。
     */
    const stamp = vmNoteStamp(
      nowNotes.filter(n => !noteProblem(n, true)),
      nowRanges.filter(r => !rangeProblem(r, true)), job.fromLawId);
    if (stamp !== job.stamp) {
      toast('この版の注釈が変わっています。もう一度調べます');
      await showVersionPlan(job.fromLawId, job.toLawId);
      return;
    }

    const now = Date.now();
    const built = buildVersionCopies({
      plan: job.plan, picks: job.picks,
      nowNotes, nowRanges,
      fromDisp: job.from.disp, toDisp: job.to.disp,
      toLawId: job.toLawId, deviceId, now,
    });

    if (!built.notes.length && !built.ranges.length) {
      vmShowResult(built, null);
      return;
    }

    /*
     * 控えも同じトランザクションで確定する。別に書くと、写したのに控えが無い
     * （取り消せない）、あるいは控えだけある状態が残る。
     */
    const last = {
      op: built.op, fromLawId: job.fromLawId, toLawId: job.toLawId,
      at: now, notes: built.notes.length, ranges: built.ranges.length,
    };
    try {
      await store.applyBulk({
        notes: built.notes, ranges: built.ranges, meta: { [VM_LAST_KEY]: last },
        local: true,            // 同期の読み取り中なら、やり直させる
        /*
         * 写しも、書く直前にトランザクションの中で検める。
         *
         * 読み直した本文は確かめていたが、**書き込みに expect を渡して
         * いなかった。** 読んだあとに別のタブが写し先へ注釈を作ると、
         * 「空いていた」という古い判断で上書きできた（Codex の2回目の
         * 指摘3）。入れ替えと同じ守りに揃える。
         */
        expect: {
          laws: [
            { lawId: job.fromLawId, savedAt: job.from.savedAt },
            { lawId: job.toLawId, savedAt: job.to.savedAt },
          ],
          ...expectFor(nowNotes, nowRanges, [job.fromLawId, job.toLawId], built),
        },
      });
    } catch (e) {
      toast('写せませんでした（何も変えていません）: ' + e.message);
      return;
    }

    await vmRefresh();
    vmShowResult(built, last);
  } finally {
    vmSetBusy(false);
  }
}

/** 写したあとの画面。飛ばしたものは理由を添えて出す。 */
function vmShowResult(built, last) {
  vmStep(3);
  const head = built.notes.length || built.ranges.length
    ? '注釈 ' + built.notes.length + '件 / 文言 ' + built.ranges.length + '件 を写しました'
    : '写したものはありません';
  const out = ['<div class="vmig-done">' + esc(head) + '</div>'];

  if (built.skipped.length) {
    out.push('<div class="sub-head">写さなかったもの　' + built.skipped.length + '件</div>');
    for (const s of built.skipped) {
      out.push('<div class="vmig-skip">'
        + esc(anchorLabel(s.anchor) + (s.to ? ' → ' + anchorLabel(s.to) : '')
          + (s.text ? '　「' + s.text + '」' : '') + '　' + s.why)
        + '</div>');
    }
  }
  $('#vmig-result').innerHTML = out.join('');

  /*
   * 取り消しのボタン。控えが無いときは繋いだものを外す。
   * 隠すだけにすると、前の回の控えを掴んだままの押し方が残る。
   */
  const undo = $('#vmig-result-undo');
  undo.hidden = !last;
  // 入れ替えの結果画面と同じボタンを使う。文言を戻さないと前の操作の名前が残る
  undo.textContent = 'この写しを取り消す';
  undo.onclick = last ? () => undoVersionCopy(last) : null;
}

/* ------------------------------------------------------------ 取り消し */

/*
 * 写したものを取り消す。
 *
 * 消すのではなく墓石にする。本当に消すと、他の端末から同期で戻ってくる。
 * 写したあとで手を入れたものは核が外す（直した中身まで消すのは、
 * 利用者の仕事を捨てることになる）。
 */
async function undoVersionCopy(last) {
  if (!last || !last.op || vmBusy) return;
  if (!confirm('この写しを取り消します。'
    + '\n\n写したあとで直したものは残します。よろしいですか？')) return;

  vmSetBusy(true);
  try {
    /*
     * 保存できていない編集があるなら進まない。
     *
     * ここを見ていなかったので、写した注釈を直して保存が失敗していても
     * 取り消しが進み、直した中身ごと墓石にしていた（Codex の指摘2）。
     * 「写したあとで直したものは残す」という約束は、DBに入っているものしか
     * 守れない。核は読み直した版で判断するので、入っていない編集は
     * 「直していない」ものとして消される。
     */
    if (!(await flushSave()) || !savesAreClean()) {
      toast('保存できていない編集があります'
        + (unsavedCount() ? '（' + unsavedCount() + '件）' : '')
        + '。保存できてからもう一度どうぞ');
      return;
    }

    // 読んでいる間に書かれたら読み直す。写す側と同じ理由（Codex の指摘1）
    let notes, ranges;
    for (let tries = 0; ; tries++) {
      const before = localWrites;
      try {
        [notes, ranges] = await Promise.all([store.allNotes(), store.allRanges()]);
      } catch (e) {
        toast('読み直せませんでした（何も変えていません）: ' + e.message);
        return;
      }
      if (localWrites === before) break;
      if (tries >= 2) {
        toast('編集中のため取り消せません。少し待ってからもう一度どうぞ');
        return;
      }
    }

    const plan = planVersionUndo({
      notes, ranges,
      fromLawId: last.fromLawId, toLawId: last.toLawId,
      deviceId, now: Date.now(), op: last.op,
    });

    if (!plan.notes.length && !plan.ranges.length) {
      toast(plan.kept.length
        ? '取り消せるものがありません（' + plan.kept.length + '件は写したあとに直されています）'
        : '取り消せるものがありません');
      return;
    }

    try {
      await store.applyBulk({
        notes: plan.notes, ranges: plan.ranges, meta: { [VM_LAST_KEY]: null },
        local: true,            // 同期が読んでいる最中なら、やり直させる
      });
    } catch (e) {
      toast('取り消せませんでした（何も変えていません）: ' + e.message);
      return;
    }

    await vmRefresh();
    toast('注釈 ' + plan.notes.length + '件 / 文言 ' + plan.ranges.length + '件 を取り消しました'
      + (plan.kept.length ? '（写したあとに直された ' + plan.kept.length + '件は残しました）' : ''));

    // 控えは使い切った。箱を消して、結果の画面からも取り消しボタンを外す
    await paintVersionUndoBox();
    $('#vmig-result-undo').hidden = true;
    if (vm) {
      /*
       * 計画は作り直す。取り消しで写し先の注釈が減ったので、「写し先にすでに
       * 注釈があります」だった行が写せるようになっている。
       */
      await showVersionPlan(vm.fromLawId, vm.toLawId);
    }
  } finally {
    vmSetBusy(false);
  }
}

/* ------------------------------------------ 版をその場で入れ替える（画面） */

/*
 * 元の法令の本文を、e-Gov のいま効いている版に差し替える。
 *
 * なぜこれが要るのか。元の法令（`323AC0000000131` のような e-Gov の法令ID）は
 * 「名前は固定、中身は動く」ものである。改正が施行されれば、同じIDの先にある
 * 本文が入れ替わる。ところがこのアプリには、取り込んだあとに本文だけを
 * 取り直す道が無かった。あるのは「版を選ぶ」（別の固定版として増やす）だけで、
 * 元の法令はいつまでも取り込んだ日の本文のままだった。
 *
 * 作った日には、それで正しかった。元の法令はいつも最新だったからである。
 * 時間が経つと前提が逆さまになり、「注釈の付いている側が古い」という形に
 * なった。改正前の注釈を改正後へ持っていけない、という詰まりはここから出た。
 *
 * 差し替えるときの約束は3つ。
 *
 *   ・いまの本文を捨てない。固定版として手元に残す（読み返しと取り消しに使う）
 *   ・注釈を黙って見えなくしない。行き先が決まらないものは残した固定版へ移す
 *   ・どの版に差し替えたかを記録する。次の改正で「新しい版が出ています」と
 *     言えるようになる（古い記録は版IDも施行日も持たないので言えなかった）
 */
async function openVersionSwap(lawId) {
  const rec = state.laws.find(l => l.lawId === lawId);
  if (!rec) { toast('法令が見つかりません'); return; }
  if (rec.revisionOf) {
    toast('固定した版は入れ替えません（その版として固定したものです）');
    return;
  }
  if (lawOrigin(rec) !== 'egov') {
    toast(lawOrigin(rec) === 'pack'
      ? '規則パックのものは、パックの一覧から新しい版を取り込みます'
      : '取り込んだファイルは e-Gov に無いので、新しい版を取れません');
    return;
  }

  vm = null;
  const token = ++vmToken;
  $('#vmig-law').textContent = rec.lawTitle;
  $('#vmig-lead').hidden = true;
  $('#vmig-lead').innerHTML = '';
  $('#vmig-sum').innerHTML = '<p class="hint">e-Gov に新しい版を問い合わせています…</p>';
  $('#vmig-list').innerHTML = '';
  $('#vmig-go').hidden = true;
  vmStep(2);
  $('#vmig-back').hidden = true;
  if (!$('#dlg-vmig').open) $('#dlg-vmig').showModal();

  const stop = msg => {
    if (token !== vmToken) return;
    $('#vmig-sum').innerHTML = '<p class="hint">' + esc(msg) + '</p>';
    $('#vmig-list').innerHTML = '';
    $('#vmig-go').hidden = true;
  };

  let revs;
  try { revs = await apiRevisions(lawId); } catch (e) { stop(e.message); return; }
  if (token !== vmToken) return;

  /*
   * いま効いている版＝施行日が今日までのうち一番新しいもの。
   * 未施行の版には差し替えない。差し替えると、いま効いている条文が
   * 手元から消える（圏外では取り直せない）。未施行を読みたいときは
   * 「版を選ぶ」で別の固定版として増やす道が元からある。
   */
  const now = today();
  const enforced = (revs || [])
    .filter(r => r.amendment_enforcement_date && r.amendment_enforcement_date <= now);

  /*
   * どの版に差し替えるかは、**並べ替えの末尾で決めてはいけない。**
   *
   * 同じ施行日の版が複数ある法令がある（児童福祉法は 2026-10-01 に2版、
   * 2024-04-01 には6版）。末尾を取ると、現行ではない方を掴んで本文を
   * 上書きしかねない。ここは**取ったものがそのまま本文になる**ので、
   * 表示の誤りでは済まない。
   *
   * 検索APIが現行として返す版を正とし、取れなければ施行日の一番新しい版に
   * 落とす。落としたうえでその日に版が複数あるなら、どれか分からないので
   * 進めずに断る。黙って別の版を書くより、できないと言う方がよい。
   */
  const latestDate = latestEnforcedDate(enforced);
  if (!latestDate) { stop('施行済みの版が見つかりませんでした。'); return; }
  const atLatest = enforced.filter(r => r.amendment_enforcement_date === latestDate);

  let latest = null;
  try {
    const cur = await apiCurrentRevision(lawId);
    if (cur) latest = enforced.find(r => r.law_revision_id === cur.law_revision_id) || cur;
  } catch (e) { /* 取れなければ下に落とす */ }
  if (token !== vmToken) return;
  if (!latest) {
    /*
     * 落とし先が一意だと言えるのは、**日付の無い版が1つも無いとき**に限る。
     *
     * 施行日を持たない版を外してから数えているので、「その日に1つだけ」でも
     * 日付不明の版が現行である見込みを消せない（Codex の指摘4）。本文を
     * 書き替える操作なので、少しでも分からなければ進めない。
     */
    const undated = (revs || []).filter(r => !r.amendment_enforcement_date).length;
    if (atLatest.length > 1 || undated) {
      stop('どの版がいま効いているのかを確かめられませんでした。'
        + '通信できるときに、もう一度お試しください。');
      return;
    }
    latest = atLatest[0];
  }
  if (rec.lawRevisionId && rec.lawRevisionId === latest.law_revision_id) {
    stop('いま手元にあるのが最新の版です（' + latest.amendment_enforcement_date + ' 施行）。');
    return;
  }

  $('#vmig-sum').innerHTML = '<p class="hint">'
    + esc(latest.amendment_enforcement_date + ' 施行の版を取っています…') + '</p>';

  let xml;
  try { xml = await apiFetchLaw(latest.law_revision_id); } catch (e) { stop(e.message); return; }
  if (token !== vmToken) return;

  /*
   * 版IDを持たない古い記録では、新しいかどうかを版IDで決められない。
   * 本文を突き合わせる。同じなら差し替える意味がないので、そう言って
   * 版IDだけを書き足す（次からは版IDで判定できる）。
   *
   * **本文はデータベースから読む。** rec は state.laws の見出しで、xml を
   * 持たない（store.allLawMeta が落としている）。前は rec.xml と比べて
   * いたので、この枝には一度も入らなかった（Codex の指摘7）。
   *
   * そして、ここを素直に直すだけでは**法令が開けなくなる。**
   * putLawAndMeta は渡した記録をそのまま本文の棚に書くので、xml を持たない
   * 見出しを渡すと本文が消える。届かない枝だったから助かっていた。
   * 読んだ記録そのものを下敷きにして書く。
   */
  let full = null;
  try { full = await store.getLaw(lawId); } catch (e) { /* 読めなければ突き合わせない */ }
  if (token !== vmToken) return;
  if (full && full.xml && xml === full.xml) {
    try {
      await store.putLaw({ ...full,
        lawRevisionId: latest.law_revision_id,
        enforcementDate: latest.amendment_enforcement_date,
        importedAt: today(),
        savedAt: Date.now() });
      delete amendState[lawId];
      saveAmendState();
      await refreshLawList();
    } catch (e) { /* 書けなくても読むのに差し支えない */ }
    stop('手元の本文は ' + latest.amendment_enforcement_date
      + ' 施行の版と同じでした。差し替えるものはありません。');
    return;
  }

  await showSwapPlan(lawId, xml, latest);
}

/*
 * 書き込みのときに検めてもらう指紋を組む。
 *
 * 法令の savedAt だけを検めても、**別のタブが注釈だけを直した場合は通って
 * しまう**（本文は変わらないので。Codex の2回目の指摘3）。読み直したときの
 * 中身から、これから触る鍵の指紋を作って applyBulk に渡す。
 *
 *   lawIds  その法令に付いている注釈を全部入れる（元の住所になりうる）
 *   built   これから書くもの（行き先の住所になりうる）
 */
function expectFor(nowNotes, nowRanges, lawIds, built) {
  const fp = r => !r ? '' : (isTomb(r) ? 't:' : 'l:') + vvKey(r.version);
  const nm = new Map((nowNotes || []).filter(n => n && n.key).map(n => [n.key, n]));
  const rm = new Map((nowRanges || []).filter(r => r && r.id).map(r => [r.id, r]));
  const ids = new Set((lawIds || []).filter(Boolean));
  const nk = new Set();
  const rk = new Set();
  for (const n of nowNotes || []) if (n && ids.has(n.lawId)) nk.add(n.key);
  for (const r of nowRanges || []) if (r && ids.has(r.lawId)) rk.add(r.id);
  for (const n of (built && built.notes) || []) if (n && n.key) nk.add(n.key);
  for (const r of (built && built.ranges) || []) if (r && r.id) rk.add(r.id);
  return {
    notes: [...nk].map(k => [k, fp(nm.get(k))]),
    ranges: [...rk].map(i => [i, fp(rm.get(i))]),
  };
}

/*
 * 差し替えたあとに残す固定版の住所。
 *
 * **端末の印を混ぜる。** 法令の本文は同期で運ばない（運ぶのは目録だけ）ので、
 * 他の端末が同じ日に入れ替えると、その端末の `base@kept-<同じ日付>` に
 * 付いた注釈だけが同期で届き、本文はこちらに無い状態になる。すると
 * `state.laws` を見るだけでは「空いている」と判断して同じ住所を選び、
 * 届いた注釈の上に書いてしまう（Codex の指摘7）。
 *
 * 日付は名前に使う（「2026-10-18 時点の本文」）。住所は人が読むものでは
 * ないので、一意であることを優先する。
 *
 * 空いているかは、法令だけでなく**注釈の住所**も見る。本文が無くても
 * 注釈だけが居ることがあるのが、まさにこの穴だった。
 */
function keptLawIdFor(base, stamp) {
  const tail = String(typeof deviceId === 'string' ? deviceId : '')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 6)
    || Math.random().toString(16).slice(2, 8);
  const taken = id => state.laws.some(l => l.lawId === id)
    || [...state.notes.values()].some(n => n.lawId === id)
    || [...state.ranges.values()].some(r => r.lawId === id);
  const head = base + '@kept-' + stamp + '-' + tail;
  if (!taken(head)) return head;
  for (let i = 2; i < 100; i++) {
    const id = head + '-' + i;
    if (!taken(id)) return id;
  }
  throw new Error('退避させる版の住所を決められませんでした');
}

/*
 * 差し替えの計画を立てる。写しと同じ画面・同じ判定を使う。
 *
 * 突き合わせる相手はまだ保存していないXMLなので、材料は
 * versionMaterialsFromXml から作る（保存してから比べると、失敗したときに
 * 新しい本文だけが入った状態が残る）。
 */
async function showSwapPlan(lawId, xml, rev) {
  const token = ++vmToken;
  const rec = state.laws.find(l => l.lawId === lawId);
  vmStep(2);
  $('#vmig-back').hidden = true;
  $('#vmig-sum').innerHTML = '<p class="hint">両方の本文を読んで、突き合わせています…</p>';
  $('#vmig-list').innerHTML = '';
  $('#vmig-go').hidden = true;

  let from, to;
  try {
    from = await versionMaterials(lawId);
    to = versionMaterialsFromXml(xml, '新しい版');
  } catch (e) {
    if (token !== vmToken) return;
    $('#vmig-sum').innerHTML = '<p class="hint">'
      + esc('調べられませんでした: ' + e.message) + '</p>';
    return;
  }
  if (token !== vmToken) return;
  if (!to.index.length) {
    $('#vmig-sum').innerHTML = '<p class="hint">'
      + '新しい版から条文を1件も読み取れませんでした。差し替えません。</p>';
    return;
  }

  // 新しい本文で住所の重なりを数え直す。取り込みと同じ検め方
  const seen = new Map();
  for (const e of to.index) seen.set(e.anchor, (seen.get(e.anchor) || 0) + 1);
  const dupAnchors = [...seen].filter(([, k]) => k > 1).map(([a]) => a);

  const notes = [...state.notes.values()];
  const ranges = [...state.ranges.values()];
  const plan = planVersionMigration({
    fromBodies: from.bodies, toBodies: to.bodies,
    fromScopes: from.scopes, toScopes: to.scopes,
    fromDisp: from.disp, toDisp: to.disp,
    notes, ranges,
    fromLawId: lawId, toLawId: lawId,
  });

  /*
   * 別々に直された注釈（候補を抱えたもの）があるなら、入れ替えを出さない。
   *
   * 一度は「候補を連れていく」ようにしたが、それは失うより悪い直し方だった。
   * 候補は元の `key / lawId / anchor` を持つレコードで、resolveConflict は
   * 選んだ候補をそのまま展開する。だから移した先で「これを採る」を押すと
   * **元の住所へ書き戻る**（Codex の2回目の指摘1）。
   *
   * 先に解決してもらう。どこにあるかを出さないと探せないので、住所を並べる。
   */
  const conflicted = [];
  for (const it of plan.items) {
    for (const n of it.notes) if (hasConflict(n)) conflicted.push(it.anchor);
    for (const g of it.ranges) {
      if (hasConflict(g.rec)) conflicted.push(it.anchor + '「' + (g.rec.text || '') + '」');
    }
  }
  if (conflicted.length) {
    $('#vmig-sum').innerHTML = '<p class="hint">'
      + '<strong>別々に直された注釈が ' + conflicted.length + '件あります。</strong>'
      + 'どちらを採るかを先に選んでください。選ばないまま本文を入れ替えると、'
      + '候補の行き先が決められません。</p>'
      + '<p class="hint">' + esc(conflicted.slice(0, 20)
        .map(a => anchorLabel(String(a).split('「')[0])
          + (String(a).includes('「') ? '「' + String(a).split('「')[1] : '')).join('　'))
      + (conflicted.length > 20 ? ' ほか' : '') + '</p>';
    $('#vmig-list').innerHTML = '';
    $('#vmig-go').hidden = true;
    return;
  }

  /*
   * 退避させる版の名前。**分かっていることだけを書く。**
   *
   * 「どの版か」は書けない。版IDを持たない記録では、取り込んだ日の時点で
   * e-Gov が何を返したかしか分からない（「2026-08-01 施行」とは書けない）。
   *
   * 「いつの本文か」も書けない。一度そう書いたが、嘘をついた。
   *
   *   入れ替える → 取り消す → もう一度入れ替える
   *   取り消しで savedAt が「いま」になるので、2回目の退避版が
   *   「2026-10-24 時点の本文」と名乗った。中身は 2026-10-18 の本文である
   *
   * 確実に分かるのは**どの改正より前か**である。差し替える相手の施行日が
   * 分かっているので、この本文はそれより前のものだと言い切れる。取り込んだ
   * 日は、記録が持っているときだけ添える（savedAt では代用しない）。
   */
  const got = rec.importedAt || '';
  const baseTitle = rec.baseTitle || rec.lawTitle || '';
  const when = rev.amendment_enforcement_date || '';

  /*
   * 「その施行の改正より前」と名乗れるのは、**退避する本文がその日より
   * 前のものだと分かるとき**に限る。
   *
   * 同じ日に施行された別の版へ入れ替えることがある（児童福祉法は
   * 2026-10-01 に2版ある）。そのとき手元の本文もその日のものなので、
   * 「より前」は嘘になる（Codex の指摘6）。分からないときは
   * 「入れ替え前の本文」と、確実なことだけを言う。
   */
  const mineWhen = rec.enforcementDate || '';
  const before = !!when && (!mineWhen || mineWhen < when);
  const keptTitle = baseTitle + '（'
    + (before ? when + ' 施行の改正より前の本文' : '入れ替え前の本文')
    + (got ? '。' + got + ' 取り込み' : '') + '）';
  /* 住所に使う日付。取り込んだ日が分かればそれ、分からなければ退避した日 */
  const stamp = got || today();

  vm = {
    mode: 'swap',
    fromLawId: lawId, toLawId: lawId, from, to, plan,
    picks: defaultPicks(plan),
    stamp: vmNoteStamp(notes, ranges, lawId),
    swap: {
      xml, dupAnchors,
      rev: rev.law_revision_id || '',
      enforcedOn: rev.amendment_enforcement_date || '',
      amendTitle: rev.amendment_law_title || '',
      keptLawId: keptLawIdFor(lawId, stamp),
      keptTitle, keptStamp: stamp,
    },
  };
  renderVersionPlan();
}

/*
 * 差し替えを確定する。
 *
 * 書くのは1つのトランザクションの中で5つ。
 *
 *   1  いまの本文を固定版として保存する
 *   2  元の法令の本文を新しいものに差し替える（版IDと施行日も書く）
 *   3  注釈を新しい本文の住所へ動かす（墓石＋新規）
 *   4  行き先が決まらなかった注釈を、1 の固定版へ移す
 *   5  取り消し用の控えを残す
 *
 * 分けて書くと、本文だけ新しくなって注釈が古い住所に残る状態があり得る。
 * その状態では注釈が画面のどこにも出ないので、途中で失敗したことに
 * 気づけない。全部入るか、何も入らないかにする。
 */
async function doVersionSwap() {
  if (!vm || vm.mode !== 'swap' || vmBusy) return;
  const job = vm;
  const token = vmToken;
  const total = job.plan.items.length;
  const picked = [...job.picks.values()].filter(Boolean).length;

  if (!confirm('「' + ((state.laws.find(l => l.lawId === job.fromLawId) || {}).lawTitle
      || job.fromLawId) + '」の本文を '
    + job.swap.enforcedOn + ' 施行の版に差し替えます。'
    + '\n\n　新しい本文へ動かす注釈　' + picked + '件'
    + '\n　退避させた版へ移す注釈　' + (total - picked) + '件'
    + '\n　いまの本文は「' + job.swap.keptTitle + '」として残します'
    + '\n\nあとで取り消せます。よろしいですか？')) return;

  vmSetBusy(true);
  try {
    // 書きかけのメモを先に確定させる。保存できなければ進まない（写しと同じ）
    if (!(await flushSave()) || !savesAreClean()) {
      toast('保存できていない編集があります'
        + (unsavedCount() ? '（' + unsavedCount() + '件）' : '')
        + '。保存できてからもう一度どうぞ');
      return;
    }
    if (token !== vmToken || vm !== job) return;

    /*
     * 法令と注釈を1つのトランザクションで読む。
     *
     * 別々に読むと、その隙に同期の書き込みが挟まりうる。同期は
     * applyBulk に local を渡さないので localWrites が動かず、下の
     * 読み直しでも気づけない（Codex の指摘5）。1回で読めば隙が無い。
     *
     * localWrites の見張りは残す。こちらは「人が編集中かどうか」を見る
     * もので、トランザクションの外で起きる保存を拾う。
     */
    let rec, nowNotes, nowRanges;
    for (let tries = 0; ; tries++) {
      const before = localWrites;
      try {
        const got = await store.readForMigration([job.fromLawId]);
        rec = got.laws[0];
        nowNotes = got.notes;
        nowRanges = got.ranges;
      } catch (e) {
        toast('読み直せませんでした（何も変えていません）: ' + e.message);
        return;
      }
      if (localWrites === before) break;
      if (tries >= 2) {
        toast('編集中のため入れ替えられません。少し待ってからもう一度どうぞ');
        return;
      }
    }
    if (token !== vmToken || vm !== job) return;

    if (!rec) { toast('法令が見つかりません（何も変えていません）'); return; }
    if ((rec.savedAt || 0) !== job.from.savedAt) {
      toast('法令が取り込み直されています。もう一度調べます');
      await openVersionSwap(job.fromLawId);
      return;
    }
    const stamp = vmNoteStamp(
      nowNotes.filter(n => !noteProblem(n, true)),
      nowRanges.filter(r => !rangeProblem(r, true)), job.fromLawId);
    if (stamp !== job.stamp) {
      toast('この法令の注釈が変わっています。もう一度調べます');
      await openVersionSwap(job.fromLawId);
      return;
    }
    /*
     * 退避先の住所が、調べている間に埋まっていないか。
     * 法令だけでなく、読み直した注釈の住所も見る（本文が無くても注釈だけが
     * 同期で届いていることがある。Codex の指摘7）。
     */
    if (state.laws.some(l => l.lawId === job.swap.keptLawId)
      || nowNotes.some(n => n && n.lawId === job.swap.keptLawId && !isTomb(n))
      || nowRanges.some(r => r && r.lawId === job.swap.keptLawId && !isTomb(r))) {
      toast('退避させる版の住所が使われています。もう一度調べます');
      await openVersionSwap(job.fromLawId);
      return;
    }

    const now = Date.now();
    const built = buildVersionSwap({
      plan: job.plan, picks: job.picks, nowNotes, nowRanges,
      fromDisp: job.from.disp, toDisp: job.to.disp,
      lawId: job.fromLawId, keptLawId: job.swap.keptLawId, deviceId, now,
    });

    /*
     * 退避させる版。いまの記録をそのまま継ぐ（来歴も重なりの印も、
     * この本文についてのものなので正しい）。略称は外す。略称で引けると
     * 本来の法令と紛れる（takeRevision と同じ理由）。
     */
    const kept = { ...rec,
      lawId: job.swap.keptLawId,
      lawTitle: job.swap.keptTitle,
      baseTitle: rec.baseTitle || rec.lawTitle || '',
      abbrev: null,
      revisionOf: job.fromLawId,
      keptFrom: { at: job.swap.keptStamp, op: built.op },
      savedAt: now };
    delete kept.swappedAt;
    delete kept.keptAs;

    /*
     * 差し替えた元の法令。版IDと施行日を書く。
     * ここを書かないと、次の改正で「新しい版が出ています」と言えない
     * （checkAmendment の behind 判定は、版IDか施行日のどちらかを要る）。
     */
    const next = { ...rec,
      xml: job.swap.xml,
      lawRevisionId: job.swap.rev,
      enforcementDate: job.swap.enforcedOn,
      amendLawTitle: job.swap.amendTitle || '',
      dupAnchors: job.swap.dupAnchors,
      importedAt: today(),
      swappedAt: now,
      keptAs: job.swap.keptLawId,
      savedAt: now };

    const last = { kind: 'swap', op: built.op,
      lawId: job.fromLawId, keptLawId: job.swap.keptLawId, at: now,
      moves: built.moves, parked: built.parked, rangeMoves: built.rangeMoves,
      stayed: built.stayed.length,
      /* 本文を戻すときに書き直すもの。空欄と「無い」を区別して持つ */
      prev: { rev: rec.lawRevisionId || '', enforced: rec.enforcementDate || '',
        importedAt: rec.importedAt || '', amendLawTitle: rec.amendLawTitle || '',
        dupAnchors: rec.dupAnchors || [] },
      next: { rev: job.swap.rev, enforced: job.swap.enforcedOn } };

    try {
      await store.applyBulk({
        laws: [kept, next],
        notes: built.notes, ranges: built.ranges,
        meta: { [SWAP_LAST_KEY]: last },
        local: true,
        /*
         * 書く直前にもう一度、トランザクションの中で検める。
         *
         * 上の検査から applyBulk までの間に、別のタブが同じ入れ替えを
         * 終わらせていることがある（Codex の指摘6）。本文が書き換わって
         * いないこと、退避先がまだ空いていることを、中で確かめる。
         */
        expect: {
          laws: [
            { lawId: job.fromLawId, savedAt: rec.savedAt || 0 },
            { lawId: job.swap.keptLawId, absent: true },
          ],
          /*
           * 注釈の指紋も渡す。本文の savedAt だけでは、別のタブが注釈を
           * 直した場合に通ってしまう（Codex の2回目の指摘3）。
           */
          ...expectFor(nowNotes, nowRanges, [job.fromLawId, job.swap.keptLawId], built),
        },
      });
    } catch (e) {
      toast('入れ替えられませんでした（何も変えていません）: ' + e.message);
      return;
    }

    await afterSwapRefresh(job.fromLawId, job.swap.keptLawId);
    vmShowSwapResult(built, last);
  } finally {
    vmSetBusy(false);
  }
}

/*
 * 差し替えたあとの作り直し。
 *
 * 画面に出ている本文は差し替える前のものなので、開き直さないと古い条文の上に
 * 新しい注釈を塗ることになる（住所が違うので、ほとんどが消えて見える）。
 * 索引の写しも捨てる。改正の印も捨てる（前の版についての判定である）。
 */
async function afterSwapRefresh(lawId, keptLawId) {
  state.indexCache.delete(lawId);
  if (keptLawId) state.indexCache.delete(keptLawId);
  delete amendState[lawId];
  saveAmendState();
  await refreshLawList();
  await loadNotes();
  await loadRanges();
  for (const pane of livePanes()) {
    if (pane.current && pane.current.lawId === lawId) {
      await openLaw(lawId, null, pane.el.scrollTop, pane);
    }
  }
  paintNotes();
  paintRanges();
  renderMarkList();
}

/** 差し替えたあとの画面。退避させたものと、動かせなかったものを必ず出す。 */
function vmShowSwapResult(built, last) {
  vmStep(3);
  const out = ['<div class="vmig-done">'
    + esc('本文を ' + (last.next.enforced || '') + ' 施行の版に差し替えました') + '</div>'];
  out.push('<div class="vmig-what">'
    + esc('新しい本文へ動かした注釈　' + built.moves.length + '件'
      + '　/　住所が変わらなかった注釈　' + built.stayed.length + '件'
      + '　/　文言の印　' + built.rangeMoves.length + '件') + '</div>');
  if (built.parked.length) {
    out.push('<div class="sub-head">退避させた版へ移した注釈　'
      + built.parked.length + '件</div>');
    out.push('<div class="vmig-what">'
      + esc('新しい本文に行き先が決まらなかったものです。'
        + '「' + (last.keptLawId ? (state.laws.find(l => l.lawId === last.keptLawId) || {}).lawTitle
          || last.keptLawId : '') + '」を開けば、元の条文と一緒に読めます。')
      + '</div>');
    for (const a of built.parked) {
      out.push('<div class="vmig-skip">' + esc(anchorLabel(a)) + '</div>');
    }
  }
  if (built.skipped.length) {
    out.push('<div class="sub-head">思ったとおりに動かせなかったもの　'
      + built.skipped.length + '件</div>');
    for (const s of built.skipped) {
      out.push('<div class="vmig-skip">'
        + esc(anchorLabel(s.anchor) + (s.to ? ' → ' + anchorLabel(s.to) : '')
          + (s.text ? '　「' + s.text + '」' : '') + '　' + s.why)
        + '</div>');
    }
  }
  $('#vmig-result').innerHTML = out.join('');

  const undo = $('#vmig-result-undo');
  undo.hidden = !last;
  undo.textContent = 'この入れ替えを取り消す';
  undo.onclick = last ? () => undoVersionSwap(last) : null;
}

/*
 * 差し替えを取り消す。本文を戻し、注釈を元の住所へ連れ帰る。
 *
 * 退避させた固定版は消さない。applyBulk は書くことしかできないので、
 * 消すなら別のトランザクションになる。本文と注釈を戻したのに固定版だけ
 * 残る／固定版だけ消えて本文が戻っていない、という半端な状態を作るより、
 * 使われない固定版が1つ残るほうが安全である。要らなければ一覧から消せる。
 */
async function undoVersionSwap(last) {
  if (!last || !last.op || vmBusy) return;

  /*
   * 確認は、読んで計画を立てたあとに出す。
   *
   * 「本文を戻すと画面に出なくなる注釈が何件あるか」は、旧本文を描いて
   * みないと数えられない（Codex の指摘3）。数を言えないまま「よろしい
   * ですか」と聞くのは、聞いていないのと同じである。
   *
   * confirm は JS を止めるので、読み直しと書き込みの間に挟んでも、その
   * 隙に同期や保存が割り込むことはない。
   */
  vmSetBusy(true);
  try {
    if (!(await flushSave()) || !savesAreClean()) {
      toast('保存できていない編集があります'
        + (unsavedCount() ? '（' + unsavedCount() + '件）' : '')
        + '。保存できてからもう一度どうぞ');
      return;
    }

    // 入れ替えと同じ理由で、1つのトランザクションで読む
    let baseRec, keptRec, notes, ranges;
    for (let tries = 0; ; tries++) {
      const before = localWrites;
      try {
        const got = await store.readForMigration([last.lawId, last.keptLawId]);
        baseRec = got.laws[0];
        keptRec = got.laws[1];
        notes = got.notes;
        ranges = got.ranges;
      } catch (e) {
        toast('読み直せませんでした（何も変えていません）: ' + e.message);
        return;
      }
      if (localWrites === before) break;
      if (tries >= 2) {
        toast('編集中のため取り消せません。少し待ってからもう一度どうぞ');
        return;
      }
    }

    if (!baseRec) { toast('元の法令が見つかりません（何も変えていません）'); return; }
    if (!keptRec) {
      toast('退避させた版が見つかりません。本文を戻せないので取り消せません');
      return;
    }
    if ((baseRec.swappedAt || 0) !== last.at) {
      toast('この入れ替えのあとに本文が変わっています。取り消せません');
      return;
    }

    const now = Date.now();
    const plan = planSwapUndo({ notes, ranges, last, deviceId, now });

    /*
     * 戻し先に他人が居るなら、取り消しそのものを断る。
     *
     * 一部だけ戻すと「本文は旧版、注釈は半分新版」という状態が残る。
     * どちらが正しいか誰にも分からなくなるので、全部か何もしないかにする。
     */
    if (plan.blocked.length) {
      const where = plan.blocked.slice(0, 3).map(b => anchorLabel(b.anchor)).join('、');
      toast('取り消せません（何も変えていません）。'
        + '戻す先に、入れ替えのあとで書いた注釈が ' + plan.blocked.length + '件あります'
        + '（' + where + (plan.blocked.length > 3 ? ' ほか' : '') + '）。'
        + 'その注釈を消すか別の場所へ移してから、もう一度どうぞ');
      return;
    }

    /*
     * 本文を戻すと画面に出なくなる注釈を数える。
     *
     * 入れ替えのあと、新しい本文にだけある条文（新設条など）に注釈を
     * 付けていると、旧本文にその住所が無い。消えはしないが、画面の
     * どこにも出なくなる（条項号の注釈には迷子の箱が無い）。
     * 黙って起こさず、数を言って尋ねる（Codex の指摘3）。
     */
    let orphans = [];
    try {
      const old = versionMaterialsFromXml(keptRec.xml, last.keptLawId);
      const has = new Set((old.index || []).map(e => e.anchor));
      const coming = new Set(plan.notes.filter(x => !isTomb(x)).map(x => x.key));
      const going = new Set(plan.notes.filter(x => isTomb(x)).map(x => x.key));
      for (const n of notes) {
        if (isTomb(n) || n.lawId !== last.lawId) continue;
        if (coming.has(n.key) || going.has(n.key)) continue;
        if (!has.has(n.anchor)) orphans.push(n.anchor);
      }
      /*
       * 文言注釈も数える。数えていなかったので、新設条文に文言の印だけを
       * 付けて取り消すと、注意書きが出ないまま画面から消えた
       * （Codex の2回目の指摘6）。
       */
      const backIds = new Set(plan.ranges.map(x => x.id));
      for (const r of ranges) {
        if (isTomb(r) || r.lawId !== last.lawId) continue;
        if (backIds.has(r.id)) continue;
        if (!has.has(r.anchor)) orphans.push(r.anchor);
      }
    } catch (e) {
      // 旧本文を描けないなら数えられない。数えられないことを言う
      orphans = null;
    }

    /*
     * 数えられなかったことも言う。黙ると「0件だった」と読まれる。
     */
    const orphanNote = orphans === null
      ? '\n\n※ 旧本文を読めなかったので、戻したときに画面に出なくなる注釈が'
        + 'あるかどうかを数えられませんでした。'
      : orphans.length
        ? '\n\n※ 入れ替えのあとに、新しい本文にだけある条文へ注釈を '
          + orphans.length + '件 付けています（'
          + orphans.slice(0, 3).map(a => anchorLabel(a)).join('、')
          + (orphans.length > 3 ? ' ほか' : '')
          + '）。本文を戻すと、この ' + orphans.length
          + '件は消えませんが画面に出なくなります。'
        : '';

    if (!confirm('この入れ替えを取り消します。'
      + '\n\n本文を元に戻し、動かした注釈 ' + plan.notes.filter(x => !isTomb(x)).length
      + '件 / 文言 ' + plan.ranges.length + '件 を元の位置へ連れ帰ります。'
      + '\n入れ替えたあとに直した中身は、そのまま持って帰ります。'
      + orphanNote
      + '\n\n退避させた版（' + (last.keptLawId || '') + '）は残ります。'
      + '要らなければ一覧から消してください。'
      + '\n\nよろしいですか？')) return;

    /*
     * 本文を戻す。版IDと施行日は、差し替える前に持っていたものに戻す。
     * 持っていなかったのなら消す（空文字を入れると「分かっている」ことに
     * なってしまい、checkAmendment が別の判断をする）。
     */
    const back = { ...baseRec, xml: keptRec.xml,
      dupAnchors: (last.prev && last.prev.dupAnchors) || [],
      savedAt: now };
    const prev = last.prev || {};
    if (prev.rev) back.lawRevisionId = prev.rev; else delete back.lawRevisionId;
    if (prev.enforced) back.enforcementDate = prev.enforced; else delete back.enforcementDate;
    if (prev.importedAt) back.importedAt = prev.importedAt; else delete back.importedAt;
    if (prev.amendLawTitle) back.amendLawTitle = prev.amendLawTitle;
    else delete back.amendLawTitle;
    delete back.swappedAt;
    delete back.keptAs;

    try {
      await store.applyBulk({
        laws: [back], notes: plan.notes, ranges: plan.ranges,
        meta: { [SWAP_LAST_KEY]: null },
        local: true,
        /*
         * 別のタブが先に取り消していたら、中で止める。
         *
         * 確認のダイアログを出している間も、**別のタブは書ける。**
         * confirm が止めるのはこのタブのJSだけである。
         */
        expect: {
          laws: [{ lawId: last.lawId, savedAt: baseRec.savedAt || 0 }],
          ...expectFor(notes, ranges, [last.lawId, last.keptLawId], plan),
        },
      });
    } catch (e) {
      toast('取り消せませんでした（何も変えていません）: ' + e.message);
      return;
    }

    await afterSwapRefresh(last.lawId, last.keptLawId);
    toast('本文を戻しました。注釈 ' + plan.notes.filter(x => !isTomb(x)).length
      + '件 / 文言 ' + plan.ranges.length + '件 を元の位置へ戻しました'
      + (plan.lost.length ? '（' + plan.lost.length + '件は見つかりませんでした）' : ''));

    await paintVersionUndoBox();
    $('#vmig-result-undo').hidden = true;
    if ($('#dlg-vmig').open) $('#dlg-vmig').close();
  } finally {
    vmSetBusy(false);
  }
}

/* ------------------------------------------------------------ 小道具 */

/** 書いたあとの作り直し。注釈の読み直しと、画面への塗り直し。 */
async function vmRefresh() {
  await loadNotes();
  await loadRanges();
  paintNotes();
  paintRanges();
  renderMarkList();
}

/*
 * 段の切り替え。
 *
 * 下のボタンは段で意味が変わる。段1では「写す」も「選び直す」も要らない。
 * 出しておくと、何も選んでいないのに押せるボタンが並ぶ。
 */
function vmStep(n) {
  for (const i of [1, 2, 3]) $('#vmig-step' + i).hidden = i !== n;
  $('#vmig-back').hidden = n === 1 || (vm && vm.mode === 'swap');
  if (n !== 2) $('#vmig-go').hidden = true;
}

/** ダイアログの中のボタンを繋ぐ。init から一度だけ呼ぶ。 */
function wireVersionMigration() {
  $('#vmig-go').onclick = () => (vm && vm.mode === 'swap')
    ? doVersionSwap() : doVersionCopy();
  $('#vmig-back').onclick = () => {
    if (vm) openVersionMigration(vm.fromLawId);
  };
}
