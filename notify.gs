/*** 医療機器DX台帳 ─ LINE WORKS ＋ メール 通知 ************************
 *  notify.gs
 *
 *  故障まわりの出来事と、その他報告だけを通知します。
 *    ・LINE WORKS を使う人 → LW_TO_USERS（Botとの1対1トーク）
 *    ・LINE WORKS を使わない人（業者・院外・PC中心の人）→ MAIL_TO（メール）
 *  宛先で分けるので、同じ人に二重には届きません（両方に書いた人は両方に届きます）。
 *  日々の点検（ACT002）は送りません。
 *
 *    ACT005 故障報告    🔧
 *    ACT006 故障出し    🛠
 *    ACT007 故障復帰    ✅
 *    ACT012 その他報告  💬（分類つき。ステータスは変わらない）
 *
 *  ───────────────────────────────────────────────
 *  スクリプトプロパティ
 *    LW_CLIENT_ID        Developer Console のアプリ（Client ID）
 *    LW_CLIENT_SECRET    同上
 *    LW_SERVICE_ACCOUNT  xxxx.serviceaccount@ドメイン
 *    LW_PRIVATE_KEY      秘密鍵。改行が崩れていても読めるようにしてあります
 *    LW_BOT_ID           Bot のID（数字）
 *    LW_TO_USERS         送る相手。LINE WORKS のID（ログインID）をカンマか改行で区切って並べる
 *                          例）yamada@hospital-example, sato@hospital-example
 *                        1人ずつ、それぞれの「Botとの1対1トーク」に届く
 *    LW_CHANNEL_ID       （任意・旧方式）LW_TO_USERS が空のときだけ、このトークルームへ送る
 *    LW_OFF              "1" を入れると通知を止める（検証中や障害時の緊急停止用）
 *                          ※ LINE WORKS もメールも、両方止まります
 *
 *    ── メール（任意。空ならメールは送りません）──
 *    MAIL_TO             送る相手のメールアドレス。カンマか改行で区切って並べる
 *                          例）tanaka@maker-example.co.jp, jimu@hospital-example.jp
 *                        1人ずつ別々のメールで送る（ほかの宛先は見えない）
 *    MAIL_REPLY_TO       （任意）返信を受ける先。空なら送信元（このスクリプトの持ち主）へ返る
 *    MAIL_NO_LINK        （任意）"1" を入れると、メール本文に管理画面へのリンクを入れない
 *                          院外の人しかいないときに。リンクを開いてもパスワードが無いと入れません
 *    MAIL_OFF            （任意）"1" を入れると、メールだけ止める
 *  ───────────────────────────────────────────────
 *
 *  ⚠️ ここが失敗しても、点検・故障報告の記録は必ず残ります。
 *     通知は「おまけ」として、呼び出し側で握りつぶす作りにしてあります。
 *     LINE WORKS とメールは別々に送るので、片方が失敗してももう片方は届きます。
 *
 *  ⚠️ メールの送信元は、このスクリプトの持ち主のアカウントです。
 *     1日に送れる数に上限があります（無料のGmailは宛先100件／日ほど）。
 **********************************************************************/

const LW_AUTH_URL  = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const LW_API_BASE  = 'https://www.worksapis.com/v1.0';
const LW_TOKEN_KEY = 'lw_access_token';
const LW_TOKEN_SEC = 5 * 3600;          // CacheServiceの上限は6時間。少し手前で取り直す
const LW_DEDUP_SEC = 5 * 60;            // 同じ機器・同じ種類（・同じ分類）は5分間は1通だけ

function lwProp_(k) {
  return PropertiesService.getScriptProperties().getProperty(k) || '';
}

/* =============================================================
 *  秘密鍵の読み込み
 *    スクリプトプロパティに貼ると、改行が消えたり \n という
 *    ただの文字列になったりします。どの形で入っていても、
 *    PEMとして組み直してから使います。
 * ============================================================= */

