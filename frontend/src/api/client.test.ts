// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './index';
import type {
  ApiClient,
  ApiRequestOptions,
  ChannelCardOut,
  SearchVideosRequest,
  SearchVideosResponse,
  VideoCardOut,
} from './index';

const fetchedAt = '2025-01-01T00:00:00Z';
const searchResponse = {
  query: '',
  applied: { query: '', min_subscribers: 0, max_views: null },
  videos: [{ id: 'video-id', title: 'Video', view_count: 0, like_count: null, view_sub_ratio: null }],
  fetched_at: fetchedAt,
  next_page_token: null,
  items_scanned: 0,
  matched_count: 0,
  quota_used_estimate: 0,
} satisfies SearchVideosResponse;
const channelResponse = {
  channel: { id: 'channel-id', title: 'Channel', subscriber_count: 0, subscriber_count_hidden: null },
  sample: {
    selected_count: 0,
    metric_count: 0,
    uploads_scanned: 0,
    pages_scanned: 0,
    date_from: null,
    date_to: null,
    stop_reason: 'uploads_exhausted',
    target_reached: false,
    scan_limit_reached: false,
  },
  metrics: { count: 0, median_views: null, consistency: 0 },
  summary: 'No sample videos.',
  videos: [],
  source_video: null,
  fetched_at: fetchedAt,
  from_cache: false,
  quota_used_estimate: 0,
} satisfies ChannelCardOut;
const videoResponse = {
  id: 'video-id',
  title: 'Video',
  view_count: 0,
  like_count: null,
  channel_subscriber_count_hidden: null,
  view_median_ratio: null,
  sample: null,
  comparison_status: 'duration_too_short',
  comparison_reason: null,
  fetched_at: fetchedAt,
  from_cache: false,
  quota_used_estimate: 0,
} satisfies VideoCardOut;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function assertApiError(error: unknown): asserts error is ApiError {
  expect(error).toBeInstanceOf(ApiError);
}

async function apiErrorFrom(request: Promise<unknown>): Promise<ApiError> {
  try {
    await request;
  } catch (error) {
    assertApiError(error);
    return error;
  }
  throw new Error('Expected an ApiError rejection.');
}

