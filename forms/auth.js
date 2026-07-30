/* Shared password gate for the TC forms.
   The real check is server-side: every webhook node uses Header Auth, so a wrong
   or missing key gets 403 from n8n before any workflow node runs. This overlay
   only stops someone from filling a whole form before finding that out, and
   remembers the key in localStorage so it is typed once per browser.

   Usage in a form:
     <script src="auth.js"></script>
     fetch(url, { method: 'POST', body: fd, headers: TC_AUTH_HEADERS() })
     if (res.status === 401 || res.status === 403) { TC_AUTH_FAIL(); return; }
*/
(function () {
  var STORAGE_KEY = 'tc_form_key';
  var HEADER_NAME = 'x-auth-key';
  var overlay = null;

  function readKey() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function writeKey(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) {}
  }
  function dropKey() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function injectStyle() {
    if (document.getElementById('tcAuthStyle')) return;
    /* Spotify Encore conventions: green is reserved for the primary action,
       primary hover = brighten + scale, text inputs focus to a white border. */
    var css = ''
      + '#tcAuthGate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;'
      + 'justify-content:center;padding:24px;background:#000;'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      + '#tcAuthGate .tc-card{width:100%;max-width:340px;background:#121212;border-radius:8px;'
      + 'padding:32px 28px;text-align:center}'
      + '#tcAuthGate h2{margin:0 0 8px;font-size:24px;line-height:1.2;font-weight:700;color:#fff;'
      + 'letter-spacing:-0.04em}'
      + '#tcAuthGate p{margin:0 0 24px;font-size:14px;line-height:1.5;color:#a7a7a7}'
      + '#tcAuthGate input{width:100%;height:48px;padding:0 14px;border-radius:4px;'
      + 'border:1px solid #727272;background:#121212;color:#fff;font-size:16px;font-family:inherit;'
      + 'text-align:center;letter-spacing:0.2em;transition:border-color .1s ease}'
      + '#tcAuthGate input::placeholder{color:#6a6a6a;letter-spacing:0.2em}'
      + '#tcAuthGate input:hover{border-color:#fff}'
      + '#tcAuthGate input:focus{outline:none;border-color:#fff;box-shadow:inset 0 0 0 1px #fff}'
      + '#tcAuthGate button{width:100%;height:48px;margin-top:16px;border:none;border-radius:500px;'
      + 'background:#1ED760;color:#000;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;'
      + 'transition:background-color .1s ease,transform .1s ease}'
      + '#tcAuthGate button:hover{background:#3BE477;transform:scale(1.04)}'
      + '#tcAuthGate button:active{background:#1ED760;transform:scale(1)}'
      + '#tcAuthGate .tc-err{margin:16px 0 0;font-size:14px;line-height:1.4;color:#f15e6c;min-height:20px}';
    var el = document.createElement('style');
    el.id = 'tcAuthStyle';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function show(message) {
    injectStyle();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tcAuthGate';
      overlay.innerHTML = ''
        + '<div class="tc-card">'
        + '<h2>Mật khẩu</h2>'
        + '<p>Nhập mật khẩu để mở form. Máy này chỉ cần nhập một lần.</p>'
        + '<input type="password" id="tcAuthInput" autocomplete="current-password" '
        + 'inputmode="numeric" placeholder="••••" aria-label="Mật khẩu">'
        + '<button type="button" id="tcAuthBtn">Mở form</button>'
        + '<p class="tc-err" id="tcAuthErr"></p>'
        + '</div>';
      document.body.appendChild(overlay);

      var input = overlay.querySelector('#tcAuthInput');
      var submit = function () {
        var v = input.value.trim();
        if (!v) {
          overlay.querySelector('#tcAuthErr').textContent = 'Chưa nhập gì.';
          return;
        }
        writeKey(v);
        hide();
      };
      overlay.querySelector('#tcAuthBtn').addEventListener('click', submit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    }
    overlay.querySelector('#tcAuthErr').textContent = message || '';
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    var box = overlay.querySelector('#tcAuthInput');
    box.value = '';
    setTimeout(function () { box.focus(); }, 50);
  }

  function hide() {
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  /* Headers to attach to every webhook request, including connectivity probes. */
  window.TC_AUTH_HEADERS = function () {
    var h = {};
    h[HEADER_NAME] = readKey();
    return h;
  };

  /* Call on a 401/403 from the webhook: forget the key and ask again. */
  window.TC_AUTH_FAIL = function () {
    dropKey();
    show('Mật khẩu sai hoặc đã đổi. Nhập lại rồi gửi lần nữa.');
  };

  function start() {
    if (!readKey()) show('');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