function lwPrivateKey_() {
  let raw = lwProp_('LW_PRIVATE_KEY');
  if (!raw) throw new Error('LW_PRIVATE_KEY が設定されていません');

  // ① 文字列としての \n、\r\n、全角スペースを、ふつうの改行と半角に均す
  raw = String(raw)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/　/g, ' ');

  // ② ヘッダを覚えておく。PKCS#1（RSA PRIVATE KEY）と
  //    PKCS#8（PRIVATE KEY）で書き方が違うので、元のものを使う
  const m = raw.match(/-----BEGIN ([A-Z ]+)-----/);
  const label = m ? m[1].trim() : 'PRIVATE KEY';

  // ③ ヘッダ・フッタ・空白をすべて落として、中身だけにする
  const body = raw
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');

  if (!body) throw new Error('LW_PRIVATE_KEY の中身が空です');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new Error('LW_PRIVATE_KEY にBase64以外の文字が混ざっています。'
      + '貼り直してください（前後の余計な文字やクォートに注意）');
  }

  // ④ 64文字ごとに改行を入れて、PEMに戻す
  const lines = body.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n'
       + lines.join('\n')
       + '\n-----END ' + label + '-----\n';
}

/* =============================================================
 *  アクセストークン
 *    JWTを自分で作って、24時間もののトークンと交換します。
 *    毎回取りにいくと遅いので、キャッシュに置いて使い回します。
 * ============================================================= */

function lwB64_(s) {
  return Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
}

function lwJwt_() {
  const iss = lwProp_('LW_CLIENT_ID');
  const sub = lwProp_('LW_SERVICE_ACCOUNT');
  if (!iss) throw new Error('LW_CLIENT_ID が設定されていません');
  if (!sub) throw new Error('LW_SERVICE_ACCOUNT が設定されていません');

  const now = Math.floor(Date.now() / 1000);
  const head = { alg: 'RS256', typ: 'JWT' };
  const body = { iss: iss, sub: sub, iat: now, exp: now + 3600 };

  const unsigned = lwB64_(JSON.stringify(head)) + '.' + lwB64_(JSON.stringify(body));
  const sig = Utilities.computeRsaSha256Signature(unsigned, lwPrivateKey_());
  return unsigned + '.' + Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function lwToken_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const hit = cache.get(LW_TOKEN_KEY);
    if (hit) return hit;
  }

  const res = UrlFetchApp.fetch(LW_AUTH_URL, {
    method: 'post',
    payload: {
      assertion: lwJwt_(),
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: lwProp_('LW_CLIENT_ID'),
      client_secret: lwProp_('LW_CLIENT_SECRET'),
      scope: 'bot',
    },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    throw new Error('トークンを取得できませんでした（HTTP ' + code + '）\n' + text.slice(0, 500));
  }

  let out;
  try {
    out = JSON.parse(text);
  } catch (e) {
    throw new Error('トークンの返事がJSONではありませんでした\n' + text.slice(0, 300));
  }
  if (!out.access_token) {
    throw new Error('トークンが入っていませんでした\n' + text.slice(0, 300));
  }

  cache.put(LW_TOKEN_KEY, out.access_token, LW_TOKEN_SEC);
  return out.access_token;
}

/* =============================================================
 *  送信
 * ============================================================= */

// 送る相手の一覧。カンマ・読点・空白・改行のどれで区切ってもよい。重複は1つにする
function lwRecipients_() {
  return String(lwProp_('LW_TO_USERS'))
    .split(/[\s,、，;；]+/)
    .map(function (x) { return x.trim(); })
    .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
}

// よくある失敗に、見当を添える
function lwHint_(code) {
  if (code === 404) return 'IDが違う可能性があります（LINE WORKS のログインIDを確認）';
  if (code === 403) return 'Bot の利用範囲にその人が入っていない可能性があります（管理者画面のBot設定）';
  if (code === 400) return 'IDの書き方か、送る中身が受け付けられませんでした';
  return '';
}

/**
 * 送る。
 *   LW_TO_USERS があれば、1人ずつ1対1で送る（まとめて同時に投げるので、人数が増えても待たない）
 *   無ければ、LW_CHANNEL_ID のトークルームへ送る（旧方式）
 * 1人でも届けば成功として返し、届かなかった人は __LOG に残す。
 * 誰にも届かなかったときだけ例外にする。
 * @return {{ok: string[], ng: Object[]}}
 */