const requestCases: Array<{
  name: string;
  response: SearchVideosResponse | ChannelCardOut | VideoCardOut;
  run: (client: ApiClient, options?: ApiRequestOptions) => Promise<unknown>;
}> = [
  { name: 'searchVideos', response: searchResponse, run: (client, options) => client.searchVideos({}, options) },
  { name: 'getChannel', response: channelResponse, run: (client, options) => client.getChannel('channel-id', options) },
  { name: 'getVideo', response: videoResponse, run: (client, options) => client.getVideo('video-id', options) },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('explicit API requests', () => {
  it('exports only the public runtime API and does not fetch at import or construction', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const api = await import('./index');
    expect(Object.keys(api).sort()).toEqual(['ApiError', 'createApiClient', 'createConfiguredApiClient']);
    api.createApiClient();
    api.createApiClient({ baseUrl: 'https://api.example.test/', fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes the supplied search DTO without trimming, defaults, or losing null/zero', async () => {
    const request: SearchVideosRequest = {
      query: '  topic / & ?  ',
      limit: 1,
      period: 'all',
      published_after: null,
      published_before: fetchedAt,
      relevance_language: null,
      page_token: null,
      duration_ranges: [],
      min_views: 0,
      max_views: null,
      min_subscribers: 0,
      max_subscribers: 0,
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(searchResponse));
    const result = await createApiClient({ fetch: fetchMock }).searchVideos(request);
    expect(result).toEqual(searchResponse);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/search/videos', {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(request.min_subscribers).toBe(0);
    expect(request.max_views).toBeNull();
  });

  it('omits absent search fields instead of supplying backend defaults', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(searchResponse));
    await createApiClient({ fetch: fetchMock }).searchVideos({ query: 'topic' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"query":"topic"}');
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });

  it('encodes channel paths and snake_case query names, including explicit false', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(channelResponse));
    const result = await createApiClient({ fetch: fetchMock }).getChannel('channel /?#中', {
      forceSync: false,
      sourceVideoId: 'video /?&=#中',
    });
    expect(result).toEqual(channelResponse);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/channels/channel%20%2F%3F%23%E4%B8%AD?force_sync=false&source_video_id=video+%2F%3F%26%3D%23%E4%B8%AD',
      {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' },
      },
    );
  });

  it('encodes video paths and serializes explicit forceSync=true', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(videoResponse));
    expect(await createApiClient({ fetch: fetchMock }).getVideo('video /?#中', { forceSync: true }))
      .toEqual(videoResponse);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/videos/video%20%2F%3F%23%E4%B8%AD?force_sync=true');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit');
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('does not append absent optional query parameters or discard an explicit empty source id', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(channelResponse))
      .mockResolvedValueOnce(jsonResponse(videoResponse))
      .mockResolvedValueOnce(jsonResponse(channelResponse))
      .mockResolvedValueOnce(jsonResponse(videoResponse));
    const client = createApiClient({ fetch: fetchMock });
    await client.getChannel('channel-id');
    await client.getVideo('video-id', {});
    await client.getChannel('channel-id', { forceSync: true, sourceVideoId: '' });
    await client.getVideo('video-id', { forceSync: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/channels/channel-id',
      '/api/videos/video-id',
      '/api/channels/channel-id?force_sync=true&source_video_id=',
      '/api/videos/video-id?force_sync=false',
    ]);
  });

  it.each(requestCases)('$name passes through the exact AbortSignal', async ({ response, run }) => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(response));
    await run(createApiClient({ fetch: fetchMock }), { signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit');
  });

  it.each(requestCases)('$name fetches once per call with no client cache or implicit requests', async ({ response, run }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => jsonResponse(response));
    const client = createApiClient({ fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await run(client)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await run(client)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores arbitrary transport options rather than allowing headers, cookies, or credentials', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(channelResponse));
    const options = {
      forceSync: false,
      credentials: 'include',
      headers: { Authorization: 'fixture-only', 'X-YouTube-Key': 'fixture-only', Cookie: 'fixture-only' },
    };
    await createApiClient({ fetch: fetchMock }).getChannel('channel-id', options);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: 'application/json' });
  });
});

