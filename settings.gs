/*** 医療機器DX台帳 ─ 設定画面 ****************************************
 *  settings.gs
 *
 *  管理画面の「🛠 設定」から、スクリプトプロパティの一部を変えられるようにします。
 *
 *    ① 変えられるもの（日常の運用で触るもの）
 *         LW_TO_USERS   LINE WORKS で通知を受け取る人
 *         MAIL_TO       メールで通知を受け取る人
 *         MAIL_REPLY_TO メールの返信先
 *         LW_OFF        通知を全部止める
 *         MAIL_OFF      メールだけ止める
 *         MAIL_NO_LINK  メールに管理画面のリンクを入れない
 *         INSPECT_PW    点検画面のパスワード（GAS版も Cloudflare 版も、これ1つを見る）
 *         SUMMARY_OFF   月次サマリーを止める
 *         WEEKLY_OFF    週1の点検期限のお知らせを止める
 *         WEEKLY_DAY / WEEKLY_HOUR / WEEKLY_BROKEN_DAYS / WEEKLY_LEND_DAYS
 *                       週1のお知らせの曜日・時台・「長く故障中」「長く貸出中」の日数
 *                       （空なら標準値。曜日・時台を変えたら、自動送信が付いていれば付け直す）
 *    ＋ 月次サマリー（summary.gs）の自動送信の付け外し・プレビュー・テスト送信
 *    ＋ 週1の点検期限のお知らせ（weekly.gs）の自動送信の付け外し・プレビュー・テスト送信
 *    ＋ バックアップ（backup.gs）の状態・いますぐバックアップ・自動実行の付け外し
 *         BK_KEEP       バックアップを何世代残すか（空なら backup.gs の標準値 4。減らしたら保存の時点で古い分をゴミ箱へ）
 *    ② 見るだけ（「設定あり／なし」だけ。値は画面に出さない）
 *         LINE WORKS の接続情報・パスワード類・合言葉など
 *    ③ 変更の記録
 *         誰が・いつ・何を変えたかを __LOG に「SETTINGS」として残す
 *
 *  ⚠️ ここに無いプロパティは、画面からは読むことも書くこともできません。
 *     管理画面のパスワード（ADMIN_PW）と TOKEN_SECRET は、これまでどおり
 *     スクリプトエディタの「プロジェクトの設定」から変えます。
 *     （変え間違えると管理者が全員締め出されるため、画面からは触らせない）
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / withLock / SHEET / ACTIVE … データ層
 *    lwRecipients_ / lwSendText_ / lwPrivateKey_ / lwResultText_ / lwNow_ … notify.gs
 *    mailRecipients_ / mailLooksOk_ / mailSendText_ / mailResultText_   … notify.gs
 **********************************************************************/