function lwSendText_(text) {
  const botId = lwProp_('LW_BOT_ID');
  if (!botId) throw new Error('LW_BOT_ID が設定されていません');

  const base = LW_API_BASE + '/bots/' + encodeURIComponent(botId);
  const to = lwRecipients_();
  let targets;
  if (to.length) {
    targets = to.map(function (u) {
      // @ はURLの途中にそのまま書いてよい文字。%40 にすると受け側によっては読み違えるので戻す
      return { label: u, url: base + '/users/' + encodeURIComponent(u).replace(/%40/g, '@') + '/messages' };
    });
  } else {
    const chId = lwProp_('LW_CHANNEL_ID');
    if (!chId) throw new Error('LW_TO_USERS（送る相手）が設定されていません');
    targets = [{ label: 'トークルーム ' + chId,
                 url: base + '/channels/' + encodeURIComponent(chId) + '/messages' }];
  }

  const payload = JSON.stringify({ content: { type: 'text', text: String(text) } });
  const ok = [], ng = [];
  let pending = targets;

  // トークンが切れていた（401）人だけ、取り直して1度だけ投げ直す
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const token = lwToken_(attempt > 0);
    const res = UrlFetchApp.fetchAll(pending.map(function (t) {
      return {
        url: t.url,
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        headers: { Authorization: 'Bearer ' + token },
        payload: payload,
        muteHttpExceptions: true,
      };
    }));

    const retry = [];
    res.forEach(function (r, i) {
      const code = r.getResponseCode();
      if (code >= 200 && code < 300) {
        ok.push(pending[i].label);
      } else if (code === 401 && attempt === 0) {
        retry.push(pending[i]);
      } else {
        ng.push({ id: pending[i].label, code: code,
                  body: r.getContentText().slice(0, 200), hint: lwHint_(code) });
      }
    });
    pending = retry;
  }

  ng.forEach(function (x) {
    lwLog_('ng', '送れなかった : ' + x.id + '（HTTP ' + x.code + '）' + (x.hint ? ' ' + x.hint : ''));
  });

  if (!ok.length) {
    throw new Error('誰にも送れませんでした\n' + ng.map(function (x) {
      return '  ' + x.id + ' : HTTP ' + x.code + (x.hint ? '（' + x.hint + '）' : '') + '\n    ' + x.body;
    }).join('\n'));
  }
  return { ok: ok, ng: ng };
}

/* =============================================================
 *  本文の組み立て
 * ============================================================= */

// 通知する種類と、見出しの出しかた
const LW_KINDS = {
  ACT005: { icon: '🔧', title: '故障報告',  lead: '故障の報告が入りました' },
  ACT006: { icon: '🛠', title: '故障出し',  lead: '修理に出しました' },
  ACT007: { icon: '✅', title: '故障復帰',  lead: '修理が終わって戻りました' },
  ACT012: { icon: '💬', title: 'その他報告', lead: '使えるけど気になることの報告です' },
};

// その他報告の分類のアイコン（app.gs の OTHER_KINDS から引く）
function lwCatIcon_(name) {
  try {
    const k = otherKind_(name);
    return k ? k.icon : '';
  } catch (e) {
    return '';
  }
}

function lwNow_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

// 機器マスタから、通知に出す情報だけ拾う。引けなくても止めない
function lwDevice_(kanriNo) {
  const out = { name: '', dept: '', loc: '', site: '', maker: '', model: '', status: '' };
  try {
    const r = findRow(SHEET.DEV, '管理番号', String(kanriNo), { fresh: true });
    if (!r) return out;
    out.name   = String(r['機器名'] || '');
    out.dept   = String(r['部署名'] || '');
    out.loc    = String(r['保管場所名'] || '');
    out.site   = String(r['拠点'] || '');
    out.maker  = String(r['メーカー名'] || '');
    out.model  = String(r['型番'] || '');
    out.status = String(r['ステータス'] || '');
  } catch (e) { /* 引けなくても通知は出す */ }
  return out;
}

function lwUserName_(userId) {
  if (!userId) return '';
  try {
    const r = findRow(SHEET.USR, '職員番号', String(userId), { fresh: true });
    if (!r) return String(userId);
    const n = String(r['ユーザー名'] || '');
    const d = String(r['部署名'] || '');
    return d ? (n + '（' + d + '）') : n;
  } catch (e) {
    return String(userId);
  }
}

// 履歴画面のその1件へ飛ぶリンク
function lwLink_(hid) {
  try {
    const base = appUrl_();
    if (!base) return '';
    return base + '?p=history' + (hid ? '&hid=' + encodeURIComponent(hid) : '');
  } catch (e) {
    return '';
  }
}

