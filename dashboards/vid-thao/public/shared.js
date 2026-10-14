// Shared UI behaviour for the 3 dashboards (source: dashboards/shared/, copied by sync-shared.ps1).

// 1) Topbar: transparent at the top of the page, white + 1px line once scrolled (Shopify page-header).
(() => {
  const update = () => document.body.classList.toggle('scrolled', window.scrollY > 0);
  window.addEventListener('scroll', update, { passive: true });
  update();
})();

// 2) Shopify-style dropdown over native <select>.
// The native select stays in the DOM (hidden) as the source of truth: app code
// keeps reading/writing .value and listening to onchange. A pill button + menu
// mirror it; option changes (innerHTML/text) and programmatic .value writes re-render.
(() => {
  const ICONS = {
    calendar: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="13" height="12" rx="2.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></svg>',
    person:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="7" r="3"/><path d="M4.5 16c.8-2.6 3-4 5.5-4s4.7 1.4 5.5 4"/></svg>',
  };
  const CHECK = '<svg class="dd-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 10.5 3.2 3L15 6.5"/></svg>';
  const CHEVRON = '<svg class="dd-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 8 4 4 4-4"/></svg>';
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  let openDd = null;

  function close(dd) {
    if (!dd) return;
    dd.classList.remove('open');
    dd.querySelector('.dd-menu').hidden = true;
    if (openDd === dd) openDd = null;
  }

  function enhance(sel) {
    if (sel.closest('.dd')) return;
    const dd = document.createElement('div');
    dd.className = `dd dd-${sel.id || 'select'}${sel.dataset.dd ? ' dd-' + sel.dataset.dd : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    if (sel.title) btn.title = sel.title;
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.hidden = true;
    sel.parentNode.insertBefore(dd, sel);
    dd.append(btn, menu, sel);
    sel.hidden = true;

    const render = () => {
      const cur = sel.options[sel.selectedIndex];
      const icon = ICONS[sel.dataset.icon] || '';
      btn.innerHTML = `${icon}<span class="dd-label"></span>${sel.dataset.dd === 'chip' ? '' : CHEVRON}`;
      btn.querySelector('.dd-label').textContent = cur ? cur.textContent : '';
      menu.innerHTML = '';
      for (const opt of sel.options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dd-item' + (opt.selected ? ' selected' : '');
        item.textContent = opt.textContent;
        if (opt.selected) item.insertAdjacentHTML('beforeend', CHECK);
        item.addEventListener('click', () => {
          close(dd);
          if (sel.value === opt.value) return;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        menu.appendChild(item);
      }
    };

    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); render(); },
    });
    new MutationObserver(render).observe(sel, { childList: true, subtree: true, characterData: true });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (dd.classList.contains('open')) return close(dd);
      close(openDd);
      dd.classList.add('open');
      menu.hidden = false;
      menu.style.left = ''; menu.style.right = '';
      if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
        menu.style.left = 'auto'; menu.style.right = '0';
      }
      openDd = dd;
    });
    menu.addEventListener('click', e => e.stopPropagation());
    render();
  }

  document.addEventListener('click', () => close(openDd));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(openDd); });
  document.querySelectorAll('select').forEach(enhance);
})();

// 3) Column filter popup chips (Shopify report Filters): the value chip shows the current
//    value(s) or "Add value"; clicking it opens the editor (input + Clear/Apply). The app's
//    own openFilterPopup/applyFilter keep working on #filterOp/#filterVal1/#filterVal2.
(() => {
  const popup = document.getElementById('filterPopup');
  const chip = document.getElementById('filterValueChip');
  if (!popup || !chip) return;
  const v1 = document.getElementById('filterVal1'), v2 = document.getElementById('filterVal2');
  const op = document.getElementById('filterOp');
  const between = () => op.value === 'between' || op.value === 'notBetween';
  const label = () => {
    const a = v1.value.trim(), b = v2.value.trim();
    const txt = !a ? '' : between() ? a + ' and ' + (b || '…') : a;
    chip.textContent = txt || 'Add value';
    chip.classList.toggle('empty', !txt);
  };
  const edit = on => { popup.classList.toggle('editing', on); if (on) setTimeout(() => v1.focus(), 0); };
  chip.addEventListener('click', () => edit(!popup.classList.contains('editing')));
  [v1, v2].forEach(i => i.addEventListener('input', label));
  op.addEventListener('change', label);
  // popup opened by app code (style.display = 'block'): refresh chip, open editor if no value yet
  new MutationObserver(() => {
    if (popup.style.display !== 'block') { delete popup.dataset.shown; return; }
    if (popup.dataset.shown) return;
    popup.dataset.shown = '1';
    label();
    edit(!v1.value.trim());
  }).observe(popup, { attributes: true, attributeFilter: ['style'] });
})();
