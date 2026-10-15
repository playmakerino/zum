// Tests for meta.js (the copy of dashboards/shared/meta.js next to server.js). No Meta calls: axios is mocked.
jest.mock('axios');
const axios = require('axios');
const meta = require('./meta');

meta.timing.pollMs = 0;
meta.timing.retryMs = [0, 0, 0];
afterEach(() => jest.resetAllMocks());

// minimal SSE response: records the events, close() = the browser went away
function fakeRes() {
  const res = { chunks: [], ended: false, handlers: {} };
  res.setHeader = () => {};
  res.write = c => { res.chunks.push(c); return true; };
  res.end = () => { res.ended = true; };
  res.on = (ev, fn) => { res.handlers[ev] = fn; };
  res.close = () => res.handlers.close?.();
  res.events = () => res.chunks.map(c => JSON.parse(c.slice(6)));
  return res;
}
const settle = () => new Promise(r => setTimeout(r, 0));

describe('sseLoad', () => {
  test('a second request with the same key joins the running load', async () => {
    let release;
    const run = jest.fn(async ({ progress, send }) => {
      progress('working');
      await new Promise(r => { release = r; });
      send({ result: 42 });
    });
    const a = fakeRes(), b = fakeRes();
    meta.sseLoad(a, 'k1', run);
    meta.sseLoad(b, 'k1', run);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await settle();
    for (const r of [a, b]) {
      expect(r.events()).toEqual([{ progress: 'working' }, { result: 42 }]);
      expect(r.ended).toBe(true);
    }
  });

  test('a load stops at its next check once no browser waits for it', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let release, finished = false;
    const run = async ({ stopped, send }) => {
      await new Promise(r => { release = r; });
      stopped();
      finished = true;
      send({ result: 1 });
    };
    const a = fakeRes();
    meta.sseLoad(a, 'k2', run);
    a.close();
    release();
    await settle();
    expect(finished).toBe(false);
    expect(a.events()).toEqual([]);
    // the key is free again: the next request starts a new load
    const again = jest.fn(async ({ send }) => send({ result: 2 }));
    const b = fakeRes();
    meta.sseLoad(b, 'k2', again);
    await settle();
    expect(again).toHaveBeenCalledTimes(1);
    expect(b.events()).toEqual([{ result: 2 }]);
  });

  test('errors reach every waiting browser as { error, detail }', async () => {
    const a = fakeRes();
    meta.sseLoad(a, 'k3', async () => { throw { response: { data: { error: { code: 17, message: 'User request limit reached' } } } }; });
    await settle();
    expect(a.events()[0]).toMatchObject({ error: 'Meta API rate limit reached' });
    expect(a.ended).toBe(true);
  });
});

describe('fetchInsights', () => {
  test('a failed async report is run again', async () => {
    axios.post.mockResolvedValue({ data: { report_run_id: 'r1' }, headers: {} });
    axios.get
      .mockResolvedValueOnce({ data: { async_status: 'Job Failed', async_percent_completion: 40 }, headers: {} })
      .mockResolvedValueOnce({ data: { async_status: 'Job Completed', async_percent_completion: 100 }, headers: {} })
      .mockResolvedValueOnce({ data: { data: [{ ad_id: 'a1' }], paging: {} } });
    const retries = [];
    const rows = await meta.fetchInsights({ base: 'B', token: 't', fields: 'f', timeRange: {}, onRetry: m => retries.push(m) });
    expect(rows).toEqual([{ ad_id: 'a1' }]);
    expect(retries).toEqual(['Meta report Job Failed, retrying in 0s (1/3)']);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('when every retry fails, the probe call gives the real reason', async () => {
    axios.post.mockResolvedValue({ data: { report_run_id: 'r1' }, headers: {} });
    axios.get.mockImplementation(async (url, { params }) => {
      if (params.date_preset) throw { response: { data: { error: { code: 190, error_subcode: 463, message: 'expired' } } } };
      return { data: { async_status: 'Job Failed' }, headers: {} };
    });
    const err = await meta.fetchInsights({ base: 'B', token: 't', fields: 'f', timeRange: {} }).catch(e => e);
    expect(axios.post).toHaveBeenCalledTimes(4); // first try + 3 retries
    expect(meta.metaErrorMessage(err).error).toBe('Meta API token expired or invalid');
  });

  test('a valid query that keeps failing says it is a temporary Meta problem', async () => {
    axios.post.mockResolvedValue({ data: { report_run_id: 'r1' }, headers: {} });
    axios.get.mockImplementation(async (url, { params }) => (params.date_preset ? { data: { data: [] } } : { data: { async_status: 'Job Failed' }, headers: {} }));
    const err = await meta.fetchInsights({ base: 'B', token: 't', fields: 'f', timeRange: {} }).catch(e => e);
    const { error, detail } = meta.metaErrorMessage(err);
    expect(error).toBe('Meta async report Job Failed');
    expect(detail.message).toMatch(/after 3 retries although the query is valid/);
  });

  test('stopped() ends polling', async () => {
    axios.post.mockResolvedValue({ data: { report_run_id: 'r1' }, headers: {} });
    axios.get.mockResolvedValue({ data: { async_status: 'Job Running', async_percent_completion: 10 }, headers: {} });
    let checks = 0;
    const stopped = () => { if (++checks > 3) throw new meta.LoadStopped('gone'); };
    await expect(meta.fetchInsights({ base: 'B', token: 't', fields: 'f', timeRange: {}, stopped })).rejects.toBeInstanceOf(meta.LoadStopped);
  });
});

describe('metaErrorMessage', () => {
  test('other Meta errors show code and message', () => {
    const err = { response: { data: { error: { code: 100, error_subcode: 33, message: 'Unsupported get request' } } } };
    expect(meta.metaErrorMessage(err)).toEqual({ error: 'Meta API error', detail: '[100/33] Unsupported get request' });
  });

  test('an HTML error page from Meta', () => {
    const err = { message: 'Request failed', response: { data: '<!DOCTYPE html><html>…' } };
    expect(meta.metaErrorMessage(err).error).toBe('Meta API temporarily unavailable');
  });
});

describe('fetchByIds', () => {
  test('Graph batch of 50 per request, keeps the id, skips per-id errors and failed batches', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ids = Array.from({ length: 120 }, (_, i) => String(i));
    const ok = body => ({ code: 200, body: JSON.stringify(body) });
    axios.post
      .mockResolvedValueOnce({ data: [ok({ thumbnail_url: 'u0' }), { code: 400, body: JSON.stringify({ error: { message: 'x' } }) }] })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: [ok({ id: '100', thumbnail_url: 'u100' })] });
    const out = await meta.fetchByIds('t', ids, 'thumbnail_url', { thumbnail_width: 480 });
    expect(axios.post).toHaveBeenCalledTimes(3);
    const params = axios.post.mock.calls[0][2].params;
    const batch = JSON.parse(params.batch);
    expect(batch).toHaveLength(50);
    expect(batch[0]).toEqual({ method: 'GET', relative_url: '0?fields=thumbnail_url&thumbnail_width=480' });
    expect(params.ids).toBeUndefined();
    expect(out).toEqual([{ id: '0', thumbnail_url: 'u0' }, { id: '100', thumbnail_url: 'u100' }]);
  });
});