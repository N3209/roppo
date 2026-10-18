'use strict';

/*
 * 起動。
 *
 * ここだけ別のファイルにしてある。<script> は書いた順に走るので、最後に
 * 読み込まれるファイルが起動を受け持つ。前のファイルで宣言されたものは
 * ここから見えるが、逆は見えない（後ろのファイルの宣言は前のファイルの
 * 実行時点では存在しない）。だから起動は必ず最後に置く。
 *
 * 'use strict' はファイルごとに書く。前のファイルからは引き継がれない。
 */

(async function init() {
  wirePanes();
  wire();
  registerServiceWorker();
  let tab = 'laws';
  try { tab = localStorage.getItem('roppo.tab') || 'laws'; } catch (e) { /* 任意 */ }
  switchTab(tab);
  syncFindPlaceholder();
  let sheetTab = 'jump';
  try { sheetTab = localStorage.getItem('roppo.sheetTab') || 'jump'; } catch (e) { /* 任意 */ }
  switchSheetTab(sheetTab);
  placeControls();
  /*
   * 端末IDと並び順を先に読む。
   *
   * 以前は resumeSync が先だったので、Google から戻ってきたときだけ
   * 端末IDが空のまま同期が走った。名前が roppo--3.json のようになり、
   * 読むときに弾かれて、いつまでも揃わなかった。
   * 同期は「手元の状態が揃ってから」でなければ始められない。
   */
  await loadDeviceId();
  await loadLawOrder();
  await resumeSync();         // Google から戻ってきたなら、同期の続きをやる
  loadAmendState();
  await loadNotes();
  await loadRanges();
  // 条の単位に付いた古い注釈を第1項へ移す（一度だけ。上の注記を見よ）
  await moveArticleNotesOnce();
  await refreshLawList();
  let last = null;
  try { last = localStorage.getItem('roppo.last'); } catch (e) { /* 使えなくても支障ない */ }
  loadLastPos();
  showLastSync();
  const first = (last && state.laws.some(l => l.lawId === last)) ? last
    : (state.laws.length ? state.laws[0].lawId : null);
  if (first) {
    await openLaw(first);
    pushHist({ lawId: first, anchor: null, scrollTop: P().el.scrollTop });
  }
  checkAmendmentsIfStale();     // 通信できるときだけ、1日に1度
  window.addEventListener('pagehide', rememberPos);
})();
