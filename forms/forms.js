/* Shared script of the TC forms (styles in forms.css).

   Load it as the first thing inside .container, before the form's own script:
     <script src="forms.js" data-switcher="tc"></script>   renders the form switcher right there
     <script src="forms.js"></script>                       forms without a switcher
   data-switcher picks the chip set: "tc" = the 9 TC forms (image source x product group),
   "img" = the 3 forms of Trang (test/scale x image source). The switcher is rendered synchronously, so the card below never jumps.

   Also defines the help panel (openGuide / closeGuide, Escape closes it) and the small helpers the
   forms' own scripts call: escapeHtml, cleanProductUrl, showStatus, extractFolderId. */

(function () {
  var SWITCHERS = {
    tc: {
      rows: [
        { dim: 'source', label: 'Image source', chips: [
          ['device', 'Device', 'Upload product images from your device'],
          ['dropbox', 'Dropbox', 'Choose product images from Dropbox'],
          ['shopify', 'Shopify', 'Pull images from the Shopify product page']
        ] },
        { dim: 'group', label: 'Product group', chips: [
          ['single', 'Any products', 'Unrelated products, each with its own print'],
          ['theme', 'By print theme', 'Several prints of one theme across multiple products'],
          ['oneprint', 'By print', 'One print applied to several products']
        ] }
      ],
      forms: {
        'device|single': 'tc_form_1.html', 'dropbox|single': 'tc_form_4.html', 'shopify|single': 'tc_form_3.html',
        'shopify|theme': 'tc_form_2.html', 'device|theme': 'tc_form_7.html', 'dropbox|theme': 'tc_form_8.html',
        'shopify|oneprint': 'tc_form_6.html', 'device|oneprint': 'tc_form_9.html', 'dropbox|oneprint': 'tc_form_10.html'
      }
    },
    img: {
      rows: [
        { dim: 'group', label: 'Test/scale', chips: [
          ['mockup', 'By mockup', 'Ad images whose mockup IDs repeat across images'],
          ['pattern', 'By pattern', 'Ad images of one print, product types can be mixed']
        ] },
        { dim: 'source', label: 'Image source', chips: [
          ['drive', 'Google Drive', 'Take ad images from a Google Drive folder'],
          ['device', 'Device', 'Upload ad images from your device']
        ] }
      ],
      forms: {
        'drive|mockup': 'tc_img_form_drive.html',
        'device|pattern': 'tc_form_1_trang.html'
      }
    }
  };

  var me = document.currentScript;
  var set = me && SWITCHERS[me.getAttribute('data-switcher')];
  if (!set) return;

  var html = '<nav class="form-switcher" aria-label="Choose form">';
  set.rows.forEach(function (row) {
    html += '<div class="fs-row" data-dim="' + row.dim + '"><span class="fs-label">' + row.label + '</span><div class="fs-chips">';
    row.chips.forEach(function (c) {
      html += '<a class="form-chip" data-val="' + c[0] + '" data-tip="' + c[2] + '">' + c[1] + '</a>';
    });
    html += '</div></div>';
  });
  me.insertAdjacentHTML('beforebegin', html + '</nav>');
  var nav = me.previousElementSibling;

  // Current form's chips are active; every other chip links to the form with that value and the current
  // value of the other row, or (ghosted) to the first form with that value when the combination does not exist.
  var FORMS = set.forms;
  var REV = {};
  for (var k in FORMS) REV[FORMS[k].toLowerCase()] = k.split('|');
  var cur = (location.pathname.split('/').pop() || '').toLowerCase();
  var pair = REV[cur] || [], curSource = pair[0], curGroup = pair[1];
  nav.querySelectorAll('.form-chip').forEach(function (a) {
    var dim = a.closest('.fs-row').getAttribute('data-dim'), val = a.getAttribute('data-val');
    var isActive = (dim === 'source' && val === curSource) || (dim === 'group' && val === curGroup);
    if (isActive) { a.classList.add('active'); a.setAttribute('aria-current', 'page'); return; }
    var s = dim === 'source' ? val : curSource, g = dim === 'group' ? val : curGroup;
    var target = FORMS[s + '|' + g];
    if (!target) {
      a.classList.add('ghost');
      for (var key in FORMS) {
        var p = key.split('|');
        if ((dim === 'source' && p[0] === val) || (dim === 'group' && p[1] === val)) { target = FORMS[key]; break; }
      }
    }
    if (target) a.setAttribute('href', target);
  });
})();

// ---------- Help panel (markup: #guideFab, #guideOverlay, #guidePanel in each form) ----------
function openGuide() {
  document.getElementById('guidePanel').classList.add('open');
  document.getElementById('guideOverlay').classList.add('open');
  document.getElementById('guidePanel').setAttribute('aria-hidden', 'false');
}
function closeGuide() {
  document.getElementById('guidePanel').classList.remove('open');
  document.getElementById('guideOverlay').classList.remove('open');
  document.getElementById('guidePanel').setAttribute('aria-hidden', 'true');
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && document.getElementById('guidePanel')) closeGuide();
});

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shopify product URL without the /collections/<handle> segment
function cleanProductUrl(url) {
  return url.replace(/\/collections\/[^/]+(?=\/products\/)/, '');
}

// type: success | error | loading (classes in forms.css)
function showStatus(type, html) {
  const el = document.getElementById('statusMsg');
  el.className = 'status ' + type;
  el.innerHTML = html;
}

// Google Drive folder ID from a folder link or a bare ID; '' when it is neither
function extractFolderId(input) {
  if (!input) return '';
  const trimmed = input.trim();
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/drive\/u\/\d+\/folders\/([a-zA-Z0-9_-]+)/
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) return trimmed;
  return '';
}
