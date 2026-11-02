'use strict';

/*
 * 改正後の版へ注釈を写す。その核。
 *
 * 画面は version-migration-view.js が受け持つ。ここには画面に触るものを
 * 置かない。純粋な計算だけにしてあるので、計画を立てるだけなら何も変わらない。
 *
 * 最後の方で読み込む。中から呼んでいるものが散っているからである。
 *
 *   core.js   版番形（vvBump・vvKey）・墓石（isTomb・noteTomb・rangeTomb）・
 *             端末ID（deviceId）・別々に直されたかの判定（hasConflict）
 *   annot.js  画面の文字列（textMapOf）・何番目かを数える（nthIndexOf）
 *   find.js   住所の並べ方（anchorSortKey・cmpKey）
 *
 * 逆向きの参照は newRangeId の2か所（annot.js）だけで、どちらも関数の中なので
 * 読み込み時には走らない。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */

/* --------------------------------- 版をまたいで注釈を写す（突き合わせ） */

/*
 * 改正前の版に付けた注釈を、改正後の版の「正しい位置」へ写すための突き合わせ。
 *
 * 番号ではなく本文で突き合わせる。番号は改正で動く（条が削除されれば以降が
 * 繰り上がる）が、本文は動かない。
 *
 * 決め方は上から下へ。本則・附則・別表の対応を決め、その中で条、その中で項、
 * その中で号を決める。親が決まるまで子を探さない。こうしないと
 *   ・本則の項が附則の項に「移った」ことになる
 *   ・別の条に同じ文言の号があると、そちらに吸われる
 * という事故が起きる（最初に書いた版はどちらも起きた）。
 *
 * 対応を確かと見るのは、その本文が **旧版と新版の両方で、その親の中で
 * ただ一つ** のときだけ。片方にしか一意性を求めないと
 *   旧第5条と旧第20条が同文 → 第5条だけ削除 → 第5条の注釈が第20条へ
 * という誤りが起きる（最初の版で起きた）。両側に求めれば「分からない」に
 * 落ちる。分からないものは利用者に選ばせる。黙って決めない。
 *
 * 文字数の下限は置かない。探す範囲を親の中に閉じ、両側の一意性を求めるので、
 * 短い本文でも誤って吸われない。「削除」のように同じ文が並ぶ場合は一意で
 * なくなるので、自動では決まらない。
 */

/** アンカーの深さ。条=2、項=3、号=4。別表（AP1）=1。 */
const depthOf = a => String(a).split('/').length;

/** アンカーの scope（M / S1 / AP1）。 */
const scopeOf = a => String(a).split('/')[0];

/** すぐ上の住所。号→項、項→条。条や別表には無い。 */
const upOf = a => {
  const p = String(a).split('/');
  return p.length > 2 ? p.slice(0, -1).join('/') : '';
};

/*
 * 突き合わせで使う「親」。
 *
 * すぐ上の住所が実在すればそれ。無ければ scope。
 * 附則直下の項（S1//3）は条を持たないので、親は附則そのものになる。
 */
function parentFor(anchor, bodies) {
  const up = upOf(anchor);
  if (up && bodies.has(up)) return up;
  return scopeOf(anchor);
}

/*
 * 附則と別表の対応を決める。
 *
 * S1 / AP1 は出現順なので、番号では対応づけない。手前に附則が1本増えると
 * 番号がずれる。改正法令番号があればそれで、無ければ題名で対応づける。
 * どちらも無い・重なるときは対応させない（推測しない）。
 */
function matchScopes(fromScopes, toScopes) {
  const pairs = new Map();

  if (fromScopes.has('M') && toScopes.has('M')) pairs.set('M', 'M');

  /*
   * 手掛かりの作り方。
   *
   * S1 / AP1 という番号は、XML に出てきた順に振ったものである。番号で
   * 対応づけると「並び順で決める」ことになり、附則が1本挿し込まれただけで
   * 全部ずれる。だから中身から手掛かりを作る。
   *
   *   附則  改正法令番号（AmendLawNum）があればそれ。これは名指しになる。
   *         無いものは、ラベル（たいてい「附則」）に「番号なし」の印を付ける。
   *         ラベル自体は名指しにならないが、下の両側一意で担保する。
   *   別表  題名。題名が無いものに振っている「別表1」は出現順なので使わない。
   *         手掛かりが作れなければ対応づけず、要確認に回す。
   *
   * kind を頭に付けて、附則と別表が混ざらないようにする。
   */
  const keyOf = v => {
    const kind = String(v.kind || '');
    if (v.amend) return kind + '|a:' + v.amend;
    const label = String(v.label || '').replace(/\s+/g, '');
    if (!label) return '';            // 題名も番号も無い。生成した名前は使わない
    return kind + '|n:' + label;
  };

  /*
   * 両側で数える。
   *
   * 前は新版の側だけ重なりを落とし、旧版は出てきた順に当てていた。旧版に
   * 「附則」が2本あって新版に1本なら、先に出た方が勝って残りは取り残される
   * （Codex の指摘3）。どちらが正しいか決められないのだから、両側とも
   * ただ1つのときだけ対応づける。
   */
  const tally = scopes => {
    const count = new Map();
    const first = new Map();
    for (const [sc, v] of scopes) {
      if (sc === 'M') continue;
      const k = keyOf(v);
      if (!k) continue;
      count.set(k, (count.get(k) || 0) + 1);
      if (!first.has(k)) first.set(k, sc);
    }
    return { count, first };
  };
  const a = tally(fromScopes);
  const b = tally(toScopes);

  for (const [k, sc] of a.first) {
    if (a.count.get(k) !== 1 || b.count.get(k) !== 1) continue;
    pairs.set(sc, b.first.get(k));
  }
  return pairs;
}

/** その親の下にある、同じ深さの住所。 */
function kidsOf(bodies, parent, depth) {
  const out = [];
  for (const a of bodies.keys()) {
    if (depthOf(a) !== depth) continue;
    if (parentFor(a, bodies) !== parent) continue;
    out.push(a);
  }
  return out;
}

/*
 * ある深さの対応を決める。親の対応が決まっているものだけを見る。
 * 本文が両側でただ一つのときに結ぶ。
 */
