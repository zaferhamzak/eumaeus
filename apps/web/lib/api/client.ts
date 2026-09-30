import type { ApiErrorBody, ApiErrorCode } from "@/types/api";
import { getCurrentOrganizationId } from "@/lib/currentOrganization";

/**
 * The ONE place an HTTP request is made to the Control Plane API (§23: "do
 * NOT scatter fetch(...) through every component"). Always a same-origin,
 * relative path — next.config.ts's rewrites are what actually reach the
 * backend (see that file's own doc comment for why: no CORS config needed,
 * and this is the seam a future auth layer attaches to).
 */

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly code: ApiErrorCode | "NETWORK_ERROR" | "PARSE_ERROR",
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Any plain object of query params — resource-specific `List*Params` interfaces (lib/api/emails.ts etc.) are passed here directly rather than needing their own index signature. */
  query?: object;
  signal?: AbortSignal;
  /** Acts in this organization instead of the one selected in the switcher (e.g. an organization's own settings page). */
  organizationId?: string;
}

function buildUrl(path: string, query?: ApiRequestOptions["query"]): string {
  const url = new URL(path, "http://internal.invalid"); // base is discarded — only used so URLSearchParams can attach to a relative path safely
  if (query) {
    for (const [key, value] of Object.entries(
      query as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Every response is parsed uniformly, including non-2xx ones: the backend's
 * consistent error shape (Phase 6 §4 — `{error:{code,message,requestId}}`) is
 * turned into a typed ApiRequestError so callers never have to re-parse it,
 * and human-readable messages + the request id are always available to show
 * in an error state (§24/§37) — never a raw stack trace or SQL fragment,
 * because the backend itself never sends one.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, options.query);

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const organizationId = options.organizationId ?? getCurrentOrganizationId();
  if (organizationId) headers["X-Organization-Id"] = organizationId;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    throw new ApiRequestError(
      error instanceof Error ? error.message : "Network request failed",
      "NETWORK_ERROR",
      0,
      null,
    );
  }

  const requestId = response.headers.get("x-request-id");

  if (response.status === 204) {
    return undefined as T;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    if (response.ok) {
      // A 2xx with no body (shouldn't normally happen outside 204, handled
      // above) — treat as success with no payload rather than an error.
      return undefined as T;
    }
    throw new ApiRequestError(
      `Request failed with status ${response.status}`,
      "PARSE_ERROR",
      response.status,
      requestId,
    );
  }

  if (!response.ok) {
    const body = parsed as Partial<ApiErrorBody>;
    const code = body.error?.code ?? "INTERNAL_ERROR";
    const message =
      body.error?.message ?? `Request failed with status ${response.status}`;
    throw new ApiRequestError(
      message,
      code,
      response.status,
      body.error?.requestId ?? requestId,
      body.error?.details,
    );
  }

  return parsed as T;
}

/**
 * Phase 20: like apiRequest, but the response is a file (e.g. a CSV export),
 * saved through the browser's download. Errors still arrive as the backend's
 * JSON error shape and become an ApiRequestError.
 */
export async function apiDownload(
  path: string,
  options: Pick<ApiRequestOptions, "query" | "organizationId"> & {
    fallbackName: string;
  },
): Promise<void> {
  const organizationId = options.organizationId ?? getCurrentOrganizationId();
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      headers: organizationId
        ? { "X-Organization-Id": organizationId }
        : undefined,
    });
  } catch (error) {
    throw new ApiRequestError(
      error instanceof Error ? error.message : "Network request failed",
      "NETWORK_ERROR",
      0,
      null,
    );
  }
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as Partial<ApiErrorBody> | null;
    throw new ApiRequestError(
      body?.error?.message ?? `Request failed with status ${response.status}`,
      body?.error?.code ?? "INTERNAL_ERROR",
      response.status,
      body?.error?.requestId ?? response.headers.get("x-request-id"),
    );
  }
  const blob = await response.blob();
  const name =
    /filename="([^"]+)"/.exec(
      response.headers.get("content-disposition") ?? "",
    )?.[1] ?? options.fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
