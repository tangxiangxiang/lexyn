import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'

export function reviewSessionRoute(session: { deckId?: string; sessionId: string }, flow?: string) {
  return { path: '/review', query: { deckId: session.deckId, session: session.sessionId, flow } }
}

export const review = {
  overview: (deck: string | undefined, signal?: AbortSignal) => study('review/overview', [deck], { signal }),
  session: (deck: string | undefined, id: string | undefined, signal?: AbortSignal) =>
    study('review/scoped', [deck, id], { signal }),
  open: (signal?: AbortSignal) => study('review/open', [], { signal }),
  start: (deck: string | undefined, resume?: boolean) => study('review/start', [deck, resume], { write: true }),
  repair: (...args: StudyEndpoints['review/repair']['args']) => study('review/repair', args, { write: true }),
  setStatus: (...args: StudyEndpoints['review/status']['args']) => study('review/status', args, { write: true }),
  reveal: (...args: StudyEndpoints['review/reveal']['args']) => study('review/reveal', args, { write: true }),
  score: (...args: StudyEndpoints['review/score']['args']) => study('review/score', args, { write: true }),
}
