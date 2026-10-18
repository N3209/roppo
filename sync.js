'use strict';

/*
 * 端末のあいだで注釈を揃える。Google Drive を通す。書き出しと復元もここ。
 *
 * 分割前の app.js の次の節を、順を変えずに集めたものである。
 *
 *   同期：Google の認可 / 同期：Drive の通信先 / 同期：手順 / 同期：入口
 *   書き出しと復元 / ほかの端末にある法令
 *
 * 「同期：運ぶ形と検証」「同期：版」「同期：マージの核」はここに無い。
 * 墓石・版番形・検証・マージは同期だけのものではなく、注釈の保存と改正の
 * 引き継ぎからも呼ばれるので core.js に置いてある。見出しの字面で寄せると、
 * 同期でない機能が同期に依存することになる。
 *
 * トップレベルで組み立てているものは無い。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */
/* ------------------------------------------------- 同期：Google の認可 */

/*
 * トークンを取る。画面ごと Google へ移り、戻ってくる。
 *
 * なぜポップアップを使わないか。iPhone でホーム画面から起動していると、
 * ポップアップが表示されずに待ち続けることがある。画面遷移なら、その形でも
 * 元の保存領域に戻れることを実機で確かめた。
 *
 * なぜ Google のスクリプトを読まないか。実行時の依存を増やさないため。
 * 読むのは同期のときだけ、とすることもできるが、遷移で足りるなら要らない。
 *
 * トークンはメモリにだけ置く。localStorage には書かない。1時間で切れるので、
 * 切れたら取り直す。往復の途中であることは sessionStorage に印で残す。
 */
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/*
 * このアプリの識別子。秘密ではない（ブラウザに出る前提の値）。
 * Google Cloud で作ったもので、drive.appdata のスコープだけを求める。
 */
const G_CLIENT_ID = '866936668538-nclss2rol3u90rs0ujk2rg6a97u7kddc.apps.googleusercontent.com';
const G_STATE = 'roppo.g.state';
const G_RESUME = 'roppo.g.resume';
const G_ACCOUNT = 'roppo.g.account';

let gToken = null;         // { value, expiresAt }

const gRedirect = () => location.origin + location.pathname;

function gAlive() {
  return !!(gToken && gToken.value && gToken.expiresAt > Date.now() + 30000);
}

/** どのアカウントを使うか。複数ログインしていると、指定しないと決まらない。 */
function gAccount() {
  try { return localStorage.getItem(G_ACCOUNT) || ''; } catch (e) { return ''; }
}
function setGAccount(v) {
  try { localStorage.setItem(G_ACCOUNT, String(v || '').trim()); } catch (e) { /* 任意 */ }
}

