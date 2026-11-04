// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, createConfiguredApiClient } from './index';
import type { VideoCardOut } from './index';

const videoResponse = {
  id: 'video-id',
  title: 'Video',
  comparison_status: 'duration_too_short',
  fetched_at: '2025-01-01T00:00:00Z',
} satisfies VideoCardOut;

function stubFetch() {
  const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
    JSON.stringify(videoResponse), { headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createConfiguredApiClient', () => {
  it.each([
    { label: 'omitted', value: undefined },
    { label: 'empty', value: '' },
  ])('uses same-origin when the public base is $label', async ({ value }) => {
    vi.stubEnv('VITE_API_BASE_URL', value);
    const fetchMock = stubFetch();
    const client = createConfiguredApiClient();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await client.getVideo('video-id')).toEqual(videoResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/videos/video-id');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit');
  });

  it('delegates a configured public root origin to the pure factory', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://public-api.example.test/');
    const fetchMock = stubFetch();
    const client = createConfiguredApiClient();
    expect(fetchMock).not.toHaveBeenCalled();
    await client.getVideo('video-id', { forceSync: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0])
      .toBe('https://public-api.example.test/api/videos/video-id?force_sync=true');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('does not eagerly capture configuration or construct/request a client at import', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'not-a-url');
    const fetchMock = stubFetch();
    vi.resetModules();
    const api = await import('./index');
    api.createApiClient();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('VITE_API_BASE_URL', 'https://called-later.example.test/');
    const client = api.createConfiguredApiClient();
    expect(fetchMock).not.toHaveBeenCalled();
    await client.getVideo('video-id');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://called-later.example.test/api/videos/video-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads current configuration per factory call, without a singleton or construction requests', async () => {
    const fetchMock = stubFetch();
    vi.stubEnv('VITE_API_BASE_URL', 'https://first.example.test');
    const first = createConfiguredApiClient();
    vi.stubEnv('VITE_API_BASE_URL', 'https://second.example.test');
    const second = createConfiguredApiClient();
    expect(first).not.toBe(second);
    expect(fetchMock).not.toHaveBeenCalled();

    await first.getVideo('video-id');
    await second.getVideo('video-id');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://first.example.test/api/videos/video-id',
      'https://second.example.test/api/videos/video-id',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves the pure factory default same-origin even when public configuration is invalid', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'not-a-url');
    const fetchMock = stubFetch();
    const client = createApiClient();
    expect(fetchMock).not.toHaveBeenCalled();
    await client.getVideo('video-id');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/videos/video-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'malformed', value: 'not-a-url' },
    { label: 'credentials', value: 'https://fixture:discard-sentinel@api.example.test' },
    { label: 'query', value: 'https://api.example.test?mode=discard-sentinel' },
    { label: 'fragment', value: 'https://api.example.test#discard-sentinel' },
    { label: 'subpath', value: 'https://api.example.test/api' },
    { label: 'non-HTTP scheme', value: 'ftp://api.example.test' },
  ])('rejects unsafe $label configuration without echo or requests', ({ value }) => {
    vi.stubEnv('VITE_API_BASE_URL', value);
    const fetchMock = stubFetch();
    let error: unknown;
    try {
      createConfiguredApiClient();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError', code: 'invalid_base_url', status: null, retryable: false, fields: [],
      message: 'Некорректный адрес API. Укажите пустое значение или публичный корневой HTTP(S)-адрес.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
