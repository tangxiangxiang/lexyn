import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AuthEnv, createAuthApi } from '../auth/routes.ts'
import type { Ecdict } from './ecdict.ts'

export function dictionaryRoutes(dictionary: Ecdict, auth: ReturnType<typeof createAuthApi>) {
  const app = new Hono<AuthEnv>()
  app.use('*', auth.guardOrigin, auth.requireOwner, bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Dictionary request too large.' } }, 413),
  }))
  app.onError((error, c) => {
    if (error instanceof Error && error.message === 'Invalid dictionary query.') {
      return c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Invalid dictionary query.' } }, 400)
    }
    return c.json({ error: { code: 'DICTIONARY_STORAGE', message: 'Dictionary lookup is temporarily unavailable.' } }, 503)
  })
  app.get('/status', (c) => c.json(dictionary.status()))
  app.post('/lookup', async (c) => {
    if (c.req.header('Content-Type')?.split(';')[0] !== 'application/json') {
      return c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Expected JSON.' } }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'term')
      || !('term' in body) || typeof body.term !== 'string') {
      return c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Invalid dictionary query.' } }, 400)
    }
    return c.json(dictionary.lookup(body.term))
  })
  app.post('/lookup-batch', async (c) => {
    if (c.req.header('Content-Type')?.split(';')[0] !== 'application/json') {
      return c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Expected JSON.' } }, 400)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'terms')
      || !('terms' in body) || !Array.isArray(body.terms) || body.terms.length > 50
      || body.terms.some((term) => typeof term !== 'string')) {
      return c.json({ error: { code: 'DICTIONARY_INPUT', message: 'Invalid dictionary batch.' } }, 400)
    }
    return c.json(body.terms.map((term: string) => dictionary.lookup(term)))
  })
  return app
}
