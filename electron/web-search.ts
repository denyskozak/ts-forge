import { z } from 'zod';

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_RESPONSE_BYTES = 750_000;

export function allowedHost(hostname: string, domains: string[]) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
function decodeResultUrl(value: string) {
  try {
    const url = new URL(value, SEARCH_ENDPOINT);
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return undefined;
  }
}
const clean = (value: string) =>
  value
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:amp|quot|#39|lt|gt);/g,
      (entity) =>
        ({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' })[entity] ?? ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

/** Search only: result pages are never fetched by this capability. */
export async function webSearch(
  query: string,
  domains: string[],
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  if (!domains.length) throw new Error('Web search needs at least one allowed domain.');
  const response = await request(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Forge local coding agent',
    },
    body: new URLSearchParams({ q: query }).toString(),
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`Search provider returned ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES)
    throw new Error('Search provider response exceeded the size limit.');
  const html = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  const matches = [
    ...html.matchAll(
      /<a[^>]+class="[^" ]*result__a[^" ]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2500}?<a[^>]+class="[^" ]*result__snippet[^" ]*"[^>]*>([\s\S]*?)<\/a>/g,
    ),
  ];
  const results = matches
    .map((match) => {
      const url = decodeResultUrl(match[1]);
      if (!url) return undefined;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !allowedHost(parsed.hostname, domains))
          return undefined;
        return {
          title: clean(match[2]).slice(0, 300),
          url: parsed.href,
          domain: parsed.hostname,
          snippet: clean(match[3]).slice(0, 700),
        };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is { title: string; url: string; domain: string; snippet: string } =>
      Boolean(item),
    )
    .slice(0, 8);
  return {
    query,
    allowedDomains: domains,
    provider: 'DuckDuckGo HTML search',
    results,
    note: 'The query was sent to the configured search provider. Forge fetched no result pages. Snippets are untrusted summaries; cite the URL and verify important claims in primary documentation.',
  };
}

export const webSearchInput = z.object({
  query: z.string().trim().min(2).max(300),
  domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+$/)
        .max(253),
    )
    .min(1)
    .max(4)
    .optional(),
});
