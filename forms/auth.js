/* Shared password field for the TC forms.

   The real check is server-side: every webhook node uses Header Auth, so a wrong
   or missing key gets 403 from n8n before any workflow node runs. This panel sits
   in the corner and does not block the form. It remembers the key in localStorage
   so it is typed once per browser, and asks again only after a 403.

   Usage in a form:
     <script src="auth.js"></script>
     fetch(url, { method: 'POST', body: fd, headers: TC_AUTH_HEADERS() })
     if (res.status === 401 || res.status === 403) { TC_AUTH_FAIL(); return; }
*/
(function () {
  var STORAGE_KEY = 'tc_form_key';
  var HEADER_NAME = 'x-auth-key';
  var panel = null;

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
       primary hover = brighten + scale, secondary text goes grey to white,
       text inputs focus to a white border. */
    var css = ''
      + '#tcAuthPanel{position:fixed;top:12px;right:12px;z-index:9999;'
      + 'background:#181818;border:1px solid rgba(255,255,255,0.10);border-radius:8px;'
      + 'padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,0.45);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      + '#tcAuthPanel.tc-alert{animation:tcAuthPulse .5s ease-in-out 3}'
      + '@keyframes tcAuthPulse{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,0.45)}'
      + '50%{box-shadow:0 0 0 3px rgba(241,94,108,0.55)}}'

      + '#tcAuthPanel label{display:block;margin:0 0 6px;font-size:11px;font-weight:700;'
      + 'letter-spacing:0.1em;text-transform:uppercase;color:#a7a7a7}'
      + '#tcAuthPanel .tc-field{display:flex;gap:8px;align-items:center}'
      + '#tcAuthPanel input{width:124px;height:36px;padding:0 12px;border-radius:4px;'
      + 'border:1px solid #727272;background:#121212;color:#fff;font-size:14px;'
      + 'font-family:inherit;letter-spacing:0.16em;transition:border-color .1s ease}'
      + '#tcAuthPanel input::placeholder{color:#6a6a6a;letter-spacing:0.16em}'
      + '#tcAuthPanel input:hover{border-color:#fff}'
      + '#tcAuthPanel input:focus{outline:none;border-color:#fff;box-shadow:inset 0 0 0 1px #fff}'
      + '#tcAuthPanel .tc-save{height:36px;padding:0 18px;border:none;border-radius:500px;'
      + 'background:#1ED760;color:#000;font-size:14px;font-weight:700;font-family:inherit;'
      + 'cursor:pointer;transition:background-color .1s ease,transform .1s ease}'
      + '#tcAuthPanel .tc-save:hover{background:#3BE477;transform:scale(1.04)}'
      + '#tcAuthPanel .tc-save:active{background:#1ED760;transform:scale(1)}'
      + '#tcAuthPanel .tc-err{margin:8px 0 0;max-width:200px;font-size:12px;line-height:1.4;'
      + 'color:#f15e6c}'

      + '#tcAuthPanel .tc-row{display:flex;gap:8px;align-items:center}'
      + '#tcAuthPanel .tc-dot{width:8px;height:8px;border-radius:50%;background:#1ED760;flex:none}'
      + '#tcAuthPanel .tc-state{font-size:13px;color:#a7a7a7}'
      + '#tcAuthPanel .tc-link{border:none;background:none;padding:0;margin-left:4px;'
      + 'font-family:inherit;font-size:13px;font-weight:700;color:#a7a7a7;cursor:pointer;'
      + 'text-decoration:underline;transition:color .1s ease}'
      + '#tcAuthPanel .tc-link:hover{color:#fff}'

      + '@media (max-width:560px){#tcAuthPanel{left:12px;right:12px;top:8px}'
      + '#tcAuthPanel input{flex:1;width:auto}}';
    var el = document.createElement('style');
    el.id = 'tcAuthStyle';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function build() {
    injectStyle();
    panel = document.createElement('div');
    panel.id = 'tcAuthPanel';
    panel.innerHTML = ''
      + '<div class="tc-row" id="tcAuthSaved" style="display:none">'
      + '<span class="tc-dot"></span>'
      + '<span class="tc-state">Đã lưu mật khẩu</span>'
      + '<button type="button" class="tc-link" id="tcAuthChange">Đổi</button>'
      + '</div>'
      + '<div id="tcAuthEntry" style="display:none">'
      + '<label for="tcAuthInput">Mật khẩu</label>'
      + '<div class="tc-field">'
      + '<input type="password" id="tcAuthInput" autocomplete="current-password" '
      + 'inputmode="numeric" placeholder="••••" aria-label="Mật khẩu">'
      + '<button type="button" class="tc-save" id="tcAuthBtn">Lưu</button>'
      + '</div>'
      + '<p class="tc-err" id="tcAuthErr"></p>'
      + '</div>';
    document.body.appendChild(panel);

    var input = panel.querySelector('#tcAuthInput');
    var save = function () {
      var v = input.value.trim();
      if (!v) {
        panel.querySelector('#tcAuthErr').textContent = 'Chưa nhập gì.';
        return;
      }
      writeKey(v);
      showSaved();
    };
    panel.querySelector('#tcAuthBtn').addEventListener('click', save);
    panel.querySelector('#tcAuthChange').addEventListener('click', function () {
      showEntry('');
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
  }

  function showSaved() {
    if (!panel) build();
    panel.classList.remove('tc-alert');
    panel.querySelector('#tcAuthEntry').style.display = 'none';
    panel.querySelector('#tcAuthSaved').style.display = 'flex';
  }

  function showEntry(message) {
    if (!panel) build();
    panel.querySelector('#tcAuthSaved').style.display = 'none';
    panel.querySelector('#tcAuthEntry').style.display = 'block';
    panel.querySelector('#tcAuthErr').textContent = message || '';
    var input = panel.querySelector('#tcAuthInput');
    input.value = '';
    if (message) {
      panel.classList.remove('tc-alert');
      void panel.offsetWidth;
      panel.classList.add('tc-alert');
    }
    setTimeout(function () { input.focus(); }, 50);
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
    showEntry('Mật khẩu sai hoặc đã đổi. Nhập lại rồi gửi lần nữa.');
  };

  function start() {
    if (readKey()) showSaved(); else showEntry('');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
