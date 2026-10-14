/* Searchable product-type dropdown of forms 2, 7, 8 (markup: #productTypeCombo,
   #productTypeSearch, #product_type, #productTypeMenu). Each form calls initProductTypeCombo() once.
   New product type: add it to PRODUCT_TYPES here and to the n8n datatable "Product type settings". */
function initProductTypeCombo() {
  const PRODUCT_TYPES = [
    { value: 'QBS', label: 'Quilt bedding set' },
    { value: 'QBL', label: 'Quilt blanket' },
    { value: 'QTR', label: 'Quilt table runner' },
    { value: 'CTS', label: 'Crewneck T-Shirt' },
    { value: 'SLB', label: 'Sleep bag' },
    { value: 'BGS', label: 'Baby gift set' },
    { value: 'CSS', label: 'Crewneck sweatshirt' },
    { value: 'ZFR', label: 'Zippered Footie Romper' },
    { value: 'CZR', label: 'Convertible Zippy' },
    { value: 'SZR', label: 'Shorty Zippy' },
    { value: 'TPJ', label: 'Two Piece Long Sleeve Pajama Set' },
    { value: 'SPJ', label: 'Two Piece Short Sleeve Shorts Pajama Set' },
    { value: 'MPS', label: 'Men Pajama Set' },
    { value: 'WPS', label: 'Women Pajama Set' },
    { value: 'BLK', label: 'Blanket' },
    { value: 'BHD', label: 'Blanket Hoodie' },
    { value: 'PLC', label: 'Pillow Case' },
    { value: 'SBP', label: 'Backpack' },
    { value: 'ACS', label: 'Adult Crewneck Sweatshirt' },
    { value: 'WCS', label: 'Women Crewneck Sweatshirt' },
    { value: 'MCS', label: 'Men Crewneck Sweatshirt' },
    { value: 'DRS', label: 'Twirl Dress' },
    { value: 'ZHD', label: 'Zip Hoodie' },
    { value: 'STB', label: 'Soft Toy Bunny' },
    { value: 'STRB', label: 'Stories Book' },
    { value: 'BDS', label: 'Bodysuit' },
    { value: 'BBR', label: 'Bubble Romper' },
    { value: 'BED', label: 'Bedding Set' },
    { value: 'SWD', label: 'Swaddle Blanket' },
    { value: 'BNB', label: 'Banner' },
    { value: 'Hoop', label: 'Hoop' },
    { value: 'LPL', label: 'Letter Pillow' },
    { value: 'PNT', label: 'Pennant' }
  ].sort((a, b) => a.label.localeCompare(b.label));
  const combo  = document.getElementById('productTypeCombo');
  const input  = document.getElementById('productTypeSearch');
  const hidden = document.getElementById('product_type');
  const menu   = document.getElementById('productTypeMenu');
  let filtered = PRODUCT_TYPES.slice();
  let activeIndex = -1;

  const labelFor = v => { const o = PRODUCT_TYPES.find(x => x.value === v); return o ? o.label : ''; };

  function render() {
    if (!filtered.length) { menu.innerHTML = '<div class="combo-empty">No match</div>'; return; }
    menu.innerHTML = filtered.map((o, i) =>
      `<div class="combo-opt${i === activeIndex ? ' active' : ''}" role="option" data-val="${escapeHtml(o.value)}">` +
        `<span>${escapeHtml(o.label)}</span><span class="opt-code">${escapeHtml(o.value)}</span>` +
      `</div>`
    ).join('');
  }

  function openMenu() {
    combo.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    filtered = PRODUCT_TYPES.slice();
    activeIndex = filtered.findIndex(o => o.value === hidden.value);
    render();
    input.select();
  }

  function closeMenu() {
    combo.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.value = labelFor(hidden.value);
    activeIndex = -1;
  }

  function selectValue(val) {
    if (hidden.value !== val) {
      hidden.value = val;
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeMenu();
  }

  function scrollActive() {
    const el = menu.querySelector('.combo-opt.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', openMenu);
  input.addEventListener('click', openMenu);

  input.addEventListener('input', () => {
    combo.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? PRODUCT_TYPES.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : PRODUCT_TYPES.slice();
    activeIndex = filtered.length ? 0 : -1;
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!combo.classList.contains('open')) return openMenu();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      render(); scrollActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render(); scrollActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && filtered[activeIndex]) selectValue(filtered[activeIndex].value);
    } else if (e.key === 'Escape') {
      closeMenu(); input.blur();
    }
  });

  menu.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    selectValue(opt.getAttribute('data-val'));
  });

  document.addEventListener('click', (e) => {
    if (!combo.contains(e.target)) closeMenu();
  });

  input.value = labelFor(hidden.value);

  // Forms call this after a successful submit so the next batch must pick a type again
  window.resetProductType = () => {
    hidden.value = '';
    input.value = '';
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  };
}
