/*** 医療機器DX台帳 ─ 月次サマリー（幹部向け・メール）********************
 *  summary.gs
 *
 *  毎月1日の朝8時台に、先月のまとめを1通メールで送ります。
 *
 *    ✅ 部署点検   予定 → 実施（実施率）、実施率の低い部署
 *    ⏰ 期限       送った時点の 期限切れ・7日以内・期限が近い（due.gs と同じ決まり）
 *    🔧 故障       先月の 故障報告・故障出し・故障復帰、いま故障中・修理中の機器（30日超を名指し）
 *    💬 その他報告 先月の件数と分類ごとの内訳
 *
 *  送る相手
 *    故障通知と同じ人。MAIL_TO と LW_TO_USERS を合わせて、メールアドレスの形のものだけ。
 *    （LINE WORKS のIDがメールアドレスと同じ形なら、その人にもメールで届く）
 *
 *  止め方
 *    SUMMARY_OFF に "1"（設定画面の「月次サマリーを止める」）。LW_OFF（通知を全部止める）でも止まる。
 *
 *  数え方は「帳票」画面と同じ
 *    実施率の分母は保守点検計画の「予定」（report.gs の getMaintenancePlan）。
 *    システムで記録し始めた月より前は数えない。その月は、スクリプトプロパティ RECORD_SINCE
 *    （例 2026-09）があればそれ、無ければ部署点検の記録がいちばん古い月。
 *
 *  はじめにやること（1回だけ）
 *    設定画面の「📊 月次サマリー」で「⏰ 自動送信を設定」を押す（または smInstallTrigger を実行）
 *
 *  使っているもの（ほかのファイルにある）
 *    getTable / SHEET … データ層    getMaintenancePlan … report.gs
 *    dueBase_ / dueOf_ / dueRuleText_ … due.gs
 *    lwRecipients_ / mailRecipients_ / mailLooksOk_ / lwProp_ … notify.gs    appUrl_ … web.gs
 **********************************************************************/

const SM_DAY      = 1;     // 毎月この日に
const SM_HOUR     = 8;     // この時台に送る
const SM_LONG     = 30;    // 故障中・修理中が何日を超えたら名指しするか
const SM_LOW_DEPT = 3;     // 実施率の低い部署を何件出すか
const SM_MIN_PLAN = 3;     // 部署の実施率は、予定がこの回数以上の部署だけで比べる
const SM_FUNC     = 'summaryMonthly';
const SM_PROP_LAST = 'SM_LAST';      // 最後に送った月（yyyy-MM）。二重送信よけ

/* =============================================================
 *  小道具
 * ============================================================= */

function smYm_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM');
}

// 先月（'yyyy-MM'）
function smPrevMonth_() {
  const s = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM').split('-');
  let y = Number(s[0]), m = Number(s[1]) - 1;
  if (m === 0) { y--; m = 12; }
  return y + '-' + ('0' + m).slice(-2);
}

function smLabel_(ym) {
  const s = String(ym).split('-');
  return Number(s[0]) + '年' + Number(s[1]) + '月';
}

function smPct_(a, b) {
  return b ? Math.round(a / b * 100) + '%' : '—';
}

function smLog_(level, message) {
  try { Logger.log('[SUMMARY:' + level + '] ' + message); } catch (e) { /* 気にしない */ }
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (sh) sh.appendRow([new Date(), 'SUMMARY', level, message]);
  } catch (e) { /* 書けなくても本筋には関係ない */ }
}

// 送る相手：MAIL_TO ＋ LW_TO_USERS のうち、メールアドレスの形のもの（重複は1つ）
function smRecipients_() {
  const seen = {}, out = [];
  mailRecipients_().concat(lwRecipients_()).forEach(function (a) {
    const k = String(a).trim().toLowerCase();
    if (!k || seen[k] || !mailLooksOk_(a)) return;
    seen[k] = 1;
    out.push(String(a).trim());
  });
  return out;
}

