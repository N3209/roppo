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
function paintVersionMigrationNote(note, rec) {
  const peers = versionPeers(rec.lawId);
  const n = countVersionNotes(rec.lawId);
  note.hidden = false;
  const head = n
    ? 'この版に付けた注釈 ' + n + '件を、別の版の正しい位置へ写せます'
    : 'この版に注釈はまだありません';
  note.innerHTML = '<span>固定した版です。' + esc(head) + '</span>'
    + (n && peers.length
      ? '<button type="button" class="mini vmig-open">注釈を写す</button>'
      : n ? '<span class="warn">写し先になる版が手元にありません</span>' : '');
  const b = note.querySelector('.vmig-open');
  if (b) b.onclick = () => openVersionMigration(rec.lawId);
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
  const list = state.laws.filter(l => l.lawId !== lawId && l.source !== 'file'
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
  let last = null;
  try { last = await store.getMeta(VM_LAST_KEY); } catch (e) { /* 読めなければ出さない */ }
  const v = last && last.value;
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
async function versionMaterials(lawId) {
  const rec = await store.getLaw(lawId);
  if (!rec) throw new Error('法令が見つかりません: ' + lawId);
  const doc = parseXML(rec.xml);
  const lawEl = doc.querySelector('Law');
  if (!lawEl) throw new Error('法令本体が見つかりません: ' + lawId);
  const { html, bodies, scopes } = renderLaw(lawEl);
  return { bodies, scopes, disp: dispByAnchor(html), savedAt: rec.savedAt || 0 };
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
  $('#vmig-law').textContent = (fromLaw ? fromLaw.lawTitle : vm.fromLawId)
    + ' → ' + (toLaw ? toLaw.lawTitle : vm.toLawId);

  renderVersionSummary();

  const list = $('#vmig-list');
  list.innerHTML = '';
  if (!vm.plan.items.length) {
    list.innerHTML = '<p class="hint">この版に写せる注釈がありません。</p>';
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
  $('#vmig-sum').innerHTML = '<div class="vmig-counts">' + esc(parts.join('　/　')) + '</div>'
    + '<div class="vmig-picked">写すもの <b>' + picked + '</b> 件'
    + '（全 ' + vm.plan.items.length + ' 件）</div>';
  $('#vmig-go').hidden = false;
  // 走っている最中は押せない（選択を変えても戻さない）
  $('#vmig-go').disabled = vmBusy || picked === 0;
  $('#vmig-go').textContent = picked ? '写す（' + picked + '件）' : '写す';
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
    let fromRec, toRec, nowNotes, nowRanges;
    for (let tries = 0; ; tries++) {
      const before = localWrites;
      try {
        [fromRec, toRec, nowNotes, nowRanges] = await Promise.all([
          store.getLaw(job.fromLawId), store.getLaw(job.toLawId),
          store.allNotes(), store.allRanges(),
        ]);
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
  $('#vmig-back').hidden = n === 1;
  if (n !== 2) $('#vmig-go').hidden = true;
}

/** ダイアログの中のボタンを繋ぐ。init から一度だけ呼ぶ。 */
function wireVersionMigration() {
  $('#vmig-go').onclick = () => doVersionCopy();
  $('#vmig-back').onclick = () => {
    if (vm) openVersionMigration(vm.fromLawId);
  };
}
