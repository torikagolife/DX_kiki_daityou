<!DOCTYPE html>
<html lang="ja">
<head>
<base target="_top">
<meta charset="utf-8">
<?!= include('admincss'); ?>
<style>
/* ワイドモニタでは広く使う。狭い画面では画面幅に合わせる */
.wrap{ max-width:min(1760px, 97vw); }
#tbl{ min-width:100%; }
</style>
</head>
<body>
<div class="wrap">

  <div class="hd">
    <h1>🕘 医療機器DX台帳</h1><span>📖 履歴の確認・登録・修正</span>
  </div>

  <?!= include('nav', { navUrl: navUrl, navNow: navNow }); ?>

  <div id="msg" class="msg hide"></div>

  <!-- ===== パスワード ===== -->
  <div id="vPw" class="hide">
    <div class="dlg" style="max-width:420px;margin:0">
      <h2>🔑 管理パスワード</h2>
      <div class="fld">
        <input type="password" id="pw" autocomplete="off"
               onkeydown="if(event.key==='Enter')doLogin()">
      </div>
      <button class="btn" id="btnPw" onclick="doLogin()" style="width:100%">🔓 開く</button>
    </div>
  </div>

  <!-- ===== 本体 ===== -->
  <div id="vMain" class="hide">
    <div class="bar">
      <input type="text" id="fNo" placeholder="🏷 管理番号" style="max-width:150px">
      <select id="fAct"></select>
      <input type="date" id="fFrom" style="max-width:160px">
      <span class="sub">🗓 〜</span>
      <input type="date" id="fTo" style="max-width:160px">
      <button class="btn" onclick="search()">🔍 検索</button>
      <button class="btn-sub" onclick="clearAll()">🧹 クリア</button>
      <button class="btn" onclick="openAdd()">✨ アクション登録</button>
      <span class="cnt" id="cnt"></span>
    </div>

    <div class="tblwrap"><table id="tbl"></table></div>
  </div>

  <div id="loading" style="text-align:center;padding:40px" class="sub">
    <span class="spin"></span>📥 読み込み中…
  </div>

</div>

<!-- ===== 詳細・修正ダイアログ ===== -->
<div class="ov" id="ov" onclick="if(event.target===this)closeDlg()">
  <div class="dlg" style="max-width:520px">
    <h2 id="dlgTitle">🕘 履歴の詳細</h2>
    <div id="dlgErr" class="msg err hide"></div>
    <div id="dlgBody"></div>
    <div class="row">
      <button class="btn-sub" onclick="closeDlg()">✖️ 閉じる</button>
      <button class="btn" id="btnSave" onclick="save()">💾 保存する</button>
    </div>
  </div>
</div>

<!-- ===== アクション登録ダイアログ ===== -->
<div class="ov" id="ovAdd" onclick="if(event.target===this)closeAdd()">
  <div class="dlg" style="max-width:520px">
    <h2>✨ ⚡ アクションを登録</h2>
    <div id="addErr" class="msg err hide"></div>

    <div class="fld">
      <label>🏷 管理番号<span class="req">*</span></label>
      <div style="display:flex;gap:8px">
        <input type="text" id="aNo" placeholder="A1403" autocapitalize="characters"
               style="flex:1" onkeydown="if(event.key==='Enter')findDev()">
        <button class="btn-sub" id="btnFind" onclick="findDev()"
                style="flex:0 0 auto">📥 読込</button>
      </div>
    </div>

    <div id="devCard" class="hide" style="background:var(--accent-weak);
         border-radius:10px;padding:12px;margin-bottom:14px;font-size:14px"></div>

    <div id="addBody" class="hide"></div>

    <div class="row">
      <button class="btn-sub" onclick="closeAdd()">↩️ やめる</button>
      <button class="btn" id="btnAdd" onclick="submitAdd()">✅ 登録する</button>
    </div>
  </div>
</div>


<!-- ===== 書類ボックス（見るだけ。追加・削除はマスタ管理の機器から） ===== -->
<div class="ov" id="ovDocs" style="z-index:1005" onclick="if(event.target===this)closeDocs()">
  <div class="dlg" style="max-width:600px">
    <h2 id="docsTitle">📎 書類ボックス</h2>
    <div class="sub" id="docsSub" style="margin:-4px 0 10px"></div>
    <div id="docsBody"></div>
    <div class="row">
      <button class="btn-sub" onclick="closeDocs()">✖️ 閉じる</button>
    </div>
  </div>
</div>

<!-- ===== 写真・書類を大きく見る ===== -->
<div class="ov" id="ovView" style="z-index:1010" onclick="if(event.target===this)closeView()">
  <div class="dlg" style="max-width:820px">
    <h2 id="viewTitle" style="word-break:break-all"></h2>
    <div id="viewBody"></div>
    <div class="row">
      <button class="btn-sub" onclick="closeView()">✖️ 閉じる</button>
    </div>
  </div>
</div>

<script>var INIT_HID = <?!= JSON.stringify(initHid) ?>;</script>
<script>
var S = { token:'', data:null, detail:null, actx:null, dev:null };

