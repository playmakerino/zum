const { todayStr, addDays, findPurchaseAction, pickTopSpendAds } = require('./server');

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

// ── addDays ─────────────────────────────────────────────────────────────────

describe('addDays', () => {
  test('adds positive days', () => {
    expect(addDays('2025-01-01', 1)).toBe('2025-01-02');
    expect(addDays('2025-01-01', 7)).toBe('2025-01-08');
  });

  test('subtracts with negative days', () => {
    expect(addDays('2025-01-10', -3)).toBe('2025-01-07');
  });

  test('crosses month boundary', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
  });

  test('crosses year boundary', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
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

// ── pickTopSpendAds ─────────────────────────────────────────────────────────

describe('pickTopSpendAds', () => {
  test('aggregates spend by ad_id', () => {
    const rows = [
      { ad_id: '1', ad_name: 'Ad A', spend: '60', action_values: [] },
      { ad_id: '1', ad_name: 'Ad A', spend: '50', action_values: [] },
    ];
    const result = pickTopSpendAds(rows);
    expect(result).toHaveLength(1);
    expect(result[0].spend).toBe(110);
  });

  test('includes all ads regardless of spend amount', () => {
    const rows = [
      { ad_id: '1', ad_name: 'Low', spend: '50', action_values: [] },
      { ad_id: '2', ad_name: 'High', spend: '200', action_values: [] },
    ];
    const result = pickTopSpendAds(rows);
    expect(result).toHaveLength(2);
  });

  test('keeps only highest-spend ad per ad_name', () => {
    const rows = [
      { ad_id: '1', ad_name: 'Same Name', spend: '150', action_values: [] },
      { ad_id: '2', ad_name: 'Same Name', spend: '300', action_values: [] },
    ];
    const result = pickTopSpendAds(rows);
    expect(result).toHaveLength(1);
    expect(result[0].ad_id).toBe('2');
    expect(result[0].spend).toBe(300);
  });

  test('computes roas from purchase action_values', () => {
    const rows = [
      {
        ad_id: '1', ad_name: 'Ad', spend: '200',
        action_values: [{ action_type: 'purchase', value: '600' }],
      },
    ];
    const result = pickTopSpendAds(rows);
    expect(result[0].roas).toBe(3);
  });

  test('sets roas to 0 when no purchases', () => {
    const rows = [{ ad_id: '1', ad_name: 'Ad', spend: '200', action_values: [] }];
    const result = pickTopSpendAds(rows);
    expect(result[0].roas).toBe(0);
  });

  test('skips rows without ad_id', () => {
    const rows = [{ ad_name: 'No ID', spend: '200', action_values: [] }];
    expect(pickTopSpendAds(rows)).toHaveLength(0);
  });
});
