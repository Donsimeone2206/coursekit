/**
 * Calls to live class providers: a short timeout, a bounded response size, no redirects (a redirect could carry a
 * signed URL or a bearer token to another host) and errors that say what to check without echoing secrets, URLs with
 * checksums or tokens.
 */
import { LIVE_PROVIDER_LABELS, type LiveProviderId } from '../../../shared/live.js';

export const PROVIDER_TIMEOUT_MS = 10_000;
export const MAX_PROVIDER_RESPONSE = 2 * 1024 * 1024;

export type ProviderErrorKind = 'unreachable' | 'config' | 'rejected' | 'not_found' | 'rate_limited';

/** A provider call failed. `message` is safe to show to staff and to log. */
export class LiveProviderError extends Error {
  constructor(
    readonly provider: LiveProviderId,
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface ProviderRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the server';
  }
}

async function readLimited(res: Response, maxBytes: number, provider: LiveProviderId): Promise<string> {
  if (!res.body) return '';
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new LiveProviderError(provider, `${LIVE_PROVIDER_LABELS[provider]} sent a reply that is too large.`, 'unreachable');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new LiveProviderError(provider, `${LIVE_PROVIDER_LABELS[provider]} sent a reply that is too large.`, 'unreachable');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** fetch() with the limits above. Uses the global fetch at call time (tests replace it with mock servers). */
export async function providerFetch(provider: LiveProviderId, url: string, init: ProviderRequest = {}): Promise<ProviderResponse> {
  const label = LIVE_PROVIDER_LABELS[provider];
  const timeoutMs = init.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LiveProviderError(provider, `${label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`, 'unreachable');
    }
    throw new LiveProviderError(provider, `Couldn't reach ${label} at ${hostOf(url)}.`, 'unreachable');
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new LiveProviderError(
      provider,
      `${label} at ${hostOf(url)} answered with a redirect. Check the server address in Administration → Live classes.`,
      'config',
      res.status,
    );
  }
  let text: string;
  try {
    text = await readLimited(res, init.maxBytes ?? MAX_PROVIDER_RESPONSE, provider);
  } catch (err) {
    if (err instanceof LiveProviderError) throw err;
    throw new LiveProviderError(provider, `${label} stopped answering part-way through.`, 'unreachable');
  }
  return { status: res.status, headers: res.headers, text };
}

/**
 * Logs a problem of the background work. Provider errors carry safe messages by construction, and every provider
 * call goes through providerFetch, so other errors come from Coursekit itself (they never include a provider URL).
 */
export function logProviderProblem(context: string, err: unknown): void {
  const message =
    err instanceof LiveProviderError ? err.message : err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : 'Unknown error';
  console.error(`[coursekit] Live classes: ${context}: ${message}`);
}
