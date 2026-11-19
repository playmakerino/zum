const { todayStr, findPurchaseAction, summarizeAds, extractGroupKey } = require('./server');

// ── todayStr ────────────────────────────────────────────────────────────────

describe('todayStr', () => {
  test('returns YYYY-MM-DD format', () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returns today', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(todayStr()).toBe(today);
  });
});

// ── findPurchaseAction ──────────────────────────────────────────────────────

describe('findPurchaseAction', () => {
  test('finds "purchase"', () => {
    const actions = [
      { action_type: 'link_click', value: '10' },
      { action_type: 'purchase', value: '3' },
    ];
    expect(findPurchaseAction(actions)).toEqual({ action_type: 'purchase', value: '3' });
  });

  test('finds "omni_purchase"', () => {
    const actions = [{ action_type: 'omni_purchase', value: '5' }];
    expect(findPurchaseAction(actions)).toEqual({ action_type: 'omni_purchase', value: '5' });
  });

  test('returns undefined when no purchase action', () => {
    expect(findPurchaseAction([{ action_type: 'link_click', value: '10' }])).toBeUndefined();
  });

  test('returns undefined for empty/missing array', () => {
    expect(findPurchaseAction([])).toBeUndefined();
    expect(findPurchaseAction()).toBeUndefined();
  });
});

// ── extractGroupKey ─────────────────────────────────────────────────────────

describe('extractGroupKey', () => {
  test('extracts print_id-type_id without mockup', () => {
    expect(extractGroupKey('[Dub4936-CZR]')).toBe('Dub4936-CZR');
  });

  test('extracts print_id-type_id ignoring mockup_id', () => {
    expect(extractGroupKey('[Dub4936-TPJ_PM-MWA-07]')).toBe('Dub4936-TPJ');
  });

  test('falls back to full ad_name when no match', () => {
    expect(extractGroupKey('Random Ad Name')).toBe('Random Ad Name');
  });
});

// ── summarizeAds ────────────────────────────────────────────────────────────

describe('summarizeAds', () => {
  test('aggregates spend by ad_id', () => {
    const rows = [
      { ad_id: '1', ad_name: '[Dub1000-CZR]', spend: '60', action_values: [] },
      { ad_id: '1', ad_name: '[Dub1000-CZR]', spend: '50', action_values: [] },
    ];
    const result = summarizeAds(rows);
    expect(result).toHaveLength(1);
    expect(result[0].spend).toBe(110);
  });

  test('filters out ads with spend <= 100', () => {
    const rows = [
      { ad_id: '1', ad_name: '[Dub1000-CZR]', spend: '50', action_values: [] },
      { ad_id: '2', ad_name: '[Dub2000-TPJ]', spend: '200', action_values: [] },
    ];
    const result = summarizeAds(rows);
    expect(result).toHaveLength(1);
    expect(result[0].ad_name).toBe('[Dub2000-TPJ]');
  });

  test('keeps every ad of a design, tagged with the design and status', () => {
    const rows = [
      { ad_id: '1', ad_name: '[Dub4936-CZR]', status: 'PAUSED', spend: '150', action_values: [] },
      { ad_id: '2', ad_name: '[Dub4936-CZR_PM-MWA-07]', status: 'ACTIVE', spend: '300', action_values: [] },
    ];
    const result = summarizeAds(rows);
    expect(result).toHaveLength(2);
    expect(result.map(a => a.group)).toEqual(['Dub4936-CZR', 'Dub4936-CZR']);
    expect(result.map(a => a.status)).toEqual(['PAUSED', 'ACTIVE']);
  });

  test('computes roas from purchase action_values', () => {
    const rows = [
      {
        ad_id: '1', ad_name: '[Dub1000-CZR]', spend: '200',
        action_values: [{ action_type: 'purchase', value: '600' }],
      },
    ];
    const result = summarizeAds(rows);
    expect(result[0].roas).toBe(3);
  });

  test('sets roas to 0 when no purchases', () => {
    const rows = [{ ad_id: '1', ad_name: '[Dub1000-CZR]', spend: '200', action_values: [] }];
    const result = summarizeAds(rows);
    expect(result[0].roas).toBe(0);
  });

  test('skips rows without ad_id', () => {
    const rows = [{ ad_name: '[Dub1000-CZR]', spend: '200', action_values: [] }];
    expect(summarizeAds(rows)).toHaveLength(0);
  });
});