/* ---------- ① 変えられるもの ---------- */
//   type : list（1行1件）/ text（1行）/ flag（オン・オフ。オンで "1"、オフで削除）
//          secret（パスワード。空にはできない。記録には値を残さない）
const STG_EDIT = [
  { key: 'LW_TO_USERS',   type: 'list', group: 'lw',
    label: 'LINE WORKS で受け取る人', icon: '💬',
    hint: 'LINE WORKS のログインID（例：yamada@hospital-example）。1行に1人。' },
  { key: 'MAIL_TO',       type: 'list', group: 'mail',
    label: 'メールで受け取る人', icon: '✉️',
    hint: 'LINE WORKS を使っていない人（業者・院外・PC中心の人）のメールアドレス。1行に1人。' },
  { key: 'MAIL_REPLY_TO', type: 'text', group: 'mail',
    label: 'メールの返信先', icon: '↩️',
    hint: '空なら、送信元（このシステムを作ったGoogleアカウント）に返信が届きます。' },
  { key: 'MAIL_NO_LINK',  type: 'flag', group: 'mail',
    label: 'メールに管理画面のリンクを入れない', icon: '🔗',
    hint: '院外の人だけに送るときはオンが安心です（リンクを開いてもパスワードが無ければ入れません）。' },
  { key: 'MAIL_OFF',      type: 'flag', group: 'stop',
    label: 'メールだけ止める', icon: '⏸',
    hint: 'LINE WORKS はそのまま届きます。' },
  { key: 'LW_OFF',        type: 'flag', group: 'stop',
    label: '通知を全部止める', icon: '⛔',
    hint: 'LINE WORKS もメールも止まります。記録とステータスの更新は今までどおり動きます。' },
  { key: 'SUMMARY_OFF',   type: 'flag', group: 'stop',
    label: '月次サマリーを止める', icon: '📊',
    hint: '毎月1日の月次サマリーのメールだけ止まります。故障の通知はそのまま届きます。' },
  { key: 'WEEKLY_OFF',    type: 'flag', group: 'stop',
    label: '週1の点検期限のお知らせを止める', icon: '🗓',
    hint: '週1の点検期限のお知らせのメールだけ止まります。故障の通知はそのまま届きます。' },
  // 週1のお知らせ（weekly.gs）。def は weekly.gs の WK_DEF_* と同じにしておく
  { key: 'WEEKLY_DAY',    type: 'select', group: 'weekly', def: 'MONDAY',
    label: '週1のお知らせを送る曜日', icon: '📅', hint: '',
    options: [['MONDAY', '月曜'], ['TUESDAY', '火曜'], ['WEDNESDAY', '水曜'], ['THURSDAY', '木曜'],
              ['FRIDAY', '金曜'], ['SATURDAY', '土曜'], ['SUNDAY', '日曜']] },
  { key: 'WEEKLY_HOUR',   type: 'select', group: 'weekly', def: '8',
    label: '週1のお知らせを送る時間', icon: '⏰', hint: 'Google の都合で、その時台のどこかで届きます（8時台なら 8:00〜8:59）。',
    options: Array.from({ length: 24 }, function (_, h) { return [String(h), h + '時台']; }) },
  { key: 'WEEKLY_BROKEN_DAYS', type: 'num', group: 'weekly', def: '30', min: 1, max: 365, unit: '日',
    label: '週1のお知らせ：故障中・修理中がこの日数を超えたら載せる', icon: '🔧', hint: '' },
  { key: 'WEEKLY_LEND_DAYS',   type: 'num', group: 'weekly', def: '14', min: 1, max: 365, unit: '日',
    label: '週1のお知らせ：貸出中がこの日数を超えたら載せる', icon: '📤', hint: '' },
  // バックアップ（backup.gs）。def は backup.gs の BK_KEEP と同じにしておく
  { key: 'BK_KEEP',       type: 'num', group: 'backup', def: '4', min: 1, max: 52, unit: '世代',
    label: 'バックアップを残す世代数', icon: '💾',
    hint: '週1回コピーするので、4世代で約1か月前まで戻れます。減らすと、保存した時点で古いコピーをゴミ箱へ入れます。' },
  { key: 'INSPECT_PW',    type: 'secret', group: 'pw',
    label: '点検画面のパスワード', icon: '🔑',
    hint: '現場共通のパスワード。GAS版と Cloudflare 版の点検画面の両方がこれを使います。'
        + '変えると、ログイン中のスマホは次の操作でログイン画面に戻ります。' },
];
const STG_PW_MIN = 4;             // 点検パスワードの長さ
const STG_PW_MAX = 64;

/* ---------- ② 見るだけ ---------- */
const STG_VIEW = [
  { key: 'LW_CLIENT_ID',       label: 'LINE WORKS Client ID',        need: 'lw' },
  { key: 'LW_CLIENT_SECRET',   label: 'LINE WORKS Client Secret',    need: 'lw' },
  { key: 'LW_SERVICE_ACCOUNT', label: 'LINE WORKS サービスアカウント', need: 'lw' },
  { key: 'LW_PRIVATE_KEY',     label: 'LINE WORKS 秘密鍵',            need: 'lw', check: 'key' },
  { key: 'LW_BOT_ID',          label: 'LINE WORKS Bot ID',           need: 'lw' },
  { key: 'LW_CHANNEL_ID',      label: 'トークルームID（旧方式・使わない）', need: '' },
  { key: 'ADMIN_PW',           label: '管理画面のパスワード',          need: 'must' },
  { key: 'TOKEN_SECRET',       label: 'ログイン保持の署名鍵',          need: 'must' },
  { key: 'CF_SECRET',          label: 'Cloudflare との合言葉',         need: 'must' },
  { key: 'DRIVE_ROOT_ID',      label: '書類フォルダのID',              need: '',
    note: '初めて書類ボックスを開いたときに自動で入ります。' },
  { key: 'FAVICON_URL',        label: 'タブのアイコン',                need: '' },
];

