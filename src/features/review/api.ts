import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'

export const review = {
  overview: (deck: string | undefined, signal?: AbortSignal) => study('review/overview', [deck], { signal }),
  round: (deck: string | undefined, signal?: AbortSignal) => study('review/session', [deck], { signal }),
  start: (...args: StudyEndpoints['review/start']['args']) => study('review/start', args, { write: true }),
  repair: (...args: StudyEndpoints['review/repair']['args']) => study('review/repair', args, { write: true }),
  setStatus: (...args: StudyEndpoints['review/status']['args']) => study('review/status', args, { write: true }),
  reveal: (...args: StudyEndpoints['review/reveal']['args']) => study('review/reveal', args, { write: true }),
  score: (...args: StudyEndpoints['review/score']['args']) => study('review/score', args, { write: true }),
}
