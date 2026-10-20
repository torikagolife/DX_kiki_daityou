/*** 医療機器DX台帳 ─ Cloudflare Workers 版の点検画面むけAPI **************
 *  cfapi.gs   ← 既存のGASプロジェクトにこのファイルを足す
 *
 *  Workers は画面を返すだけで、データは持ちません。
 *  点検も故障報告もファイルも、ぜんぶここを通って
 *  今までどおりスプレッドシートとGoogleドライブに入ります。
 *
 *  ⚠️ このファイルは doPost を定義します。
 *     GASは1プロジェクトに doPost を1つしか持てません。
 *     既に別のファイルで doPost を作っていないか、先に確認してください。
 *     （エディタの検索で「function doPost」を探す）
 *
 *  点検画面のパスワード
 *    Workers は自分ではパスワードを持たず、ここ（action 'login'）に確かめに来ます。
 *    正はスクリプトプロパティ INSPECT_PW の1か所だけ。管理画面の「🛠 設定」から変えられます。
 *    ログイン中のスマホからの呼び出しには「パスワードの目印」（pwv）が付いてくるので、
 *    今の目印と違えば PWCHANGED を返して、ログインし直してもらいます。
 *
 *  使い方
 *    1. スクリプトプロパティに CF_SECRET を1つ入れる
 *         長い文字列なら何でもよい。Workers 側の GAS_SECRET と同じものにする
 *    2. デプロイを管理 → 鉛筆 → 新バージョン → デプロイ
 *       （「次のユーザーとして実行 = 自分」「アクセスできるユーザー = 全員」のまま）
 *    3. /exec のURLを Workers の GAS_URL に入れる
 **********************************************************************/

function cfOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return cfOut_({ error: 'リクエストを読めませんでした' });
  }

  // Workers しか知らない合言葉。ブラウザには渡していない
  const want = PropertiesService.getScriptProperties().getProperty('CF_SECRET');
  if (!want || String(body.secret || '') !== String(want)) {
    return cfOut_({ error: 'AUTH' });
  }

  // パスワードが変わっていたら、ログインし直してもらう
  // （ログイン前の呼び出し＝login・jsqr には pwv が付かないので素通り）
  if (body.pwv && String(body.pwv) !== inspectPwVer_()) {
    return cfOut_({ error: 'PWCHANGED' });
  }

  try {
    return cfOut_({ ok: true, data: cfDispatch_(body) });
  } catch (err) {
    return cfOut_({ error: (err && err.message) ? err.message : String(err) });
  }
}

function cfDispatch_(b) {
  const p = b.payload || {};

  switch (b.action) {

    /* ---- 点検画面のパスワード（正はスクリプトプロパティ INSPECT_PW）---- */
    case 'login': {
      const want = String(PropertiesService.getScriptProperties().getProperty('INSPECT_PW') || '').trim();
      if (!want) throw new Error('点検画面のパスワード（INSPECT_PW）が設定されていません');
      const ok = String(p.pw || '').trim() === want;
      return ok ? { ok: true, ver: inspectPwVer_() } : { ok: false };
    }

    /* ---- 疎通確認 ---- */
    case 'ping':
      return { pong: true, at: fmtDate_(today_()), app: APP_NAME };

    /* ---- QRのライブラリ。jsqr.html の中身をそのまま渡す ---- */
    case 'jsqr':
      return { src: cfJsqrSource_() };

    /* ---- 機器を1台開く ---- */
    case 'device': {
      const ctx = getInspectionContext(p.kanriNo);
      // 点検期限（due.gs）。出せなくても点検はできるように、失敗は null
      if (ctx && ctx.device) ctx.due = dueForDevice_(ctx.device.kanriNo || p.kanriNo);
      return ctx;
    }

    /* ---- 部署ごとの「期限が近い機器」（部署点検だけ）---- */
    case 'due':
      return getDueList(p.dept);

    /* ---- 点検・故障報告 ---- */
    case 'inspect':        return submitInspection(p);
    case 'trouble':        return submitTrouble(p);
    case 'updateInspect':  return updateInspection(p);
    case 'updateTrouble':  return updateTrouble(p);

    /* ---- その他報告（ステータスは変えない）---- */
    case 'other':          return submitOther(p);
    case 'updateOther':    return updateOther(p);

    /* ---- 書類（Googleドライブ）---- */
    case 'files':   return listFiles(p.kanriNo);
    case 'file':    return getFileData(p.fileId);
    case 'upload':  return uploadFile(p);

    /* ---- 代表写真 ---- */
    case 'thumb':   return getThumb(p.kanriNo);
  }
  throw new Error('知らない操作です: ' + b.action);
}

/* jsqr.html は <script> で包まれているので、中身だけ取り出す */
function cfJsqrSource_() {
  const html = HtmlService.createHtmlOutputFromFile('jsqr').getContent();
  const m = html.match(/<script[^>]*>([\s\S]*)<\/script>/i);
  return m ? m[1] : html;
}

/* =====================================================================
 *  動作確認
 *    エディタから実行して、ログに値が出れば中身は動いています。
 *    Workers とつながらないときは、まずこれで切り分け。
 * ===================================================================== */

function cfApiTest() {
  const log = [];
  const sec = PropertiesService.getScriptProperties().getProperty('CF_SECRET');
  log.push('CF_SECRET : ' + (sec ? '設定あり（' + sec.length + '文字）' : '★未設定★'));
  const ipw = PropertiesService.getScriptProperties().getProperty('INSPECT_PW');
  log.push('INSPECT_PW: ' + (ipw ? '設定あり（点検画面はこれでログイン）' : '★未設定★（点検画面に誰も入れません）'));

  log.push('ping      : ' + JSON.stringify(cfDispatch_({ action: 'ping' })));

  const src = cfJsqrSource_();
  log.push('jsqr      : ' + src.length + ' 文字'
    + (src.length > 10000 ? '（取れています）' : '★短すぎます。jsqr.html を確認★'));

  // 手元の1台で getInspectionContext が通るか
  const dev = getTable(SHEET.DEV, { fresh: true }).rows[0];
  if (dev) {
    const no = String(dev['管理番号']);
    const ctx = cfDispatch_({ action: 'device', payload: { kanriNo: no } });
    log.push('device    : ' + no + ' / ' + ctx.device.name
      + ' / 点検項目 ' + (ctx.items || []).length + ' 件'
      + ' / 実施者候補 ' + (ctx.users || []).length + ' 名');
    const fl = cfDispatch_({ action: 'files', payload: { kanriNo: no } });
    log.push('files     : ' + (fl.files || []).length + ' 件');
  } else {
    log.push('device    : ★機器マスタが空です★');
  }

  Logger.log(log.join('\n'));
}