function matchLevel(fb, tb, depth, pairs) {
  const got = new Map();
  const byParent = new Map();
  for (const a of fb.keys()) {
    if (depthOf(a) !== depth) continue;
    const p = parentFor(a, fb);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(a);
  }

  for (const [fromParent, kids] of byParent) {
    const toParent = pairs.get(fromParent);
    if (toParent === undefined) continue;        // 親が決まっていない
    const theirs = kidsOf(tb, toParent, depth);

    const mine = new Map();
    for (const a of kids) {
      const sig = (fb.get(a) || {}).sig;
      if (sig === undefined) continue;
      mine.set(sig, (mine.get(sig) || 0) + 1);
    }
    const theirsBySig = new Map();
    for (const a of theirs) {
      const sig = (tb.get(a) || {}).sig;
      if (sig === undefined) continue;
      if (!theirsBySig.has(sig)) theirsBySig.set(sig, []);
      theirsBySig.get(sig).push(a);
    }

    for (const a of kids) {
      const sig = (fb.get(a) || {}).sig;
      if (sig === undefined) continue;
      if (mine.get(sig) !== 1) continue;         // 旧版の中で一意でない
      const cand = theirsBySig.get(sig) || [];
      if (cand.length !== 1) continue;           // 新版の中で一意でない
      got.set(a, cand[0]);
    }
  }
  return got;
}

/*
 * アンカー → 文字列。2通り作る。
 *
 *   disp  その住所**自身**の文字。下位の項・号は入らない（textMapOf が
 *         data-anchor を持つ部分木を飛ばす）
 *   full  下位まで含めた文字
 *
 * **disp は「何番目」を数えるため、full は人に見せるため。** 取り違えると
 * どちらも壊れる。
 *
 * disp がなぜ画面の文字でなければならないか。文言注釈は「文言＋何番目の
 * 出現」で位置を持ち、描き直すときは画面に出ている文字列から探す
 * （placeRange → textMapOf）。だから行き先を確かめるときも、まったく同じ
 * 文字列で数えなければならない。突き合わせ用の本文（bodies）は使えない。
 * あちらは番号ラベルを除き空白も落としてある。号番号「一」を含むか含まない
 * かで「何番目」の意味が変わり、第一号が第二号へ移る改正で別の文言に付いた
 * （Codex が再現した）。描いたHTMLに textMapOf を通せば、描画時と同じ関数な
 * ので数え方がずれる余地がない。
 *
 * full がなぜ要るか。条（第30条）のように、自分の文字をほとんど持たず中身が
 * 全部項に入っている住所は disp が空になる。版移行の画面で旧本文を出すのに
 * disp を使っていたので、条に付けたメモの行が「（本文がありません）」に
 * なっていた。**判断材料を置くための変更が、いちばん多い条で効いていなかった。**
 *
 * 会社法で数百msかかるが、求めに応じて一度走るだけである。
 */
function textsByAnchor(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  /*
   * ルビは本文ではない。textMapOf も RT を飛ばすので、先に落としておけば
   * disp と full が同じ文字の上で作られる。
   */
  for (const rt of host.querySelectorAll('rt')) rt.remove();
  const disp = new Map();
  const acc = new Map();          // 住所 → 自分と下位の文字（組み立て中）
  /*
   * **下位を含めた文字は、積み上げて作る。** el.textContent を住所ごとに
   * 呼ぶと、条のところで項・号の文字をもう一度たどることになる。刑訴
   * （1.3MB）で1秒ほど余計にかかった。先祖は必ず先に出てくるので、
   * 自分の文字を自分と先祖の箱に積めば、たどり直さずに済む。
   */
  for (const el of host.querySelectorAll('[data-anchor]')) {
    const a = el.dataset.anchor;
    if (disp.has(a)) continue;
    const own = textMapOf(el).text;
    disp.set(a, own);
    if (!acc.has(a)) acc.set(a, []);
    if (!own) continue;
    acc.get(a).push(own);
    for (let q = a; ; ) {
      const up = upOf(q);
      const sc = scopeOf(q);
      // すぐ上が実在すればそれ。無ければ scope（附則直下の項 S1//3 がこれ）
      const next = (up && acc.has(up)) ? up
        : (sc !== q && acc.has(sc)) ? sc : '';
      if (!next) break;
      acc.get(next).push(own);
      q = next;
    }
  }
  const full = new Map();
  for (const [a, arr] of acc) full.set(a, arr.join(''));
  return { disp, full };
}

function dispByAnchor(html) {
  return textsByAnchor(html).disp;
}

/*
 * 文言注釈の行き先を確かめる。
 *
 * 条項号の対応が決まっても、その中のどの文言かは別の話である。
 * 文言注釈は「文言＋何番目の出現」で位置を持つので、同じ文言が増えたり
 * 減ったりすると、番目がずれて別のところに着く。
 *
 *   旧「AB A B」の1番目の AB に印 → 新「A B AB」
 *   どちらも空白を落とせば ABAB だが、画面の文字列では AB の数が違う。
 *   番目を据え置くと、以前は別々だった2文字に着いてしまう。
 *
 * そこで、旧版でその番目が置かれていた場所の前後を取り、新版の中で
 * 前後まで一致する出現を探す。ただ一つに絞れたときだけ確かと見る。
 * 絞れなければ要確認にする。番目を据え置いて付け直すことはしない。
 */
const CTX = 12;        // 前後に見る文字数の上限
const CTX_MIN = 6;     // これだけ確かめられなければ、確かとは見ない