// システムで記録し始めた月（'yyyy-MM'）
function smSince_(his) {
  const p = String(lwProp_('RECORD_SINCE') || '').trim();
  if (/^\d{4}-\d{2}$/.test(p)) return p;
  let first = null;
  his.forEach(function (h) {
    if (String(h['アクションID']) !== 'ACT002') return;
    const d = rpDate_(h['実施日']);
    if (d && (!first || d < first)) first = d;
  });
  return first ? smYm_(first) : '';
}

/* =============================================================
 *  集計
 * ============================================================= */

function smCollect_(ym) {
  const parts = String(ym).split('-');
  const y = Number(parts[0]), m = Number(parts[1]);
  const fy = m >= 4 ? y : y - 1;
  const col = (m - 4 + 12) % 12;                     // 年度の何か月目か（4月=0）

  const his = getTable(SHEET.HIS, { fresh: true }).rows;
  const since = smSince_(his);

  /* ---- ✅ 部署点検（帳票の計画と同じ計算）---- */
  const plan = getMaintenancePlan({ fy: fy, scope: 'all', since: since });
  let planN = 0, doneN = 0, extraN = 0;
  const byDept = {};
  plan.list.forEach(function (x) {
    x.rows.forEach(function (r) {
      if (r.kind !== '部署点検') return;
      const c = r.cells[col];
      const dp = x.dev.dept || '部署未設定';
      const b = byDept[dp] = byDept[dp] || { plan: 0, done: 0 };
      if (c === 'PD' || c === 'M') { planN++; b.plan++; }
      if (c === 'PD') { doneN++; b.done++; }
      if (c === 'D') extraN++;
    });
  });
  const beforeSince = since && ym < since;
  const low = Object.keys(byDept)
    .filter(function (k) { return byDept[k].plan >= SM_MIN_PLAN; })
    .map(function (k) { return { dept: k, plan: byDept[k].plan, done: byDept[k].done,
                                 rate: byDept[k].done / byDept[k].plan }; })
    .filter(function (x) { return x.rate < 1; })
    .sort(function (a, b) { return a.rate - b.rate || b.plan - a.plan; })
    .slice(0, SM_LOW_DEPT);

  /* ---- ⏰ 期限（いまの時点。due.gs と同じ決まり）---- */
  const base = dueBase_();
  const devs = getTable(SHEET.DEV, { fresh: true }).rows
    .filter(function (r) { return String(r['管理番号'] || '').trim(); });
  const due = { over: { dev: 0, dept: 0, maker: 0 }, week: { dev: 0, dept: 0, maker: 0 },
                soon: { dev: 0, dept: 0, maker: 0 } };
  devs.forEach(function (d) {
    const x = dueOf_(d, base);
    ['over', 'week', 'soon'].forEach(function (lv) {
      const a = x.dept.level === lv, b = x.maker.level === lv;
      if (a) due[lv].dept++;
      if (b) due[lv].maker++;
      if (a || b) due[lv].dev++;
    });
  });

  /* ---- 🔧 故障・💬 その他報告（先月の履歴）---- */
  const inMonth = function (h) {
    const d = rpDate_(h['実施日']) || rpDate_(h['登録日時']);
    return d && smYm_(d) === ym;
  };
  const cnt = { ACT005: 0, ACT006: 0, ACT007: 0, ACT012: 0 };
  const cats = {};
  const lastTrouble = {};          // 機器ごとの最後の 故障報告／故障出し の日
  his.forEach(function (h) {
    const act = String(h['アクションID'] || '');
    const no = String(h['管理番号'] || '');
    if (act === 'ACT005' || act === 'ACT006') {
      const d = rpDate_(h['実施日']) || rpDate_(h['登録日時']);
      if (d && (!lastTrouble[no] || d > lastTrouble[no])) lastTrouble[no] = d;
    }
    if (!(act in cnt) || !inMonth(h)) return;
    cnt[act]++;
    if (act === 'ACT012') {
      const mm = String(h['故障内容／対応内容'] || '').match(/^\[([^\]]+)\]/);
      const k = mm ? mm[1] : 'その他';
      cats[k] = (cats[k] || 0) + 1;
    }
  });

  const today = dueToday_();
  const broken = [];
  devs.forEach(function (d) {
    const st = String(d['ステータス'] || '');
    if (st !== '故障中' && st !== '修理中') return;
    const no = String(d['管理番号']);
    const since0 = lastTrouble[no];
    broken.push({ kanriNo: no, name: String(d['機器名'] || ''), dept: String(d['部署名'] || ''),
                  status: st, days: since0 ? today - dueDayNum_(since0) : null });
  });
  broken.sort(function (a, b) { return (b.days || 0) - (a.days || 0); });

  return {
    ym: ym, label: smLabel_(ym), since: since, beforeSince: !!beforeSince,
    insp: { plan: planN, done: doneN, extra: extraN, low: low },
    due: due, trouble: cnt, cats: cats, broken: broken,
    at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
    asOf: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d')
  };
}