// opts.noLink : true なら管理画面へのリンクと、それに触れる行を出さない（院外向けメール用）
// opts.dev    : 機器マスタから引いた値（呼ぶ側で引いてあれば使い回す）
function lwBuildText_(kind, info, opts) {
  opts = opts || {};
  const k = LW_KINDS[kind] || { icon: '📣', title: kind, lead: '' };
  const d = opts.dev || lwDevice_(info.kanriNo);

  const lines = [];
  const cat = String(info.category || '').trim();
  if (cat) {
    // 例）💬 その他報告　📦 付属品・消耗品
    const ci = lwCatIcon_(cat);
    lines.push(k.icon + ' ' + k.title + '　' + (ci ? ci + ' ' : '') + cat);
  } else {
    lines.push(k.icon + ' ' + k.title);
  }
  lines.push('');
  lines.push('🏷 ' + String(info.kanriNo || '') + '　' + (d.name || ''));

  const place = [d.site, d.dept, d.loc].filter(String).join(' / ');
  if (place) lines.push('📍 ' + place);
  if (d.maker || d.model) lines.push('🏭 ' + [d.maker, d.model].filter(String).join(' '));

  const who = lwUserName_(info.userId);
  if (who) lines.push('🙋 ' + who);

  const body = String(info.text || '').trim();
  if (body) {
    lines.push('');
    lines.push('💬 ' + body);
  }
  const memo = String(info.memo || '').trim();
  if (memo) lines.push('📝 ' + memo);

  lines.push('');
  if (d.status) lines.push('🚦 いまのステータス : ' + d.status);
  lines.push('🕘 ' + lwNow_());

  const url = opts.noLink ? '' : lwLink_(info.hid);

  if (url && (kind === 'ACT005' || kind === 'ACT012')) {
    lines.push('📎 写真や取説は、下のリンクから書類ボックスで見られます');
  }

  if (url) {
    lines.push('');
    lines.push('▶ ' + url);
  }
  return lines.join('\n');
}

/* =============================================================
 *  メール
 *    LINE WORKS を使っていない人向け。本文は LINE WORKS と同じものを使い回し、
 *    件名だけ受信箱で見分けやすい形にします。
 * ============================================================= */

const MAIL_FROM_NAME = '医療機器DX台帳';