function planRangeMove(oldDisp, newDisp, r) {
  const q = String((r && r.text) || '');
  if (!q) return { ok: false, why: '文言が空' };

  const from = String(oldDisp == null ? '' : oldDisp);
  const to = String(newDisp == null ? '' : newDisp);
  const nth = Number(r.nth) || 1;

  const at = nthIndexOf(from, q, nth);
  if (at < 0) return { ok: false, why: '旧版の本文に見つからない' };

  const preOld = from.slice(Math.max(0, at - CTX), at);
  const postOld = from.slice(at + q.length, at + q.length + CTX);

  /*
   * 前後が短すぎると、どの出現かを確かめようがない。
   * 両側とも文の端なら比べる文字が0文字になり、何も確かめずに「一致した」
   * ことになる（「AB A B」→「A B AB」がそれ。Codex の反例）。
   */
  if (preOld.length + postOld.length < CTX_MIN) {
    return { ok: false, why: '前後の文が短く、どの出現か確かめられない' };
  }

  /*
   * 前後が「旧版で見えていた分だけ」あって、そのまま一致する出現を探す。
   *
   * 新しい側の前後が短い＝文が削られたということなので、一致とは見ない。
   * 逆に長いのは手前に挿し込まれただけなので、末尾・先頭が合えばよい。
   * 窓を固定して切り出すと、挿入で窓がずれて同じ場所でも一致しなくなる。
   */
  const find = hay => {
    const got = [];
    for (let i = hay.indexOf(q), k = 0; i >= 0; i = hay.indexOf(q, i + 1)) {
      k += 1;                                    // 何番目の出現か（1始まり）
      const pre = hay.slice(Math.max(0, i - CTX), i);
      const post = hay.slice(i + q.length, i + q.length + CTX);
      if (pre.length < preOld.length || !pre.endsWith(preOld)) continue;
      if (post.length < postOld.length || !post.startsWith(postOld)) continue;
      got.push(k);
    }
    return got;
  };

  /*
   * 旧版でも一つに決まっているか。
   *
   * 新版の候補数だけを見ていたので、旧版に同じ前後の箇所が2つあり、
   * 注釈した側だけが削除されたとき、残ったもう一方へ写していた
   * （Codex が再現した）。削除と移動は本文だけでは見分けられない。
   */
  const here = find(from);
  if (here.length !== 1) {
    return { ok: false, why: '旧版でも同じ前後が ' + here.length + 'か所あります' };
  }

  const there = find(to);
  if (there.length === 1) return { ok: true, nth: there[0] };
  if (there.length > 1) {
    return { ok: false, why: '同じ前後の文が ' + there.length + 'か所ある' };
  }
  return { ok: false,
    why: to.includes(q) ? '前後の文が変わっている' : '新版の本文に見つからない' };
}

/**
 * 写す計画を立てる。DBも時計も触らない。
 *
 *   same      対応先が同じ住所
 *   moved     対応先が別の住所（番号が動いた）
 *   ambiguous 親は決まったが、同じ本文が新版の中に2か所以上ある
 *   changed   親は決まり、同じ番号の相手も居るが、本文が違う
 *   gone      親は決まったが、同じ番号の相手も、同じ本文も無い
 *   unknown   親の対応も候補も無い（附則の対応が付かない、など）
 *
 * **viaGuess が立っているものは、親が候補どまりである。** 内容が一つに
 * 決まっても moved にはしない（親が別の条なら、同じ本文でも別の条文）。
 * 必ず人が決める側に落とす。
 */
