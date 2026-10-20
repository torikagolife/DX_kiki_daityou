/*** 医療機器DX台帳 ─ バックアップ ************************************
 *  backup.gs（作り直し版）
 *
 *  2つのことをします。
 *
 *    ① 週1回  スプレッドシートを丸ごとコピーして、ドライブのバックアップ用フォルダに置く。
 *             紐づいているスクリプト（.gs / .html）も一緒に複製されるので、
 *             データとコードが同じ時点で1セット残る。
 *    ② 月1回  xlsx に書き出してメールで送る。Googleアカウントの外に1つ置くため。
 *
 *  Apps Script API も、Cloudプロジェクトの設定も要りません。
 *
 *  ───────────────────────────────────────────────
 *  はじめにやること（1回だけ）
 *    1. 下の「設定」の BK_MAIL に送り先を書く
 *    2. appsscript.json の oauthScopes に次の1行を足す（メールを送るため）
 *         "https://www.googleapis.com/auth/script.send_mail"
 *    3. backupCheck を実行して、設定を確かめる
 *    4. backupNow を実行して、コピーが1つできることを確かめる
 *    5. bkInstallTrigger を実行する（毎週月曜の朝5時に自動で回り始める）
 *  ───────────────────────────────────────────────
 *
 *  ⚠️ このファイルは前の backup.gs を丸ごと置き換えます。
 *     前のファイルの中身は全部消して、これを貼ってください。
 **********************************************************************/

/* ---------- 設定 ---------- */

// バックアップを置くフォルダの名前。マイドライブの直下に無ければ作る
const BK_FOLDER = '医療機器DX台帳_バックアップ';

// コピーの名前の頭。これで始まるものだけを世代管理の対象にする
const BK_PREFIX = '医療機器DX台帳_';

// スプレッドシートのコピーを何世代残すか（週1なら8で約2か月）
const BK_KEEP = 8;

// xlsx をメールで送る先。空にすると、メールの代わりにフォルダへ置く
const BK_MAIL = 'ykubota@fff.or.jp';

// フォルダに置く xlsx を何か月ぶん残すか（BK_MAIL が空のときだけ使う）
const BK_XLSX_KEEP = 12;

// 自動で回す曜日と時刻（プロジェクトのタイムゾーン = Asia/Tokyo）
//   曜日は英語の大文字で。MONDAY / TUESDAY / … / SUNDAY
//   ※ ここで ScriptApp を直接書かないこと。ファイルの一番外側に書いた式は、
//     点検画面を開くたびにも毎回評価されるため
const BK_WEEKDAY = 'MONDAY';
const BK_HOUR    = 5;

/* =============================================================
 *  手で動かすもの
 * ============================================================= */

/** いますぐコピーを1つ取る */
function backupNow() {
  const r = bkCopy_();
  bkLog_('ok', r.message);
  Logger.log(r.message);
  return r;
}

/** いますぐ xlsx を送る（またはフォルダに置く） */
function backupXlsxNow() {
  const r = bkXlsx_();
  PropertiesService.getScriptProperties().setProperty('BK_LAST_XLSX', bkMonth_());
  bkLog_('ok', r.message);
  Logger.log(r.message);
  return r;
}

/* =============================================================
 *  トリガーから呼ばれるもの
 *    週1で来る。毎回コピーを取り、月が変わっていたら xlsx も送る。
 *    1回休んでも、次の回で月が変わっていれば送るので取りこぼさない
 * ============================================================= */

function backupScheduled() {
  const done = [];
  try {
    done.push(bkCopy_().message);

    const props = PropertiesService.getScriptProperties();
    const month = bkMonth_();
    if (props.getProperty('BK_LAST_XLSX') !== month) {
      done.push(bkXlsx_().message);
      props.setProperty('BK_LAST_XLSX', month);
    }

    bkLog_('ok', done.join(' / '));
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    bkLog_('ng', msg);
    bkMailFail_(msg, done);
    throw e;            // Google側の「トリガー失敗のお知らせ」も出るように投げ直す
  }
}

/* ---------- トリガーの付け外し ---------- */

