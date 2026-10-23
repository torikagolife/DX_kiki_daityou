/*** 医療機器DX台帳 ─ 週1の点検期限のお知らせ（メール）********************
 *  weekly.gs
 *
 *  毎週月曜の8時台（設定画面で変えられる）に、いま手を打つべき機器の一覧を1通メールで送ります。
 *  月次サマリー（summary.gs）の週版。数字だけでなく、機器の名前まで並べます。
 *
 *    ⛔ 点検期限切れ        部署点検・業者点検の次回予定日を過ぎた機器
 *    ⚠️ 7日以内に期限       今日から7日以内に期限が来る機器
 *    🔧 長く故障中・修理中  最後の故障報告／故障出しから30日（設定で変更可）を超えた機器
 *    📤 長く貸出中          最後の貸出から14日（設定で変更可）を超えた機器
 *
 *  期限の決まりは due.gs と同じ（台帳ビュー・点検画面と同じ数字になる）。
 *  何も無い週も「該当なし」の1通を送る（仕組みが止まっていないことの確認を兼ねる）。
 *
 *  送る相手
 *    月次サマリーと同じ。故障通知の相手（MAIL_TO ＋ LW_TO_USERS）のうち、メールアドレスの形のもの。
 *
 *  止め方
 *    WEEKLY_OFF に "1"（設定画面の「週1のお知らせを止める」）。LW_OFF（通知を全部止める）でも止まる。
 *
 *  設定画面から変えられるもの（スクリプトプロパティ。空なら下の標準値）
 *    WEEKLY_DAY          送る曜日（MONDAY〜SUNDAY）          標準 MONDAY
 *    WEEKLY_HOUR         送る時台（0〜23）                    標準 8
 *    WEEKLY_BROKEN_DAYS  故障中・修理中が何日を超えたら載せる  標準 30
 *    WEEKLY_LEND_DAYS    貸出中が何日を超えたら載せる          標準 14
 *    ※ 曜日・時台を変えたときは、設定画面の保存で自動送信も付け直す（settings.gs）
 *
 *  はじめにやること（1回だけ）
 *    設定画面の「🗓 週1の点検期限のお知らせ」で「⏰ 自動送信を設定」を押す（または wkInstallTrigger を実行）
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / SHEET … データ層    dueBase_ / dueOf_ / dueToday_ / dueDayNum_ / dueDate_ / dueRuleText_ … due.gs
 *    smRecipients_ … summary.gs    mailFooter_ / MAIL_FROM_NAME / lwProp_ … notify.gs    appUrl_ … web.gs
 **********************************************************************/

// 標準値（スクリプトプロパティが空のときに使う。settings.gs の STG_EDIT の def と同じにしておく）
const WK_DEF_WEEKDAY = 'MONDAY';   // この曜日の
const WK_DEF_HOUR    = 8;          // この時台に送る
const WK_DEF_BROKEN  = 30;         // 故障中・修理中がこの日数を超えたら載せる
const WK_DEF_LEND    = 14;         // 貸出中がこの日数を超えたら載せる
const WK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const WK_LIST_MAX = 50;         // 1つの見出しに並べる上限（超えた分は台数だけ）
const WK_FUNC     = 'weeklyNotice';
const WK_PROP_LAST = 'WK_LAST'; // 最後に送った日（yyyy-MM-dd）。同じ日に二度送らない

function wkLog_(level, message) {
  try { Logger.log('[WEEKLY:' + level + '] ' + message); } catch (e) { /* 気にしない */ }
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (sh) sh.appendRow([new Date(), 'WEEKLY', level, message]);
  } catch (e) { /* 書けなくても本筋には関係ない */ }
}

// いまの設定（おかしな値なら標準値に戻す）
function wkConf_() {
  const num = function (key, def, min, max) {
    const v = String(lwProp_(key) || '').trim();
    const n = Number(v);
    return (v && /^\d+$/.test(v) && n >= min && n <= max) ? n : def;
  };
  const day = String(lwProp_('WEEKLY_DAY') || '').trim().toUpperCase();
  return {
    weekday: WK_DAYS.indexOf(day) >= 0 ? day : WK_DEF_WEEKDAY,
    hour   : num('WEEKLY_HOUR', WK_DEF_HOUR, 0, 23),
    broken : num('WEEKLY_BROKEN_DAYS', WK_DEF_BROKEN, 1, 365),
    lend   : num('WEEKLY_LEND_DAYS', WK_DEF_LEND, 1, 365)
  };
}

function wkToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function wkMd_(s) {
  const m = String(s || '').match(/^\d{4}\/(\d{2})\/(\d{2})/);
  return m ? Number(m[1]) + '/' + Number(m[2]) : String(s || '');
}

/* =============================================================
 *  集計
 * ============================================================= */