function planVersionMigration({ fromBodies, toBodies, fromScopes, toScopes,
  fromDisp, toDisp, notes, ranges, fromLawId, toLawId }) {
  const fd = fromDisp || new Map();
  const td = toDisp || new Map();
  const fb = fromBodies || new Map();
  const tb = toBodies || new Map();

  const scopePairs = matchScopes(fromScopes || new Map(), toScopes || new Map());

  // 親から子へ。scope を親として置いてから、条・項・号を順に決める
  const pairs = new Map(scopePairs);
  for (const d of [2, 3, 4]) {
    for (const [a, b] of matchLevel(fb, tb, d, pairs)) pairs.set(a, b);
  }

  /*
   * 親の候補。**確定（pairs）とは別の入れ物に持つ。**
   *
   * 指紋は下位を入れ子で持つので、号が1つ変われば条の指紋も変わる。すると
   * その条は pairs に乗らず、**その中の変わっていない項・号まで「辿れない」**
   * になっていた。刑法9条1項で実際に出た（第三者の指摘の本当の害はここ）。
   *
   * そこで「内容が一致する」と「子を探すためにここを親と見てよい」を分ける。
   * 候補は同じ番号から作る。親が決まっていれば、その下の同じ番号は、
   * 少なくとも**探す場所としては**筋が通る。
   *
   * **この表を same / moved の根拠にしてはいけない。** 入れると、親が未承認
   * なのに子だけが完全一致で確定し、defaultPicks が自動で選ぶ（Codex の指摘5）。
   * 下の判定では、候補経由のものを必ず「人が決める」側に落としている。
   */
  const guess = new Map();
  for (const d of [2, 3, 4]) {
    for (const a of fb.keys()) {
      if (depthOf(a) !== d || pairs.has(a)) continue;
      const up = parentFor(a, fb);
      const toUp = pairs.has(up) ? pairs.get(up) : guess.get(up);
      if (toUp === undefined) continue;
      const sameNum = toUp + String(a).slice(up.length);
      if (tb.has(sameNum)) guess.set(a, sameNum);
    }
  }

  // 注釈の付いている住所を集める
  const at = new Map();
  const want = anchor => {
    if (!at.has(anchor)) at.set(anchor, { anchor, notes: [], ranges: [] });
    return at.get(anchor);
  };
  for (const n of notes || []) {
    if (isTomb(n) || n.lawId !== fromLawId) continue;
    want(n.anchor).notes.push(n);
  }
  for (const r of ranges || []) {
    if (isTomb(r) || r.lawId !== fromLawId) continue;
    want(r.anchor).ranges.push(r);
  }

  const items = [];
  for (const got of at.values()) {
    const anchor = got.anchor;
    const from = fb.get(anchor);
    const decided = pairs.get(anchor);
    let kind, target = '', cands = [], viaGuess = false;

    if (decided !== undefined) {
      /*
       * scope の対応がそのまま住所の対応になるのは別表である（AP1 は scope
       * でもありアンカーでもある）。題名で相手が決まっても中身が同じとは
       * 限らない。対応表に載った時点で「確定」にしていたので、本文を一度も
       * 比べずに same/moved と言っていた（Codex の指摘4）。
       */
      const to = tb.get(decided);
      target = decided;
      if (from && to && from.sig !== to.sig) kind = 'changed';
      else if (from && !to) { kind = 'gone'; target = ''; }
      else kind = decided === anchor ? 'same' : 'moved';
    } else {
      /*
       * 対応が決まらなかった。親が決まっているなら、その親の中で候補を探す。
       * 決まらなかった理由（同文が複数／本文が変わった／無い）を分ける。
       */
      const up = parentFor(anchor, fb);
      /*
       * 親が確定していればそれを使う。していなければ候補を使う。
       * 候補を使ったときは viaGuess を立て、下で「人が決める」側に落とす。
       */
      const sure = pairs.get(up);
      const toParent = sure !== undefined ? sure : guess.get(up);
      viaGuess = sure === undefined && toParent !== undefined;
      if (toParent === undefined) {
        kind = 'unknown';
      } else {
        const sig = from && from.sig;
        const kids = kidsOf(tb, toParent, depthOf(anchor));
        const found = sig === undefined ? []
          : kids.filter(a => (tb.get(a) || {}).sig === sig);

        /*
         * 旧版の側でも一意か。ここを見ないと、
         *   旧第5条と旧第20条が同文 → 第5条だけ削除
         * のとき、第5条の注釈が「唯一残った同文」である第20条へ移ってしまう。
         * 「削除された」と「移って残った」は、本文だけでは区別できない。
         * 候補として見せるにとどめ、利用者に決めてもらう。
         */
        const mine = sig === undefined ? 0
          : kidsOf(fb, parentFor(anchor, fb), depthOf(anchor))
            .filter(a => (fb.get(a) || {}).sig === sig).length;

        /*
         * 同じ番号の相手（親だけ差し替えて、残りはそのまま）。
         *
         * 住所の最後の一片だけを継ぐと、附則直下の項（S1//3 のように条番号が
         * 空のもの）で空の一片が落ちて S1/3 になる。そんな住所は新版に無いので
         * 「本文が変わった」ではなく「無くなった」と言ってしまう（Codex の指摘8）。
         * 親から先をまるごと継げば、空の一片も残る。
         */
        const sameNum = toParent + String(anchor).slice(parentFor(anchor, fb).length);

        if (found.length > 1) { kind = 'ambiguous'; cands = found.slice(); }
        else if (found.length === 1 && mine === 1) {
          /*
           * 中身は一つに決まる。**ただし親が候補どまりなら確定にしない。**
           * 親が別の条なら、同じ本文でも別の条文である。候補として見せる。
           */
          if (viaGuess) { kind = 'ambiguous'; cands = found.slice(); }
          else { kind = 'moved'; target = found[0]; }
        } else if (found.length === 1) { kind = 'ambiguous'; cands = found.slice(); }
        else if (tb.has(sameNum)) { kind = 'changed'; target = sameNum; }
        else kind = 'gone';
      }
    }

    /*
     * 文言注釈は1件ずつ別に確かめる。条項号の対応が決まっても、
     * その中のどの文言かは保証されない。
     */
    const newBody = target ? (tb.get(target) || null) : null;
    const ranges = got.ranges.map(r => ({
      rec: r,
      move: target
        ? planRangeMove(fd.get(anchor), td.get(target), r)
        : { ok: false, why: '写し先が決まっていない' },
    }));

    items.push({
      anchor, kind, to: target, cands, viaGuess,
      oldBody: from || null,
      newBody,
      notes: got.notes, ranges,
      fromLawId, toLawId,
    });
  }

  /*
   * 多対一を落とす。
   *
   * 両側の一意性を求めているので対応表では起きないが、候補から拾った moved では
   * 2つの旧住所が同じ新住所を指しうる。どちらが正しいか決められないので、
   * 両方とも「分からない」に落とす。処理順で勝たせない。
   */
  const claim = new Map();
  for (const it of items) {
    if (!it.to) continue;
    if (!claim.has(it.to)) claim.set(it.to, []);
    claim.get(it.to).push(it);
  }
  for (const [to, list] of claim) {
    if (list.length < 2) continue;
    for (const it of list) {
      it.kind = 'ambiguous';
      it.cands = [to];
      it.to = '';
      it.newBody = null;
      for (const x of it.ranges) x.move = { ok: false, why: '写し先が決まっていない' };
    }
  }

  items.sort((a, b) => cmpKey(anchorSortKey(a.anchor), anchorSortKey(b.anchor)));
  for (const it of items) {
    it.cands.sort((x, y) => cmpKey(anchorSortKey(x), anchorSortKey(y)));
  }

  const counts = { same: 0, moved: 0, ambiguous: 0, changed: 0, gone: 0, unknown: 0 };
  for (const it of items) counts[it.kind]++;
  return { items, counts, scopePairs, pairs };
}

/* --------------------------------- 版をまたいで注釈を写す（写す処理） */

/*
 * 計画と利用者の選択をもとに、新しい版へ注釈を写す。
 *
 * 「写す」だけで、旧版の注釈は消さない。旧版も法令として手元に残っている
 * ので、墓石にする必要がない。写したあとで見比べられる方がよい。
 *
 * 気を付けることが6つある（Codex の指摘）。
 *   1. 文言注釈は新しい id を振る。同じ id のまま書くと元の記録を置き換える
 *   2. 写し先にすでに注釈があれば上書きしない
 *   3. 計画の中での衝突（複数の元注釈が同じ写し先へ）も見る
 *   4. 二度走らせても増えない。どこから写したかを記録して見分ける
 *   5. 版と候補（alts）は複製しない。写したものは新しい記録である
 *   6. 書き込む直前にもう一度確かめる。画面を開いてから編集や同期が入りうる
 */

/*
 * 文言注釈の id。同じ作り方を3か所に書いていたので、ここにまとめた。
 * 写すときに元の id を使い回すと、元の記録を置き換えてしまう。
 */
const newRangeId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));

/**
 * 写したものの出どころ。
 *
 *   lawId / anchor / id  どこから写したか。二度写しを見分けるのに使う
 *   op                   どの操作で写したか。「この操作を取り消す」に使う
 */
const copyMark = (lawId, anchor, id, op) => ({ lawId, anchor, id: id || '', op: op || '' });

/** 同じところから写したものか。操作IDは見ない（二度写しの判定に使うため）。 */
const sameCopy = (a, b) => !!a && !!b
  && a.lawId === b.lawId && a.anchor === b.anchor && (a.id || '') === (b.id || '');

