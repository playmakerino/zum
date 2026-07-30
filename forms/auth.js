/* Shared password entry for the TC forms.

   The real check is server-side: every webhook node uses Header Auth, so a wrong
   or missing key gets 403 from n8n before any workflow node runs.

   Following Encore, the corner holds state only and the credential is typed in a
   dialog, so the green primary in that dialog never competes with the form's own
   submit button. The dialog is dismissible, so the form stays usable. The key
   lives in localStorage, so it is typed once per browser and asked for again only
   after a 403.

   The chip sits below the guide panel layer (z-index 70 in tc_prd_form) so it can
   never cover that panel's close button.

   Usage in a form:
     <script src="auth.js"></script>
     fetch(url, { method: 'POST', body: fd, headers: TC_AUTH_HEADERS() })
     if (res.status === 401 || res.status === 403) { TC_AUTH_FAIL(); return; }
*/
(function () {
  var STORAGE_KEY = 'tc_form_key';
  var HEADER_NAME = 'x-auth-key';
  var chip = null;
  var dialog = null;
  var toastTimer = null;

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
       white border, an invalid input gets a red border plus red helper text. */
    var css = ''
      /* state only, no green, no input. In flow at the top of the page so it scrolls
         away: it is needed once per browser, and a failure announces itself with the
         dialog and the toast rather than waiting to be found. */
      + '#tcAuthChipRow{display:flex;justify-content:flex-end;margin-bottom:16px}'
      + '#tcAuthChip{display:inline-flex;gap:8px;align-items:baseline;background:#181818;'
      + 'border-radius:500px;padding:8px 16px;'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      /* fallback for a page with no .container to sit in */
      + '#tcAuthChip.tc-floating{position:fixed;top:12px;right:12px;z-index:40;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,0.4)}'
      + '#tcAuthChip .tc-state{font-size:14px;line-height:1.5;color:#a7a7a7}'
      + '#tcAuthChip .tc-link{border:none;background:none;padding:0;font-family:inherit;'
      + 'font-size:14px;font-weight:700;color:#a7a7a7;cursor:pointer;transition:color .1s ease}'
      + '#tcAuthChip .tc-link:hover{color:#fff;text-decoration:underline}'

      /* dialog: where the credential is actually typed */
      + '#tcAuthScrim{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;padding:24px;background:rgba(0,0,0,0.7);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      + '#tcAuthScrim .tc-card{position:relative;width:100%;max-width:360px;background:#282828;'
      + 'border-radius:8px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,0.6)}'
      + '#tcAuthScrim h2{margin:0 0 8px;font-size:24px;line-height:1.2;font-weight:700;'
      + 'color:#fff;letter-spacing:-0.02em}'
      + '#tcAuthScrim .tc-sub{margin:0 0 24px;font-size:14px;line-height:1.5;color:#a7a7a7}'
      + '#tcAuthScrim input{width:100%;height:48px;padding:0 16px;border-radius:4px;'
      + 'border:1px solid #727272;background:#121212;color:#fff;font-size:16px;'
      + 'font-family:inherit;transition:border-color .1s ease}'
      + '#tcAuthScrim input:hover{border-color:#fff}'
      + '#tcAuthScrim input:focus{outline:none;border-color:#fff;box-shadow:inset 0 0 0 1px #fff}'
      + '#tcAuthScrim.tc-invalid input,#tcAuthScrim.tc-invalid input:hover{border-color:#f15e6c}'
      + '#tcAuthScrim .tc-err{margin:8px 0 0;font-size:14px;line-height:1.5;color:#f15e6c}'
      + '#tcAuthScrim .tc-save{width:100%;height:48px;margin-top:24px;border:none;'
      + 'border-radius:500px;background:#1ED760;color:#000;font-size:16px;font-weight:700;'
      + 'font-family:inherit;cursor:pointer;'
      + 'transition:background-color .1s ease,transform .1s ease}'
      + '#tcAuthScrim .tc-save:hover{background:#3BE477;transform:scale(1.04)}'
      + '#tcAuthScrim .tc-save:active{background:#1ED760;transform:scale(1)}'
      + '#tcAuthScrim .tc-x{position:absolute;top:12px;right:12px;width:32px;height:32px;'
      + 'display:flex;align-items:center;justify-content:center;border:none;background:none;'
      + 'color:#a7a7a7;font-size:20px;line-height:1;font-family:inherit;cursor:pointer;'
      + 'transition:color .1s ease}'
      + '#tcAuthScrim .tc-x:hover{color:#fff}'

      /* toast: the form's submit button is far from the chip, so failures announce
         themselves at the bottom of the viewport instead */
      + '#tcAuthToast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
      + 'z-index:10000;background:#282828;color:#fff;border-radius:4px;padding:12px 16px;'
      + 'font-size:14px;line-height:1.5;font-weight:400;box-shadow:0 8px 24px rgba(0,0,0,0.5);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"

      + '@media (max-width:560px){#tcAuthChip.tc-floating{top:8px;right:8px}}';
    var el = document.createElement('style');
    el.id = 'tcAuthStyle';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function buildChip() {
    injectStyle();
    chip = document.createElement('div');
    chip.id = 'tcAuthChip';
    chip.innerHTML = ''
      + '<span class="tc-state" id="tcAuthState"></span>'
      + '<button type="button" class="tc-link" id="tcAuthOpen"></button>';
    var container = document.querySelector('.container');
    if (container) {
      var row = document.createElement('div');
      row.id = 'tcAuthChipRow';
      row.appendChild(chip);
      container.insertBefore(row, container.firstChild);
    } else {
      chip.classList.add('tc-floating');
      document.body.appendChild(chip);
    }
    chip.querySelector('#tcAuthOpen').addEventListener('click', function () {
      openDialog('');
    });
  }

  function renderChip() {
    if (!chip) buildChip();
    var saved = !!readKey();
    chip.querySelector('#tcAuthState').textContent = saved ? 'Password saved' : 'Password required';
    chip.querySelector('#tcAuthOpen').textContent = saved ? 'Change' : 'Enter';
  }

  function buildDialog() {
    injectStyle();
    dialog = document.createElement('div');
    dialog.id = 'tcAuthScrim';
    dialog.innerHTML = ''
      + '<div class="tc-card" role="dialog" aria-modal="true" aria-labelledby="tcAuthTitle">'
      + '<button type="button" class="tc-x" id="tcAuthX" aria-label="Close">&times;</button>'
      + '<h2 id="tcAuthTitle">Password</h2>'
      + '<p class="tc-sub">Saved in this browser, so you only enter it once.</p>'
      + '<form id="tcAuthForm">'
      + '<input type="password" id="tcAuthInput" name="password" '
      + 'autocomplete="current-password" aria-label="Password">'
      + '<p class="tc-err" id="tcAuthErr" style="display:none"></p>'
      + '<button type="submit" class="tc-save">Save</button>'
      + '</form>'
      + '</div>';
    document.body.appendChild(dialog);

    var input = dialog.querySelector('#tcAuthInput');
    /* A real form element, so the browser password manager offers to store it. */
    dialog.querySelector('#tcAuthForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) {
        setError('Enter the password first.');
        return;
      }
      writeKey(v);
      closeDialog();
      renderChip();
    });
    dialog.querySelector('#tcAuthX').addEventListener('click', closeDialog);
    dialog.addEventListener('mousedown', function (e) {
      if (e.target === dialog) closeDialog();
    });
    input.addEventListener('input', function () {
      if (dialog.classList.contains('tc-invalid')) setError('');
    });
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeDialog();
  }

  function setError(message) {
    var box = dialog.querySelector('#tcAuthErr');
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
    dialog.classList.toggle('tc-invalid', !!message);
  }

  function openDialog(message) {
    if (!dialog) buildDialog();
    dialog.style.display = 'flex';
    dialog.querySelector('#tcAuthInput').value = '';
    setError(message);
    document.addEventListener('keydown', onEsc);
    setTimeout(function () { dialog.querySelector('#tcAuthInput').focus(); }, 50);
  }

  function closeDialog() {
    if (dialog) dialog.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
  }

  function toast(message) {
    injectStyle();
    var el = document.getElementById('tcAuthToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tcAuthToast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 4000);
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
    renderChip();
    toast('Wrong password');
    openDialog('Wrong password. Enter it again, then submit once more.');
  };

  /* Nothing opens on load: the form is usable straight away and the chip is the
     only invitation to type the password. */
  function start() {
    renderChip();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
