const {
  dateStr,
  findPurchaseAction,
  sumActionValue,
  sumActionByType,
  aggregateMetrics,
  groupByCreative,
  buildPrimaryTextMap,
  buildCreativeMap,
  uniqueAdIds,
  collectFetchableCreativeIds,
  collectAllCreativeIds,
} = require('./server');

// ── dateStr ──────────────────────────────────────────────────────────────────

describe('dateStr', () => {
  test('returns a string in YYYY-MM-DD format', () => {
    expect(dateStr(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returns today when daysAgo is 0', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(dateStr(0)).toBe(today);
  });

  test.each([1, 7, 30])('returns correct date for %i days ago', n => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    expect(dateStr(n)).toBe(d.toISOString().split('T')[0]);
  });
});

// ── findPurchaseAction ───────────────────────────────────────────────────────

describe('findPurchaseAction', () => {
  test('finds action with action_type "purchase"', () => {
    expect(findPurchaseAction([
      { action_type: 'link_click', value: '10' },
      { action_type: 'purchase', value: '3' },
    ])).toEqual({ action_type: 'purchase', value: '3' });
  });

  test('finds action with action_type "omni_purchase"', () => {
    expect(findPurchaseAction([
      { action_type: 'link_click', value: '10' },
      { action_type: 'omni_purchase', value: '5' },
    ])).toEqual({ action_type: 'omni_purchase', value: '5' });
  });

  test('returns undefined when no purchase action exists', () => {
    expect(findPurchaseAction([{ action_type: 'page_engagement', value: '20' }])).toBeUndefined();
  });

  test('returns undefined for empty / missing input', () => {
    expect(findPurchaseAction([])).toBeUndefined();
    expect(findPurchaseAction()).toBeUndefined();
  });

  test('prefers first match (purchase before omni_purchase)', () => {
    expect(findPurchaseAction([
      { action_type: 'purchase', value: '2' },
      { action_type: 'omni_purchase', value: '4' },
    ])).toEqual({ action_type: 'purchase', value: '2' });
  });
});

// ── sumActionValue / sumActionByType ─────────────────────────────────────────

describe('sumActionValue', () => {
  test('sums all values', () => {
    expect(sumActionValue([{ value: '5' }, { value: '3.5' }])).toBe(8.5);
  });

  test('handles missing/non-array inputs', () => {
    expect(sumActionValue(null)).toBe(0);
    expect(sumActionValue(undefined)).toBe(0);
    expect(sumActionValue([])).toBe(0);
  });

  test('treats missing value as 0', () => {
    expect(sumActionValue([{ value: '5' }, {}])).toBe(5);
  });
});

describe('sumActionByType', () => {
  test('sums only matching action_type', () => {
    const arr = [
      { action_type: 'video_view', value: '10' },
      { action_type: 'link_click', value: '7' },
      { action_type: 'video_view', value: '3' },
    ];
    expect(sumActionByType(arr, 'video_view')).toBe(13);
  });

  test('returns 0 when no match', () => {
    expect(sumActionByType([{ action_type: 'foo', value: '1' }], 'video_view')).toBe(0);
  });

  test('handles non-array', () => {
    expect(sumActionByType(null, 'video_view')).toBe(0);
  });
});

// ── aggregateMetrics ─────────────────────────────────────────────────────────

describe('aggregateMetrics', () => {
  function bareRow(extra) {
    return { impressions: '0', clicks: '0', spend: '0', reach: '0', unique_clicks: '0', frequency: '0', ...extra };
  }

  test('aggregates standard numeric metrics', () => {
    const result = aggregateMetrics({}, [
      bareRow({ impressions: '100', clicks: '10', spend: '5', reach: '80', unique_clicks: '9' }),
      bareRow({ impressions: '200', clicks: '20', spend: '10', reach: '150', unique_clicks: '18' }),
    ]);
    expect(result.impressions).toBe(300);
    expect(result.clicks).toBe(30);
    expect(result.spend).toBe(15);
    expect(result.reach).toBe(230);
    expect(result.unique_clicks).toBe(27);
  });

  test('computes ctr / cpc / cpm', () => {
    const r = aggregateMetrics({}, [bareRow({ impressions: '1000', clicks: '50', spend: '100' })]);
    expect(r.ctr).toBe('5.00');
    expect(r.cpc).toBe('2.00');
    expect(r.cpm).toBe('100.00');
  });

  test('returns "0" for ctr/cpc/cpm when impressions/clicks are zero', () => {
    const r = aggregateMetrics({}, [bareRow()]);
    expect(r.ctr).toBe('0');
    expect(r.cpc).toBe('0');
    expect(r.cpm).toBe('0');
  });

  test('aggregates purchase actions and computes ROAS / CPR / AOV', () => {
    const r = aggregateMetrics({}, [
      bareRow({ spend: '100',
        actions:       [{ action_type: 'purchase', value: '5' }],
        action_values: [{ action_type: 'purchase', value: '500' }],
      }),
    ]);
    expect(r.purchase_count).toBe(5);
    expect(r.purchase_value).toBe(500);
    expect(r.roas).toBe(5);
    expect(r.cpr).toBe(20);
    expect(r.aov).toBe(100);
  });

  test('roas/cpr/aov are 0 when no purchases', () => {
    const r = aggregateMetrics({}, [bareRow({ spend: '50' })]);
    expect(r.roas).toBe(0);
    expect(r.cpr).toBe(0);
    expect(r.aov).toBe(0);
  });

  test('aggregates video metrics: 3sec / thruplays / plays', () => {
    const r = aggregateMetrics({}, [
      bareRow({
        impressions: '1000',
        actions: [{ action_type: 'video_view', value: '400' }],
        video_thruplay_watched_actions: [{ value: '120' }],
        video_play_actions:             [{ value: '500' }],
      }),
      bareRow({
        impressions: '1000',
        actions: [{ action_type: 'video_view', value: '600' }],
        video_thruplay_watched_actions: [{ value: '180' }],
        video_play_actions:             [{ value: '500' }],
      }),
    ]);
    expect(r.video_3sec_views).toBe(1000);
    expect(r.video_thruplays).toBe(300);
    expect(r.video_plays).toBe(1000);
    expect(r.video_3sec_rate).toBe(50);     // 1000/2000 * 100
    expect(r.thruplay_rate).toBe(30);       // 300/1000 * 100
  });

  test('weighted avg play time: Σ(avg × plays) / Σ(plays)', () => {
    // Row A: 10s avg × 100 plays; Row B: 20s avg × 300 plays
    // Total time = 1000 + 6000 = 7000; total plays = 400
    // Weighted avg = 17.5s
    const r = aggregateMetrics({}, [
      { impressions: '0', clicks: '0', spend: '0', reach: '0', unique_clicks: '0', frequency: '0',
        video_avg_time_watched_actions: [{ value: '10' }],
        video_play_actions:             [{ value: '100' }] },
      { impressions: '0', clicks: '0', spend: '0', reach: '0', unique_clicks: '0', frequency: '0',
        video_avg_time_watched_actions: [{ value: '20' }],
        video_play_actions:             [{ value: '300' }] },
    ]);
    expect(r.video_avg_time).toBeCloseTo(17.5, 2);
  });

  test('video metrics are 0 when fields absent', () => {
    const r = aggregateMetrics({}, [{ impressions: '100', clicks: '5', spend: '10', reach: '0', unique_clicks: '0', frequency: '0' }]);
    expect(r.video_3sec_views).toBe(0);
    expect(r.video_thruplays).toBe(0);
    expect(r.video_plays).toBe(0);
    expect(r.video_avg_time).toBe(0);
    expect(r.video_3sec_rate).toBe(0);
    expect(r.thruplay_rate).toBe(0);
  });
});

// ── groupByCreative ──────────────────────────────────────────────────────────

describe('groupByCreative', () => {
  function row(creative_id, extra = {}) {
    return {
      ad_name: 'Ad A',
      impressions: '0', clicks: '0', spend: '0', reach: '0', unique_clicks: '0', frequency: '0',
      creative: creative_id ? { id: creative_id, object_type: 'VIDEO', primary_text: 't', thumbnail_url: 'u', is_catalog: false } : null,
      ...extra,
    };
  }

  test('groups rows by creative.id', () => {
    const result = groupByCreative([
      row('c1', { spend: '5' }),
      row('c1', { spend: '10' }),
      row('c2', { spend: '20' }),
    ]);
    expect(result).toHaveLength(2);
    const c1 = result.find(r => r.creative_id === 'c1');
    expect(c1.spend).toBe(15);
  });

  test('maps object_type to format label', () => {
    const v = groupByCreative([row('c1')]);
    expect(v[0].format).toBe('Video');
    const img = groupByCreative([{ ...row('c2'), creative: { id: 'c2', object_type: 'SHARE' } }]);
    expect(img[0].format).toBe('Image');
    const car = groupByCreative([{ ...row('c3'), creative: { id: 'c3', object_type: 'PHOTO' } }]);
    expect(car[0].format).toBe('Carousel');
  });

  test('uses "unknown" for rows without creative', () => {
    const result = groupByCreative([row(null, { spend: '5' })]);
    expect(result[0].creative_id).toBe('unknown');
    expect(result[0].format).toBeNull();
  });
});

// ── buildPrimaryTextMap ──────────────────────────────────────────────────────

describe('buildPrimaryTextMap', () => {
  test('extracts primary text from asset_feed_spec', () => {
    expect(buildPrimaryTextMap([
      { creative: { id: 'c1', asset_feed_spec: { bodies: [{ text: 'Hello' }] } } },
    ])).toEqual({ c1: 'Hello' });
  });

  test('falls back through object_story_spec link/video/photo and creative name', () => {
    expect(buildPrimaryTextMap([
      { creative: { id: 'c1', object_story_spec: { link_data:  { message: 'L' } } } },
      { creative: { id: 'c2', object_story_spec: { video_data: { message: 'V' } } } },
      { creative: { id: 'c3', object_story_spec: { photo_data: { message: 'P' } } } },
      { creative: { id: 'c4', name: 'just-a-name' } },
    ])).toEqual({ c1: 'L', c2: 'V', c3: 'P', c4: 'just-a-name' });
  });

  test('skips ads without creative or text', () => {
    expect(buildPrimaryTextMap([
      { creative: null },
      { id: '123' },
      { creative: { id: 'c1' } },
      { creative: { id: 'c2', asset_feed_spec: { bodies: [] } } },
    ])).toEqual({});
  });
});

// ── buildCreativeMap ─────────────────────────────────────────────────────────

describe('buildCreativeMap', () => {
  test('maps ad.id → creative info with HD thumb URL', () => {
    const map = buildCreativeMap(
      [{ id: 'a1', creative: { id: 'c1', name: 'n', object_type: 'VIDEO', primary_text: 't', is_catalog: false } }],
      { c1: 'https://hd/c1.jpg' }
    );
    expect(map.a1.thumbnail_url).toBe('https://hd/c1.jpg');
    expect(map.a1.id).toBe('c1');
    expect(map.a1.object_type).toBe('VIDEO');
  });

  test('skips ads without creative', () => {
    expect(buildCreativeMap([{ id: 'a1', creative: null }], {})).toEqual({});
  });

  test('thumbnail_url is null when no HD entry', () => {
    const map = buildCreativeMap([{ id: 'a1', creative: { id: 'c1' } }], {});
    expect(map.a1.thumbnail_url).toBeNull();
  });
});

// ── ID collectors ────────────────────────────────────────────────────────────

describe('uniqueAdIds', () => {
  test('returns unique non-empty ad_ids', () => {
    expect(uniqueAdIds([
      { ad_id: 'a1' }, { ad_id: 'a2' }, { ad_id: 'a1' }, { ad_id: '' }, {},
    ])).toEqual(['a1', 'a2']);
  });
});

describe('collectFetchableCreativeIds', () => {
  test('only video / image, non-catalog, with id', () => {
    const ads = [
      { creative: { id: 'c1', object_type: 'VIDEO', is_catalog: false } },
      { creative: { id: 'c2', object_type: 'SHARE', is_catalog: false } },
      { creative: { id: 'c3', object_type: 'VIDEO', is_catalog: true  } },  // catalog skipped
      { creative: { id: 'c4', object_type: 'OTHER', is_catalog: false } },  // type skipped
      { creative: null },                                                    // null skipped
      { creative: { id: 'c1', object_type: 'VIDEO', is_catalog: false } },  // dup
    ];
    expect(collectFetchableCreativeIds(ads).sort()).toEqual(['c1', 'c2']);
  });
});

describe('collectAllCreativeIds', () => {
  test('collects every creative.id including catalog', () => {
    expect(collectAllCreativeIds([
      { creative: { id: 'c1', is_catalog: true } },
      { creative: { id: 'c2', object_type: 'OTHER' } },
      { creative: null },
      { creative: { id: 'c1' } },
    ]).sort()).toEqual(['c1', 'c2']);
  });
});
