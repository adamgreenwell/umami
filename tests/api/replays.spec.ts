import { expect, test } from './fixtures';
import { CACHE_HEADER, UNKNOWN_UUID } from './helpers/constants';
import { dateRange } from './helpers/dates';
import { createWebsite, deleteWebsite, uniqueName } from './helpers/entities';
import { PERSONAS } from './seed/dataset';

/**
 * Global setup records one replay on `seed.website` (see seed/dataset.ts):
 * three rrweb events spanning 20ms in a single chunk. Replay ids are visit ids.
 * Other specs may record extra replays concurrently, so list assertions look for
 * the seeded replay rather than asserting exact counts.
 *
 * Share tokens are rejected on every replay endpoint (session replay is never
 * exposed through public shares).
 */

const REPLAY_EVENT_COUNT = 3;

test.describe('Replays', () => {
  test.describe.configure({ mode: 'serial' });

  let base = '';

  test.beforeAll(({ seed }) => {
    base = `/api/websites/${seed.website.id}`;
  });

  // The seeded replay is shared with other specs: always leave it unsaved.
  test.afterAll(async ({ admin, seed }) => {
    await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, { isSaved: false });
  });

  test('GET /api/websites/{websiteId}/replays lists recorded replays', async ({
    admin,
    share,
    viewer,
    seed,
  }) => {
    const response = await admin.get(`${base}/replays`, {
      params: dateRange(seed, { pageSize: 100 }),
    });
    const longOnly = await admin.get(`${base}/replays`, {
      params: dateRange(seed, { minDuration: 60_000, pageSize: 100 }),
    });
    const searched = await admin.get(`${base}/replays`, {
      params: dateRange(seed, { search: 'zzz-no-such-replay' }),
    });
    const shared = await (await share()).get(`${base}/replays`, { params: dateRange(seed) });
    const denied = await viewer.get(`${base}/replays`, { params: dateRange(seed) });
    const missingRange = await admin.get(`${base}/replays`);
    const badDuration = await admin.get(`${base}/replays`, {
      params: dateRange(seed, { minDuration: -1 }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: expect.any(Array),
      count: expect.any(Number),
      page: 1,
      pageSize: 100,
    });

    const replay = response.body.data.find((row: any) => row.id === seed.data.replayVisitId);
    expect(replay).toEqual({
      id: seed.data.replayVisitId,
      websiteId: seed.website.id,
      sessionId: seed.data.replaySessionId,
      createdAt: expect.any(String),
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      duration: expect.any(Number),
      eventCount: REPLAY_EVENT_COUNT,
      chunkCount: 1,
      browser: 'chrome',
      os: expect.any(String),
      device: expect.any(String),
      // Unresolved geo is null on Postgres but '' on ClickHouse (non-nullable String columns).
      country: seed.db === 'clickhouse' ? '' : null,
      city: seed.db === 'clickhouse' ? '' : null,
    });
    expect(replay.duration).toBe(
      new Date(replay.endedAt).getTime() - new Date(replay.startedAt).getTime(),
    );

    // The seeded replay only lasts 20ms.
    expect(longOnly.status).toBe(200);
    expect(longOnly.body.data.map((row: any) => row.id)).not.toContain(seed.data.replayVisitId);

    expect(searched.status).toBe(200);
    expect(searched.body.data).toHaveLength(0);

    expect(shared.status).toBe(401);
    expect(denied.status).toBe(401);
    expect(missingRange.status).toBe(400);
    expect(badDuration.status).toBe(400);
  });

  test('replay duration and minimum filter use each visit timeline across chunks', async ({
    api,
    admin,
    seed,
  }) => {
    const website = await createWebsite(admin);

    try {
      const configured = await admin.post(`/api/websites/${website.id}`, {
        replayConfig: { replayEnabled: true, sampleRate: 1 },
      });
      expect(configured.status).toBe(200);

      const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 14_400_000;
      const identity = uniqueName('replay-duration');
      const cases = [
        // Arrive out of order; neither upload has any internal duration.
        {
          chunks: [
            [108_000, 108_000],
            [0, 0],
          ],
          duration: 108_000,
        },
        // The exact default threshold is inclusive.
        { chunks: [[0, 5_000]], duration: 5_000 },
        // Overlapping uploads must not turn a four-second visit into seven seconds.
        {
          chunks: [
            [0, 4_000],
            [1_000, 4_000],
          ],
          duration: 4_000,
        },
        { chunks: [[0, 1_000]], duration: 1_000 },
      ];
      const visits: { id: string; duration: number; chunkCount: number }[] = [];
      const sessions = new Set<string>();

      for (const [index, item] of cases.entries()) {
        // One session across separate hourly visits: duration must stay visit-scoped.
        const visitStart = start + index * 3_600_000;
        const visit = await api.post('/api/send', {
          type: 'event',
          payload: {
            website: website.id,
            hostname: website.domain,
            url: '/',
            id: identity,
            ip: '10.0.9.2',
            userAgent: PERSONAS[0].userAgent,
            timestamp: visitStart / 1000,
          },
        });
        expect(visit.status).toBe(200);
        expect(visit.body.cache).toEqual(expect.any(String));
        sessions.add(visit.body.sessionId);
        visits.push({
          id: visit.body.visitId,
          duration: item.duration,
          chunkCount: item.chunks.length,
        });

        for (const [chunkIndex, [first, last]] of item.chunks.entries()) {
          const recorded = await api.post(
            '/api/record',
            {
              type: 'record',
              payload: {
                website: website.id,
                timestamp: visitStart / 1000 + chunkIndex,
                events: [first, last].map(offset => ({
                  type: 3,
                  data: { source: 1, positions: [] },
                  timestamp: visitStart + offset,
                })),
              },
            },
            { headers: { [CACHE_HEADER]: visit.body.cache } },
          );
          expect(recorded.status).toBe(200);
          expect(recorded.body).toEqual({ ok: true });
        }
      }

      expect(sessions.size).toBe(1);
      expect(new Set(visits.map(visit => visit.id)).size).toBe(cases.length);
      const params = dateRange(seed, { pageSize: 100 });
      const path = `/api/websites/${website.id}/replays`;

      // Poll for ClickHouse ingestion visibility without weakening the assertions.
      await expect(async () => {
        const all = await admin.get(path, { params });
        expect(all.status).toBe(200);
        expect(all.body.count).toBe(cases.length);
        for (const visit of visits) {
          const replay = all.body.data.find((row: any) => row.id === visit.id);
          expect(replay).toMatchObject({ duration: visit.duration, chunkCount: visit.chunkCount });
          expect(new Date(replay.endedAt).getTime() - new Date(replay.startedAt).getTime()).toBe(
            visit.duration,
          );
        }
        const filtered = await admin.get(path, { params: { ...params, minDuration: 5 } });
        expect(filtered.status).toBe(200);
        expect(filtered.body.count).toBe(2);
        expect(filtered.body.data.map((row: any) => row.id).sort()).toEqual(
          visits
            .filter(visit => visit.duration >= 5_000)
            .map(visit => visit.id)
            .sort(),
        );
      }).toPass({ timeout: 15_000 });
    } finally {
      await deleteWebsite(admin, website.id);
    }
  });

  test('GET /api/websites/{websiteId}/replays/{replayId} returns the recorded events', async ({
    admin,
    share,
    viewer,
    seed,
  }) => {
    const response = await admin.get(`${base}/replays/${seed.data.replayVisitId}`);
    const shared = await (await share()).get(`${base}/replays/${seed.data.replayVisitId}`);
    const denied = await viewer.get(`${base}/replays/${seed.data.replayVisitId}`);
    const unknown = await admin.get(`${base}/replays/${UNKNOWN_UUID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sessionId: seed.data.replaySessionId,
      events: expect.any(Array),
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      eventCount: REPLAY_EVENT_COUNT,
      chunkCount: 1,
    });
    expect(response.body.events).toHaveLength(REPLAY_EVENT_COUNT);
    expect(response.body.events.map((event: any) => event.type)).toEqual([4, 2, 3]);
    expect(response.body.events[0]).toEqual({
      type: 4,
      data: { href: `https://${seed.data.hostname}/`, width: 1280, height: 800 },
      timestamp: expect.any(Number),
    });
    const timestamps = response.body.events.map((event: any) => event.timestamp);
    // ClickHouse stores replay bounds at second precision; Postgres keeps milliseconds.
    const bound = (value: number) =>
      seed.db === 'clickhouse' ? Math.floor(value / 1000) * 1000 : value;
    expect(bound(timestamps[0])).toBe(new Date(response.body.startedAt).getTime());
    expect(bound(timestamps[timestamps.length - 1])).toBe(
      new Date(response.body.endedAt).getTime(),
    );

    // Unknown replays are an empty recording, not a 404.
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({
      sessionId: null,
      events: [],
      startedAt: null,
      endedAt: null,
      eventCount: 0,
      chunkCount: 0,
    });

    expect(shared.status).toBe(401);
    expect(denied.status).toBe(401);
  });

  test('GET /api/websites/{websiteId}/replays/{replayId} truncates the events with until, chunkIndex and eventIndex', async ({
    admin,
    seed,
  }) => {
    const path = `${base}/replays/${seed.data.replayVisitId}`;
    const full = await admin.get(path);
    const secondTimestamp = full.body.events[1].timestamp;

    // `chunkIndex` is not an ordinal: /api/record stores each chunk under its ingest
    // timestamp in seconds (`timestamp || Date.now() / 1000`), so the parameter is an
    // inclusive upper bound on chunk timestamps.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = Math.floor(new Date(full.body.startedAt).getTime() / 1000);

    const until = await admin.get(path, { params: { until: secondTimestamp } });
    const allChunks = await admin.get(path, { params: { chunkIndex: nowSeconds } });
    const beforeFirstChunk = await admin.get(path, { params: { chunkIndex: startSeconds - 1 } });
    const listed = await admin.get(`${base}/replays`, {
      params: dateRange(seed, { pageSize: 100 }),
    });

    expect(until.status).toBe(200);
    expect(until.body.events.map((event: any) => event.timestamp)).toEqual(
      full.body.events
        .map((event: any) => event.timestamp)
        .filter((timestamp: number) => timestamp <= secondTimestamp),
    );
    expect(until.body.events.length).toBeLessThan(REPLAY_EVENT_COUNT);

    expect(allChunks.status).toBe(200);
    expect(allChunks.body.events).toEqual(full.body.events);
    expect(allChunks.body.chunkCount).toBe(1);

    expect(beforeFirstChunk.status).toBe(200);
    expect(beforeFirstChunk.body).toMatchObject({ events: [], chunkCount: 0 });

    // `eventIndex` only applies to the chunk whose timestamp equals `chunkIndex`. The
    // seeded chunk was ingested without an explicit timestamp, so its key is the ingest
    // second, which sits within a second or two of the replay's `createdAt`.
    const replay = listed.body.data.find((row: any) => row.id === seed.data.replayVisitId);
    const createdSeconds = Math.floor(new Date(replay.createdAt).getTime() / 1000);
    const truncated: any[] = [];

    for (const chunkIndex of [createdSeconds - 2, createdSeconds - 1, createdSeconds]) {
      const response = await admin.get(path, { params: { chunkIndex, eventIndex: 0 } });

      expect(response.status).toBe(200);
      truncated.push(response.body.events);
    }

    expect(truncated).toContainEqual([full.body.events[0]]);
  });

  test('POST /api/websites/{websiteId}/replays/saved/{replayId} saves a replay', async ({
    admin,
    share,
    viewer,
    seed,
  }) => {
    const name = uniqueName('saved-replay');

    // Saving an already-saved replay fails with a unique-constraint 500 (it is not an
    // upsert), so start from a known unsaved state in case an earlier run aborted.
    await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, { isSaved: false });

    const response = await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      isSaved: true,
      name,
    });
    const shared = await (await share()).post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      isSaved: true,
    });
    const denied = await viewer.post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      isSaved: true,
    });
    const missingFlag = await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      name,
    });
    const longName = await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      isSaved: true,
      name: 'x'.repeat(101),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(shared.status).toBe(401);
    expect(denied.status).toBe(401);
    expect(missingFlag.status).toBe(400);
    expect(longName.status).toBe(400);

    const status = await admin.get(`${base}/replays/saved/${seed.data.replayVisitId}`);
    const saved = await admin.get(`${base}/replays/saved`, { params: { pageSize: 100 } });
    const searched = await admin.get(`${base}/replays/saved`, { params: { search: name } });
    const missed = await admin.get(`${base}/replays/saved`, {
      params: { search: 'zzz-no-such-saved-replay' },
    });
    const listShared = await (await share()).get(`${base}/replays/saved`);
    const listDenied = await viewer.get(`${base}/replays/saved`);
    const statusShared = await (await share()).get(
      `${base}/replays/saved/${seed.data.replayVisitId}`,
    );
    const statusDenied = await viewer.get(`${base}/replays/saved/${seed.data.replayVisitId}`);

    expect(status.status).toBe(200);
    expect(status.body.isSaved).toBeTruthy();

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ data: expect.any(Array), count: expect.any(Number) });
    expect(saved.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          websiteId: seed.website.id,
          visitId: seed.data.replayVisitId,
          name,
          createdAt: expect.any(String),
        }),
      ]),
    );

    expect(searched.status).toBe(200);
    expect(searched.body.data).toHaveLength(1);
    expect(searched.body.data[0]).toMatchObject({ visitId: seed.data.replayVisitId, name });
    expect(missed.body.data).toHaveLength(0);

    expect(listShared.status).toBe(401);
    expect(listDenied.status).toBe(401);
    expect(statusShared.status).toBe(401);
    expect(statusDenied.status).toBe(401);
  });

  test('POST /api/websites/{websiteId}/replays/saved/{replayId} unsaves a replay', async ({
    admin,
    seed,
  }) => {
    const response = await admin.post(`${base}/replays/saved/${seed.data.replayVisitId}`, {
      isSaved: false,
    });
    const status = await admin.get(`${base}/replays/saved/${seed.data.replayVisitId}`);
    const saved = await admin.get(`${base}/replays/saved`, { params: { pageSize: 100 } });
    const unknown = await admin.get(`${base}/replays/saved/${UNKNOWN_UUID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(status.status).toBe(200);
    expect(status.body.isSaved).toBeFalsy();
    expect(saved.body.data.map((row: any) => row.visitId)).not.toContain(seed.data.replayVisitId);
    expect(unknown.status).toBe(200);
    expect(unknown.body.isSaved).toBeFalsy();
  });

  test('GET /api/websites/{websiteId}/sessions/{sessionId}/replays lists the replays of a session', async ({
    admin,
    share,
    viewer,
    seed,
  }) => {
    const path = `${base}/sessions/${seed.data.replaySessionId}/replays`;
    const response = await admin.get(path, { params: dateRange(seed) });
    const searched = await admin.get(path, {
      params: dateRange(seed, { search: 'zzz-no-such-replay' }),
    });
    const none = await admin.get(`${base}/sessions/${UNKNOWN_UUID}/replays`, {
      params: dateRange(seed),
    });
    const shared = await (await share()).get(path, { params: dateRange(seed) });
    const denied = await viewer.get(path, { params: dateRange(seed) });
    const missingRange = await admin.get(path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: expect.any(Array),
      count: expect.any(Number),
      page: 1,
      pageSize: expect.any(Number),
    });
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const row of response.body.data) {
      expect(row).toMatchObject({
        id: expect.any(String),
        websiteId: seed.website.id,
        sessionId: seed.data.replaySessionId,
        eventCount: expect.any(Number),
        chunkCount: expect.any(Number),
        duration: expect.any(Number),
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      });
    }
    expect(response.body.data.map((row: any) => row.id)).toContain(seed.data.replayVisitId);

    expect(searched.status).toBe(200);
    expect(searched.body.data).toHaveLength(0);

    expect(none.status).toBe(200);
    expect(none.body.data).toHaveLength(0);

    expect(shared.status).toBe(401);
    expect(denied.status).toBe(401);
    expect(missingRange.status).toBe(400);
  });
});