const STG_LOG_KIND = 'SETTINGS';
const STG_LOG_SHOW = 30;          // 画面に出す変更の記録の件数
const STG_MAX_LIST = 50;          // 一覧に入れられる人数の上限（打ち間違いの貼り付け事故よけ）

function stgProps_() { return PropertiesService.getScriptProperties(); }

/* =============================================================
 *  値の読み書き（形をそろえる）
 * ============================================================= */

// 一覧はカンマ・読点・空白・改行のどれで区切ってあっても読む（notify.gs と同じ）
function stgSplit_(s) {
  return String(s || '')
    .split(/[\s,、，;；]+/)
    .map(function (x) { return x.trim(); })
    .filter(String);
}

// 画面に渡す形
function stgRead_(def, raw) {
  raw = raw == null ? '' : String(raw);
  if (def.type === 'list') return stgSplit_(raw);
  if (def.type === 'flag') return raw === '1';
  return raw.trim();
}

// 保存する形（空なら null ＝ プロパティを消す）
function stgWrite_(def, v) {
  if (def.type === 'list') {
    const arr = Array.isArray(v) ? v : stgSplit_(v);
    return arr.length ? arr.join(',') : null;
  }
  if (def.type === 'flag') return v ? '1' : null;
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
}

// いまの値から作る目印。読み込んでから保存するまでに、ほかの人が変えていないかを見る
function stgStamp_(all) {
  const src = STG_EDIT.map(function (d) { return d.key + '=' + (all[d.key] || ''); }).join('\n');
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, src, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

/* =============================================================
 *  画面に渡すもの
 * ============================================================= */

function getSettings() {
  const all = stgProps_().getProperties();

  const edit = STG_EDIT.map(function (d) {
    return { key: d.key, type: d.type, group: d.group, label: d.label, icon: d.icon,
             hint: d.hint, value: stgRead_(d, all[d.key]),
             def: d.def || '', min: d.min, max: d.max, unit: d.unit || '', options: d.options || null };
  });

  const view = STG_VIEW.map(function (d) {
    const has = !!String(all[d.key] || '').trim();
    let state = has ? 'ok' : (d.need === 'must' ? 'ng' : (d.need === 'lw' ? 'warn' : 'none'));
    let detail = '';
    if (has && d.check === 'key') {
      try { lwPrivateKey_(); detail = '読めます'; }
      catch (e) { state = 'ng'; detail = '読めません：' + e.message; }
    }
    return { key: d.key, label: d.label, state: state, detail: detail, note: d.note || '' };
  });

  // メールの残り送信数（権限が無いとここで分かる）
  let quota = null, quotaErr = '';
  try { quota = MailApp.getRemainingDailyQuota(); }
  catch (e) { quotaErr = 'メール送信の許可がありません（エディタで mailSendTest を実行して承認してください）'; }

  return {
    edit    : edit,
    view    : view,
    stamp   : stgStamp_(all),
    quota   : quota,
    quotaErr: quotaErr,
    users   : stgUsers_(),
    log     : stgLogRead_(STG_LOG_SHOW),
    maxList : STG_MAX_LIST,
    summary : stgSummaryStatus_(),
    weekly  : stgWeeklyStatus_(),
    backup  : stgBackupStatus_()
  };
}

/* =============================================================
 *  バックアップ（backup.gs）の状態と操作
 *    backup.gs には手を入れず、その定数と関数をここから使う
 * ============================================================= */

const STG_BK_STALE_DAYS = 8;     // 最後のコピーがこれより古ければ「止まっているかも」と出す

function stgBackupStatus_() {
  try {
    if (typeof BK_FOLDER === 'undefined') return null;      // backup.gs が無い
    const out = {
      folder: BK_FOLDER, keep: (typeof bkKeep_ === 'function' ? bkKeep_() : BK_KEEP), mail: BK_MAIL || '', when: '',
      trigger: 0, copies: 0, last: '', lastAt: '', ageDays: null, stale: false,
      xlsx: 0, lastXlsxMonth: String(stgProps_().getProperty('BK_LAST_XLSX') || ''),
      url: ''
    };
    try { out.when = '毎週' + bkWeekdayName_(BK_WEEKDAY) + ' ' + BK_HOUR + '時台'; } catch (e) {}
    try {
      out.trigger = ScriptApp.getProjectTriggers().filter(function (t) {
        return t.getHandlerFunction() === 'backupScheduled';
      }).length;
    } catch (e) { out.trigger = -1; }

    const it = DriveApp.getFoldersByName(BK_FOLDER);
    let folder = null;
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) { folder = f; break; } }
    if (!folder) return out;
    out.url = folder.getUrl();

    const scan = function (mime) {
      let n = 0, last = null;
      const fs = folder.getFilesByType(mime);
      while (fs.hasNext()) {
        const x = fs.next();
        if (x.isTrashed() || x.getName().indexOf(BK_PREFIX) !== 0) continue;
        n++;
        if (!last || x.getDateCreated() > last.getDateCreated()) last = x;
      }
      return { n: n, last: last };
    };
    const sh = scan(MimeType.GOOGLE_SHEETS);
    out.copies = sh.n;
    if (sh.last) {
      const at = sh.last.getDateCreated();
      out.last = sh.last.getName();
      out.lastAt = Utilities.formatDate(at, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
      out.ageDays = Math.floor((Date.now() - at.getTime()) / 86400000);
      out.stale = out.ageDays > STG_BK_STALE_DAYS;
    }
    out.xlsx = scan(MimeType.MICROSOFT_EXCEL).n;
    return out;
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 画面のボタンから
 *   act = 'now'（いますぐコピー）/ 'install'（自動実行を設定）/ 'remove'（外す）/ 'status'（見るだけ）
 */
function settingsBackup(act, userId) {
  if (typeof BK_FOLDER === 'undefined') throw new Error('backup.gs が入っていません');
  if (act === 'status') return { msg: '', status: stgBackupStatus_() };
  if (!userId) throw new Error('操作する人を選んでください');
  const who = stgUserLabel_(userId);
  let msg = '';
  if (act === 'now') {
    const r = backupNow();
    msg = (r && r.message) ? r.message : '📄 コピーしました';
    stgLog_('💾 いますぐバックアップ　by ' + who + '\n' + msg);
  } else if (act === 'install') {
    bkInstallTrigger();
    msg = '✅ 毎週' + bkWeekdayName_(BK_WEEKDAY) + ' ' + BK_HOUR + '時台に自動でコピーするようにしました';
    stgLog_('💾 バックアップの自動実行を設定　by ' + who);
  } else if (act === 'remove') {
    bkRemoveTrigger();
    msg = '🧹 バックアップの自動実行を外しました';
    stgLog_('💾 バックアップの自動実行を外しました　by ' + who);
  } else {
    throw new Error('知らない操作です: ' + act);
  }
  return { msg: msg, status: stgBackupStatus_() };
}

// 月次サマリーの状態（summary.gs が無くても設定画面は開けるように）
function stgSummaryStatus_() {
  try { return smStatus_(); } catch (e) { return null; }
}

/* =============================================================
 *  月次サマリー（summary.gs）を画面から動かす
 *    act = 'install'（自動送信を設定）/ 'remove'（外す）/ 'preview'（本文を見る）/ 'test'（テスト送信）
 * ============================================================= */

function settingsSummary(act, userId) {
  if (!userId) throw new Error('操作する人を選んでください');
  const who = stgUserLabel_(userId);
  if (act === 'install') {
    const msg = smInstallTrigger();
    stgLog_('📊 月次サマリーの自動送信を設定　by ' + who);
    return { msg: msg, status: smStatus_() };
  }
  if (act === 'remove') {
    const n = smRemoveTrigger();
    stgLog_('📊 月次サマリーの自動送信を外しました　by ' + who);
    return { msg: n ? '🧹 自動送信を外しました' : '（外す自動送信はありませんでした）', status: smStatus_() };
  }
  if (act === 'preview') {
    const b = smBuild_(smPrevMonth_());
    return { msg: '件名：' + b.subject + '\n\n' + b.text, status: smStatus_() };
  }
  if (act === 'test') {
    const r = smSend_(smPrevMonth_(), true);
    const text = '✅ 送った : ' + r.ok.length + ' 人' + (r.ok.length ? '\n    ' + r.ok.join('\n    ') : '')
      + (r.ng.length ? '\n✖ 送れなかった : ' + r.ng.length + ' 人\n    '
         + r.ng.map(function (x) { return x.id + ' : ' + x.why; }).join('\n    ') : '');
    stgLog_('🧪 月次サマリー テスト送信　by ' + who + '\n' + text);
    return { msg: text, status: smStatus_() };
  }
  throw new Error('知らない操作です: ' + act);
}

// 週1のお知らせの状態（weekly.gs が無くても設定画面は開けるように）
function stgWeeklyStatus_() {
  try { return wkStatus_(); } catch (e) { return null; }
}

/* =============================================================
 *  週1の点検期限のお知らせ（weekly.gs）を画面から動かす
 *    act = 'install' / 'remove' / 'preview'（今の時点の本文を見る）/ 'test'（テスト送信）
 * ============================================================= */

function settingsWeekly(act, userId) {
  if (!userId) throw new Error('操作する人を選んでください');
  const who = stgUserLabel_(userId);
  if (act === 'install') {
    const msg = wkInstallTrigger();
    stgLog_('🗓 週1の点検期限のお知らせの自動送信を設定　by ' + who);
    return { msg: msg, status: wkStatus_() };
  }
  if (act === 'remove') {
    const n = wkRemoveTrigger();
    stgLog_('🗓 週1の点検期限のお知らせの自動送信を外しました　by ' + who);
    return { msg: n ? '🧹 自動送信を外しました' : '（外す自動送信はありませんでした）', status: wkStatus_() };
  }
  if (act === 'preview') {
    const b = wkBuild_();
    return { msg: '件名：' + b.subject + '\n\n' + b.text, status: wkStatus_() };
  }
  if (act === 'test') {
    const r = wkSend_(true);
    const text = '✅ 送った : ' + r.ok.length + ' 人' + (r.ok.length ? '\n    ' + r.ok.join('\n    ') : '')
      + (r.ng.length ? '\n✖ 送れなかった : ' + r.ng.length + ' 人\n    '
         + r.ng.map(function (x) { return x.id + ' : ' + x.why; }).join('\n    ') : '');
    stgLog_('🧪 週1の点検期限のお知らせ テスト送信　by ' + who + '\n' + text);
    return { msg: text, status: wkStatus_() };
  }
  throw new Error('知らない操作です: ' + act);
}

// 変更者として選べる人（ユーザーマスタの有効な人）
function stgUsers_() {
  try {
    return getTable(SHEET.USR, { fresh: true }).rows
      .filter(function (r) { return String(r['有効']) === ACTIVE; })
      .map(function (r) {
        return { id: String(r['職員番号']), name: String(r['ユーザー名'] || ''),
                 dept: String(r['部署名'] || '') };
      });
  } catch (e) {
    return [];
  }
}

function stgUserLabel_(userId) {
  const u = stgUsers_().filter(function (x) { return x.id === String(userId); })[0];
  return u ? (u.name + '（' + u.id + '）') : String(userId);
}

/* =============================================================
 *  入力チェック
 *    1つでも引っかかったら、何も保存しない
 * ============================================================= */

function stgValidate_(next) {
  const errs = [];

  // LINE WORKS のID：空白なし。重複は1つにまとめる（大文字小文字は同じ扱い）
  const lw = stgDedup_(next.LW_TO_USERS || []);
  lw.forEach(function (u) {
    if (/[\s<>"']/.test(u)) errs.push('💬 LINE WORKS のIDに使えない文字があります：' + u);
  });
  if (lw.length > STG_MAX_LIST) errs.push('💬 LINE WORKS で受け取る人が多すぎます（' + STG_MAX_LIST + '人まで）');

  // メール：アドレスの形
  const mail = stgDedup_(next.MAIL_TO || []);
  mail.forEach(function (a) {
    if (!mailLooksOk_(a)) errs.push('✉️ メールアドレスの形になっていません：' + a);
  });
  if (mail.length > STG_MAX_LIST) errs.push('✉️ メールで受け取る人が多すぎます（' + STG_MAX_LIST + '人まで）');

  // 両方に入っている人は二重に届く
  const lwLow = lw.map(function (x) { return x.toLowerCase(); });
  mail.forEach(function (a) {
    if (lwLow.indexOf(a.toLowerCase()) >= 0) {
      errs.push('⚠️ ' + a + ' が LINE WORKS とメールの両方に入っています（二重に届きます）。どちらか一方にしてください');
    }
  });

  // 返信先
  const rt = String(next.MAIL_REPLY_TO || '').trim();
  if (rt && !mailLooksOk_(rt)) errs.push('↩️ 返信先がメールアドレスの形になっていません：' + rt);

  // 点検画面のパスワード
  if (Object.prototype.hasOwnProperty.call(next, 'INSPECT_PW')) {
    const pw = String(next.INSPECT_PW == null ? '' : next.INSPECT_PW).trim();
    if (!pw) {
      errs.push('🔑 点検画面のパスワードは空にできません');
    } else if (pw.length < STG_PW_MIN || pw.length > STG_PW_MAX) {
      errs.push('🔑 点検画面のパスワードは ' + STG_PW_MIN + '〜' + STG_PW_MAX + ' 文字にしてください');
    } else if (/\s/.test(pw)) {
      errs.push('🔑 点検画面のパスワードに空白は使えません');
    } else if (pw === String(stgProps_().getProperty('ADMIN_PW') || '').trim()) {
      // 同じにすると、現場のパスワードで管理画面まで入れてしまう
      errs.push('🔑 点検画面のパスワードを、管理画面のパスワードと同じにはできません');
    }
    next.INSPECT_PW = pw;
  }

  // 数字・選択（週1のお知らせ）：標準値と同じなら空（＝プロパティを消す）にしておく
  STG_EDIT.forEach(function (d) {
    if (d.type !== 'num' && d.type !== 'select') return;
    if (!Object.prototype.hasOwnProperty.call(next, d.key)) return;
    let v = String(next[d.key] == null ? '' : next[d.key]).trim();
    if (d.type === 'num') {
      v = v.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      if (v && (!/^\d+$/.test(v) || Number(v) < d.min || Number(v) > d.max)) {
        errs.push(d.icon + ' ' + d.label + 'は ' + d.min + '〜' + d.max + ' の数字にしてください：' + v);
      } else if (v) {
        v = String(Number(v));
      }
    } else if (v && !d.options.some(function (o) { return o[0] === v; })) {
      errs.push(d.icon + ' ' + d.label + 'の値がおかしいです：' + v);
    }
    next[d.key] = (v === d.def) ? '' : v;
  });

  // 画面から来た項目だけ書き戻す（来ていない項目を空として保存しないように）
  if (Object.prototype.hasOwnProperty.call(next, 'LW_TO_USERS')) next.LW_TO_USERS = lw;
  if (Object.prototype.hasOwnProperty.call(next, 'MAIL_TO')) next.MAIL_TO = mail;
  if (Object.prototype.hasOwnProperty.call(next, 'MAIL_REPLY_TO')) next.MAIL_REPLY_TO = rt;
  return errs;
}

function stgDedup_(arr) {
  const seen = {};
  return (Array.isArray(arr) ? arr : stgSplit_(arr))
    .map(function (x) { return String(x).trim(); })
    .filter(function (x) {
      if (!x) return false;
      const k = x.toLowerCase();
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
}

/* =============================================================
 *  保存
 *    p = { userId, stamp, values: { LW_TO_USERS:[…], MAIL_TO:[…], MAIL_REPLY_TO:'', LW_OFF:true, … } }
 *    変わった項目だけ書き換え、変わった中身を __LOG に残す
 * ============================================================= */

function saveSettings(p) {
  p = p || {};
  if (!p.userId) throw new Error('変更する人を選んでください');
  const v = p.values || {};

  // 画面から来た値のうち、変えてよい項目だけを拾う（それ以外は黙って捨てる）
  const next = {};
  STG_EDIT.forEach(function (d) {
    if (Object.prototype.hasOwnProperty.call(v, d.key)) next[d.key] = v[d.key];
  });

  const errs = stgValidate_(next);
  if (errs.length) throw new Error(errs.join('\n'));

  const who = stgUserLabel_(p.userId);

  const result = withLock(function () {
    const props = stgProps_();
    const all = props.getProperties();

    if (p.stamp && p.stamp !== stgStamp_(all)) {
      throw new Error('ほかの人が先に設定を変えました。画面を読み込み直してから、もう一度変えてください');
    }

    const changes = [];
    STG_EDIT.forEach(function (d) {
      if (!Object.prototype.hasOwnProperty.call(next, d.key)) return;
      const before = all[d.key] == null ? null : String(all[d.key]);
      const after  = stgWrite_(d, next[d.key]);
      const same = (before || null) === after ||
                   (d.type === 'list' && stgSplit_(before).join(',') === (after || ''));
      if (same) return;

      if (after === null) props.deleteProperty(d.key);
      else props.setProperty(d.key, after);
      changes.push(stgDiffText_(d, before, after));
    });

    if (changes.length) {
      changes.forEach(function (c) { stgLog_(c + '　by ' + who); });
    }
    return { changed: changes, stamp: stgStamp_(props.getProperties()),
             wkMoved: changes.some(function (c) { return /（WEEKLY_(DAY|HOUR)）/.test(c); }),
             bkKeep : changes.some(function (c) { return /（BK_KEEP）/.test(c); }) };
  });

  // 週1のお知らせの曜日・時台を変えたら、自動送信が付いていれば新しい曜日・時台で付け直す
  if (result.wkMoved) {
    try {
      const st = wkStatus_();
      if (st.trigger > 0) {
        wkInstallTrigger();
        const m = '🗓 週1のお知らせの自動送信を ' + wkStatus_().when + ' に付け直しました';
        stgLog_(m + '　by ' + who);
        result.changed.push(m);
      }
    } catch (e) {
      result.changed.push('⚠️ 週1のお知らせの自動送信を付け直せませんでした（設定画面で「⏰ 自動送信を設定」を押してください）：' + e.message);
    }
  }
  // バックアップの世代数を変えたら、その場で多すぎる古いコピーをゴミ箱へ
  if (result.bkKeep) {
    try {
      const n = bkTrimNow_();
      if (n) {
        const m = '💾 古いバックアップ ' + n + ' 件をゴミ箱へ入れました（残す数 ' + bkKeep_() + '）';
        stgLog_(m + '　by ' + who);
        result.changed.push(m);
      }
    } catch (e) {
      result.changed.push('⚠️ 古いバックアップを片付けられませんでした（次の自動バックアップのときに片付きます）：' + e.message);
    }
  }
  delete result.wkMoved;
  delete result.bkKeep;
  return result;
}

// 変更の中身を人が読める形にする（追加・削除を分けて書く）
function stgDiffText_(def, before, after) {
  const name = def.icon + ' ' + def.label + '（' + def.key + '）';
  if (def.type === 'secret') {
    // 値そのものは記録に残さない
    return name + '：変更しました（ログイン中の点検画面は、次の操作でログインし直しになります）';
  }
  if (def.type === 'flag') {
    return name + '：' + (before === '1' ? 'オン' : 'オフ') + ' → ' + (after === '1' ? 'オン' : 'オフ');
  }
  if (def.type === 'list') {
    const b = stgSplit_(before), a = stgSplit_(after);
    const bl = b.map(function (x) { return x.toLowerCase(); });
    const al = a.map(function (x) { return x.toLowerCase(); });
    const add = a.filter(function (x) { return bl.indexOf(x.toLowerCase()) < 0; });
    const del = b.filter(function (x) { return al.indexOf(x.toLowerCase()) < 0; });
    const parts = [];
    if (add.length) parts.push('追加 ' + add.join(', '));
    if (del.length) parts.push('削除 ' + del.join(', '));
    if (!parts.length) parts.push('並び順を変更');
    return name + '：' + parts.join(' ／ ') + '（計 ' + a.length + ' 人）';
  }
  if (def.type === 'num' || def.type === 'select') {
    const show = function (v) {
      const x = v ? v : def.def;
      const o = def.options ? def.options.filter(function (p) { return p[0] === x; })[0] : null;
      return (o ? o[1] : x + (def.unit || '')) + (v ? '' : '（標準）');
    };
    return name + '：' + show(before) + ' → ' + show(after);
  }
  return name + '：' + (before ? before : '（空）') + ' → ' + (after ? after : '（空）');
}

/* =============================================================
 *  変更の記録（__LOG）
 * ============================================================= */

function stgLog_(message) {
  try { Logger.log('[SETTINGS] ' + message); } catch (e) { /* 気にしない */ }
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (sh) sh.appendRow([new Date(), STG_LOG_KIND, 'change', message]);
  } catch (e) { /* 書けなくても保存そのものは済んでいる */ }
}

// __LOG から SETTINGS の行だけ、新しい順に拾う
function stgLogRead_(limit) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    // 古い行まで全部読むと遅いので、末尾の2000行だけ見る
    const from = Math.max(2, last - 1999);
    const width = Math.min(4, sh.getLastColumn());
    const rows = sh.getRange(from, 1, last - from + 1, width).getValues();
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (String(r[1]) !== STG_LOG_KIND) continue;
      const d = r[0] instanceof Date ? r[0] : new Date(r[0]);
      out.push({
        at : isNaN(d.getTime()) ? String(r[0]) : Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
        msg: String(width >= 4 ? r[3] : r[2] || '')
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

/* =============================================================
 *  テスト送信（保存済みの設定で送る）
 * ============================================================= */

function settingsTestLw(userId) {
  if (!userId) throw new Error('テストする人を選んでください');
  if (!lwRecipients_().length && !String(stgProps_().getProperty('LW_CHANNEL_ID') || '')) {
    throw new Error('LINE WORKS で受け取る人が保存されていません');
  }
  let text;
  try {
    const r = lwSendText_('🧪 医療機器DX台帳のテスト送信です（設定画面から）。\n'
      + 'これが見えていれば、LINE WORKS の通知は届きます。\n'
      + '🕘 ' + lwNow_());
    text = lwResultText_(r);
  } catch (e) {
    text = '✖ ' + e.message;
  }
  stgLog_('🧪 LINE WORKS テスト送信　by ' + stgUserLabel_(userId) + '\n' + text);
  return text;
}

function settingsTestMail(userId) {
  if (!userId) throw new Error('テストする人を選んでください');
  if (!mailRecipients_().length) throw new Error('メールで受け取る人が保存されていません');
  let text;
  try {
    const r = mailSendText_('【テスト】医療機器DX台帳の通知テスト',
      '🧪 医療機器DX台帳のテスト送信です（設定画面から）。\n'
      + 'これが届いていれば、メール通知の準備は整っています。\n'
      + '🕘 ' + lwNow_());
    text = mailResultText_(r);
  } catch (e) {
    text = '✖ ' + e.message;
  }
  stgLog_('🧪 メール テスト送信　by ' + stgUserLabel_(userId) + '\n' + text);
  return text;
}
