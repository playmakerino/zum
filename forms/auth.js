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
    /* Encore conventions: green only on the primary action, primary hover is
       brighten + scale, secondary text goes grey to white, inputs focus to a
       white border, and an invalid input is shown by a red border plus red
       helper text instead of any animation. */
    var css = ''
      + '#tcAuthPanel{position:fixed;top:12px;right:12px;z-index:9999;'
      + 'background:#181818;border-radius:8px;padding:12px;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,0.5);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"

      + '#tcAuthPanel label{display:block;margin:0 0 6px;font-size:12px;font-weight:700;'
      + 'color:#fff}'
      + '#tcAuthPanel .tc-field{display:flex;gap:8px;align-items:center}'
      + '#tcAuthPanel input{width:132px;height:40px;padding:0 12px;border-radius:4px;'
      + 'border:1px solid #727272;background:#121212;color:#fff;font-size:14px;'
      + 'font-family:inherit;transition:border-color .1s ease}'
      + '#tcAuthPanel input:hover{border-color:#fff}'
      + '#tcAuthPanel input:focus{outline:none;border-color:#fff;box-shadow:inset 0 0 0 1px #fff}'
      + '#tcAuthPanel.tc-invalid input,#tcAuthPanel.tc-invalid input:hover{border-color:#f15e6c}'
      + '#tcAuthPanel .tc-save{height:40px;padding:0 18px;border:none;border-radius:500px;'
      + 'background:#1ED760;color:#000;font-size:14px;font-weight:700;font-family:inherit;'
      + 'cursor:pointer;transition:background-color .1s ease,transform .1s ease}'
      + '#tcAuthPanel .tc-save:hover{background:#3BE477;transform:scale(1.04)}'
      + '#tcAuthPanel .tc-save:active{background:#1ED760;transform:scale(1)}'
      + '#tcAuthPanel .tc-err{display:flex;gap:6px;margin:8px 0 0;max-width:212px;'
      + 'font-size:12px;line-height:1.4;color:#f15e6c}'

      + '#tcAuthPanel .tc-row{display:flex;gap:10px;align-items:baseline}'
      + '#tcAuthPanel .tc-state{font-size:13px;color:#a7a7a7}'
      + '#tcAuthPanel .tc-link{border:none;background:none;padding:0;font-family:inherit;'
      + 'font-size:13px;font-weight:700;color:#a7a7a7;cursor:pointer;transition:color .1s ease}'
      + '#tcAuthPanel .tc-link:hover{color:#fff;text-decoration:underline}'

      + '@media (max-width:560px){#tcAuthPanel{left:12px;right:12px;top:8px}'
      + '#tcAuthPanel input{flex:1;width:auto}#tcAuthPanel .tc-err{max-width:none}}';
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
      + '<span class="tc-state">Đã lưu mật khẩu</span>'
      + '<button type="button" class="tc-link" id="tcAuthChange">Đổi</button>'
      + '</div>'
      + '<div id="tcAuthEntry" style="display:none">'
      + '<label for="tcAuthInput">Mật khẩu</label>'
      + '<div class="tc-field">'
      + '<input type="password" id="tcAuthInput" autocomplete="current-password" '
      + 'aria-label="Mật khẩu">'
      + '<button type="button" class="tc-save" id="tcAuthBtn">Lưu</button>'
      + '</div>'
      + '<p class="tc-err" id="tcAuthErr" style="display:none"></p>'
      + '</div>';
    document.body.appendChild(panel);

    var input = panel.querySelector('#tcAuthInput');
    var save = function () {
      var v = input.value.trim();
      if (!v) {
        setError('Chưa nhập gì.');
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
    input.addEventListener('input', function () {
      if (panel.classList.contains('tc-invalid')) setError('');
    });
  }

  function setError(message) {
    var box = panel.querySelector('#tcAuthErr');
    box.textContent = message || '';
    box.style.display = message ? 'flex' : 'none';
    panel.classList.toggle('tc-invalid', !!message);
  }

  function showSaved() {
    if (!panel) build();
    setError('');
    panel.querySelector('#tcAuthEntry').style.display = 'none';
    panel.querySelector('#tcAuthSaved').style.display = 'flex';
  }

  function showEntry(message) {
    if (!panel) build();
    panel.querySelector('#tcAuthSaved').style.display = 'none';
    panel.querySelector('#tcAuthEntry').style.display = 'block';
    panel.querySelector('#tcAuthInput').value = '';
    setError(message);
    setTimeout(function () { panel.querySelector('#tcAuthInput').focus(); }, 50);
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
