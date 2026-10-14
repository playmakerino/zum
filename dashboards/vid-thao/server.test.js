const {
  dateStr,
  findPurchaseAction,
  sumActionValue,
  sumActionByType,
  aggregateMetrics,
  groupByVideo,
  indexVideoTable,
  newAdRows,
  collectFetchableCreativeIds,
  hasVideoPlays,
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
    return { impressions: '0', clicks: '0', spend: '0', ...extra };
  }

  test('aggregates standard numeric metrics', () => {
    const result = aggregateMetrics({}, [
      bareRow({ impressions: '100', clicks: '10', spend: '5' }),
      bareRow({ impressions: '200', clicks: '20', spend: '10' }),
    ]);
    expect(result.impressions).toBe(300);
    expect(result.clicks).toBe(30);
    expect(result.spend).toBe(15);
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
      { impressions: '0', clicks: '0', spend: '0',
        video_avg_time_watched_actions: [{ value: '10' }],
        video_play_actions:             [{ value: '100' }] },
      { impressions: '0', clicks: '0', spend: '0',
        video_avg_time_watched_actions: [{ value: '20' }],
        video_play_actions:             [{ value: '300' }] },
    ]);
    expect(r.video_avg_time).toBeCloseTo(17.5, 2);
  });

  test('video metrics are 0 when fields absent', () => {
    const r = aggregateMetrics({}, [{ impressions: '100', clicks: '5', spend: '10' }]);
    expect(r.video_3sec_views).toBe(0);
    expect(r.video_thruplays).toBe(0);
    expect(r.video_plays).toBe(0);
    expect(r.video_avg_time).toBe(0);
    expect(r.video_3sec_rate).toBe(0);
    expect(r.thruplay_rate).toBe(0);
  });
});

// ── groupByVideo ──────────────────────────────────────────────────────────

describe('groupByVideo', () => {
  function row(ad_id, extra = {}) {
    return {
      ad_id,
      ad_name: 'Ad A',
      impressions: '0', clicks: '0', spend: '0',
      ...extra,
    };
  }
  const cacheEntry = (creative_id, extra = {}) =>
    creative_id ? { creative: { id: creative_id, object_type: 'VIDEO', is_catalog: false, ...extra } } : { creative: null };

  test('groups rows by creative.id (looked up via ad_id)', () => {
    const result = groupByVideo(
      [row('a1', { spend: '5' }), row('a2', { spend: '10' }), row('a3', { spend: '20' })],
      { a1: cacheEntry('c1'), a2: cacheEntry('c1'), a3: cacheEntry('c2') },
      {},
    );
    expect(result).toHaveLength(2);
    const c1 = result.find(r => r.creative_id === 'c1');
    expect(c1.spend).toBe(15);
  });

  test('groups creatives that share a video_id into one row', () => {
    const result = groupByVideo(
      [row('a1', { spend: '5' }), row('a2', { spend: '10' }), row('a3', { spend: '20' })],
      { a1: cacheEntry('c1', { video_id: 'v1' }), a2: cacheEntry('c2', { video_id: 'v1' }), a3: cacheEntry('c3', { video_id: 'v2' }) },
      { c2: 'https://hd/c2.jpg' },
    );
    expect(result).toHaveLength(2);
    const v1 = result.find(r => r.video_id === 'v1');
    expect(v1.spend).toBe(15);
    expect(v1.creative_count).toBe(2);
    expect(v1.thumbnail_url).toBe('https://hd/c2.jpg');
  });

  test('submitter comes only from the video table', () => {
    const rows = [row('a1'), row('a2')];
    const cache = { a1: cacheEntry('c1', { video_id: 'v1' }), a2: cacheEntry('c2', { video_id: 'v2' }) };
    const res = groupByVideo(rows, cache, {}, indexVideoTable([{ video_id: 'v2', submitted_by: 'thaodp' }]));
    expect(res.find(r => r.video_id === 'v1').submitted_by).toBe('');
    expect(res.find(r => r.video_id === 'v2').submitted_by).toBe('thaodp');
  });

  test('BigQuery ad row gives the video, Drive file, reel and submitter', () => {
    const table = indexVideoTable([{ video_id: 'v9', ad_id: 'a1', submitted_by: 'ngocvp', drive_file_id: 'd1', reel_url: 'https://www.facebook.com/reel/r1' }]);
    // the creative read from Meta may carry another video id; the BigQuery one wins
    const res = groupByVideo([row('a1')], { a1: cacheEntry('c1', { video_id: 'other' }) }, {}, table);
    expect(res[0]).toMatchObject({ video_id: 'v9', submitted_by: 'ngocvp', drive_file_id: 'd1', drive_thumb_id: 'd1', reel_url: 'https://www.facebook.com/reel/r1' });
  });

  test('thumbnail image in the folder is used as the Drive thumbnail', () => {
    const table = indexVideoTable([{ video_id: 'v1', ad_id: 'a1', drive_file_id: 'd1', thumb_drive_id: 't1' }]);
    const res = groupByVideo([row('a1')], { a1: cacheEntry('c1') }, {}, table);
    expect(res[0].drive_thumb_id).toBe('t1');
  });

  test('a BigQuery ad whose creative Meta no longer returns is still a video', () => {
    const table = indexVideoTable([{ video_id: 'v1', ad_id: 'a1', drive_file_id: 'd1' }]);
    const res = groupByVideo([row('a1')], { a1: cacheEntry(null) }, {}, table);
    expect(res[0]).toMatchObject({ video_id: 'v1', format: 'Video', drive_file_id: 'd1' });
  });

  test('rows without BigQuery data have no Drive video', () => {
    const res = groupByVideo([row('a1')], { a1: cacheEntry('c1', { video_id: 'v1' }) }, {}, indexVideoTable([]));
    expect(res[0]).toMatchObject({ video_id: 'v1', drive_file_id: null, drive_thumb_id: null, reel_url: null });
  });

  test('maps object_type to format label', () => {
    const grp = (oType) => groupByVideo([row('a1')], { a1: cacheEntry('c1', { object_type: oType }) }, {});
    expect(grp('VIDEO')[0].format).toBe('Video');
    expect(grp('SHARE')[0].format).toBe('Image');
    expect(grp('PHOTO')[0].format).toBe('Carousel');
  });

  test('uses "unknown" for rows whose ad has no creative', () => {
    const result = groupByVideo([row('a1', { spend: '5' })], { a1: cacheEntry(null) }, {});
    expect(result[0].creative_id).toBe('unknown');
    expect(result[0].format).toBeNull();
  });

  test('thumbnail_url comes from hdThumbMap by creative id', () => {
    const result = groupByVideo([row('a1')], { a1: cacheEntry('c1') }, { c1: 'https://hd/c1.jpg' });
    expect(result[0].thumbnail_url).toBe('https://hd/c1.jpg');
  });

  test('thumbnail_url is null when no HD entry', () => {
    const result = groupByVideo([row('a1')], { a1: cacheEntry('c1') }, {});
    expect(result[0].thumbnail_url).toBeNull();
  });
});

