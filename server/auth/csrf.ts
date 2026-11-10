// Nuvyn's exact-origin and Fetch Metadata checks, with Lexyn's client header
// and required Origin on mutations.
export function isSameOriginRequest(headers: Headers, method: string, allowedOrigins: ReadonlySet<string>) {
  const origin = headers.get('origin')
  const site = headers.get('sec-fetch-site')?.toLowerCase()
  return headers.get('x-lexyn-client') === '1'
    && (!site || site === 'same-origin' || site === 'none')
    && (origin === null ? method === 'GET' : allowedOrigins.has(origin))
}

export function hasJsonContentType(headers: Headers) {
  const contentType = headers.get('content-type')
  return contentType !== null && /^application\/json\s*(?:;|$)/i.test(contentType)
}