describe('resource IDs', () => {
  it.each([
    { method: 'getChannel', resource: 'channels', id: '.', normalized: '/api/channels/' },
    { method: 'getChannel', resource: 'channels', id: '..', normalized: '/api/' },
    { method: 'getVideo', resource: 'videos', id: '.', normalized: '/api/videos/' },
    { method: 'getVideo', resource: 'videos', id: '..', normalized: '/api/' },
  ] as const)('rejects exact dot-segment IDs before fetch ($method, case %#)', async ({ method, resource, id, normalized }) => {
    const origin = 'https://api.example.test';
    const path = `/api/${resource}/${encodeURIComponent(id)}`;
    // Native URL/Request demonstrate the normalization without any network.
    expect(new URL(path, origin).pathname).toBe(normalized);
    expect(new Request(`${origin}${path}`).url).toBe(`${origin}${normalized}`);

    const response = method === 'getChannel' ? channelResponse : videoResponse;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(response));
    const client = createApiClient({ baseUrl: origin, fetch: fetchMock });
    const error = await apiErrorFrom(client[method](id));
    expect(error).toMatchObject({
      name: 'ApiError', code: 'invalid_resource_id', status: null, retryable: false, fields: [],
      message: 'Некорректный идентификатор ресурса.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'getChannel', id: '...', path: '/api/channels/...' },
    { method: 'getVideo', id: '.video', path: '/api/videos/.video' },
    { method: 'getChannel', id: '%2e%2e', path: '/api/channels/%252e%252e' },
    { method: 'getVideo', id: 'video..', path: '/api/videos/video..' },
  ] as const)('preserves encoding for non-dot-segment IDs ($method, case %#)', async ({ method, id, path }) => {
    const response = method === 'getChannel' ? channelResponse : videoResponse;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(response));
    expect(await createApiClient({ fetch: fetchMock })[method](id)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(path);
  });
});

describe('structured and sanitized API errors', () => {
  it.each([
    { status: 422, message: 'Некоторые поля запроса заполнены некорректно.' },
    { status: 404, message: 'Запрошенные данные недоступны.' },
    { status: 429, message: 'Частота запросов временно ограничена.' },
    { status: 503, message: 'Сервис временно недоступен.' },
    { status: 500, message: 'Не удалось выполнить запрос.' },
  ])('uses a Russian input-independent HTTP fallback at $status', async ({ status, message }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ detail: 'untrusted proxy text' }, status));
    expect(await apiErrorFrom(createApiClient({ fetch: fetchMock }).getVideo('video-id')))
      .toMatchObject({ status, code: 'http_error', message, fields: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes 422 fields, preserving locations and zero indices but dropping extra input/context', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      detail: {
        code: 'validation_error', message: 'Некорректные поля запроса.', retryable: false,
        fields: [{
          loc: ['body', 'duration_ranges', 0], type: 'literal_error', message: 'Choose a supported duration range.',
          input: 'discard-sentinel', ctx: { input: 'discard-sentinel' },
        }],
      },
    }, 422));
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).searchVideos({}));
    expect(error).toMatchObject({
      name: 'ApiError', status: 422, code: 'validation_error', retryable: false,
      message: 'Некорректные поля запроса.',
      fields: [{ loc: ['body', 'duration_ranges', 0], type: 'literal_error', message: 'Choose a supported duration range.' }],
    });
    expect(JSON.stringify(error)).not.toContain('discard-sentinel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, code: 'quota_exceeded', retryable: false, message: 'Quota is exhausted.' },
    { status: 429, code: 'rate_limited', retryable: true, message: 'Too many requests.' },
    { status: 503, code: 'source_not_configured', retryable: false, message: 'The service is not configured.' },
    { status: 503, code: 'source_unavailable', retryable: true, message: 'The source is currently unavailable.' },
  ])('preserves $status / $code metadata without retrying', async ({ status, code, retryable, message }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      detail: { code, message, retryable, fields: null },
    }, status));
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).getVideo('video-id'));
    expect(error).toMatchObject({ status, code, retryable, message, fields: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 422, retryable: false }, { status: 429, retryable: true }, { status: 503, retryable: true },
  ])('uses controlled defaults for omitted optional error fields at $status', async ({ status, retryable }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      detail: { code: 'request_failed', message: 'The action could not be completed.' },
    }, status));
    expect(await apiErrorFrom(createApiClient({ fetch: fetchMock }).getChannel('channel-id')))
      .toMatchObject({ status, retryable, fields: [] });
  });

  it.each([
    { label: 'string detail', body: { detail: 'untrusted proxy text' } },
    { label: 'legacy array detail', body: { detail: [{ message: 'untrusted proxy text' }] } },
    { label: 'top-level message', body: { message: 'untrusted proxy text' } },
    { label: 'missing code', body: { detail: { message: 'untrusted proxy text' } } },
    { label: 'unsafe code', body: { detail: { code: 'https://proxy.example.test', message: 'untrusted proxy text' } } },
    { label: 'non-string message', body: { detail: { code: 'proxy_error', message: { raw: 'untrusted proxy text' } } } },
    { label: 'null body', body: null },
    { label: 'array body', body: [] },
  ])('does not expose unknown JSON error bodies: $label', async ({ body }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body, 502));
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).getVideo('video-id'));
    expect(error).toMatchObject({
      status: 502, code: 'http_error', retryable: true, fields: [],
      message: 'Не удалось выполнить запрос.',
    });
  });

  it.each([
    { label: 'URL', message: 'See https://proxy.example.test/?key=discard-sentinel' },
    { label: 'HTML', message: '<html>discard-sentinel</html>' },
    { label: 'raw exception', message: 'TypeError: discard-sentinel' },
    { label: 'traceback', message: 'Traceback (most recent call last)' },
    { label: 'authorization', message: 'Authorization: Bearer discard-sentinel' },
    { label: 'key assignment', message: 'api_key=discard-sentinel' },
    { label: 'token assignment', message: 'page_token=discard-sentinel' },
    { label: 'file URL', message: 'file:///private/discard-sentinel' },
    { label: 'control characters', message: 'line one\nline two' },
    { label: 'oversized message', message: 'x'.repeat(501) },
  ])('replaces unsafe structured backend messages: $label', async ({ message }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      detail: { code: 'source_unavailable', message, retryable: true },
    }, 503));
    expect(await apiErrorFrom(createApiClient({ fetch: fetchMock }).searchVideos({}))).toMatchObject({
      status: 503, code: 'source_unavailable', retryable: true,
      message: 'Сервис временно недоступен.',
    });
  });

  it('sanitizes validation messages and rejects unsafe or malformed location/type metadata', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      detail: {
        code: 'validation_error', message: 'Invalid fields.', fields: [
          { loc: ['body', 'min_views'], type: 'greater_than_equal', message: 'https://proxy.example.test/discard-sentinel', input: 'discard-sentinel' },
          { loc: ['body', 'max_views'], type: 'value_error', message: 'Invalid maximum.' },
          { loc: ['body', 'https://proxy.example.test'], type: 'value_error', message: 'Do not expose this.' },
          { loc: ['body', -1], type: 'value_error', message: 'Do not expose this.' },
          { loc: ['body'], type: 'https://proxy.example.test', message: 'Do not expose this.' },
          { loc: 'body', type: 'missing', message: 'Do not expose this.' },
          null,
          'untrusted field',
        ],
      },
    }, 422));
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).searchVideos({}));
    expect(error.fields).toEqual([
      { loc: ['body', 'min_views'], type: 'greater_than_equal', message: 'Некорректное значение.' },
      { loc: ['body', 'max_views'], type: 'value_error', message: 'Invalid maximum.' },
    ]);
    expect(JSON.stringify(error)).not.toContain('discard-sentinel');
  });
});