/** 毎週の自動実行を設定する。何度実行しても1つだけになる */
function bkInstallTrigger() {
  bkRemoveTrigger();
  ScriptApp.newTrigger('backupScheduled')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[BK_WEEKDAY])
    .atHour(BK_HOUR)
    .create();
  Logger.log('✅ 毎週 ' + bkWeekdayName_(BK_WEEKDAY) + ' ' + BK_HOUR + '時台に動くようにしました');
}

/** 自動実行を止める */
function bkRemoveTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupScheduled') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log(n ? '🧹 自動実行を ' + n + ' 件外しました' : '（外す自動実行はありませんでした）');
}

/* =============================================================
 *  中身
 * ============================================================= */

// ① スプレッドシートを丸ごとコピーする
function bkCopy_() {
  const ss = SpreadsheetApp.getActive();
  const src = DriveApp.getFileById(ss.getId());
  const folder = bkFolder_();

  const name = BK_PREFIX + bkStamp_();
  const copy = src.makeCopy(name, folder);

  const trimmed = bkTrim_(folder, MimeType.GOOGLE_SHEETS, BK_KEEP);
  return {
    url: copy.getUrl(),
    message: '📄 ' + name + ' をコピーしました'
           + (trimmed ? '（🧹 古い ' + trimmed + ' 件をゴミ箱へ）' : '')
  };
}

// ② xlsx に書き出して、メールで送る（送り先が無ければフォルダへ）
function bkXlsx_() {
  const ss = SpreadsheetApp.getActive();
  const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const type = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
  if (code !== 200) {
    throw new Error('xlsx に書き出せませんでした（HTTP ' + code + '）');
  }
  // ログイン画面のHTMLが返ってきたときは、ここで気づく
  if (type.indexOf('text/html') >= 0) {
    throw new Error('xlsx の代わりにHTMLが返ってきました。権限を承認し直してください');
  }

  const name = BK_PREFIX + bkStamp_() + '.xlsx';
  const blob = res.getBlob().setName(name);
  const size = bkSize_(blob.getBytes().length);

  if (BK_MAIL) {
    MailApp.sendEmail({
      to: BK_MAIL,
      subject: '📦 ' + name,
      body: '医療機器DX台帳の月1回のバックアップです。\n\n'
          + 'ファイル : ' + name + '（' + size + '）\n'
          + 'これは Google の外に置くための控えです。\n'
          + '院内のPCやNASなど、Googleアカウントとは別の場所に保存してください。\n\n'
          + '週1回のコピーは、ドライブの「' + BK_FOLDER + '」フォルダにあります。\n',
      attachments: [blob],
    });
    return { message: '📧 ' + name + '（' + size + '）を ' + BK_MAIL + ' へ送りました' };
  }

  const folder = bkFolder_();
  folder.createFile(blob);
  const trimmed = bkTrim_(folder, MimeType.MICROSOFT_EXCEL, BK_XLSX_KEEP);
  return { message: '📁 ' + name + '（' + size + '）をフォルダに置きました'
                  + (trimmed ? '（🧹 古い ' + trimmed + ' 件をゴミ箱へ）' : '')
                  + '。BK_MAIL を設定するとメールで届きます' };
}

/* ---------- 置き場所 ---------- */

function bkFolder_() {
  const it = DriveApp.getFoldersByName(BK_FOLDER);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) return f;
  }
  return DriveApp.createFolder(BK_FOLDER);
}

/* ---------- 古いものを片づける ----------
 *  名前が BK_PREFIX で始まり、種類が mime のものだけを数える。
 *  それ以外（手で置いたメモ、前の版のZIPなど）には触らない。
 *  完全削除はせず、ゴミ箱に移すだけ */
function bkTrim_(folder, mime, keep) {
  const list = [];
  const it = folder.getFilesByType(mime);
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (f.getName().indexOf(BK_PREFIX) !== 0) continue;
    list.push({ file: f, at: f.getDateCreated().getTime() });
  }
  if (list.length <= keep) return 0;

  list.sort(function (a, b) { return b.at - a.at; });   // 新しい順
  let n = 0;
  for (let i = keep; i < list.length; i++) {
    list[i].file.setTrashed(true);
    n++;
  }
  return n;
}