// 送る相手の一覧。区切り方は LW_TO_USERS と同じ。重複は1つ、大文字小文字は区別しない
function mailRecipients_() {
  const seen = {};
  return String(lwProp_('MAIL_TO'))
    .split(/[\s,、，;；]+/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) {
      if (!x) return false;
      const k = x.toLowerCase();
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
}

// ざっくりした書式チェック（打ち間違いを先に弾いて、ログで分かるようにする）
function mailLooksOk_(addr) {
  return /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(addr);
}

// 件名。例）【故障報告】A1403 汎用輸液ポンプ ／ 【その他報告・付属品・消耗品】A1403 汎用輸液ポンプ
function mailSubject_(kind, info, dev) {
  const k = LW_KINDS[kind] || { title: kind };
  const cat = String(info.category || '').trim();
  const head = '【' + k.title + (cat ? '・' + cat : '') + '】';
  return head + String(info.kanriNo || '') + (dev && dev.name ? ' ' + dev.name : '');
}

function mailFooter_() {
  return '\n\n――――――――――――――\n'
       + 'このメールは「医療機器DX台帳」から自動で送っています。\n'
       + '心当たりがない場合は、病院の医療機器管理担当までご連絡ください。';
}

/**
 * メールを送る。1人ずつ別々に送る（ほかの宛先が見えないように）。
 * 1人でも届けば成功として返し、送れなかった人は __LOG に残す。
 * 誰にも送れなかったときだけ例外にする。
 * @return {{ok: string[], ng: Object[]}}
 */
function mailSendText_(subject, text) {
  const to = mailRecipients_();
  if (!to.length) throw new Error('MAIL_TO（送る相手）が設定されていません');

  const replyTo = lwProp_('MAIL_REPLY_TO').trim();
  const body = String(text) + mailFooter_();
  const ok = [], ng = [];

  // 残り送信数を先に見ておく（足りない分は送らずに記録する）
  let left = Infinity;
  try { left = MailApp.getRemainingDailyQuota(); } catch (e) { /* 見られなくても送ってみる */ }

  to.forEach(function (addr) {
    if (!mailLooksOk_(addr)) {
      ng.push({ id: addr, why: 'メールアドレスの形になっていません' });
      return;
    }
    if (left <= 0) {
      ng.push({ id: addr, why: '今日送れる数の上限に達しました（明日になれば戻ります）' });
      return;
    }
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

  ng.forEach(function (x) {
    lwLog_('ng', '送れなかった : ' + x.id + ' ' + x.why, 'MAIL');
  });

  if (!ok.length) {
    throw new Error('誰にもメールを送れませんでした\n' + ng.map(function (x) {
      return '  ' + x.id + ' : ' + x.why;
    }).join('\n'));
  }
  return { ok: ok, ng: ng };
}

/* =============================================================
 *  呼び出し口
 *    呼ぶ側はこれ1つだけ。失敗しても例外は外に出しません。
 * ============================================================= */

/**
 * @param {string} kind  'ACT005' / 'ACT006' / 'ACT007' / 'ACT012'
 * @param {Object} info  { kanriNo, hid, userId, text, memo, category }
 * @return {boolean} 送れたら true（送らなかった・失敗したときは false）
 */
function notifyEvent_(kind, info) {
  try {
    if (lwProp_('LW_OFF') === '1') return false;        // 緊急停止
    if (!LW_KINDS[kind]) return false;                  // 点検などは通さない
    if (!info || !info.kanriNo) return false;

    // 同じ機器・同じ種類の連打を抑える（現場が不安で2度押すことがある）
    const cache = CacheService.getScriptCache();
    // その他報告は、同じ機器でも分類が違えば別の話なので両方通す
    const key = 'lwsent_' + kind + '_' + String(info.kanriNo)
              + (info.category ? '_' + String(info.category) : '');
    if (cache.get(key)) {
      lwLog_('skip', kind + ' ' + info.kanriNo + ' 直前に送信済みのため省略');
      return false;
    }

    const useLw   = !!(lwRecipients_().length || lwProp_('LW_CHANNEL_ID'));
    const useMail = lwProp_('MAIL_OFF') !== '1' && mailRecipients_().length > 0;
    if (!useLw && !useMail) {
      lwLog_('ng', kind + ' ' + info.kanriNo + ' 送る相手が設定されていません（LW_TO_USERS / MAIL_TO）');
      return false;
    }

    const dev = lwDevice_(info.kanriNo);   // 機器マスタは1回だけ引いて両方で使う
    let sent = false;

    // ① LINE WORKS（失敗してもメールへ進む）
    if (useLw) {
      try {
        const r = lwSendText_(lwBuildText_(kind, info, { dev: dev }));
        sent = true;
        lwLog_('ok', kind + ' ' + info.kanriNo + ' 送信 ' + r.ok.length + '人'
                     + (r.ng.length ? '（届かなかった ' + r.ng.length + '人）' : ''));
      } catch (e) {
        lwLog_('ng', kind + ' ' + info.kanriNo + ' ' + (e && e.message ? e.message : e));
      }
    }

    // ② メール
    if (useMail) {
      try {
        const text = lwBuildText_(kind, info, { dev: dev, noLink: lwProp_('MAIL_NO_LINK') === '1' });
        const r = mailSendText_(mailSubject_(kind, info, dev), text);
        sent = true;
        lwLog_('ok', kind + ' ' + info.kanriNo + ' メール ' + r.ok.length + '人'
                     + (r.ng.length ? '（送れなかった ' + r.ng.length + '人）' : ''), 'MAIL');
      } catch (e) {
        lwLog_('ng', kind + ' ' + info.kanriNo + ' ' + (e && e.message ? e.message : e), 'MAIL');
      }
    }

    // どちらか1つでも届いたら連打抑制をかける（全滅なら次の押し直しで再挑戦できるように）
    if (sent) cache.put(key, '1', LW_DEDUP_SEC);
    return sent;

  } catch (e) {
    // ここで握りつぶすのが肝心。通知のせいで故障報告が失敗したら本末転倒
    lwLog_('ng', kind + ' ' + (info && info.kanriNo) + ' ' + (e && e.message ? e.message : e));
    return false;
  }
}

/* ---------- 記録 ---------- */

// __LOG シートがあれば1行足す。無ければ実行ログだけに出す
// via : 'LINEWORKS'（省略時）か 'MAIL'
function lwLog_(level, message, via) {
  via = via || 'LINEWORKS';
  const line = '[' + (via === 'MAIL' ? 'MAIL' : 'LW') + ':' + level + '] ' + message;
  try {
    Logger.log(line);
  } catch (e) { /* 気にしない */ }
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('__LOG');
    if (sh) sh.appendRow([new Date(), via, level, message]);
  } catch (e) { /* 書けなくても通知の本筋には関係ない */ }
}

/* =============================================================
 *  動作確認
 *    上から順に試すと、どこで止まっているか分かります。
 * ============================================================= */

// ① 設定と秘密鍵だけ確認する（LINE WORKSへは何も送りません）
function lwCheck() {
  const log = [];
  const names = ['LW_CLIENT_ID', 'LW_CLIENT_SECRET', 'LW_SERVICE_ACCOUNT',
                 'LW_PRIVATE_KEY', 'LW_BOT_ID'];
  names.forEach(function (n) {
    const v = lwProp_(n);
    log.push('  ' + n.padEnd(20, ' ')
             + (v ? '設定あり（' + v.length + '文字）' : '★未設定★'));
  });

  // 送る相手
  log.push('');
  const to = lwRecipients_();
  if (to.length) {
    log.push('送る相手 LW_TO_USERS : ' + to.length + ' 人（それぞれのBotとの1対1トークへ）');
    to.forEach(function (u) { log.push('  ・' + u); });
    if (lwProp_('LW_CHANNEL_ID')) {
      log.push('  ※ LW_CHANNEL_ID も入っていますが、LW_TO_USERS があるので使いません');
    }
  } else if (lwProp_('LW_CHANNEL_ID')) {
    log.push('送る相手 : LW_CHANNEL_ID のトークルーム（旧方式）');
    log.push('  ★ LW_TO_USERS が空です。1対1で送るならこちらに相手を入れてください');
  } else {
    log.push('送る相手 : ★未設定★（LW_TO_USERS に LINE WORKS のIDを入れてください）');
  }

  log.push('');
  try {
    const pem = lwPrivateKey_();
    const ls = pem.split('\n');
    log.push('秘密鍵 : 読めました（' + ls.length + '行）');
    log.push('  先頭 : ' + ls[0]);
    log.push('  末尾 : ' + ls[ls.length - 2]);
  } catch (e) {
    log.push('秘密鍵 : ★' + e.message + '★');
  }

  log.push('');
  log.push('停止フラグ LW_OFF : ' + (lwProp_('LW_OFF') === '1' ? 'オン（送りません）' : 'オフ'));

  // メール側もひと目で分かるように
  log.push('');
  log.push(mailCheckText_());
  Logger.log(log.join('\n'));
}

/* ---------- メールの動作確認 ---------- */

function mailCheckText_() {
  const log = [];
  const to = mailRecipients_();
  if (to.length) {
    log.push('メールの相手 MAIL_TO : ' + to.length + ' 人（1人ずつ別々のメール）');
    to.forEach(function (a) {
      log.push('  ・' + a + (mailLooksOk_(a) ? '' : '　★アドレスの形になっていません★'));
    });
    const lwTo = lwRecipients_().map(function (u) { return u.toLowerCase(); });
    const both = to.filter(function (a) { return lwTo.indexOf(a.toLowerCase()) >= 0; });
    if (both.length) {
      log.push('  ※ LW_TO_USERS にもいる人 : ' + both.join(', ') + '（二重に届きます）');
    }
  } else {
    log.push('メールの相手 MAIL_TO : なし（メールは送りません）');
  }
  log.push('  返信先 MAIL_REPLY_TO : ' + (lwProp_('MAIL_REPLY_TO') || '（空 → 送信元へ返る）'));
  log.push('  リンク MAIL_NO_LINK  : ' + (lwProp_('MAIL_NO_LINK') === '1' ? '入れない' : '入れる'));
  log.push('  停止   MAIL_OFF      : ' + (lwProp_('MAIL_OFF') === '1' ? 'オン（メールだけ送りません）' : 'オフ'));
  try {
    log.push('  今日あと送れる数     : ' + MailApp.getRemainingDailyQuota() + ' 件');
  } catch (e) {
    log.push('  今日あと送れる数     : 確認できませんでした（メール送信の許可がまだかもしれません）');
  }
  return log.join('\n');
}

// ⑤ メールの設定だけ確認する（送りません）
function mailCheck() {
  Logger.log(mailCheckText_());
}

// ⑥ MAIL_TO の全員へテストメールを1通送る
function mailSendTest() {
  try {
    const r = mailSendText_('【テスト】医療機器DX台帳の通知テスト',
      '🧪 医療機器DX台帳のテスト送信です。\n'
      + 'これが届いていれば、メール通知の準備は整っています。\n'
      + '🕘 ' + lwNow_());
    Logger.log(mailResultText_(r));
  } catch (e) {
    Logger.log('✖ ' + e.message);
  }
}

// ⑦ 本番と同じ件名・本文でメールを送ってみる（機器マスタの1台目を使います）
function mailPreviewTest() {
  let no = 'A0001';
  try {
    const d = getTable(SHEET.DEV, { fresh: true }).rows[0];
    if (d) no = String(d['管理番号']);
  } catch (e) { /* 既定のまま */ }

  const info = { kanriNo: no, hid: 'HIS9999', userId: '',
                 text: '（テスト）カフの加圧が安定しない', memo: '' };
  const dev = lwDevice_(no);
  const subject = mailSubject_('ACT005', info, dev);
  const text = lwBuildText_('ACT005', info, { dev: dev, noLink: lwProp_('MAIL_NO_LINK') === '1' });
  Logger.log('--- 件名 ---\n' + subject + '\n--- 本文 ---\n' + text + mailFooter_());

  try {
    Logger.log('\n' + mailResultText_(mailSendText_(subject, text)));
  } catch (e) {
    Logger.log('\n✖ ' + e.message);
  }
}

function mailResultText_(r) {
  const log = ['✅ 送った : ' + r.ok.length + ' 人'];
  r.ok.forEach(function (a) { log.push('    ' + a); });
  if (r.ng.length) {
    log.push('✖ 送れなかった : ' + r.ng.length + ' 人');
    r.ng.forEach(function (x) { log.push('    ' + x.id + ' : ' + x.why); });
  }
  log.push('※「送った」はGoogleが受け付けたという意味です。迷惑メールに入っていないか、相手にも確認してください');
  return log.join('\n');
}

// ② トークンまで取れるか（まだ送りません）
function lwTokenTest() {
  try {
    const t = lwToken_(true);
    Logger.log('✅ トークンを取得できました（' + t.length + '文字）');
  } catch (e) {
    Logger.log('✖ ' + e.message);
  }
}

// ③ 実際に送る相手全員へ1通送ってみる。誰に届いて誰に届かなかったかが出る
function lwSendTest() {
  try {
    const r = lwSendText_('🧪 医療機器DX台帳のテスト送信です。\n'
                + 'これが見えていれば、通知の準備は整っています。\n'
                + '🕘 ' + lwNow_());
    Logger.log(lwResultText_(r));
  } catch (e) {
    Logger.log('✖ ' + e.message);
  }
}

function lwResultText_(r) {
  const log = ['✅ 届いた : ' + r.ok.length + ' 人'];
  r.ok.forEach(function (u) { log.push('    ' + u); });
  if (r.ng.length) {
    log.push('✖ 届かなかった : ' + r.ng.length + ' 人');
    r.ng.forEach(function (x) {
      log.push('    ' + x.id + ' : HTTP ' + x.code + (x.hint ? '（' + x.hint + '）' : ''));
    });
  }
  return log.join('\n');
}

// ④ 本番と同じ本文で送ってみる（機器マスタの1台目を使います）
function lwPreviewTest() {
  let no = 'A0001';
  try {
    const d = getTable(SHEET.DEV, { fresh: true }).rows[0];
    if (d) no = String(d['管理番号']);
  } catch (e) { /* 既定のまま */ }

  const text = lwBuildText_('ACT005', {
    kanriNo: no, hid: 'HIS9999', userId: '',
    text: '（テスト）カフの加圧が安定しない', memo: '',
  });
  Logger.log('--- 組み立てた本文 ---\n' + text);

  try {
    Logger.log('\n' + lwResultText_(lwSendText_(text)));
  } catch (e) {
    Logger.log('\n✖ ' + e.message);
  }
}