/** 画面ごと Google へ移る。戻ってきたら resumeAfterAuth が受ける。 */
function gGo(resume, pick) {
  const st = newDeviceId();
  try {
    sessionStorage.setItem(G_STATE, st);
    sessionStorage.setItem(G_RESUME, resume || '');
  } catch (e) { /* 戻ってから state を確かめられないだけ */ }
  /*
   * pick を渡すと、必ずアカウントの選択画面を出す。
   * 端末ごとに違うアカウントに繋がっていると、置き場所（appDataFolder）が
   * 別になり、互いのファイルが見えない。実際にそうなった。選び直せる道が要る。
   */
  location.href = G_AUTH
    + '?client_id=' + encodeURIComponent(G_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(gRedirect())
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(G_SCOPE)
    + '&state=' + encodeURIComponent(st)
    + '&include_granted_scopes=true'
    + (pick ? '&prompt=select_account' : '')
    + (!pick && gAccount() ? '&login_hint=' + encodeURIComponent(gAccount()) : '');
}

/*
 * 戻ってきたところ。起動のいちばん早いところで呼ぶ。
 * フラグメントは読んだらすぐ消す。履歴やログにトークンを残さない。
 */
function takeAuthFragment() {
  const frag = location.hash || '';
  if (!/[#&](access_token|error)=/.test(frag)) return null;
  const q = new URLSearchParams(frag.replace(/^#/, ''));
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (e) { /* 消せなくても読み込みは進む */ }

  let want = '';
  try { want = sessionStorage.getItem(G_STATE) || ''; } catch (e) { /* 下で弾く */ }
  try { sessionStorage.removeItem(G_STATE); } catch (e) { /* 任意 */ }

  const err = q.get('error');
  if (err) return { ok: false, why: err };
  // 送った印と一致しない返事は受け取らない（すり替え対策）
  if (!want || q.get('state') !== want) return { ok: false, why: 'state が合わない' };

  const tok = q.get('access_token');
  const sec = Number(q.get('expires_in') || 0);
  if (!tok) return { ok: false, why: 'トークンが来なかった' };
  gToken = { value: tok, expiresAt: Date.now() + Math.max(60, sec) * 1000 };
  return { ok: true, why: '' };
}

/** 同期の途中で飛んだのか。戻ってきたときに見る。 */
function takeResume() {
  let v = '';
  try { v = sessionStorage.getItem(G_RESUME) || ''; } catch (e) { /* 無ければ空 */ }
  try { sessionStorage.removeItem(G_RESUME); } catch (e) { /* 任意 */ }
  return v;
}


/* ------------------------------------------------- 同期：Drive の通信先 */

/*
 * Drive の appDataFolder に置く。アプリ専用の隠し場所で、Drive の画面には
 * 出ない。ほかのファイルには一切触らない（スコープが drive.appdata だけ）。
 *
 * ファイル名に発行元と世代を入れる。一覧だけで「どの端末の何世代目か」が
 * 分かるので、中身を読まずに済む。
 *
 *   roppo-<writerId>-<generation>.json
 *
 * 名前は一意ではない（同じ名前のものが作れてしまう）ので、名前だけを頼りに
 * しない。中身にも writerId と generation を入れてあり、読んだ方を正とする。
 */
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SNAP_RE = /^roppo-([A-Za-z0-9_-]+)-(\d+)\.json$/;

function driveRemote() {
  const auth = () => {
    if (!gAlive()) throw new Error('認可が切れています');
    return { Authorization: 'Bearer ' + gToken.value };
  };
  const check = async r => {
    if (r.ok) return r;
    let msg = 'HTTP ' + r.status;
    try {
      const d = await r.json();
      if (d && d.error && d.error.message) msg = d.error.message;
    } catch (e) { /* 本文が読めないときは番号だけ */ }
    if (r.status === 401 || r.status === 403) gToken = null;   // 取り直させる
    throw new Error(msg);
  };

  return {
    /*
     * 置いてあるものの一覧。
     * ページが短いことを終わりの合図にしない。nextPageToken を最後まで辿る。
     */
    async listSnapshots() {
      const out = [];
      let page = '';
      for (let i = 0; i < 50; i++) {        // 念のための上限
        const u = DRIVE_API + '?spaces=appDataFolder&pageSize=100'
          + '&fields=nextPageToken,files(id,name,modifiedTime)'
          + (page ? '&pageToken=' + encodeURIComponent(page) : '');
        const r = await check(await fetch(u, { headers: auth() }));
        const d = await r.json();
        for (const f of (d.files || [])) {
          const m = SNAP_RE.exec(f.name || '');
          if (!m) continue;
          out.push({ id: f.id, name: f.name, writerId: m[1],
            generation: Number(m[2]), modifiedTime: f.modifiedTime });
        }
        page = d.nextPageToken || '';
        if (!page) break;
      }
      return out;
    },

    async readSnapshot(id) {
      const r = await check(await fetch(
        DRIVE_API + '/' + encodeURIComponent(id) + '?alt=media', { headers: auth() }));
      const text = await r.text();
      try { return JSON.parse(text); }
      catch (e) { throw new Error('JSON として読めません'); }
    },

    /*
     * 新しいファイルとして置く。既にあるものは書き換えない。
     * 途中で失敗しても、前の世代がそのまま残る。
     */
    async createSnapshot(snap) {
      const name = 'roppo-' + snap.writerId + '-' + snap.generation + '.json';
      const bound = 'b' + newDeviceId();
      const meta = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
      const body = '--' + bound + '\r\n'
        + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        + JSON.stringify(meta) + '\r\n'
        + '--' + bound + '\r\n'
        + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        + JSON.stringify(snap) + '\r\n'
        + '--' + bound + '--';
      const r = await check(await fetch(
        DRIVE_UPLOAD + '?uploadType=multipart&fields=id,name',
        { method: 'POST',
          headers: { ...auth(), 'Content-Type': 'multipart/related; boundary=' + bound },
          body }));
      return await r.json();
    },

    /*
     * 古い世代を片付ける。自分の最新2つだけ残す。他の端末のものは触らない。
     *
     * 発行元の名前が空のもの（roppo--3.json）も片付ける。端末IDを読む前に
     * 同期が走っていた頃の置き土産で、誰のものとも読めず、残しても使えない。
     * 中身は手元のDBにあるものと同じなので、消して失うものはない。
     */
    async sweep(writerId, keep) {
      const list = await this.listSnapshots();
      const mine = list.filter(f => f.writerId === writerId)
        .sort((a, b) => b.generation - a.generation);
      const drop = mine.slice(Math.max(1, keep || 2));

      try {
        const r = await fetch(DRIVE_API
          + '?spaces=appDataFolder&pageSize=100&fields=files(id,name)',
          { headers: auth() });
        if (r.ok) {
          const d = await r.json();
          for (const f of (d.files || [])) {
            if (/^roppo--\d+\.json$/.test(f.name || '')) drop.push({ id: f.id, name: f.name });
          }
        }
      } catch (e) { /* 片付けられなくても害はない */ }
      for (const f of drop) {
        try {
          await fetch(DRIVE_API + '/' + encodeURIComponent(f.id),
            { method: 'DELETE', headers: auth() });
        } catch (e) { /* 消せなくても害はない。次に片付く */ }
      }
      return drop.length;
    },
  };
}

/* ----------------------------------------------------- 同期：手順 */

/*
 * 同期の段取り。通信先（remote）は外から渡す。
 *
 * remote は3つだけ持つ。Drive でも、試験の偽物でも、同じ形にする。
 *   listSnapshots()        置いてあるものの一覧（{id, writerId, generation}）
 *   readSnapshot(id)       中身を1つ読む
 *   createSnapshot(snap)   新しく1つ置く（既にあるものは書き換えない）
 *
 * 段取り
 *   1. 書きかけを確定する。保存できていないなら進まない
 *   2. 一覧を取り、他の端末のものを最後まで読んで検める
 *   3. その時点のDBを読み直してマージし、一度のトランザクションで反映する
 *   4. 自分の塊を作り、世代番号を1つ進めて置く
 *   5. 置けたら、その世代を確認済みにする
 *
 * 通信をトランザクションの中で待たない。取得と検証は先に済ませる。
 * DBに入れてから置くのに失敗しても、同じ状態からやり直せる。
 */
async function syncOnce(remote, opts) {
  const o = opts || {};
  const say = o.onStep || (() => {});
  const out = { ok: false, why: '', read: 0, skipped: [], conflicts: 0,
    published: false, otherDatasets: [] };

  /*
   * 端末の名前が無いまま進まない。名前は版の項目名にもファイル名にもなるので、
   * 空だと誰の編集か分からなくなり、置いたものも読めなくなる。
   */
  if (!deviceId) { out.why = '端末の準備ができていません'; return out; }

  // 1. 書きかけを確定する
  await flushSave();
  if (!savesAreClean()) {
    out.why = '保存できていないものが ' + unsavedCount() + '件あります';
    return out;
  }
  say('置いてあるものを調べる');

  // 2. 一覧を取り、他の端末のものを読む
  let list;
  try { list = await remote.listSnapshots(); }
  catch (e) { out.why = '一覧を取れません: ' + (e && e.message ? e.message : e); return out; }
  if (!Array.isArray(list)) { out.why = '一覧の形が違います'; return out; }

  // 端末ごとに、いちばん新しい世代だけ読む
  const newest = new Map();
  for (const f of list) {
    if (!f || typeof f.writerId !== 'string') continue;
    if (f.writerId === deviceId) continue;          // 自分のものは読まない
    const cur = newest.get(f.writerId);
    if (!cur || Number(f.generation || 0) > Number(cur.generation || 0)) newest.set(f.writerId, f);
  }

  /*
   * まず全部読んで検める。かたまりの印を決めるのは、読んでからである。
   * 先に自分で印を作ってしまうと、置いてあるものと食い違って合流できない。
   */
  const all = [];
  for (const f of newest.values()) {
    let raw;
    try { raw = await remote.readSnapshot(f.id); }
    catch (e) {
      // 読めないものがあったら止める。空として扱うと、こちらの墓石が相手を消す
      out.why = '読めないものがあります（' + f.writerId + '）: '
        + (e && e.message ? e.message : e);
      return out;
    }
    const v = validateSnapshot(raw);
    if (!v.ok) { out.why = '中身が読めません（' + f.writerId + '）: ' + v.why; return out; }
    all.push(v.snapshot);
  }

  const ds = await adoptDatasetId(all);
  if (!ds.id) { out.why = ds.why || 'かたまりの印を決められません'; return out; }
  const datasetId = ds.id;

  const incoming = [];
  for (const s of all) {
    /*
     * かたまりの印が無いものは混ぜない。
     *
     * 印が空だと「別のかたまり」の判定をすり抜けて、そのまま取り込まれる。
     * どこの誰のものか分からないものを、黙って自分の注釈に混ぜてはいけない。
     */
    if (!s.datasetId) { out.skipped.push(s.writerId + '（かたまりの印が無い）'); continue; }
    if (s.datasetId !== datasetId) {
      out.skipped.push(s.writerId);                  // 別のかたまり。混ぜない
      // どのかたまりを飛ばしたかは持ち帰る。合流するかどうかは利用者が決める
      if (!out.otherDatasets.includes(s.datasetId)) out.otherDatasets.push(s.datasetId);
      continue;
    }
    incoming.push(s);
    out.read++;
  }
  say(out.read + '件を読んだ');

  /*
   * 3. いまのDBを読み直してマージする
   *
   * 読んでから書き戻すまでに保存が挟まると、その編集を古い値で潰す。通信は
   * もう終わっているので、ここは一息で済ませられる。読む前と突き合わせ後で
   * 書き込み回数が変わっていないことを確かめ、変わっていたら読み直す。
   * 突き合わせから applyBulk までは await を挟まない（挟むと同じ隙間ができる）。
   */
  let merged = null;
  for (let tries = 0; tries < 3 && !merged; tries++) {
    await flushSave();
    const before = localWrites;
    const notes = await store.allNotes();
    const ranges = await store.allRanges();
    if (localWrites !== before) continue;        // 読んでいる間に書かれた
    const mine = buildSnapshot({
      notes, ranges, order: lawOrderRec,
      datasetId, writerId: deviceId, generation: 0,
    });
    let m = mine.records;
    for (const s of incoming) m = mergeSnapshots({ records: m }, s);
    merged = m;
  }
  if (!merged) {
    out.why = '編集中のため取り込めませんでした。少し待ってからもう一度どうぞ';
    return out;
  }
  out.conflicts = merged.notes.filter(hasConflict).length
    + merged.ranges.filter(hasConflict).length;

  try {
    await store.applyBulk({
      notes: merged.notes,
      ranges: merged.ranges,
      lawOrder: merged.lawOrder.ids,
      meta: { [LAW_ORDER_KEY]: merged.lawOrder },
    });
  } catch (e) {
    out.why = '取り込めません（何も変えていません）: ' + (e && e.message ? e.message : e);
    return out;
  }
  lawOrderRec = merged.lawOrder;
  lawOrder = merged.lawOrder.ids;
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  /*
   * 開いている編集欄は同期前のオブジェクトを掴んでいる。作り直さないと、
   * 次にそこを編集したときに取り込んだ版や候補を落とす。
   * ただし書きかけを消さないよう、入力中は触らない。
   */
  if (!pendingSave && !pendingRange
    && !(document.activeElement && document.activeElement.closest
      && document.activeElement.closest('#popover'))) {
    renderNotePane();
  }
  say('取り込んだ');

  // 4. 自分の塊を置く
  let gen = 0;
  try {
    const rec = await store.getMeta(GENERATION_KEY);
    gen = Number((rec && rec.value) || 0);
  } catch (e) { /* 0 から */ }
  gen += 1;
  const snap = buildSnapshot({
    notes: merged.notes, ranges: merged.ranges, order: merged.lawOrder,
    // 目録は突き合わせない。置くときに、この端末がいま持っているものを書く
    laws: state.laws,
    datasetId, writerId: deviceId, generation: gen,
  });
  try {
    await remote.createSnapshot(snap);
  } catch (e) {
    // 取り込みは済んでいる。置けなかっただけなので、次に同じ状態から出し直す
    out.why = '取り込みましたが、置けませんでした: ' + (e && e.message ? e.message : e);
    return out;
  }
  /*
   * ほかの端末の目録を覚えておく。
   *
   * 「どの端末に何が入っているか」は、次に同期するまで変わらない。
   * 覚えておけば、通信できないときにも見られる。
   */
  try {
    const inv = {};
    for (const s2 of incoming) {
      if (s2.writerId === deviceId) continue;
      const list = (s2.records && s2.records.laws) || null;
      if (list) inv[s2.writerId] = { at: Date.now(), laws: list };
    }
    if (Object.keys(inv).length) await store.putMeta(LAW_INV_KEY, inv);
  } catch (e) { /* 覚えられなくても同期は済んでいる */ }

  // 5. 置けた世代だけを確認済みにする
  try {
    await store.putMeta(GENERATION_KEY, gen);
    const seen = {};
    for (const s of incoming) seen[s.writerId] = s.generation;
    await store.putMeta(LAST_SEEN_KEY, seen);
    await store.putMeta(LAST_SYNC_KEY, Date.now());
  } catch (e) { /* 記録できなくても、次の同期でやり直せる */ }

  out.ok = true;
  out.published = true;
  say('置いた（世代 ' + gen + '）');
  return out;
}

/** 同期の結果を一言にする。 */
function syncSummary(r) {
  if (!r.ok) return r.why || '同期できませんでした';
  const parts = ['同期しました'];
  /*
   * 0件でも言う。黙っていると「取り込まれたのか、相手が居ないのか」が
   * 分からない。実際にそこで詰まった。
   */
  parts.push(r.read ? '他の端末 ' + r.read + '件を取り込み' : '他の端末のものは見つかりません');
  if (r.conflicts) parts.push('別々に直したものが ' + r.conflicts + '件（両方残しました）');
  if (r.skipped.length) parts.push('別のかたまり ' + r.skipped.length + '件は混ぜていません');
  return parts.join('　/　');
}


/* ----------------------------------------------------- 同期：入口 */

/*
 * 同期の入口。押したときにトークンが無ければ、画面ごと Google へ移る。
 * 戻ってきたら resumeSync が受けて、そのまま続きをやる。押すのは一度でよい。
 *
 * オフラインでは何も起きないので、そう言う。読むのは今までどおりできる。
 */
let syncing = false;

async function doSync() {
  if (syncing) return;
  if (!navigator.onLine) { toast('通信できません。読むのはこのまま続けられます'); return; }

  if (!gAlive()) {
    // 取りに行く。戻ってきたら resumeSync が続きをやる
    toast('Google に接続します…');
    gGo('sync');
    return;
  }
  await runSync();
}

async function runSync() {
  if (syncing) return;
  syncing = true;
  setSyncState('同期しています…');
  try {
    const r = await syncOnce(driveRemote(), { onStep: s => setSyncState(s) });
    toast(syncSummary(r));
    offerJoin(r.otherDatasets);
    if (r.ok) {
      // 置けたら古い世代を片付ける。失敗しても害はない
      try { await driveRemote().sweep(deviceId, 2); } catch (e) { /* 次に片付く */ }
    }
  } catch (e) {
    toast('同期できませんでした: ' + (e && e.message ? e.message : e));
  } finally {
    syncing = false;
    await showLastSync();
  }
}

/** 戻ってきたときに呼ぶ。同期の途中で飛んだなら、そのまま続ける。 */
async function resumeSync() {
  const got = takeAuthFragment();
  const resume = takeResume();
  if (!got) return;
  if (!got.ok) {
    toast('Google に接続できませんでした: ' + got.why
      + (got.why === 'access_denied' ? '（許可が必要です）' : ''));
    return;
  }
  if (resume === 'sync') await runSync();
  else if (resume === 'peek') await peekRemote();
  else toast('Google に接続しました');
}

function setSyncState(s) {
  const el = $('#sync-state');
  if (el) el.textContent = s || '';
}

/*
 * 別のかたまりに分かれてしまったときに、合流する。
 *
 * 印は本来、最初の1台が決めて後から来た端末が合わせるものである。しかし
 * 両方が先に自分の印を作ってしまうと、互いを「別のかたまり」として飛ばし合い、
 * いつまでも揃わない。実際にそうなった。
 *
 * どちらに合わせても中身は失われない。合わせた側も、次に置くときは自分の
 * 持っているもの全部を新しい印で出すためである。だから片方を選べばよい。
 * ただし黙って混ぜない。混ぜてはいけないものだった場合に取り返しがつかない。
 */
let joinTarget = '';

function offerJoin(ids) {
  const btn = $('#btn-join');
  if (!btn) return;
  if (!ids || ids.length !== 1) { joinTarget = ''; btn.hidden = true; return; }
  joinTarget = ids[0];
  btn.hidden = false;
  btn.textContent = '相手のかたまりに合流する';
}

async function doJoin() {
  if (!joinTarget) return;
  const mine = await loadDatasetId();
  if (!confirm('この端末のかたまりを、相手のものに合わせます。\n\n'
    + 'いま: ' + (mine || '（無し）') + '\n'
    + 'あと: ' + joinTarget + '\n\n'
    + '中身は失われません。よろしいですか？')) return;
  try { await store.putMeta(DATASET_KEY, joinTarget); }
  catch (e) { toast('印を変えられません: ' + e.message); return; }
  const btn = $('#btn-join');
  if (btn) btn.hidden = true;
  joinTarget = '';
  toast('合流しました。同期します…');
  await runSync();
}

/*
 * ドライブに何が置いてあるかを見る。同期はしない。
 *
 * 取り込み0件のとき、原因が「相手がまだ置いていない」のか「別のアカウントを
 * 見ている」のかが分からなかった。置いてあるものを見せれば切り分けられる。
 */
/*
 * いまどのアカウントに繋がっているかを聞く。
 * drive.appdata のスコープでも、自分が誰かは答えてもらえる。
 * 取れなければ黙って諦める（これが取れなくても同期はできる）。
 */
async function whoAmI() {
  try {
    const r = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
      { headers: { Authorization: 'Bearer ' + gToken.value } });
    if (!r.ok) return '';
    const d = await r.json();
    return (d && d.user && (d.user.emailAddress || d.user.displayName)) || '';
  } catch (e) { return ''; }
}

async function peekRemote() {
  if (!navigator.onLine) { toast('通信できません'); return; }
  if (!gAlive()) { toast('Google に接続します…'); gGo('peek'); return; }
  const box = $('#sync-peek');
  if (box) { box.hidden = false; box.textContent = '調べています…'; }
  try {
    const who = await whoAmI();
    const list = await driveRemote().listSnapshots();
    const ds = await loadDatasetId();
    const lines = [];
    lines.push('アプリの版: ' + APP_VERSION);
    if (who) lines.push('繋がっているアカウント: ' + who);
    else lines.push('繋がっているアカウント: （分かりません）');
    lines.push('この端末: ' + (deviceId || '（空！　古い版です）')
      + (ds ? '　かたまり: ' + ds : '　かたまり: まだ無し'));

    /*
     * 名前で絞らずに、置いてあるものを生で見せる。
     *
     * 「置いたはずなのに見えない」とき、置けていないのか、名前の形が合わずに
     * こちらが弾いているのかが分からなかった。生の数と名前を出せば分かる。
     */
    try {
      const r = await fetch('https://www.googleapis.com/drive/v3/files'
        + '?spaces=appDataFolder&pageSize=100&fields=files(id,name,size,modifiedTime)',
        { headers: { Authorization: 'Bearer ' + gToken.value } });
      const d = await r.json();
      const fs2 = (d && d.files) || [];
      lines.push('--- 隠し場所の中身（名前で絞らず） ' + fs2.length + '件 ---');
      for (const f of fs2.slice(0, 20)) {
        lines.push('  ' + f.name + '　' + (f.size || '?') + 'バイト　' + (f.modifiedTime || ''));
      }
      if (!fs2.length) lines.push('  （空。置けていません）');
    } catch (e) {
      lines.push('--- 生の一覧を取れません: ' + (e && e.message ? e.message : e));
    }
    lines.push('--- 同期のファイルとして読めたもの ---');

    if (!list.length) {
      lines.push('置いてあるもの: なし');
      lines.push('（相手がまだ同期していないか、別の Google アカウントを見ています）');
      lines.push('※ 両方の端末で、上のアカウントが同じかを確かめてください');
    } else {
      lines.push('置いてあるもの ' + list.length + '件:');
      const by = new Map();
      for (const f of list) {
        const cur = by.get(f.writerId);
        if (!cur || f.generation > cur) by.set(f.writerId, f.generation);
      }
      for (const [w, g] of by) {
        lines.push('  ' + w + '　最新の世代 ' + g + (w === deviceId ? '　（この端末）' : ''));
      }
      /*
       * 置いてあるものの印を覗いて、別のかたまりが居れば合流を出す。
       * 同期を待たずに気づけるようにする。
       */
      /*
       * 見るのは端末ごとの最新世代だけ。古い世代には合流前の印が残っている
       * ので、全部を見ると「別のかたまりが居る」と言い続けてしまう。
       * 同期の側は元から最新だけを見ている。ここだけ揃っていなかった。
       */
      const others = [];
      for (const [w, g] of by) {
        if (w === deviceId) continue;
        const f = list.find(x => x.writerId === w && x.generation === g);
        if (!f) continue;
        try {
          const s = await driveRemote().readSnapshot(f.id);
          if (s && s.datasetId && s.datasetId !== ds && !others.includes(s.datasetId)) {
            others.push(s.datasetId);
          }
        } catch (e) { /* 読めないものは飛ばす */ }
      }
      if (others.length) {
        lines.push('※ 別のかたまりが ' + others.length + '件あります: ' + others.join('、'));
        lines.push('　 「相手のかたまりに合流する」を押すと揃います');
      }
      offerJoin(others);
    }
    if (box) box.textContent = lines.join('\n');
  } catch (e) {
    if (box) box.textContent = '調べられません: ' + (e && e.message ? e.message : e);
  }
}

/** 「最後に同期: …」を出す。 */
async function showLastSync() {
  const el = $('#sync-state');
  if (!el) return;
  let at = 0;
  try {
    const rec = await store.getMeta(LAST_SYNC_KEY);
    at = Number((rec && rec.value) || 0);
  } catch (e) { /* 出さないだけ */ }
  if (!at) { el.textContent = 'まだ同期していません'; return; }
  const min = Math.floor((Date.now() - at) / 60000);
  el.textContent = '最後に同期: '
    + (min < 1 ? 'たった今' : min < 60 ? min + '分前'
      : min < 60 * 24 ? Math.floor(min / 60) + '時間前'
      : new Date(at).toLocaleString('ja-JP'));
}

/* -------------------------------------------------------- 書き出しと復元 */

const BACKUP_VERSION = 1;

function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** 全法令（無加工のXML）と全注釈を1ファイルに。これがあれば完全に戻せる。 */
async function exportBackup() {
  /*
   * 書きかけを先に確定させる。
   *
   * メモは500ms遅れて保存される。待たずに書き出すと、いま打った文が
   * 入らないバックアップができる。それを信じて端末を初期化したら失われる。
   */
  await flushSave();
  const laws = await store.allLaws();
  const notes = await store.allNotes();
  const ranges = await store.allRanges();
  const data = {
    format: 'roppo-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    laws,                 // xml を無加工のまま含む
    notes,                // 条・項・号への注釈
    ranges,               // 文言への注釈
    lawOrder,             // 自分で並べた順。端末を変えても残したい
  };
  // 数えて見せるのは生きているものだけ。墓石はファイルには入るが、数には入れない
  const living = livingOnly(notes).length + livingOnly(ranges).length;
  const tombs = notes.length + ranges.length - living;
  download(`roppo-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  toast(`法令 ${laws.length}件 / 注釈 ${living}件 を書き出しました`
    + (tombs ? `（消した印 ${tombs}件も含む）` : '')
    + (unsavedCount() ? `　※保存できなかったものが ${unsavedCount()}件あります` : ''));
}

/**
 * バックアップから復元する。
 * 注釈は updatedAt が新しい方を残す（古い書き出しで上書きしないため）。
 *
 * 全部を検めてから、一度のトランザクションで書く。以前は1件ずつ別々に
 * 書いていたので、途中で失敗すると半分入った状態が残り、どこまで入ったのかも
 * 分からなかった。注釈は取り返せないので「全部入るか、何も入らないか」にする。
 *
 * 版（version）も見る。知らない版は読まない。部分的に読んで書き戻すと、
 * こちらが知らない項目を消してしまう。
 */
async function importBackup(file) {
  // 書きかけを先に確定させる。手元の新しい内容が「無い」と見なされないように
  await flushSave();

  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('JSONとして読めません'); return; }
  if (data.format !== 'roppo-backup') { toast('このアプリのバックアップではありません'); return; }
  const ver = Number(data.version);
  if (!Number.isFinite(ver) || ver < 1) { toast('版が読み取れません'); return; }
  if (ver > BACKUP_VERSION) {
    toast(`新しい版のバックアップです（版${ver}）。このアプリを更新してください`);
    return;
  }

  /*
   * 比較の相手は IndexedDB を読み直したものにする。
   * state.notes は画面用の写しで、別のタブが書いていると古い。
   */
  const curNotes = await store.allNotes();
  const curRanges = await store.allRanges();
  const curLaws = new Map((await store.allLawMeta()).map(l => [l.lawId, l]));

  let keptNewer = 0;

  const laws = [];
  for (const law of data.laws || []) {
    if (!law.lawId || !law.xml) continue;
    /*
     * 法令XMLは時刻で比べる。本文には版を持たせていない（e-Gov から取り直せる
     * ものなので、編集の前後を追う必要がない）。以前は無条件に上書きしていたので、
     * 古いバックアップを読むと取り込み直した本文が古いものに戻っていた。
     * 取り込んだ規則のように取り直せないものだと、それが実害になる。
     */
    const cur = curLaws.get(law.lawId);
    if (cur && (cur.savedAt || 0) > (law.savedAt || 0)) { keptNewer++; continue; }
    laws.push(law);
  }

  /*
   * 注釈はマージの核に任せる。版があれば版で、無ければ時計で前後を決め、
   * 互いを見ずに編集されたものは両方残す（alts）。
   * ここに判定を書かない。同期でも同じ核を通すので、二重に書くと食い違う。
   */
  const notes = mergeLists(curNotes, data.notes || [], r => r.key);
  const ranges = mergeLists(curRanges, data.ranges || [], r => r.id);
  const conflicts = notes.filter(hasConflict).length + ranges.filter(hasConflict).length;

  /*
   * 並び順も版で比べる。バックアップには配列で入っていることがある
   * （版を入れる前の書き出し）ので、その形も受ける。
   */
  const inOrder = Array.isArray(data.lawOrder)
    ? { ids: data.lawOrder, updatedAt: 0, version: {} }
    : (data.lawOrder && Array.isArray(data.lawOrder.ids) ? data.lawOrder : null);
  let orderRec = null;
  if (inOrder && inOrder.ids.length) {
    const m = mergeRecord({ ...lawOrderRec, key: 'lawOrder' },
      { ...inOrder, key: 'lawOrder' });
    if (m && Array.isArray(m.ids) && m.ids.join() !== lawOrderRec.ids.join()) orderRec = m;
  }
  const order = orderRec ? orderRec.ids : null;

  try {
    await store.applyBulk({ laws, notes, ranges, lawOrder: order, local: true });
  } catch (err) {
    toast('復元できませんでした（何も変えていません）: ' + err.message);
    return;
  }

  for (const law of laws) state.indexCache.delete(law.lawId);
  if (orderRec) {
    lawOrderRec = { ids: orderRec.ids, updatedAt: orderRec.updatedAt || 0,
      version: orderRec.version || {} };
    lawOrder = lawOrderRec.ids;
  }
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  if (P().current) await openLaw(P().current.lawId);
  const living = livingOnly(notes).length + livingOnly(ranges).length;
  toast(`法令 ${laws.length}件 / 注釈 ${living}件 を復元`
    + (keptNewer ? `（本文は手元が新しい ${keptNewer}件を残しました）` : '')
    + (conflicts ? `　※別々に直したものが ${conflicts}件あります（両方残しました）` : '')
    + (unsavedCount() ? `　※保存できなかったものが ${unsavedCount()}件あります` : ''));
}

function openExportDialog() {
  $('#dlg-export').showModal();
}

/* ------------------------------------------- ほかの端末にある法令 */

/*
 * ほかの端末が持っていて、この端末に無い法令を挙げる。
 *
 * 法令XMLは同期しない（数MBあるし、e-Gov から取り直せる）。しかし
 * 「どの端末に何が入っているか」を知る手段が無く、端末ごとに目で
 * 突き合わせるのが手作業になっていた。目録だけは同期に載せてあるので、
 * それを突き合わせて出す。
 *
 * ファイルから取り込んだもの（最高裁判所規則など）は e-Gov に無いので、
 * ここからは取り込めない。そう書いて、ファイルの取り込みへ案内する。
 */
async function missingLaws() {
  let inv = {};
  try {
    const rec = await store.getMeta(LAW_INV_KEY);
    inv = (rec && rec.value) || {};
  } catch (e) { return []; }

  const have = new Set(state.laws.map(l => l.lawId));
  const out = new Map();
  for (const [writer, got] of Object.entries(inv)) {
    for (const l of (got && got.laws) || []) {
      if (!l || !l.lawId || have.has(l.lawId)) continue;
      if (!out.has(l.lawId)) out.set(l.lawId, { ...l, writers: [] });
      out.get(l.lawId).writers.push(writer);
    }
  }
  return [...out.values()]
    .sort((a, b) => String(a.lawTitle).localeCompare(String(b.lawTitle), 'ja'));
}

/** 目録から1本取り込む。e-Gov のものだけ。 */
async function takeMissing(l) {
  const xml = await apiFetchLaw(l.lawId);
  await store.putLaw({
    lawId: l.lawId, lawTitle: l.lawTitle, lawNum: l.lawNum,
    xml, savedAt: Date.now(),
  });
  state.indexCache.delete(l.lawId);
}

async function renderMissing() {
  const box = $('#missing-box');
  const list = $('#missing-list');
  if (!box || !list) return;
  const miss = await missingLaws();
  box.hidden = !miss.length;
  if (!miss.length) return;

  $('#missing-count').textContent = miss.length + '件';
  const egov = miss.filter(l => l.source !== 'file');
  const btnAll = $('#missing-all');
  if (btnAll) {
    btnAll.hidden = !egov.length;
    btnAll.textContent = 'e-Gov のものをまとめて取り込む（' + egov.length + '件）';
  }

  list.innerHTML = '';
  for (const l of miss) {
    const fromFile = l.source === 'file';
    const d = document.createElement('div');
    d.className = 'r';
    d.innerHTML = `<div class="info"><div class="name">${esc(l.lawTitle || l.lawId)}</div>`
      + `<div class="sub">${esc(l.lawNum || '')}`
      + (fromFile ? '　ファイルから取り込んだもの。e-Gov には無い' : '')
      + `</div></div>`
      + (fromFile ? '<button disabled>ファイルから</button>' : '<button>取り込む</button>');
    const btn = d.querySelector('button');
    if (!fromFile) {
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '取得中…';
        try {
          await takeMissing(l);
          await refreshLawList();
          btn.textContent = '取込済';
          toast(`「${l.lawTitle || l.lawId}」を取り込みました`);
          await renderMissing();
        } catch (err) {
          btn.disabled = false; btn.textContent = '再試行';
          toast(err.message);
        }
      };
    }
    list.appendChild(d);
  }
}

/** e-Gov から取れるものをまとめて取り込む。 */
async function takeAllMissing() {
  const miss = (await missingLaws()).filter(l => l.source !== 'file');
  if (!miss.length) return;
  const btn = $('#missing-all');
  let done = 0;
  const failed = [];
  for (const l of miss) {
    if (btn) btn.textContent = '取得中… ' + (done + failed.length + 1) + '/' + miss.length;
    try { await takeMissing(l); done++; }
    catch (e) { failed.push((l.lawTitle || l.lawId) + '：' + e.message); }
  }
  await refreshLawList();
  await renderMissing();
  toast(done + '件を取り込みました'
    + (failed.length ? '　※' + failed.length + '件は取り込めませんでした' : ''));
  if (failed.length) console.warn('取り込めなかったもの', failed);
}