describe('malformed responses and network failures', () => {
  it.each([
    { label: 'HTML success', status: 200, type: 'text/html', body: '<html>untrusted proxy text</html>', code: 'invalid_response' },
    { label: 'JSON with non-JSON content type', status: 200, type: 'text/plain', body: '{}', code: 'invalid_response' },
    { label: 'malformed JSON success', status: 200, type: 'application/json', body: '{"raw":"discard-sentinel",', code: 'invalid_response' },
    { label: 'HTML failure', status: 503, type: 'text/html', body: '<html>untrusted proxy text</html>', code: 'http_error' },
    { label: 'malformed JSON failure', status: 503, type: 'application/json', body: '{"raw":"discard-sentinel",', code: 'http_error' },
    { label: 'empty JSON body', status: 200, type: 'application/json', body: '', code: 'invalid_response' },
  ])('uses controlled errors for $label', async ({ status, type, body, code }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, {
      status, headers: { 'Content-Type': type },
    }));
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).searchVideos({}));
    expect(error).toMatchObject({ status, code, fields: [] });
    expect(error.message).toBe(status === 503
      ? 'Сервис временно недоступен.'
      : 'Сервис вернул некорректный ответ.');
    expect(error).not.toHaveProperty('cause');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], 'untrusted string', 0, true])('rejects a non-object successful JSON response (%j)', async (body) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body));
    expect(await apiErrorFrom(createApiClient({ fetch: fetchMock }).getVideo('video-id')))
      .toMatchObject({ status: 200, code: 'invalid_response', message: 'Сервис вернул некорректный ответ.' });
  });

  it.each(['Application/JSON; charset=utf-8', 'application/vnd.service+json'])('accepts JSON media type %s', async (type) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(videoResponse), {
      headers: { 'Content-Type': type },
    }));
    expect(await createApiClient({ fetch: fetchMock }).getVideo('video-id')).toEqual(videoResponse);
  });

  it('rejects a response with no Content-Type without exposing the body', async () => {
    const response = new Response(JSON.stringify(videoResponse));
    response.headers.delete('content-type');
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    expect(await apiErrorFrom(createApiClient({ fetch: fetchMock }).getVideo('video-id')))
      .toMatchObject({ code: 'invalid_response', status: 200 });
  });

  it.each([
    { label: 'Error', reason: new TypeError('Failed to fetch https://proxy.example.test/?key=discard-sentinel') },
    { label: 'string', reason: 'raw discard-sentinel' },
    { label: 'object', reason: { message: 'raw discard-sentinel', url: 'https://proxy.example.test' } },
  ])('hides raw network failures ($label) and does not retry', async ({ reason }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(reason);
    const error = await apiErrorFrom(createApiClient({ fetch: fetchMock }).searchVideos({}));
    expect(error).toMatchObject({
      status: null, code: 'network_error', retryable: true, fields: [],
      message: 'Не удалось связаться с сервисом. Попробуйте ещё раз.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('discard-sentinel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation', () => {
  it.each(requestCases)('$name does not fetch with an already-aborted signal and propagates AbortError', async ({ run }) => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled.', 'AbortError');
    controller.abort(reason);
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    await expect(run(createApiClient({ fetch: fetchMock }), { signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose a custom reason from an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('discard-sentinel'));
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    await expect(createApiClient({ fetch: fetchMock }).searchVideos({}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Запрос отменён.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates the original fetch AbortError rather than wrapping it as an ApiError', async () => {
    const reason = new DOMException('Cancelled.', 'AbortError');
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(reason);
    await expect(createApiClient({ fetch: fetchMock }).getVideo('video-id')).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recognizes in-flight cancellation with a custom reason as AbortError, not network failure', async () => {
    const controller = new AbortController();
    const reason = new Error('discard-sentinel');
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(createApiClient({ fetch: fetchMock }).getChannel('channel-id', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Запрос отменён.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after fetch even if an injected fetch resolves after abort', async () => {
    const controller = new AbortController();
    const response = jsonResponse(searchResponse);
    const readBody = vi.spyOn(response, 'json');
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      controller.abort();
      return response;
    });
    await expect(createApiClient({ fetch: fetchMock }).searchVideos({}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(readBody).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates AbortError from response body consumption', async () => {
    const reason = new DOMException('Cancelled.', 'AbortError');
    const response = jsonResponse(searchResponse);
    vi.spyOn(response, 'json').mockRejectedValue(reason);
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(createApiClient({ fetch: fetchMock }).searchVideos({})).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after JSON consumption instead of returning cancelled data', async () => {
    const controller = new AbortController();
    const response = jsonResponse(searchResponse);
    vi.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort(new Error('discard-sentinel'));
      return searchResponse;
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(createApiClient({ fetch: fetchMock }).searchVideos({}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Запрос отменён.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('public root base URL', () => {
  it.each([
    { baseUrl: '', prefix: '' },
    { baseUrl: 'https://api.example.test', prefix: 'https://api.example.test' },
    { baseUrl: 'https://api.example.test/', prefix: 'https://api.example.test' },
    { baseUrl: 'https://API.EXAMPLE.test:443/', prefix: 'https://api.example.test' },
    { baseUrl: 'http://localhost:8000/', prefix: 'http://localhost:8000' },
    { baseUrl: 'http://127.0.0.1:8000', prefix: 'http://127.0.0.1:8000' },
    { baseUrl: 'http://[::1]:8000/', prefix: 'http://[::1]:8000' },
  ])('accepts and normalizes $baseUrl without construction requests', async ({ baseUrl, prefix }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(videoResponse));
    const client = createApiClient({ baseUrl, fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    await client.getVideo('video-id');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${prefix}/api/videos/video-id`);
  });

  it.each([
    'not-a-url', '//api.example.test', '/api', 'https:/api.example.test', 'https:///api.example.test',
    'ftp://api.example.test', 'https://user:fixture-only@api.example.test', 'https://@api.example.test',
    'https://api.example.test/api', 'https://api.example.test//', 'https://api.example.test?mode=public',
    'https://api.example.test?', 'https://api.example.test#section', 'https://api.example.test#',
    ' https://api.example.test', 'https://api.example.test ', 'https://api.example.test\\path',
    'https://api.example.test:invalid',
  ])('rejects malformed or non-root base URL (case %#) without echo or fetch', (baseUrl) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    let error: unknown;
    try {
      createApiClient({ baseUrl, fetch: fetchMock });
    } catch (caught) {
      error = caught;
    }
    assertApiError(error);
    expect(error).toMatchObject({
      code: 'invalid_base_url', status: null, retryable: false, fields: [],
      message: 'Некорректный адрес API. Укажите пустое значение или публичный корневой HTTP(S)-адрес.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(error.message).not.toContain(baseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
