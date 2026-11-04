import { ApiError, normalizeApiError } from './errors';
import type { ChannelCardOut, SearchVideosRequest, SearchVideosResponse, VideoCardOut } from './types';

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

export interface VideoRequestOptions extends ApiRequestOptions {
  forceSync?: boolean;
}

export interface ChannelRequestOptions extends VideoRequestOptions {
  sourceVideoId?: string;
}

export interface ApiClientOptions {
  /** Empty means same-origin; otherwise an HTTP(S) origin, not an /api path. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ApiClient {
  searchVideos(request: SearchVideosRequest, options?: ApiRequestOptions): Promise<SearchVideosResponse>;
  getChannel(channelId: string, options?: ChannelRequestOptions): Promise<ChannelCardOut>;
  getVideo(videoId: string, options?: VideoRequestOptions): Promise<VideoCardOut>;
}

function invalidBaseUrl(): ApiError {
  return new ApiError('Некорректный адрес API. Укажите пустое значение или публичный корневой HTTP(S)-адрес.', {
    code: 'invalid_base_url',
  });
}

function normalizeBaseUrl(value: string): string {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) || value.includes('@')) {
    throw invalidBaseUrl();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidBaseUrl();
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalidBaseUrl();
  }
  return url.origin;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (isAbortError(reason)) throw reason;
  throw new DOMException('Запрос отменён.', 'AbortError');
}

function invalidResponse(status: number): ApiError {
  return new ApiError('Сервис вернул некорректный ответ.', {
    code: 'invalid_response',
    status,
    retryable: true,
  });
}

function invalidResourceId(): ApiError {
  return new ApiError('Некорректный идентификатор ресурса.', {
    code: 'invalid_resource_id',
  });
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl === undefined ? '' : options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function requestJson<T>(
    path: string,
    method: 'GET' | 'POST',
    requestOptions: ApiRequestOptions,
    body?: SearchVideosRequest,
  ): Promise<T> {
    const { signal } = requestOptions;
    throwIfAborted(signal);
    const init: RequestInit = {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    };
    if (signal !== undefined) init.signal = signal;
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(signal);
      throw new ApiError('Не удалось связаться с сервисом. Попробуйте ещё раз.', {
        code: 'network_error',
        retryable: true,
      });
    }
    throwIfAborted(signal);

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const isJson = contentType === 'application/json'
      || (contentType?.startsWith('application/') === true && contentType.endsWith('+json'));
    if (!isJson) {
      throw response.ok ? invalidResponse(response.status) : normalizeApiError(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(signal);
      throw response.ok ? invalidResponse(response.status) : normalizeApiError(response.status);
    }
    throwIfAborted(signal);
    if (!response.ok) throw normalizeApiError(response.status, payload);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw invalidResponse(response.status);
    }
    // Generated DTOs supply the compile-time contract, without duplicate validators.
    return payload as T;
  }

  return {
    searchVideos(request, requestOptions = {}) {
      return requestJson<SearchVideosResponse>('/api/search/videos', 'POST', requestOptions, request);
    },
    getChannel(channelId, requestOptions = {}) {
      if (channelId === '.' || channelId === '..') return Promise.reject(invalidResourceId());
      const params = new URLSearchParams();
      if (requestOptions.forceSync !== undefined) params.set('force_sync', String(requestOptions.forceSync));
      if (requestOptions.sourceVideoId !== undefined) params.set('source_video_id', requestOptions.sourceVideoId);
      const query = params.toString();
      const path = `/api/channels/${encodeURIComponent(channelId)}${query ? `?${query}` : ''}`;
      return requestJson<ChannelCardOut>(path, 'GET', requestOptions);
    },
    getVideo(videoId, requestOptions = {}) {
      if (videoId === '.' || videoId === '..') return Promise.reject(invalidResourceId());
      const params = new URLSearchParams();
      if (requestOptions.forceSync !== undefined) params.set('force_sync', String(requestOptions.forceSync));
      const query = params.toString();
      const path = `/api/videos/${encodeURIComponent(videoId)}${query ? `?${query}` : ''}`;
      return requestJson<VideoCardOut>(path, 'GET', requestOptions);
    },
  };
}