/* =============================================================
 *  本文
 * ============================================================= */

function smBuild_(ym) {
  const c = smCollect_(ym);
  const L = [];
  L.push('📊 医療機器DX台帳 月次サマリー（' + c.label + '）');
  L.push('');

  // ✅ 部署点検
  L.push('✅ 部署点検');
  if (c.beforeSince) {
    L.push('  この月はシステムで記録し始める前です（' + c.since + ' から記録）');
  } else if (!c.insp.plan) {
    L.push('  この月に予定された部署点検はありませんでした');
  } else {
    L.push('  予定 ' + c.insp.plan + '回 → 実施 ' + c.insp.done + '回（' + smPct_(c.insp.done, c.insp.plan) + '）'
         + (c.insp.extra ? '　予定外の実施 ' + c.insp.extra + '回' : ''));
    if (c.insp.low.length) {
      L.push('  実施率が低い部署：' + c.insp.low.map(function (x) {
        return x.dept + ' ' + smPct_(x.done, x.plan) + '（' + x.done + '/' + x.plan + '）';
      }).join('、'));
    } else {
      L.push('  すべての部署で予定どおり実施されました 🎉');
    }
  }
  L.push('');

  // ⏰ 期限
  L.push('⏰ 点検の期限（' + c.asOf + ' 時点）');
  L.push('  ⛔ 期限切れ ' + c.due.over.dev + '台（部署 ' + c.due.over.dept + '／業者 ' + c.due.over.maker + '）');
  L.push('  ⚠️ 7日以内 ' + c.due.week.dev + '台（部署 ' + c.due.week.dept + '／業者 ' + c.due.week.maker + '）');
  L.push('  🗓 期限が近い ' + c.due.soon.dev + '台（部署 ' + c.due.soon.dept + '／業者 ' + c.due.soon.maker + '）');
  L.push('');

  // 🔧 故障
  L.push('🔧 故障');
  L.push('  故障報告 ' + c.trouble.ACT005 + '件／故障出し ' + c.trouble.ACT006 + '件／故障復帰 ' + c.trouble.ACT007 + '件');
  if (c.broken.length) {
    const long = c.broken.filter(function (b) { return b.days !== null && b.days > SM_LONG; });
    L.push('  いま故障中・修理中 ' + c.broken.length + '台'
         + (long.length ? '（うち' + SM_LONG + '日超 ' + long.length + '台）' : ''));
    long.forEach(function (b) {
      L.push('    ・' + b.kanriNo + ' ' + b.name + '（' + b.dept + '・' + b.status + '・' + b.days + '日）');
    });
  } else {
    L.push('  いま故障中・修理中の機器はありません');
  }
  L.push('');

  // 💬 その他報告
  const catKeys = Object.keys(c.cats).sort(function (a, b) { return c.cats[b] - c.cats[a]; });
  L.push('💬 その他報告 ' + c.trouble.ACT012 + '件');
  if (catKeys.length) {
    L.push('  ' + catKeys.map(function (k) {
      const ic = lwCatIcon_(k);
      return (ic ? ic + ' ' : '') + k + ' ' + c.cats[k];
    }).join('／'));
  }
  L.push('');

  // リンク
  let url = '';
  try { url = appUrl_(); } catch (e) { url = ''; }
  if (url && lwProp_('MAIL_NO_LINK') !== '1') {
    L.push('▶ 帳票（保守点検計画・記録）: ' + url + '?p=report');
    L.push('▶ 台帳ビュー: ' + url + '?p=ledger');
    L.push('');
  }
  L.push('💡 実施率の分母は保守点検計画の予定です（帳票の「保守点検計画」と同じ数え方）。');
  L.push('💡 ' + dueRuleText_());

  return {
    subject: '【月次サマリー】医療機器DX台帳 ' + c.label,
    text: L.join('\n'),
    data: c
  };
}

