import type { ValidationFieldError } from './types';

export interface ApiErrorOptions {
  code: string;
  status?: number | null;
  retryable?: boolean;
  fields?: ValidationFieldError[];
}

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;
  readonly fields: ValidationFieldError[];

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.fields = options.fields ?? [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z\d_.-]{0,79}$/i.test(value);
}

// Structured errors may be displayed, but transport/debug text must not be.
const unsafeMessage = /[<>\u0000-\u001f\u007f]|\/\/|\b[a-z][a-z\d+.-]*:(?=\S)|\b(?:authorization|bearer|cookie|password|api[ _-]?key|x-youtube-key|traceback)\b|\b[a-z]*(?:error|exception):|\b[\w-]*(?:key|token|secret)\s*[:=]/i;

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const message = value.trim();
  return message.length > 0 && message.length <= 500 && !unsafeMessage.test(message)
    ? message
    : fallback;
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 422:
      return 'Некоторые поля запроса заполнены некорректно.';
    case 404:
      return 'Запрошенные данные недоступны.';
    case 429:
      return 'Частота запросов временно ограничена.';
    case 503:
      return 'Сервис временно недоступен.';
    default:
      return 'Не удалось выполнить запрос.';
  }
}

function isLocationPart(value: unknown): value is string | number {
  return isSafeIdentifier(value)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function validationFields(value: unknown): ValidationFieldError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((field: unknown): ValidationFieldError[] => {
    if (!isRecord(field)
      || !Array.isArray(field.loc)
      || !field.loc.every(isLocationPart)
      || !isSafeIdentifier(field.type)) {
      return [];
    }
    return [{
      loc: [...field.loc],
      type: field.type,
      message: safeMessage(field.message, 'Некорректное значение.'),
    }];
  });
}

/** Internal transport helper; arbitrary proxy bodies are never error messages. */
export function normalizeApiError(status: number, body?: unknown): ApiError {
  const fallback = fallbackMessage(status);
  const detail = isRecord(body) && isRecord(body.detail)
    && isSafeIdentifier(body.detail.code) && typeof body.detail.message === 'string'
    ? body.detail
    : undefined;
  return new ApiError(safeMessage(detail?.message, fallback), {
    status,
    code: isSafeIdentifier(detail?.code) ? detail.code : 'http_error',
    retryable: typeof detail?.retryable === 'boolean'
      ? detail.retryable
      : status === 429 || status >= 500,
    fields: validationFields(detail?.fields),
  });
}