/**
 * 写すものを組み立てる。DBも時計も触らない。
 *
 * picks は「旧住所 → 写し先の住所」。計画の same / moved は既定で入れ、
 * ambiguous は利用者が選んだものだけ、changed は選んだときだけ入る。
 *
 * nowNotes / nowRanges は、書き込む直前に読み直した手元の記録。
 */
function buildVersionCopies({ plan, picks, nowNotes, nowRanges,
  fromDisp, toDisp, toLawId, deviceId, now, op }) {
  const opId = op || ('cp' + now + '-' + Math.random().toString(16).slice(2, 8));
  const notes = [];
  const ranges = [];
  const skipped = [];

  const living = rec => rec && !isTomb(rec);
  const noteAt = new Map();
  /*
   * 消した印（墓石）は別に持つ。写し先に墓石があるとき、版を継がずに書くと
   * 「消した」が勝ってしまう（saveNote と同じ理由）。取り消してから写し直す
   * 道があるので、ここは必ず通る。
   */
  const tombAt = new Map();
  for (const n of nowNotes || []) {
    if (living(n)) noteAt.set(n.key, n);
    else if (n && n.key) tombAt.set(n.key, n);
  }
  /*
   * 文言注釈は id で持つ。取り消したあとに写し直すと新しい id になるので、
   * 墓石（古い id）とは別の記録になり、衝突しない。だから条項号の注釈と
   * 違って、墓石の版を継ぐ必要がない。
   * （一度そういう仕掛けを置いたが、要らないものだった。rangeTomb は中身を
   *   最小限にするので copiedFrom を落とし、そもそも引き当てられない。）
   */
  const rangesAt = new Map();
  for (const r of nowRanges || []) {
    if (!living(r)) continue;
    const k = r.lawId + ':' + r.anchor;
    if (!rangesAt.has(k)) rangesAt.set(k, []);
    rangesAt.get(k).push(r);
  }

  // 3. 計画の中での衝突。複数の元住所が同じ写し先を指していたら、どちらも写さない
  const claim = new Map();
  for (const it of plan.items) {
    const to = picks.get(it.anchor);
    if (!to) continue;
    if (!claim.has(to)) claim.set(to, []);
    claim.get(to).push(it.anchor);
  }

  for (const it of plan.items) {
    const to = picks.get(it.anchor);
    if (!to) continue;

    const rival = claim.get(to) || [];
    if (rival.length > 1) {
      skipped.push({ anchor: it.anchor, to, why: '写し先が重なっています（' + rival.join('、') + '）' });
      continue;
    }

    const from = copyMark(it.fromLawId, it.anchor);
    const key = toLawId + ':' + to;

    // 条項号の注釈
    for (const n of it.notes) {
      const there = noteAt.get(key);
      if (there) {
        // 4. すでに同じところから写してあるなら、二度写さない
        if (sameCopy(there.copiedFrom, from)) {
          skipped.push({ anchor: it.anchor, to, why: 'すでに写してあります' });
        } else {
          // 2. 上書きしない
          skipped.push({ anchor: it.anchor, to, why: '写し先にすでに注釈があります' });
        }
        continue;
      }
      /*
       * 5. 版と候補は複製しない。写したものは、この端末が新しく作った記録
       *    である。元の版を継ぐと、元の注釈を直したときに前後が決められない。
       */
      notes.push({
        key, lawId: toLawId, anchor: to,
        tags: [...(n.tags || [])],
        color: n.color || '',
        summary: n.summary || '',
        memo: n.memo || '',
        copiedFrom: { ...from, op: opId },
        /*
         * 写した時点の版そのものを控える。
         *
         * 取り消すときは、いまの版がこれと完全に一致するものだけを消す。
         * 「この端末の数が1かどうか」で見ていたので、他の端末で直されたもの
         * （{A:1} → {A:1,B:1}）まで消していた。逆に、取り消して写し直すと
         * 数が増えるので、未編集なのに消せなくなっていた（Codex の指摘）。
         */
        copiedVersion: vvBump((tombAt.get(key) || {}).version, deviceId),
        updatedAt: now,
        version: vvBump((tombAt.get(key) || {}).version, deviceId),
      });
      noteAt.set(key, notes[notes.length - 1]);     // 同じ計画の中での重なりも防ぐ
    }

    // 文言の注釈
    for (const got of it.ranges) {
      const r = got.rec;
      const mark = copyMark(it.fromLawId, it.anchor, r.id);
      /*
       * 選んだ先で数え直す。
       *
       * 計画に載っている判定は、計画を立てたときの写し先についてのもので
       * ある。利用者が候補から別の先を選んだら、その先で確かめ直さないと
       * 「よその先で確かめた何番目」をそのまま使うことになる（Codex の指摘）。
       */
      const move = planRangeMove((fromDisp || new Map()).get(it.anchor),
        (toDisp || new Map()).get(to), r);
      if (!move.ok) {
        skipped.push({ anchor: it.anchor, to, text: r.text,
          why: '文言の行き先が確かめられません（' + (move.why || '') + '）' });
        continue;
      }
      const here = rangesAt.get(toLawId + ':' + to) || [];
      if (here.some(x => sameCopy(x.copiedFrom, mark))) {
        skipped.push({ anchor: it.anchor, to, text: r.text, why: 'すでに写してあります' });
        continue;
      }
      if (here.some(x => x.text === r.text && Number(x.nth) === Number(move.nth))) {
        skipped.push({ anchor: it.anchor, to, text: r.text,
          why: '写し先に同じ文言の印があります' });
        continue;
      }
      // 1. 新しい id を振る。同じ id のまま書くと元の記録を置き換える
      const made = {
        id: newRangeId(),
        lawId: toLawId, anchor: to,
        text: r.text, nth: move.nth,
        color: r.color || '', memo: r.memo || '',
        kind: r.kind,
        copiedFrom: { ...mark, op: opId },
        copiedVersion: vvBump({}, deviceId),      // 理由は条項号の側の注記
        updatedAt: now,
        version: vvBump({}, deviceId),
      };
      if (!made.kind) delete made.kind;
      ranges.push(made);
      here.push(made);
      rangesAt.set(toLawId + ':' + to, here);
    }
  }

  return { notes, ranges, skipped, op: opId };
}


/* ---------------------------------------- 版をその場で入れ替える（核） */