// ── BigQuery video table ─────────────────────────────────────────────────────

describe('indexVideoTable', () => {
  test('indexes ad rows by ad and video; an ad row wins over a legacy row', () => {
    const t = indexVideoTable([
      { video_id: 'v1', submitted_by: 'thaodp' },                       // legacy
      { video_id: 'v1', ad_id: 'a1', submitted_by: 'MinhN ', drive_file_id: 'd1' },
      { video_id: 'v2', submitted_by: 'thaodp' },
      { submitted_by: 'x' },                                             // no video_id: skipped
    ]);
    expect(Object.keys(t.byAd)).toEqual(['a1']);
    expect(t.byVideo.v1).toMatchObject({ ad_id: 'a1', submitted_by: 'minhn', drive_file_id: 'd1' });
    expect(t.byVideo.v2).toMatchObject({ ad_id: null, submitted_by: 'thaodp' });
  });
});

describe('newAdRows', () => {
  const byAd = indexVideoTable([
    { video_id: 'v1', ad_id: 'a1', ad_name: 'New', created_at: '2026-10-14T11:03:10Z' },
    { video_id: 'v2', ad_id: 'a2', ad_name: 'Old', created_at: '2026-09-01T10:00:00Z' },
    { video_id: 'v3', ad_id: 'a3', ad_name: 'Delivered', created_at: '2026-10-13T10:00:00Z' },
  ]).byAd;
  test('ads created in the period without an insights row, with zero metrics', () => {
    const rows = newAdRows(byAd, { since: '2026-10-07', until: '2026-10-14' }, new Set(['a3']));
    expect(rows).toEqual([{ ad_id: 'a1', ad_name: 'New', impressions: '0', clicks: '0', spend: '0' }]);
  });
});

// ── ID collectors ────────────────────────────────────────────────────────────

describe('collectFetchableCreativeIds', () => {
  test('only video, non-catalog, with id', () => {
    const ads = [
      { creative: { id: 'c1', object_type: 'VIDEO', is_catalog: false } },
      { creative: { id: 'c2', object_type: 'SHARE', is_catalog: false } },  // image skipped
      { creative: { id: 'c3', object_type: 'VIDEO', is_catalog: true  } },  // catalog skipped
      { creative: { id: 'c4', object_type: 'OTHER', is_catalog: false } },  // type skipped
      { creative: null },                                                    // null skipped
      { creative: { id: 'c1', object_type: 'VIDEO', is_catalog: false } },  // dup
    ];
    expect(collectFetchableCreativeIds(ads).sort()).toEqual(['c1']);
  });
});

describe('hasVideoPlays', () => {
  test('true when any play value > 0', () => {
    expect(hasVideoPlays({ video_play_actions: [{ action_type: 'video_view', value: '12' }] })).toBe(true);
  });
  test('false when missing or zero', () => {
    expect(hasVideoPlays({})).toBe(false);
    expect(hasVideoPlays({ video_play_actions: [{ action_type: 'video_view', value: '0' }] })).toBe(false);
  });
});

