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
      /* state only, no green, no input. Absolute in the top right corner of the page,
         so it scrolls away: it is needed once per browser, and a failure announces
         itself with the dialog and the toast rather than waiting to be found. */
      + '#tcAuthChip{position:absolute;top:12px;right:12px;z-index:40;'
      + 'display:inline-flex;gap:8px;align-items:center;height:32px;padding:4px 16px 4px 12px;'
      + 'color:#b3b3b3;cursor:pointer;transition:color .15s cubic-bezier(.3,0,0,1),transform .15s cubic-bezier(.3,0,0,1);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      + '#tcTopBar{position:absolute;top:12px;right:12px;z-index:40;display:flex;align-items:center}'
      + '#tcTopBar #tcAuthChip{position:relative;top:auto;right:auto}'
      + '#tcAuthChip svg{width:16px;height:16px;flex-shrink:0;fill:currentColor}'
      + '#tcAuthChip .tc-state{font-size:13px;font-weight:700;line-height:1.5}'
      /* the real button covers the whole chip; its own text is not shown here */
      + '#tcAuthChip .tc-link{border:none;background:none;padding:0;font-size:0;cursor:pointer}'
      + '#tcAuthChip .tc-link::after{content:"";position:absolute;inset:0}'
      + '#tcAuthChip:hover{color:#fff;transform:scale(1.04)}'
      + '#tcAuthChip:has(.tc-link:focus-visible){outline:2px solid #fff;outline-offset:2px;border-radius:4px}'

      /* dialog: where the credential is actually typed */
      + '#tcAuthScrim{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;padding:24px;background:rgba(0,0,0,0.7);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
      + '#tcAuthScrim .tc-card{position:relative;width:100%;max-width:360px;background:#121212;'
      + 'border-radius:8px;padding:24px;box-shadow:0 16px 24px rgba(0,0,0,0.3),0 6px 8px rgba(0,0,0,0.2)}'
      + '#tcAuthScrim h2{margin:0 0 8px;font-size:15px;font-weight:700;'
      + 'color:#fff}'
      + '#tcAuthScrim .tc-sub{margin:0 0 24px;font-size:13px;color:#b3b3b3}'
      + '#tcAuthScrim input{width:100%;height:48px;padding:0 16px;border-radius:4px;'
      + 'border:1px solid transparent;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);font-size:16px;'
      + 'font-family:inherit;transition:border-color .1s ease}'
      + '#tcAuthScrim input:hover{border-color:#fff}'
      + '#tcAuthScrim input:focus{outline:none;border-color:#fff;box-shadow:inset 0 0 0 1px #fff}'
      + '#tcAuthScrim.tc-invalid input,#tcAuthScrim.tc-invalid input:hover{border-color:#ed2c3f}'
      + '#tcAuthScrim .tc-err{margin:8px 0 0;font-size:13px;line-height:1.5;color:#f3727f}'
      + '#tcAuthScrim .tc-save{width:100%;height:48px;margin-top:24px;border:none;'
      + 'border-radius:500px;background:#1ED760;color:#000;font-size:15px;font-weight:700;'
      + 'font-family:inherit;cursor:pointer;'
      + 'transition:background-color .1s ease,transform .1s ease}'
      + '#tcAuthScrim .tc-save:hover{background:#3BE477;transform:scale(1.04)}'
      + '#tcAuthScrim .tc-save:active{background:#1ED760;transform:scale(1)}'
      + '#tcAuthScrim .tc-x{position:absolute;top:12px;right:12px;width:32px;height:32px;'
      + 'display:flex;align-items:center;justify-content:center;border:none;background:none;'
      + 'color:#7c7c7c;font-size:20px;line-height:1;font-family:inherit;cursor:pointer;'
      + 'transition:color .1s ease}'
      + '#tcAuthScrim .tc-x:hover{color:#fff}'

      /* toast: the form's submit button is far from the chip, so failures announce
         themselves at the bottom of the viewport instead */
      + '#tcAuthToast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
      + 'z-index:10000;background:#fff;color:#000;border-radius:6px;padding:12px;'
      + 'font-size:15px;line-height:1.5;font-weight:400;box-shadow:0 4px 12px rgba(0,0,0,0.3);'
      + "font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"

      + '@media (max-width:560px){#tcAuthChip,#tcTopBar{top:8px;right:8px}}';
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
      + '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13"/>'
      + '<path d="M8 3.8A2.2 2.2 0 0 0 5.8 6v1H5v5h6V7h-.8V6A2.2 2.2 0 0 0 8 3.8M7 6a1 1 0 0 1 2 0v1H7z"/></svg>'
      + '<span class="tc-state" id="tcAuthState"></span>'
      + '<button type="button" class="tc-link" id="tcAuthOpen"></button>';
    document.body.appendChild(chip);
    /* Forms with a Guide button show it in one row, left of this chip */
    var guide = document.getElementById('guideFab');
    if (guide) {
      var bar = document.createElement('div');
      bar.id = 'tcTopBar';
      document.body.appendChild(bar);
      bar.appendChild(guide);
      bar.appendChild(chip);
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