/*
 * 元の法令の本文を新しい版に差し替えるときの、注釈の振り分けを組む。
 * DBも時計も触らない。
 *
 * なぜ「写す」と別の関数なのか。違いは3つある。
 *
 *   ・住所が同じ法令の中で動く。だから元の記録を墓石にしないと、同じ注釈が
 *     古い住所と新しい住所の2か所に出る
 *   ・行き先が決まらなかった注釈は、退避させる固定版へ逃がす。元の法令に
 *     置いていくと、差し替えた本文にその住所が無いので画面のどこにも出ない。
 *     文言注釈には迷子の箱（state.orphanRanges）があるが、条項号の注釈には
 *     無いので、黙って見えなくなる
 *   ・そのまま（same）は何も書かない。住所が変わらないのだから動かす理由がない
 *
 * 二度写しの判定（copiedFrom の照合）は要らない。増やす操作ではなく動かす
 * 操作なので、元の住所には何も残らない。代わりに行き先が空いているかを見る。
 * 「これから動く注釈が居る」のは空いているのと同じである（第3条と第4条が
 * 入れ替わる改正では、互いの住所へ同時に動く）。
 *
 * 行き先が塞がっていたら、その注釈も退避先へ逃がす。元の住所に置いていくと
 * 見えなくなるので、「動かさない」という選択肢は無い。
 *
 * 文言注釈は id が鍵なので、住所を書き換えるだけで動く（墓石が要らない）。
 * 条項号の注釈は `lawId:anchor` が鍵なので、墓石＋新規になる。
 */
function buildVersionSwap({ plan, picks, nowNotes, nowRanges, fromDisp, toDisp,
  lawId, keptLawId, deviceId, now, op }) {
  const opId = op || ('sw' + now + '-' + Math.random().toString(16).slice(2, 8));
  const fd = fromDisp || new Map();
  const td = toDisp || new Map();

  const living = rec => rec && !isTomb(rec);
  const noteAt = new Map();
  const tombAt = new Map();
  for (const n of nowNotes || []) {
    if (!n || !n.key) continue;
    if (living(n)) noteAt.set(n.key, n); else tombAt.set(n.key, n);
  }

  /*
   * 行き先を決める。
   *   選ばれていて住所が同じ   そのまま（何も書かない）
   *   選ばれていて住所が違う   元の法令の中で動かす
   *   選ばれていない          退避先へ逃がす（住所はそのまま）
   */
  const dest = new Map();
  for (const it of plan.items) {
    const to = picks.get(it.anchor);
    if (to && to === it.anchor) dest.set(it.anchor, { lawId, anchor: to, kind: 'stay' });
    else if (to) dest.set(it.anchor, { lawId, anchor: to, kind: 'move' });
    else dest.set(it.anchor, { lawId: keptLawId, anchor: it.anchor, kind: 'park' });
  }

  // これから空く住所。入れ替わる改正を通すために要る
  const leaving = new Set();
  for (const [anchor, d] of dest) {
    if (d.kind !== 'stay') leaving.add(lawId + ':' + anchor);
  }

  // 行き先の重なり。どちらが正しいか決められないので、両方とも退避先へ逃がす
  const claim = new Map();
  for (const [anchor, d] of dest) {
    if (d.kind === 'stay') continue;
    const k = d.lawId + ':' + d.anchor;
    if (!claim.has(k)) claim.set(k, []);
    claim.get(k).push(anchor);
  }

  /*
   * 墓石と新規を別に集める。並べた順で put するので、入れ替わる改正では
   * 片方の墓石がもう片方の新規を消しうる（A→B と B→A が同時に起きると、
   * B の住所に墓石と新規の両方が並ぶ）。最後に突き合わせて、新規が来る
   * 住所には墓石を書かない。
   */
  const creates = new Map();
  const tombs = new Map();

  const outRanges = [];
  const skipped = [];
  const moves = [];        // [旧住所, 行き先の法令, 行き先の住所]
  const rangeMoves = [];   // [id, 旧住所, 旧nth, 行き先の法令, 行き先の住所, 新nth]
  const stayed = [];
  const parked = [];

  for (const it of plan.items) {
    let d = dest.get(it.anchor);
    const srcKey = lawId + ':' + it.anchor;

    // 行き先が使えないなら退避先へ落とす。元の住所には置いていけない
    if (d.kind === 'move') {
      const dk = d.lawId + ':' + d.anchor;
      const rival = claim.get(dk) || [];
      const there = noteAt.get(dk);
      let why = '';
      if (rival.length > 1) why = '行き先が重なっています（' + rival.join('、') + '）';
      else if (there && !leaving.has(dk)) why = '行き先にすでに注釈があります';
      if (why) {
        skipped.push({ anchor: it.anchor, to: d.anchor,
          why: why + '。退避させた版へ移しました' });
        d = { lawId: keptLawId, anchor: it.anchor, kind: 'park' };
      }
    }

    const dk = d.lawId + ':' + d.anchor;

    /* ---- 条項号の注釈 ---- */
    if (d.kind === 'stay') {
      if (it.notes.length) stayed.push(it.anchor);
    } else {
      for (const n of it.notes) {
        /*
         * 候補（別々に直されたもの）は動かさない。**先に解決させる。**
         *
         * 一度は「候補を連れていく」ようにした。それは失うより悪い直し方
         * だった。候補は中身だけでなく元の `key / lawId / anchor` を持つ
         * レコードで、resolveConflict は選んだ候補をそのまま展開する
         * （core.js）。だから移した先で「これを採る」を押すと、**元の
         * 住所へ書き戻る。** 墓石を生きた注釈で置き換え、移した先には
         * 未解決のものが残る（Codex の2回目の指摘1）。
         *
         * 版の面でも当てにならない。移した先の墓石から採番するので、
         * その版が候補を支配して次のマージで消えることがある。
         *
         * ここまで来ないように画面が止めている（showSwapPlan）。それでも
         * 来たら書かずに throw する。黙って落とすより、何も書かない方がよい。
         */
        if (hasConflict(n)) {
          throw new Error('別々に直された注釈があります（' + it.anchor
            + '）。先にどちらを採るか選んでください');
        }
        creates.set(dk, {
          key: dk, lawId: d.lawId, anchor: d.anchor,
          tags: [...(n.tags || [])],
          color: n.color || '',
          summary: n.summary || '',
          memo: n.memo || '',
          /*
           * どこから動かしたか。取り消しに使う。
           * 写し（copiedFrom）とは別の名前にする。意味が違うものを同じ欄に
           * 入れると、取り消しの対象を取り違える。
           */
          movedFrom: { lawId, anchor: it.anchor, op: opId },
          updatedAt: now,
          /*
           * いまそこに在るもの（生きていても墓石でも）を越える版を振る。
           * 入れ替わる改正では、生きている注釈の上に書くことになる。
           *
           * **元の注釈の系譜は継がない。** 継ぐと（vvMerge してから上げると）
           * その版が上の alts を支配するので、pruneAlts が候補を落とす。
           * 候補を連れてきた意味が無くなる。「移したものは元の後継だから
           * 系譜を継ぐのが自然だ」と見えるが、ここでそれをやると指摘1に
           * 戻る。直すときは core.js の pruneAlts を先に読むこと。
           */
          version: vvBump((noteAt.get(dk) || tombAt.get(dk) || {}).version, deviceId),
        });
        tombs.set(srcKey, n);
        if (d.kind === 'park') parked.push(it.anchor);
        else moves.push([it.anchor, d.lawId, d.anchor]);
      }
    }

    /* ---- 文言注釈 ---- */
    for (const got of it.ranges) {
      const r = got.rec;
      // 条項号の注釈と同じ理由（候補を別の住所へ持っていけない）
      if (hasConflict(r)) {
        throw new Error('別々に直された文言注釈があります（' + it.anchor
          + '「' + (r.text || '') + '」）。先にどちらを採るか選んでください');
      }
      /*
       * 退避先は本文がそのままなので、位置を数え直す必要がない。
       * 元の法令に残す・動かす場合は、差し替えた本文で数え直す。
       * そのまま（stay）でも数え直す。条項号の対応が決まっても、その中の
       * どの文言かは保証されない（changed を選んだ場合は本文が違う）。
       */
      if (d.kind === 'park') {
        outRanges.push({ ...r, lawId: keptLawId, anchor: it.anchor,
          movedFrom: { lawId, anchor: it.anchor, op: opId },
          updatedAt: now, version: vvBump(r.version, deviceId) });
        rangeMoves.push([r.id, it.anchor, Number(r.nth), keptLawId, it.anchor, Number(r.nth)]);
        continue;
      }
      const mv = planRangeMove(fd.get(it.anchor), td.get(d.anchor), r);
      if (!mv.ok) {
        /*
         * 差し替えた本文で位置が決められない。退避先へ逃がす。
         * 元の法令に残すと迷子の箱に入るので気づけはするが、本文が変わった
         * あとのその印は、別の文を指している恐れがある。
         */
        skipped.push({ anchor: it.anchor, to: d.anchor, text: r.text,
          why: '文言の行き先が確かめられません（' + (mv.why || '')
            + '）。退避させた版へ移しました' });
        outRanges.push({ ...r, lawId: keptLawId, anchor: it.anchor,
          movedFrom: { lawId, anchor: it.anchor, op: opId },
          updatedAt: now, version: vvBump(r.version, deviceId) });
        rangeMoves.push([r.id, it.anchor, Number(r.nth), keptLawId, it.anchor, Number(r.nth)]);
        continue;
      }
      // 住所も位置も変わらないなら書かない
      if (d.kind === 'stay' && Number(mv.nth) === Number(r.nth)) continue;
      outRanges.push({ ...r, lawId, anchor: d.anchor, nth: mv.nth,
        movedFrom: { lawId, anchor: it.anchor, op: opId },
        updatedAt: now, version: vvBump(r.version, deviceId) });
      rangeMoves.push([r.id, it.anchor, Number(r.nth), lawId, d.anchor, Number(mv.nth)]);
    }
  }

  const outNotes = [];
  for (const [k, rec] of tombs) {
    if (creates.has(k)) continue;        // 動いてきた注釈が居る。墓石を書くと消える
    outNotes.push(noteTomb(rec, now, vvBump(rec.version, deviceId)));
  }
  for (const rec of creates.values()) outNotes.push(rec);

  return { notes: outNotes, ranges: outRanges, skipped,
    moves, parked, stayed, rangeMoves, op: opId };
}