/* ---------- 失敗の知らせ ---------- */

function bkMailFail_(msg, done) {
  try {
    const to = BK_MAIL || bkOwner_();
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: '⚠️ 医療機器DX台帳のバックアップに失敗しました',
      body: '自動バックアップが途中で止まりました。\n\n'
          + '理由 : ' + msg + '\n'
          + (done.length ? '\nここまでは済んでいます :\n  ' + done.join('\n  ') + '\n' : '')
          + '\nスクリプトエディタで backupCheck を実行すると、設定を確かめられます。\n',
    });
  } catch (e) {
    // メールも送れないときは、ログに残るだけでよい
  }
}

// __LOG シートがあれば1行足す（notify.gs と同じ置き場）
function bkLog_(level, message) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (sh) sh.appendRow([new Date(), 'BACKUP', level, message]);
  } catch (e) { /* 書けなくても本筋には関係ない */ }
}

/* ---------- 小物 ---------- */

// 台帳の持ち主のメールアドレス。BK_MAIL が空のときの失敗メールの送り先。
//   Session.getEffectiveUser() は userinfo.email の権限が要るので使わない
//   （appsscript.json のスコープを増やさずに済むように、ドライブの権限で取る）
function bkOwner_() {
  try {
    const o = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getOwner();
    return o ? o.getEmail() : '';
  } catch (e) {
    return '';
  }
}

function bkStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
}

function bkMonth_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMM');
}

function bkSize_(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function bkWeekdayName_(d) {
  const map = { MONDAY: '月曜', TUESDAY: '火曜', WEDNESDAY: '水曜', THURSDAY: '木曜',
                FRIDAY: '金曜', SATURDAY: '土曜', SUNDAY: '日曜' };
  return map[String(d)] || String(d);
}

/* =============================================================
 *  動作確認
 *    何も作らず、いまの状態だけを並べる
 * ============================================================= */

function backupCheck() {
  const log = [];
  const ss = SpreadsheetApp.getActive();

  log.push('台帳       : ' + ss.getName());
  const owner = bkOwner_();
  log.push('持ち主     : ' + (owner || '（取れません）'));

  log.push('');
  log.push('保存先     : ' + BK_FOLDER);
  const it = DriveApp.getFoldersByName(BK_FOLDER);
  if (it.hasNext()) {
    const f = it.next();
    const count = function (mime) {
      let n = 0, last = null;
      const fs = f.getFilesByType(mime);
      while (fs.hasNext()) {
        const x = fs.next();
        if (x.isTrashed() || x.getName().indexOf(BK_PREFIX) !== 0) continue;
        n++;
        if (!last || x.getDateCreated() > last.getDateCreated()) last = x;
      }
      return n + ' 件' + (last ? '（最新 ' + last.getName() + '）' : '');
    };
    log.push('  コピー   : ' + count(MimeType.GOOGLE_SHEETS) + ' / 残す数 ' + BK_KEEP);
    log.push('  xlsx     : ' + count(MimeType.MICROSOFT_EXCEL));
  } else {
    log.push('  （まだありません。backupNow を実行すると作られます）');
  }

  log.push('');
  log.push('メール     : ' + (BK_MAIL || '送らない（xlsx はフォルダに置く）'));
  log.push('失敗の連絡 : ' + (BK_MAIL || owner || '★送り先がありません（BK_MAIL を入れてください）'));
  const last = PropertiesService.getScriptProperties().getProperty('BK_LAST_XLSX');
  log.push('前回のxlsx : ' + (last ? last.slice(0, 4) + '年' + last.slice(4) + '月' : 'まだ'));

  const trg = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'backupScheduled';
  });
  log.push('自動実行   : ' + (trg.length
    ? '✅ 設定あり（毎週 ' + bkWeekdayName_(BK_WEEKDAY) + ' ' + BK_HOUR + '時台）'
    : '★ 未設定（bkInstallTrigger を実行してください）'));
  if (trg.length > 1) log.push('             ★ ' + trg.length + ' 個あります。bkInstallTrigger を実行すると1つにまとまります');

  Logger.log(log.join('\n'));
}
