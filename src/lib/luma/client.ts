const LUMA_BASE_URL = "https://public-api.luma.com";

type QueryValue = string | number | boolean | null | undefined;

interface LumaFetchOptions {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

export class LumaApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "LumaApiError";
    this.status = status;
    this.body = body;
  }
}

function getApiKey(): string {
  const apiKey = process.env.LUMA_API_KEY;

  if (!apiKey) {
    throw new LumaApiError(
      "LUMA_API_KEY is not configured. Add it to .env.local.",
      500,
      null,
    );
  }

  return apiKey;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path, LUMA_BASE_URL);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "Luma authentication failed. Check your LUMA_API_KEY and event permissions.";
  }

  if (status === 429) {
    return "Luma rate limit reached. Retry in about 1 minute.";
  }

  if (status >= 500) {
    return "Luma is temporarily unavailable. Try again in a moment.";
  }

  return "Luma request failed.";
}

async function parseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function lumaFetchJson<T>(
  path: string,
  options: LumaFetchOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const requestUrl = buildUrl(path, options.query);

  const response = await fetch(requestUrl, {
    method,
    headers: {
      "content-type": "application/json",
      "x-luma-api-key": getApiKey(),
    },
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    signal: options.signal,
    cache: "no-store",
  });

  const body = await parseBody(response);

  if (!response.ok) {
    const message = statusMessage(response.status);
    throw new LumaApiError(message, response.status, body);
  }

  return body as T;
}
