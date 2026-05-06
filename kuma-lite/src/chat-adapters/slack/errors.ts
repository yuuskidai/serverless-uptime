/*
 * Vendored subset of @chat-adapter/shared/errors (MIT licensed).
 * Source: https://github.com/mattpocock/chat/blob/main/packages/adapter-shared/src/errors.ts
 *
 * Only the error classes used by the kuma-lite Slack adapter are included.
 */

export class AdapterError extends Error {
  readonly adapter: string;
  readonly code?: string;
  constructor(message: string, adapter: string, code?: string) {
    super(message);
    this.name = 'AdapterError';
    this.adapter = adapter;
    this.code = code;
  }
}

export class AdapterRateLimitError extends AdapterError {
  readonly retryAfter?: number;
  constructor(adapter: string, retryAfter?: number) {
    super(
      `Rate limited by ${adapter}${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      adapter,
      'RATE_LIMITED',
    );
    this.name = 'AdapterRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class AuthenticationError extends AdapterError {
  constructor(adapter: string, message?: string) {
    super(message || `Authentication failed for ${adapter}`, adapter, 'AUTH_FAILED');
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends AdapterError {
  constructor(adapter: string, message: string) {
    super(message, adapter, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class NetworkError extends AdapterError {
  readonly originalError?: Error;
  constructor(adapter: string, message?: string, originalError?: Error) {
    super(
      message || `Network error communicating with ${adapter}`,
      adapter,
      'NETWORK_ERROR',
    );
    this.name = 'NetworkError';
    this.originalError = originalError;
  }
}