/* =============================================================
 *  送る
 * ============================================================= */

// 本文を作って、送る相手全員に1人ずつ送る。{ ok:[], ng:[], subject }
function smSend_(ym, test) {
  const to = smRecipients_();
  if (!to.length) throw new Error('送る相手がいません（MAIL_TO か LW_TO_USERS に、メールアドレスの形で入れてください）');

  const b = smBuild_(ym);
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

  smLog_(ok.length ? 'ok' : 'ng', (test ? 'テスト ' : '') + ym + ' 送信 ' + ok.length + '人'
    + (ng.length ? '（送れなかった ' + ng.length + '人：' + ng.map(function (x) { return x.id; }).join(', ') + '）' : ''));
  return { ok: ok, ng: ng, subject: subject };
}

/* ---------- トリガーから呼ばれる（毎月1日の朝） ---------- */
function summaryMonthly() {
  const props = PropertiesService.getScriptProperties();
  if (lwProp_('LW_OFF') === '1' || lwProp_('SUMMARY_OFF') === '1') {
    smLog_('skip', '止めているので送りませんでした');
    return;
  }
  const ym = smPrevMonth_();
  if (props.getProperty(SM_PROP_LAST) === ym) {
    smLog_('skip', ym + ' は送信済みのため省略');
    return;
  }
  try {
    const r = smSend_(ym, false);
    if (r.ok.length) props.setProperty(SM_PROP_LAST, ym);
  } catch (e) {
    smLog_('ng', ym + ' ' + (e && e.message ? e.message : e));
    throw e;      // Google側の「トリガー失敗のお知らせ」も出るように
  }
}

/* ---------- 自動送信の付け外し ---------- */

function smInstallTrigger() {
  smRemoveTrigger();
  ScriptApp.newTrigger(SM_FUNC).timeBased().onMonthDay(SM_DAY).atHour(SM_HOUR).create();
  const msg = '✅ 毎月' + SM_DAY + '日の' + SM_HOUR + '時台に月次サマリーを送るようにしました';
  Logger.log(msg);
  return msg;
}

function smRemoveTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SM_FUNC) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// 設定画面に出す状態
function smStatus_() {
  let trig = 0;
  try {
    trig = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === SM_FUNC;
    }).length;
  } catch (e) { trig = -1; }
  return {
    trigger: trig,
    when: '毎月' + SM_DAY + '日 ' + SM_HOUR + '時台',
    last: String(PropertiesService.getScriptProperties().getProperty(SM_PROP_LAST) || ''),
    to: smRecipients_(),
    month: smPrevMonth_()
  };
}

/* =============================================================
 *  動作確認（エディタから）
 * ============================================================= */

// 先月分の本文をログに出すだけ（送らない）
function summaryPreview() {
  const b = smBuild_(smPrevMonth_());
  Logger.log('件名：' + b.subject + '\n送る相手：' + smRecipients_().join(', ') + '\n\n' + b.text);
}

// 先月分を、件名に【テスト】を付けて全員に送る
function summarySendTest() {
  const r = smSend_(smPrevMonth_(), true);
  Logger.log('✅ 送った ' + r.ok.length + '人：' + r.ok.join(', ')
    + (r.ng.length ? '\n✖ 送れなかった：' + r.ng.map(function (x) { return x.id + ' ' + x.why; }).join(' / ') : ''));
}
