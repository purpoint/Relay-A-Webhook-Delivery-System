/**
 * The single response shape every endpoint returns, per the API contract in
 * docs/prompt.md:
 *
 *   { success, data, error, timestamp }
 *
 * Consistency here is worth more than it looks: a client can write one
 * unwrapping helper and one error branch, instead of special-casing each
 * endpoint.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  timestamp: string;
}

export function success<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    error: null,
    timestamp: new Date().toISOString(),
  };
}

export function failure(
  code: string,
  message: string,
  details?: unknown,
): ApiResponse<never> {
  return {
    success: false,
    data: null,
    error: details === undefined ? { code, message } : { code, message, details },
    timestamp: new Date().toISOString(),
  };
}
