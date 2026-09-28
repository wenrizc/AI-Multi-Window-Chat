/**
 * Stable error contract shared by the background worker, the providers and the
 * chat UI. Keeping this in one place lets the UI map failures to localized
 * messages without re-parsing free-form error strings.
 */

export type FailureCode =
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'http_error'
  | 'network'
  | 'parse'
  | 'provider_not_found'
  | 'model_unavailable'
  | 'storage_error'
  | 'unknown';

export interface FailureInfo {
  code: FailureCode;
  error: string;
  retryable: boolean;
  status: number | null;
}

/** HTTP statuses that are safe to retry without changing the request. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Maps an HTTP status to the stable failure contract. */
export function httpStatusFailure(status: number): FailureInfo {
  const code: FailureCode =
    status === 401 || status === 403
      ? 'auth'
      : status === 404
        ? 'model_unavailable'
        : 'http_error';
  return {
    code,
    error: `Provider returned ${status}`,
    retryable: isRetryableHttpStatus(status),
    status
  };
}

export class ProviderError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    code: FailureCode,
    message: string,
    options: { retryable?: boolean; status?: number | null } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export function isNamedError(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === name
  );
}

export function isAbortError(value: unknown): boolean {
  return isNamedError(value, 'AbortError');
}

export function isTimeoutError(value: unknown): boolean {
  return isNamedError(value, 'TimeoutError');
}

/** Raised when `chrome.storage.local.set` runs out of quota. */
export class StorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export function isStorageQuotaError(value: unknown): value is StorageQuotaError {
  return value instanceof StorageQuotaError;
}

export function isQuotaErrorText(value: unknown): boolean {
  const text = value instanceof Error ? `${value.name} ${value.message}` : String(value ?? '');
  return /quota|quotaexceeded/i.test(text);
}

/**
 * Normalizes any thrown value into the failure contract consumed by the chat
 * UI. Timeouts and user aborts are distinguished so only genuinely retryable
 * failures offer the retry action.
 */
export function classifyError(error: unknown): FailureInfo {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      error: error.message,
      retryable: error.retryable,
      status: error.status
    };
  }

  if (isTimeoutError(error)) {
    return {
      code: 'timeout',
      error: error instanceof Error && error.message ? error.message : 'Request timed out.',
      retryable: true,
      status: null
    };
  }

  if (isAbortError(error)) {
    return {
      code: 'aborted',
      error: 'Request aborted.',
      retryable: false,
      status: null
    };
  }

  const message = error instanceof Error && error.message
    ? error.message
    : String(error ?? 'Unknown error');

  if (/failed to fetch|networkerror|network error|load failed|err_network/i.test(message)) {
    return { code: 'network', error: message, retryable: true, status: null };
  }

  if (/json|parse|unexpected token|unexpected end/i.test(message)) {
    return { code: 'parse', error: message, retryable: false, status: null };
  }

  return { code: 'unknown', error: message, retryable: false, status: null };
}