/**
 * 入れ替えを取り消す計画を立てる。DBも時計も触らない。
 *
 * 動かした先から元の住所へ戻すだけなので、控えには行き先の対応表しか
 * 要らない（注釈の中身まで控えると、487件で百KB単位になる）。
 *
 * 入れ替えのあとに直した中身は、そのまま持って帰る。写しの取り消しは
 * 直したものを残すが、こちらは残せない。本文を古いものに戻すのだから、
 * 新しい本文の住所に注釈を残すと行き場が無くなる。
 */
function planSwapUndo({ notes, ranges, last, deviceId, now }) {
  const out = { notes: [], ranges: [], lost: [], blocked: [] };
  if (!last || !last.op) return out;
  const op = last.op;
  const base = last.lawId;

  const living = rec => rec && !isTomb(rec);
  const noteAt = new Map();
  const tombAt = new Map();
  for (const n of notes || []) {
    if (!n || !n.key) continue;
    if (living(n)) noteAt.set(n.key, n); else tombAt.set(n.key, n);
  }

  const creates = new Map();
  const tombs = new Map();

  /* 対応表は [旧住所, 行き先の法令, 行き先の住所] と、退避の [住所] の2通り */
  const pairs = [];
  for (const m of last.moves || []) pairs.push([m[0], m[1], m[2]]);
  for (const a of last.parked || []) pairs.push([a, last.keptLawId, a]);

  /*
   * この取り消しで**本当に空く**住所。
   *
   * 入れ替わる改正を戻すときに要る（A→B と B→A を戻すなら、A の戻り先は
   * B が出ていく住所である）。これを見ないと「埋まっている」と誤判定する。
   *
   * **対応表をそのまま使ってはいけない。** 表に載っていても、その住所に
   * いま居るのが「この入れ替えで動かしたもの」でなければ出ていかない。
   *
   *   AとBを交換する入れ替え → 新Aの注釈を消して、そこに別の注釈Xを作る
   *   → 取り消すと、Aは表に載っているので「空く」と見え、Xを上書きする
   *
   * （Codex の2回目の指摘2）。だから先に1周して、動かせるものだけを集める。
   */
  const actionable = [];
  for (const [fromAnchor, toLawId, toAnchor] of pairs) {
    const rec = noteAt.get(toLawId + ':' + toAnchor);
    if (!rec || !rec.movedFrom || rec.movedFrom.op !== op) {
      out.lost.push({ anchor: fromAnchor, why: '動かした先に見つかりません' });
      continue;
    }
    actionable.push([fromAnchor, toLawId, toAnchor, rec]);
  }
  const vacating = new Set(actionable.map(([, l, a]) => l + ':' + a));

  for (const [fromAnchor, , , rec] of actionable) {
    const back = base + ':' + fromAnchor;
    /*
     * 戻し先に、この取り消しと関係のない注釈が居ないか。
     *
     * 入れ替えで旧 M/6 のメモを新 M/5 へ動かしたあと、新しい本文にもある
     * M/6 に別のメモを書くことがある。そこへ黙って書き戻すと、後から
     * 書いたメモが消える（版を継いで進めるので、候補にも残らない。
     * Codex の指摘2）。
     *
     * 見つけたら、その場で飛ばすのではなく**取り消しそのものを断る。**
     * 本文を戻す操作なので、一部だけ戻すと「本文は旧版、注釈は半分新版」
     * という状態が残り、どちらが正しいか誰にも分からなくなる。
     */
    const there = noteAt.get(back);
    if (there && !vacating.has(back)) {
      out.blocked.push({ anchor: fromAnchor,
        why: '戻す先に、入れ替えのあとで書いた注釈があります' });
      continue;
    }
    const dk = rec.key;
    creates.set(back, {
      key: back, lawId: base, anchor: fromAnchor,
      tags: [...(rec.tags || [])],
      color: rec.color || '',
      summary: rec.summary || '',
      memo: rec.memo || '',
      updatedAt: now,
      version: vvBump((noteAt.get(back) || tombAt.get(back) || {}).version, deviceId),
    });
    tombs.set(dk, rec);
  }

  for (const [k, rec] of tombs) {
    if (creates.has(k)) continue;
    out.notes.push(noteTomb(rec, now, vvBump(rec.version, deviceId)));
  }
  for (const rec of creates.values()) out.notes.push(rec);

  /*
   * 文言注釈は鍵が id なので、住所を書き換えるだけで戻る。別の記録を
   * 上書きすることはない（条項号の注釈と違って、住所が鍵ではない）。
   * だから衝突の検査は要らない。
   */
  const byId = new Map();
  for (const r of ranges || []) if (living(r)) byId.set(r.id, r);
  for (const m of last.rangeMoves || []) {
    const [id, fromAnchor, fromNth] = m;
    const r = byId.get(id);
    if (!r || !r.movedFrom || r.movedFrom.op !== op) {
      out.lost.push({ anchor: fromAnchor, why: '動かした文言注釈が見つかりません' });
      continue;
    }
    const { movedFrom, ...rest } = r;
    out.ranges.push({ ...rest, lawId: base, anchor: fromAnchor, nth: fromNth,
      updatedAt: now, version: vvBump(r.version, deviceId) });
  }

  return out;
}
/**
 * 写したものを取り消す計画を立てる。DBも時計も触らない。
 *
 * 写した記録には必ず出どころ（copiedFrom）が付いているので、どれを写した
 * ものかが分かる。試すのが怖くないのは、ここで正確に取り消せるからである。
 *
 * 本当に消さずに墓石にする。本当に消すと、他の端末から同期で戻ってくる。
 * 利用者が写したあとに手で直したものは、取り消しの対象から外す
 * （直した中身まで消すのは、利用者の仕事を捨てることになる）。
 */