function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function show(id){
  ['vPw','vMain'].forEach(function(v){
    document.getElementById(v).classList.toggle('hide', v !== id);
  });
  document.getElementById('loading').classList.add('hide');
}
function msg(t, isErr){
  var e = document.getElementById('msg');
  e.textContent = t;
  e.className = 'msg ' + (isErr ? 'err' : 'ok');
  setTimeout(function(){ e.classList.add('hide'); }, 5000);
}
function busy(on, el, label){
  if (!el) return;
  el.disabled = on;
  el.innerHTML = on ? '<span class="spin"></span>処理中…' : label;
}
function errIn(id, text){
  var e = document.getElementById(id);
  if (!text){ e.classList.add('hide'); return; }
  e.textContent = '⚠️ ' + text;
  e.classList.remove('hide');
}

// ?hid= で渡された履歴ID。空・未定義・クォートだけのものは無視する
function initHid_(){
  var v = (typeof INIT_HID === 'string') ? INIT_HID.trim() : '';
  v = v.replace(/^["']+|["']+$/g, '').trim();   // 前後のクォートを剥がす
  if (!v || v === 'undefined' || v === 'null') return '';
  return v;
}

/* 判定を絵文字つきで出す */
function judgeTx(j){
  if (j === 'NG') return '<span style="color:#c2621f;font-weight:700">❌ NG</span>';
  if (j === 'OK') return '<span style="color:#1f7f88;font-weight:700">✅ OK</span>';
  return j ? esc(j) : '<span class="sub">—</span>';
}

/* ---------- 認証 ---------- */
function tk(){ try{ return localStorage.getItem('mkdx_admin_tk') || ''; }catch(e){ return ''; } }
function setTk(t){ S.token = t; try{ localStorage.setItem('mkdx_admin_tk', t); }catch(e){} }
function clrTk(){ S.token=''; try{ localStorage.removeItem('mkdx_admin_tk'); }catch(e){} }

window.addEventListener('DOMContentLoaded', function(){
  var t = tk();
  if (!t){ show('vPw'); document.getElementById('pw').focus(); return; }
  S.token = t;
  google.script.run
    .withSuccessHandler(function(ok){
      if (!ok){ clrTk(); show('vPw'); return; }
      search();
    })
    .withFailureHandler(function(){ clrTk(); show('vPw'); })
    .pingToken(t, 'admin');
});

function doLogin(){
  var el = document.getElementById('btnPw');
  var pw = document.getElementById('pw').value;
  if (!pw){ msg('🔑 パスワードを入力してください', true); return; }
  busy(true, el, '🔓 開く');
  google.script.run
    .withSuccessHandler(function(r){
      busy(false, el, '🔓 開く');
      if (!r.ok){ msg('🙅 パスワードが違います', true); return; }
      setTk(r.token);
      document.getElementById('pw').value = '';
      document.getElementById('vPw').classList.add('hide');
      document.getElementById('loading').classList.remove('hide');
      search();
    })
    .withFailureHandler(function(e){ busy(false, el, '🔓 開く');
                                     msg('⚠️ ' + e.message, true); })
    .verifyPassword(pw, 'admin');
}

/* ---------- 一覧 ---------- */
function search(){
  var opt = {
    kanriNo: document.getElementById('fNo').value.trim(),
    actId  : document.getElementById('fAct').value,
    from   : document.getElementById('fFrom').value,
    to     : document.getElementById('fTo').value,
    limit  : 300
  };
  google.script.run
    .withSuccessHandler(function(d){
      S.data = d;
      if (!document.getElementById('fAct').options.length){
        document.getElementById('fAct').innerHTML =
          '<option value="">⚡ すべてのアクション</option>'
          + d.actions.map(function(a){
              return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>';
            }).join('');
      }
      render();
      show('vMain');

      // ?hid= で開かれたときだけ、その履歴を自動で開く（空なら何もしない）
      var h = initHid_();
      INIT_HID = '';                   // 以降は二度と自動で開かない
      if (h) openDlg(h);
    })
    .apiGetHistory(S.token, opt);
}

function clearAll(){
  document.getElementById('fNo').value = '';
  document.getElementById('fAct').value = '';
  document.getElementById('fFrom').value = '';
  document.getElementById('fTo').value = '';
  search();
}

function render(){
  var d = S.data;
  if (!d) return;
  document.getElementById('cnt').textContent =
    '📄 ' + d.shown + ' / ' + d.total + ' 件'
    + (d.shown < d.total ? '（🕘 新しい順に300件まで）' : '');

  var h = '<thead><tr>'
    + '<th>🆔 履歴ID</th><th>🗓 実施日</th><th>🏷 管理番号</th><th>🩺 機器名</th>'
    + '<th>⚡ アクション</th><th>🙋 実施者</th><th>⚖️ 判定</th><th>📝 内容</th><th></th>'
    + '</tr></thead><tbody>';

  if (!d.rows.length){
    h += '<tr><td colspan="9" class="sub" style="text-align:center;padding:24px">'
       + '🔍 該当なし</td></tr>';
  }

  d.rows.forEach(function(r, i){
    var body = r.trouble || r.memo || '';
    h += '<tr>'
      + '<td>' + esc(r.hid) + '</td>'
      + '<td>' + esc(r.date) + '</td>'
      + '<td>' + esc(r.kanriNo) + '</td>'
      + '<td>' + esc(r.devName) + '</td>'
      + '<td>' + esc(r.actName) + '</td>'
      + '<td>' + esc(r.userName) + '</td>'
      + '<td>' + judgeTx(r.judge) + '</td>'
      + '<td style="max-width:260px;white-space:normal">'
      +   (body ? esc(body.length > 60 ? body.slice(0,60) + '…' : body)
                : '<span class="sub">—</span>') + '</td>'
            + '<td class="act" style="white-space:nowrap">'
      +   (r.hid
          ? '<button class="btn-sub btn-sm" onclick="openDlg(\'' + esc(r.hid) + '\')">'
            + (r.editable ? '🔎 詳細・修正' : '🔎 詳細') + '</button>'
          : '<span class="sub">—</span>')
      +   (r.kanriNo
          ? ' <button class="btn-sub btn-sm" title="この機器の書類ボックス" onclick="openDocsRow(' + i + ')">📎</button>'
          : '')
      + '</td></tr>';
   });

  document.getElementById('tbl').innerHTML = h + '</tbody>';
}

/* =============================================================
 *  アクション登録
 * ============================================================= */

function openAdd(){
  errIn('addErr', '');
  document.getElementById('aNo').value = '';
  document.getElementById('devCard').classList.add('hide');
  document.getElementById('addBody').classList.add('hide');
  document.getElementById('addBody').innerHTML = '';
  S.dev = null;
  document.getElementById('ovAdd').classList.add('on');

  if (S.actx){ setTimeout(function(){ document.getElementById('aNo').focus(); }, 50); return; }

  google.script.run
    .withSuccessHandler(function(c){
      S.actx = c;
      setTimeout(function(){ document.getElementById('aNo').focus(); }, 50);
    })
    .withFailureHandler(function(e){
      if (String(e.message).indexOf('AUTH') >= 0){ closeAdd(); clrTk(); show('vPw'); return; }
      errIn('addErr', e.message);
    })
    .apiGetActionContext(S.token);
}

function closeAdd(){
  document.getElementById('ovAdd').classList.remove('on');
  S.dev = null;
}

function findDev(){
  var no = document.getElementById('aNo').value.trim();
  if (!no){ errIn('addErr', '🏷 管理番号を入力してください'); return; }
  errIn('addErr', '');
  var el = document.getElementById('btnFind');
  busy(true, el, '📥 読込');

  google.script.run
    .withSuccessHandler(function(d){
      busy(false, el, '📥 読込');
      S.dev = d;
      document.getElementById('devCard').innerHTML =
          '<div style="font-weight:700">🏷 ' + esc(d.kanriNo) + '　🩺 ' + esc(d.name) + '</div>'
        + '<div class="sub" style="margin-top:4px">🗂 ' + esc(d.category)
        + '　🏭 ' + esc(d.maker) + ' 🔤 ' + esc(d.model) + '</div>'
        + '<div class="sub">🏥 ' + esc(d.site) + ' 🏢 ' + esc(d.dept)
        + ' / 📍 ' + esc(d.loc)
        + '　🚦 現在の状態 : <b>' + esc(d.status) + '</b></div>';
      document.getElementById('devCard').classList.remove('hide');
      renderAddForm();
    })
    .withFailureHandler(function(e){
      busy(false, el, '📥 読込');
      if (String(e.message).indexOf('AUTH') >= 0){ closeAdd(); clrTk(); show('vPw'); return; }
      S.dev = null;
      document.getElementById('devCard').classList.add('hide');
      document.getElementById('addBody').classList.add('hide');
      errIn('addErr', e.message);
    })
    .apiFindDevice(S.token, no);
}

function renderAddForm(){
  var c = S.actx, d = S.dev;
  if (!c || !d) return;

  var aopt = c.actions.map(function(a){
    return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>';
  }).join('');
  var uopt = c.users.map(function(u){
    return '<option value="' + esc(u.id) + '">' + esc(u.name) + '（' + esc(u.dept) + '）</option>';
  }).join('');

  var h = '';
  h += '<div class="fld"><label>⚡ アクション<span class="req">*</span></label>'
     + '<select id="aAct" onchange="onActChange()">'
     + '<option value="">👇 選択してください</option>' + aopt + '</select></div>';
  h += '<div class="fld"><label>🙋 実施者<span class="req">*</span></label>'
     + '<select id="aUser"><option value="">👇 選択してください</option>'
     + uopt + '</select></div>';
  h += '<div class="fld"><label>🗓 実施日<span class="req">*</span></label>'
     + '<input type="date" id="aDate" value="' + esc(c.today) + '"></div>';
  h += '<div id="aExtra"></div>';
  h += '<div class="fld"><label>📝 備考</label><input type="text" id="aMemo"></div>';

  document.getElementById('addBody').innerHTML = h;
  document.getElementById('addBody').classList.remove('hide');

  // 前回選んだ実施者を覚えておく
  try{
    var saved = localStorage.getItem('mkdx_admin_user') || '';
    if (saved) document.getElementById('aUser').value = saved;
  }catch(e){}
}

function curAct(){
  var id = document.getElementById('aAct').value;
  for (var i = 0; i < S.actx.actions.length; i++){
    if (S.actx.actions[i].id === id) return S.actx.actions[i];
  }
  return null;
}

function onActChange(){
  var a = curAct();
  var box = document.getElementById('aExtra');
  if (!box) return;
  if (!a){ box.innerHTML = ''; return; }

  var h = '';

  // 導入なら実施日を使用開始日に寄せる
  if (a.useStart && S.dev.startDate){
    document.getElementById('aDate').value = S.dev.startDate;
    h += '<div class="sub" style="margin:-6px 0 12px">'
       + '🗓 実施日に機器マスタの使用開始日（' + esc(S.dev.startDate) + '）を入れました。</div>';
  }

  if (a.judge){
    h += '<div class="fld"><label>⚖️ 総合判定</label><select id="aJudge">'
       + '<option value="">— 未記入 —</option>'
       + '<option value="OK" selected>✅ OK</option>'
       + '<option value="NG">❌ NG</option></select></div>';
  }

  if (a.categoryOpts){
    var copt = a.categoryOpts.map(function(k){
      return '<option value="' + esc(k.name) + '">' + esc(k.icon) + ' ' + esc(k.name)
           + '（' + esc(k.hint) + '）</option>';
    }).join('');
    h += '<div class="fld"><label>🗂 分類<span class="req">*</span></label>'
       + '<select id="aCat"><option value="">👇 選択してください</option>' + copt + '</select></div>';
    h += '<div class="msg ok" style="margin-bottom:12px">'
       + '💬 ステータスは変わりません。使えない・危ないときは「故障報告」で登録してください。</div>';
  }

  if (a.trouble){
    h += '<div class="fld"><label>📝 内容<span class="req">*</span></label>'
       + '<input type="text" id="aTrouble" placeholder="'
       + (a.categoryOpts ? '例）電源コードが見当たらない' : '例）メーカーへ搬出') + '"></div>';
  }

  if (a.move){
    var dopt = S.actx.depts.map(function(x){
      return '<option value="' + esc(x.id) + '"'
           + (x.id === S.dev.deptId ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('');
    h += '<div class="fld"><label>🏢 移設先の部署<span class="req">*</span></label>'
       + '<select id="aDept" onchange="onDeptChange()">'
       + '<option value="">👇 選択してください</option>' + dopt + '</select></div>';
    h += '<div class="fld"><label>📍 移設先の保管場所<span class="req">*</span></label>'
       + '<select id="aLoc"></select></div>';
  }

  if (a.statusOpts){
    var sopt = a.statusOpts.map(function(s){
      return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
    }).join('');
    h += '<div class="fld"><label>🚦 ステータス<span class="req">*</span></label>'
       + '<select id="aStatus">' + sopt + '</select></div>';
  } else if (a.statusFix){
    h += '<div class="msg ok" style="margin-bottom:12px">'
       + '🚦 登録すると機器のステータスが「' + esc(a.statusFix) + '」になります。</div>';
  }

  box.innerHTML = h;
  if (a.move) onDeptChange();
}

function onDeptChange(){
  var sel = document.getElementById('aLoc');
  if (!sel) return;
  var dept = document.getElementById('aDept').value;
  var list = S.actx.locs.filter(function(l){ return !dept || l.dept === dept; });
  sel.innerHTML = '<option value="">👇 選択してください</option>'
    + list.map(function(l){
        return '<option value="' + esc(l.id) + '"'
             + (l.id === S.dev.locId ? ' selected' : '') + '>'
             + esc(l.name) + '（' + esc(l.site) + '）</option>';
      }).join('');
}

function submitAdd(){
  if (!S.dev){ errIn('addErr', '🏷 まず管理番号を読み込んでください'); return; }
  var a = curAct();
  if (!a){ errIn('addErr', '⚡ アクションを選択してください'); return; }

  var userId = document.getElementById('aUser').value;
  if (!userId){ errIn('addErr', '🙋 実施者を選択してください'); return; }
  try{ localStorage.setItem('mkdx_admin_user', userId); }catch(e){}

  var p = {
    kanriNo: S.dev.kanriNo,
    actId  : a.id,
    userId : userId,
    date   : document.getElementById('aDate').value,
    memo   : document.getElementById('aMemo').value
  };

  var gj = document.getElementById('aJudge');
  if (gj) p.judge = gj.value;
  var gt = document.getElementById('aTrouble');
  if (gt) p.trouble = gt.value;
  var gc = document.getElementById('aCat');
  if (gc){
    if (!gc.value){ errIn('addErr', '🗂 分類を選択してください'); return; }
    p.category = gc.value;
  }
  var gd = document.getElementById('aDept');
  if (gd) p.newDeptId = gd.value;
  var gl = document.getElementById('aLoc');
  if (gl) p.newLocId = gl.value;
  var gs = document.getElementById('aStatus');
  if (gs) p.newStatus = gs.value;

  errIn('addErr', '');
  var el = document.getElementById('btnAdd');
  busy(true, el, '✅ 登録する');

  google.script.run
    .withSuccessHandler(function(r){
      busy(false, el, '✅ 登録する');
      // closeAdd() が S.dev を空にするので、管理番号は先に控えておく
      var no = p.kanriNo;
      closeAdd();
      msg('🎉 ' + r.hid + ' を登録しました（🏷 ' + no
          + ' → 🚦 ' + r.status + '）');
      search();
    })
    .withFailureHandler(function(e){
      busy(false, el, '✅ 登録する');
      if (String(e.message).indexOf('AUTH') >= 0){ closeAdd(); clrTk(); show('vPw'); return; }
      errIn('addErr', e.message);
    })
    .apiSubmitAction(S.token, p);
}

/* =============================================================
 *  詳細・修正
 * ============================================================= */

function openDlg(hid){
  var key = String(hid == null ? '' : hid).trim();
  // 空・未定義はここで完全に止める（通信もダイアログ表示もしない）
  if (!key || key === 'undefined' || key === 'null'){
    console.log('openDlg: 空の履歴IDで呼ばれました', hid);
    return;
  }

  document.getElementById('dlgTitle').textContent = '🕘 ' + key;
  errIn('dlgErr', '');
  document.getElementById('dlgBody').innerHTML =
    '<div class="sub" style="padding:20px;text-align:center">'
    + '<span class="spin"></span>📥 読み込み中…</div>';
  document.getElementById('btnSave').classList.add('hide');
  document.getElementById('ov').classList.add('on');

    google.script.run
    .withSuccessHandler(function(d){
      if (!d){ closeDlg(); return; }     // 空で呼ばれていた場合は黙って閉じる
      S.detail = d;
      renderDlg();
    })
    .withFailureHandler(function(e){
      if (String(e.message).indexOf('AUTH') >= 0){ closeDlg(); clrTk(); show('vPw'); return; }
      document.getElementById('dlgBody').innerHTML =
        '<div class="msg err">⚠️ ' + esc(e.message) + '</div>';
    })
    .apiGetHistoryDetail(S.token, key);
}

function renderDlg(){
  var d = S.detail;
  var h = '';

  h += '<div class="fld"><label>🩺 対象機器</label>'
     + '<div style="font-weight:700">🏷 ' + esc(d.kanriNo) + '　'
     + esc(d.devName) + '</div></div>';
  h += '<div class="fld"><label>⚡ アクション / 🗓 実施日 / 🕒 登録日時</label>'
     + '<div>⚡ ' + esc(d.actName) + '　🗓 ' + esc(d.date)
     + '<span class="sub">　(🕒 登録 ' + esc(d.regAt) + ')</span></div></div>';

  if (!d.editable){
    h += '<div class="msg ok" style="margin-top:12px">'
       + '🔒 この種類の履歴はここでは修正できません。内容を直したい場合は、'
       + '⚡ 打ち消しのアクションを新しく登録してください。</div>';
    if (d.memo)    h += '<div class="fld"><label>📝 備考</label><div>'
                      + esc(d.memo) + '</div></div>';
    if (d.trouble) h += '<div class="fld"><label>😢 内容</label><div>'
                      + esc(d.trouble) + '</div></div>';
    h += photoSection_(d);
    document.getElementById('dlgBody').innerHTML = h;
    document.getElementById('btnSave').classList.add('hide');
    loadHisPhotos_(d);
    return;
  }

  var uopt = d.users.map(function(u){
    return '<option value="' + esc(u.id) + '"' + (u.id === d.userId ? ' selected' : '')
         + '>' + esc(u.name) + '（' + esc(u.dept) + '）</option>';
  }).join('');
  h += '<div class="fld"><label>🙋 実施者<span class="req">*</span></label>'
     + '<select id="eUser">' + uopt + '</select></div>';

  if (d.kind === 'trouble'){
    h += '<div class="fld"><label>😢 故障内容<span class="req">*</span></label>'
       + '<input type="text" id="eTrouble" value="' + esc(d.trouble) + '"></div>';
  } else {
    h += '<div class="fld" style="margin-bottom:6px"><label>📋 点検結果</label></div>';
    if (!d.items.length){
      h += '<div class="sub" style="margin-bottom:12px">'
         + '🙇 この履歴に紐づく点検項目が見つかりません。'
         + '🙋 実施者と📝備考のみ修正できます。</div>';
    }
    d.items.forEach(function(it){
      var v = d.values[it.id];
      v = (v === undefined || v === null) ? '' : String(v);
      var inp;
      if (it.type === '○×'){
        inp = '<select data-i="' + esc(it.id) + '">'
            + '<option value=""' + (v === '' ? ' selected' : '') + '>— 未入力 —</option>'
            + '<option value="○"' + (v === '○' ? ' selected' : '') + '>⭕️ ○</option>'
            + '<option value="×"' + (v === '×' ? ' selected' : '') + '>❌ ×</option></select>';
      } else if (it.type === '数値'){
        inp = '<input type="number" step="any" data-i="' + esc(it.id) + '" value="' + esc(v) + '">';
      } else if (it.type === '日付'){
        inp = '<input type="month" data-i="' + esc(it.id) + '" value="' + esc(v) + '">';
      } else {
        inp = '<input type="text" data-i="' + esc(it.id) + '" value="' + esc(v) + '">';
      }
      h += '<div class="fld"><label>✍️ ' + esc(it.name)
         + (it.required ? '<span class="req">❗</span>' : '') + '</label>' + inp + '</div>';
    });
    h += '<div class="fld"><label>⚖️ 総合判定</label>'
       + '<select id="eJudge">'
       + '<option value=""' + (!d.judge ? ' selected' : '') + '>🤖 自動で判定</option>'
       + '<option value="OK"' + (d.judge === 'OK' ? ' selected' : '') + '>✅ OK</option>'
       + '<option value="NG"' + (d.judge === 'NG' ? ' selected' : '') + '>❌ NG</option>'
       + '</select>'
       + '<div class="sub" style="margin-top:4px">'
       + '🤖 自動の場合、○×に ❌ があれば NG になります</div></div>';
  }

  h += '<div class="fld"><label>📝 備考</label>'
     + '<input type="text" id="eMemo" value="' + esc(d.memo) + '"></div>';
  h += photoSection_(d);

  document.getElementById('dlgBody').innerHTML = h;
  document.getElementById('btnSave').classList.remove('hide');
  loadHisPhotos_(d);
}

function closeDlg(){
  document.getElementById('ov').classList.remove('on');
  S.detail = null;
}

function save(){
  var d = S.detail;
  if (!d) return;

  var el = document.getElementById('btnSave');
  errIn('dlgErr', '');

  var userId = document.getElementById('eUser').value;
  if (!userId){ errIn('dlgErr', '🙋 実施者を選択してください'); return; }
  var memo = document.getElementById('eMemo').value;

  busy(true, el, '💾 保存する');

  var ok = function(r){
    busy(false, el, '💾 保存する');
    closeDlg();
    msg('💾 ' + r.id + ' を保存しました'
        + (r.judge ? '（⚖️ 総合判定 '
           + (r.judge === 'NG' ? '❌ NG' : '✅ ' + r.judge) + '）' : ''));
    search();
  };
  var ng = function(e){
    busy(false, el, '💾 保存する');
    if (String(e.message).indexOf('AUTH') >= 0){ closeDlg(); clrTk(); show('vPw'); return; }
    errIn('dlgErr', e.message);
  };

  if (d.kind === 'trouble'){
    var tx = document.getElementById('eTrouble').value.trim();
    if (!tx){ busy(false, el, '💾 保存する');
              errIn('dlgErr', '😢 故障内容を入力してください'); return; }
    google.script.run.withSuccessHandler(ok).withFailureHandler(ng)
      .apiAdminUpdateTrouble(S.token,
        { hid: d.hid, userId: userId, trouble: tx, memo: memo });
  } else {
    var results = [], miss = [];
    document.querySelectorAll('#dlgBody [data-i]').forEach(function(x){
      var v = String(x.value || '').trim();
      var it = null;
      for (var i = 0; i < d.items.length; i++){
        if (d.items[i].id === x.dataset.i){ it = d.items[i]; break; }
      }
      if (it && it.required && v === '') miss.push(it.name);
      if (v !== '') results.push({ id: x.dataset.i, value: v });
    });
    if (miss.length){
      busy(false, el, '💾 保存する');
      errIn('dlgErr', '✍️ 未入力があります : ' + miss.join('、'));
      return;
    }
    google.script.run.withSuccessHandler(ok).withFailureHandler(ng)
      .apiAdminUpdateInspection(S.token, {
        hid: d.hid, userId: userId, results: results,
        judge: document.getElementById('eJudge').value, memo: memo
      });
  }
}

/* =============================================================
 *  書類ボックスと、点検・報告で添付された写真
 *    ・一覧の 📎 … その機器の書類ボックス（写真はタイル、それ以外は一覧）
 *    ・詳細       … この記録で添付された写真（ファイル名が「履歴ID_」で始まるもの）
 *    どちらもサムネイルを押すと大きく開く。見るだけ（追加・削除はマスタ管理の機器から）
 * ============================================================= */

var DOCS = { cache:{}, no:'', name:'', list:[], view:{ url:'', name:'' } };

// 機器の書類一覧を取る（同じ機器は1分使い回す）
function loadFiles_(kanriNo, ok, ng){
  var c = DOCS.cache[kanriNo];
  if (c && Date.now() - c.at < 60000){ ok(c.files); return; }
  google.script.run
    .withSuccessHandler(function(d){
      var files = (d && d.files) || [];
      DOCS.cache[kanriNo] = { at: Date.now(), files: files };
      ok(files);
    })
    .withFailureHandler(function(e){
      if (String(e.message).indexOf('AUTH') >= 0){ closeDocs(); closeDlg(); clrTk(); show('vPw'); return; }
      if (ng) ng(e);
    })
    .apiListFiles(S.token, kanriNo);
}

// 写真のタイル（files の中の index で開く）
function tiles_(files, idxs, openFn){
  return '<div class="pv-grid">' + idxs.map(function(j){
    var f = files[j];
    return '<button type="button" class="pv-tile" title="' + esc(f.name) + '" onclick="' + openFn + '(' + j + ')">'
         +   '<span class="pv-img" data-pv="' + esc(f.id) + '"><span class="pv-ld"></span></span>'
         +   '<span class="pv-cap">' + esc(pvCap_(f.date)) + '</span>'
         + '</button>';
  }).join('') + '</div>';
}

/* ---------- 一覧の 📎 → 書類ボックス ---------- */
function openDocsRow(i){
  var r = S.data && S.data.rows[i];
  if (r) openDocs(r.kanriNo, r.devName);
}

function openDocs(kanriNo, name){
  pvCss_();
  DOCS.no = String(kanriNo || ''); DOCS.name = String(name || '');
  document.getElementById('docsTitle').textContent = '📎 ' + DOCS.no + ' の書類ボックス';
  document.getElementById('docsSub').textContent = DOCS.name;
  document.getElementById('docsBody').innerHTML =
    '<div class="sub" style="padding:20px;text-align:center"><span class="spin"></span>📥 読み込み中…</div>';
  document.getElementById('ovDocs').classList.add('on');
  loadFiles_(DOCS.no, function(files){
    DOCS.list = files;
    renderDocs();
  }, function(e){
    document.getElementById('docsBody').innerHTML = '<div class="msg err">⚠️ ' + esc(e.message) + '</div>';
  });
}

function renderDocs(){
  var files = DOCS.list, box = document.getElementById('docsBody');
  if (!files.length){
    box.innerHTML = '<p class="sub" style="text-align:center;padding:24px 0">'
      + '🗒 この機器の書類はまだありません。</p>';
    return;
  }
  var h = '', i = 0;
  while (i < files.length){
    var kind = files[i].kind, imgs = [], others = [];
    for (; i < files.length && files[i].kind === kind; i++){
      (files[i].isImage ? imgs : others).push(i);
    }
    h += '<div class="doc-kind-h">' + esc(kind) + '</div>';
    if (imgs.length) h += tiles_(files, imgs, 'openDocFile');
    others.forEach(function(j){
      var f = files[j];
      var ic = f.isPdf ? '📄' : '📎';
      h += '<button type="button" class="doc-line" onclick="openDocFile(' + j + ')">'
         +   '<span style="font-size:20px">' + ic + '</span>'
         +   '<span style="min-width:0;text-align:left"><b style="display:block;word-break:break-all">' + esc(f.name) + '</b>'
         +   '<span class="sub">' + esc(f.sizeText) + '　' + esc(f.date) + '</span></span>'
         + '</button>';
    });
  }
  box.innerHTML = h;
  pvFill_();
}

function openDocFile(j){ var f = DOCS.list[j]; if (f) openFile_(f); }
function closeDocs(){ document.getElementById('ovDocs').classList.remove('on'); }

/* ---------- 詳細：この記録で添付された写真 ---------- */
function photoSection_(d){
  return '<div class="fld"><label>📷 この記録で添付された写真</label>'
       + '<div id="hisPhotos"><span class="sub"><span class="spin"></span>確認中…</span></div>'
       + '<button type="button" class="btn-sub btn-sm" style="margin-top:8px" '
       + 'onclick="openDocs(S.detail.kanriNo, S.detail.devName)">📎 この機器の書類ボックスを開く</button></div>';
}

function loadHisPhotos_(d){
  pvCss_();
  var hid = String(d.hid || '');
  loadFiles_(d.kanriNo, function(files){
    var box = document.getElementById('hisPhotos');
    if (!box || !S.detail || S.detail.hid !== hid) return;    // 別の記録を開き直していたら何もしない
    // 点検画面から添付した写真は「履歴ID_日付_元の名前」で入っている
    var mine = [];
    files.forEach(function(f, j){ if (String(f.name).indexOf(hid + '_') === 0) mine.push(j); });
    DOCS.his = files;
    if (!mine.length){
      box.innerHTML = '<span class="sub">この記録に添付された写真はありません</span>';
      return;
    }
    box.innerHTML = tiles_(files, mine, 'openHisFile')
      + '<div class="sub">👆 押すと大きく開きます（' + mine.length + ' 枚）</div>';
    pvFill_();
  }, function(){
    var box = document.getElementById('hisPhotos');
    if (box) box.innerHTML = '<span class="sub">写真を確認できませんでした</span>';
  });
}

function openHisFile(j){ var f = (DOCS.his || [])[j]; if (f) openFile_(f); }

/* ---------- 大きく見る ---------- */
function openFile_(f){
  if (f.tooBig){ msg('⚠️ ' + f.name + ' は大きすぎて開けません（' + f.sizeText + '）', true); return; }
  document.getElementById('viewTitle').textContent = (f.isImage ? '🖼 ' : '📄 ') + f.name;
  var body = document.getElementById('viewBody');
  // サムネイルが手元にあれば、先にそれを大きく出しておく（本物が届いたら差し替える）
  body.innerHTML = PV[f.id]
    ? '<img src="' + PV[f.id] + '" alt="" style="width:100%;border-radius:10px;filter:blur(2px);opacity:.7">'
      + '<div class="sub" style="text-align:center;margin-top:6px"><span class="spin"></span>📥 元の写真を読み込み中…</div>'
    : '<div class="sub" style="padding:30px;text-align:center"><span class="spin"></span>📥 読み込み中…</div>';
  document.getElementById('ovView').classList.add('on');

  google.script.run
    .withSuccessHandler(function(d){
      var url = 'data:' + d.mime + ';base64,' + d.data;
      DOCS.view = { url: url, name: d.name };
      if (String(d.mime).indexOf('image/') === 0){
        body.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener" title="新しいタブで開く">'
          + '<img src="' + url + '" alt="' + esc(d.name) + '" style="width:100%;border-radius:10px;display:block"></a>'
          + '<button type="button" class="btn-sub" style="width:100%;margin-top:10px" onclick="saveView()">⬇️ この写真を保存</button>';
      } else {
        body.innerHTML = '<p class="sub" style="text-align:center;padding:16px 0">'
          + '📄 この形式は画面では開けません。保存して確認してください。</p>'
          + '<button type="button" class="btn-sub" style="width:100%" onclick="saveView()">⬇️ ' + esc(d.name) + ' を保存</button>';
      }
    })
    .withFailureHandler(function(e){
      body.innerHTML = '<div class="msg err">⚠️ ' + esc(e.message) + '</div>';
    })
    .apiGetFile(S.token, f.id);
}

function saveView(){
  if (!DOCS.view.url) return;
  var a = document.createElement('a');
  a.href = DOCS.view.url; a.download = DOCS.view.name || 'file';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function closeView(){
  document.getElementById('ovView').classList.remove('on');
  document.getElementById('viewBody').innerHTML = '';
  DOCS.view = { url:'', name:'' };
}

/* ---------- 書類ボックスの写真をタイルで並べる ---------- */
// 写真（画像ファイル）は3列のタイル、それ以外は今までどおりの一覧
function pvCss_(){
  if (document.getElementById('pvCss')) return;
  var st = document.createElement('style');
  st.id = 'pvCss';
  st.textContent =
      '.pv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 8px}'
    + '.pv-tile{position:relative;display:block;width:100%;padding:0;margin:0;border:1.5px solid #e1e8ef;'
    +   'border-radius:10px;overflow:hidden;background:#f3f6f8;cursor:pointer;text-decoration:none;color:inherit}'
    + '.pv-tile:hover{border-color:#1f7f88}'
    + '.pv-tile:active{opacity:.75}'
    + '.pv-img{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:1/1;font-size:28px}'
    + '.pv-img img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.pv-cap{position:absolute;left:0;right:0;bottom:0;padding:10px 6px 4px;font-size:11px;font-weight:600;'
    +   'color:#fff;text-align:left;background:linear-gradient(transparent,rgba(0,0,0,.55));'
    +   'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.pv-ld{width:18px;height:18px;border:2px solid #d6e0e3;border-top-color:#1f7f88;border-radius:50%;'
    +   'animation:pvsp .7s linear infinite}'
    + '@keyframes pvsp{to{transform:rotate(360deg)}}'
    + '@media (max-width:380px){.pv-grid{grid-template-columns:repeat(2,1fr)}}'
    + '.doc-kind-h{font-size:11px;font-weight:800;color:var(--accent,#1f7f88);letter-spacing:.06em;margin:12px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #dfe9ea}'
    + '.doc-kind-h:first-child{margin-top:0}'
    + '.doc-line{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;margin-bottom:6px;background:#fff;border:1.5px solid #e1e8ef;border-radius:9px;cursor:pointer;font:inherit;color:inherit}'
    + '.doc-line:hover{border-color:#1f7f88}'
    + '#hisPhotos .pv-grid{grid-template-columns:repeat(4,1fr)}'
    + '@media (max-width:480px){#hisPhotos .pv-grid{grid-template-columns:repeat(3,1fr)}}';
  document.head.appendChild(st);
}

// '2026/10/19 15:48' → '10/19 15:48'
function pvCap_(d){
  var m = String(d || '').match(/^\d{4}\/(\d{2}\/\d{2})(.*)$/);
  return m ? m[1] + m[2] : String(d || '');
}

var PV = {};          // ファイルID → サムネイルの dataURL（'' は作れなかった）
var PV_BUSY = false;

// 画面に出ている写真のうち、まだ取っていないものを6枚ずつ取りにいく
function pvFill_(){
  var els = document.querySelectorAll('[data-pv]');
  var want = [];
  for (var i = 0; i < els.length; i++){
    var id = els[i].getAttribute('data-pv');
    if (PV[id] !== undefined) pvPaint_(id);
    else if (want.indexOf(id) < 0) want.push(id);
  }
  if (!want.length || PV_BUSY) return;
  PV_BUSY = true;
  var batch = want.slice(0, 6);
  google.script.run
    .withSuccessHandler(function(d){
      PV_BUSY = false;
      var m = (d && d.map) || {};
      batch.forEach(function(id){ PV[id] = m[id] || ''; pvPaint_(id); });
      pvFill_();                                  // 残りがあれば続けて
    })
    .withFailureHandler(function(e){
      PV_BUSY = false;
      batch.forEach(function(id){ PV[id] = ''; pvPaint_(id); });
      if (String(e && e.message).indexOf('AUTH') >= 0) { closeDocs(); closeDlg(); clrTk(); show('vPw'); }
    })
    .apiGetFilePreviews(S.token, batch);
}

function pvPaint_(id){
  var els = document.querySelectorAll('[data-pv="' + id + '"]');
  for (var i = 0; i < els.length; i++){
    els[i].innerHTML = PV[id]
      ? '<img src="' + PV[id] + '" alt="">'
      : '<span>🖼</span>';
  }
}
</script>
</body>
</html>