function wkCollect_() {
  const conf = wkConf_();
  const base = dueBase_();
  const today = dueToday_();
  const devs = getTable(SHEET.DEV, { fresh: true }).rows
    .filter(function (r) { return String(r['管理番号'] || '').trim(); });

  // 機器ごとの「最後の故障報告／故障出し」と「最後の貸出」
  const lastTrouble = {}, lastLend = {};
  getTable(SHEET.HIS, { fresh: true }).rows.forEach(function (h) {
    const no = String(h['管理番号'] || '');
    const act = String(h['アクションID'] || '');
    const d = dueDate_(h['実施日']) || dueDate_(h['登録日時']);
    if (!no || !d) return;
    if (act === 'ACT005' || act === 'ACT006') {
      if (!lastTrouble[no] || d > lastTrouble[no]) lastTrouble[no] = d;
    } else if (act === 'ACT009') {
      if (!lastLend[no] || d > lastLend[no]) lastLend[no] = d;
    }
  });

  const over = [], week = [], broken = [], lend = [];
  devs.forEach(function (d) {
    const no = String(d['管理番号']);
    const head = { kanriNo: no, name: String(d['機器名'] || ''), dept: String(d['部署名'] || ''),
                   loc: String(d['保管場所名'] || ''), status: String(d['ステータス'] || '') };
    const x = dueOf_(d, base);
    [x.dept, x.maker].forEach(function (k) {
      if (k.level === 'over') over.push(Object.assign({ kind: k.kind, next: k.next, days: k.days }, head));
      if (k.level === 'week') week.push(Object.assign({ kind: k.kind, next: k.next, days: k.days }, head));
    });

    if (head.status === '故障中' || head.status === '修理中') {
      const since = lastTrouble[no];
      const days = since ? today - dueDayNum_(since) : null;
      if (days === null || days > conf.broken) broken.push(Object.assign({ days: days }, head));
    }
    if (head.status === '貸出中') {
      const since = lastLend[no];
      const days = since ? today - dueDayNum_(since) : null;
      if (days === null || days > conf.lend) lend.push(Object.assign({ days: days }, head));
    }
  });

  over.sort(function (a, b) { return a.days - b.days; });          // 過ぎてから長い順
  week.sort(function (a, b) { return a.days - b.days; });          // 近い順
  const longFirst = function (a, b) { return (b.days === null ? 1e9 : b.days) - (a.days === null ? 1e9 : a.days); };
  broken.sort(longFirst);
  lend.sort(longFirst);

  return { over: over, week: week, broken: broken, lend: lend, conf: conf,
           at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd'),
           md: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d') };
}

/* =============================================================
 *  本文
 * ============================================================= */

function wkLines_(list, fmt) {
  const out = list.slice(0, WK_LIST_MAX).map(function (x) { return '  ・' + fmt(x); });
  if (list.length > WK_LIST_MAX) out.push('  ほか ' + (list.length - WK_LIST_MAX) + ' 件（台帳ビューで確認してください）');
  return out;
}

function wkBuild_() {
  const c = wkCollect_();
  const L = [];
  const where = function (x) { return x.dept + (x.loc ? '・' + x.loc : ''); };

  L.push('🗓 医療機器DX台帳 今週の点検期限（' + c.md + ' 時点）');
  L.push('');
  L.push('⛔ 期限切れ ' + c.over.length + ' 件　⚠️ 7日以内 ' + c.week.length + ' 件　'
       + '🔧 長く故障中 ' + c.broken.length + ' 台　📤 長く貸出中 ' + c.lend.length + ' 台');

  const nothing = !c.over.length && !c.week.length && !c.broken.length && !c.lend.length;
  if (nothing) {
    L.push('');
    L.push('🎉 今週、手を打つ必要のある機器はありません。');
  }

  if (c.over.length) {
    L.push('');
    L.push('⛔ 点検期限切れ');
    L.push.apply(L, wkLines_(c.over, function (x) {
      return x.kanriNo + ' ' + x.name + '（' + where(x) + '）' + x.kind + ' ' + wkMd_(x.next) + ' 予定・' + (-x.days) + '日超過';
    }));
  }
  if (c.week.length) {
    L.push('');
    L.push('⚠️ 7日以内に期限');
    L.push.apply(L, wkLines_(c.week, function (x) {
      return x.kanriNo + ' ' + x.name + '（' + where(x) + '）' + x.kind + ' ' + wkMd_(x.next)
           + (x.days === 0 ? '・今日' : '・あと' + x.days + '日');
    }));
  }
  if (c.broken.length) {
    L.push('');
    L.push('🔧 ' + c.conf.broken + '日を超えて故障中・修理中（故障復帰の登録漏れも疑ってください）');
    L.push.apply(L, wkLines_(c.broken, function (x) {
      return x.kanriNo + ' ' + x.name + '（' + where(x) + '）' + x.status
           + (x.days === null ? '・故障報告の記録なし' : '・' + x.days + '日');
    }));
  }
  if (c.lend.length) {
    L.push('');
    L.push('📤 ' + c.conf.lend + '日を超えて貸出中（返却の登録漏れも疑ってください）');
    L.push.apply(L, wkLines_(c.lend, function (x) {
      return x.kanriNo + ' ' + x.name + '（' + where(x) + '）'
           + (x.days === null ? '貸出の記録なし' : x.days + '日');
    }));
  }

  L.push('');
  let url = '';
  try { url = appUrl_(); } catch (e) { url = ''; }
  if (url && lwProp_('MAIL_NO_LINK') !== '1') {
    L.push('▶ 台帳ビュー: ' + url + '?p=ledger');
    L.push('');
  }
  L.push('💡 ' + dueRuleText_());

  const head = nothing ? '該当なし' : ('期限切れ ' + c.over.length + '・7日以内 ' + c.week.length);
  return {
    subject: '【今週の点検期限】医療機器DX台帳 ' + c.md + '（' + head + '）',
    text: L.join('\n'),
    data: c
  };
}

/* =============================================================
 *  送る
 * ============================================================= */

function wkSend_(test) {
  const to = smRecipients_();
  if (!to.length) throw new Error('送る相手がいません（MAIL_TO か LW_TO_USERS に、メールアドレスの形で入れてください）');

  const b = wkBuild_();
  const subject = (test ? '【テスト】' : '') + b.subject;
  const body = b.text + mailFooter_();
  const replyTo = String(lwProp_('MAIL_REPLY_TO') || '').trim();

  let left = Infinity;
  try { left = MailApp.getRemainingDailyQuota(); } catch (e) { /* 見られなくても送ってみる */ }

  const ok = [], ng = [];
  to.forEach(function (addr) {
    if (left <= 0) { ng.push({ id: addr, why: '今日送れる数の上限に達しました' }); return; }
    try {
      const o = { to: addr, subject: subject, body: body, name: MAIL_FROM_NAME };
      if (replyTo) o.replyTo = replyTo;
      MailApp.sendEmail(o);
      ok.push(addr);
      left--;
    } catch (e) {
      ng.push({ id: addr, why: (e && e.message ? e.message : String(e)).slice(0, 200) });
    }
  });

  wkLog_(ok.length ? 'ok' : 'ng', (test ? 'テスト ' : '') + '送信 ' + ok.length + '人'
    + '（期限切れ ' + b.data.over.length + '・7日以内 ' + b.data.week.length
    + '・故障 ' + b.data.broken.length + '・貸出 ' + b.data.lend.length + '）'
    + (ng.length ? '　送れなかった：' + ng.map(function (x) { return x.id; }).join(', ') : ''));
  return { ok: ok, ng: ng, subject: subject };
}

/* ---------- トリガーから呼ばれる（毎週月曜の朝） ---------- */
function weeklyNotice() {
  const props = PropertiesService.getScriptProperties();
  if (lwProp_('LW_OFF') === '1' || lwProp_('WEEKLY_OFF') === '1') {
    wkLog_('skip', '止めているので送りませんでした');
    return;
  }
  const day = wkToday_();
  if (props.getProperty(WK_PROP_LAST) === day) {
    wkLog_('skip', day + ' は送信済みのため省略');
    return;
  }
  try {
    const r = wkSend_(false);
    if (r.ok.length) props.setProperty(WK_PROP_LAST, day);
  } catch (e) {
    wkLog_('ng', (e && e.message) ? e.message : String(e));
    throw e;      // Google側の「トリガー失敗のお知らせ」も出るように
  }
}

/* ---------- 自動送信の付け外し ---------- */

function wkWeekdayName_(day) {
  day = day || wkConf_().weekday;
  const map = { MONDAY: '月曜', TUESDAY: '火曜', WEDNESDAY: '水曜', THURSDAY: '木曜',
                FRIDAY: '金曜', SATURDAY: '土曜', SUNDAY: '日曜' };
  return map[day] || day;
}

function wkInstallTrigger() {
  const conf = wkConf_();
  wkRemoveTrigger();
  ScriptApp.newTrigger(WK_FUNC).timeBased()
    .onWeekDay(ScriptApp.WeekDay[conf.weekday]).atHour(conf.hour).create();
  const msg = '✅ 毎週' + wkWeekdayName_(conf.weekday) + 'の' + conf.hour + '時台に点検期限のお知らせを送るようにしました';
  Logger.log(msg);
  return msg;
}

function wkRemoveTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WK_FUNC) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// 設定画面に出す状態
function wkStatus_() {
  let trig = 0;
  try {
    trig = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === WK_FUNC;
    }).length;
  } catch (e) { trig = -1; }
  const conf = wkConf_();
  return {
    trigger: trig,
    conf: conf,
    when: '毎週' + wkWeekdayName_(conf.weekday) + ' ' + conf.hour + '時台',
    last: String(PropertiesService.getScriptProperties().getProperty(WK_PROP_LAST) || ''),
    to: smRecipients_()
  };
}

/* =============================================================
 *  動作確認（エディタから）
 * ============================================================= */

// 本文をログに出すだけ（送らない）
function weeklyPreview() {
  const b = wkBuild_();
  Logger.log('件名：' + b.subject + '\n送る相手：' + smRecipients_().join(', ') + '\n\n' + b.text);
}

// 件名に【テスト】を付けて全員に送る
function weeklySendTest() {
  const r = wkSend_(true);
  Logger.log('✅ 送った ' + r.ok.length + '人：' + r.ok.join(', ')
    + (r.ng.length ? '\n✖ 送れなかった：' + r.ng.map(function (x) { return x.id + ' ' + x.why; }).join(' / ') : ''));
}