function planVersionUndo({ notes, ranges, fromLawId, toLawId, deviceId, now, op }) {
  const outNotes = [];
  const outRanges = [];
  const kept = [];

  /*
   * 取り消すのは「写したまま、誰も触っていないもの」だけ。
   *
   * 写した時点の版そのもの（copiedVersion）と、いまの版が完全に一致する
   * ことを求める。端末ごとの数を見る形にしていたので、
   *   ・他の端末で直したもの（{A:1} → {A:1,B:1}）まで消していた
   *   ・取り消して写し直したもの（{A:3}）を、未編集なのに消せなかった
   * どちらも Codex が再現した。版まるごとの一致なら、どちらも起きない。
   *
   * 別々に直されたもの（alts を抱えているもの）も触らない。候補のどれを
   * 採るかは利用者が決めることで、こちらが消してよいものではない。
   */
  const mine = rec => !isTomb(rec) && rec.lawId === toLawId
    && rec.copiedFrom && rec.copiedFrom.lawId === fromLawId
    && (!op || rec.copiedFrom.op === op);

  const untouched = rec => vvKey(rec.version) === vvKey(rec.copiedVersion);

  for (const n of notes || []) {
    if (!mine(n)) continue;
    if (hasConflict(n)) {
      kept.push({ anchor: n.anchor, why: '別々に直されています（候補があります）' });
      continue;
    }
    if (!untouched(n)) {
      kept.push({ anchor: n.anchor, why: '写したあとに直されています' });
      continue;
    }
    outNotes.push(noteTomb(n, now, vvBump(n.version, deviceId)));
  }
  for (const r of ranges || []) {
    if (!mine(r)) continue;
    if (hasConflict(r)) {
      kept.push({ anchor: r.anchor, text: r.text, why: '別々に直されています（候補があります）' });
      continue;
    }
    if (!untouched(r)) {
      kept.push({ anchor: r.anchor, text: r.text, why: '写したあとに直されています' });
      continue;
    }
    outRanges.push(rangeTomb(r, now, vvBump(r.version, deviceId)));
  }
  return { notes: outNotes, ranges: outRanges, kept };
}

/** 計画の既定の選択。same と moved だけを入れる。 */
function defaultPicks(plan) {
  const picks = new Map();
  for (const it of plan.items) {
    if (it.kind === 'same' || it.kind === 'moved') picks.set(it.anchor, it.to);
  }
  return picks;
}

