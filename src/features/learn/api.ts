import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import type { LearnSession } from '../../../shared/domain/learning'

export type LearnSessionRecord = LearnSession & { revision: number }

export function learnSessionRoute(session: LearnSession, stage?: 'read' | 'spell') {
  const reading = session.mode === 'copy' && (stage === 'read' || (!stage && session.currentAttempts === 0))
  return {
    path: reading ? '/learn/read' : '/learn/spell',
    query: { deckId: session.deckId, listId: session.listId, session: session.sessionId, free: session.source === 'free' ? '1' : undefined },
  }
}

export const learn = {
  getDailyState: (args: StudyEndpoints['learn/daily']['args'], signal?: AbortSignal) => study('learn/daily', args, { signal }),
  freeState: (_key: boolean, signal?: AbortSignal) => study('learn/free', [], { signal }),
  startFree: (...args: StudyEndpoints['learn/start-free']['args']) => study('learn/start-free', args, { write: true }),
  setHint: (...args: StudyEndpoints['learn/hint']['args']) => study('learn/hint', args, { write: true }),
  getSession: (id: string, signal?: AbortSignal) => study('learn/session', [id], { signal }),
  result: (id: string, signal?: AbortSignal) => study('learn/history', [id, 0, 100], { signal }),
  startSession: (...args: StudyEndpoints['learn/start']['args']) => study('learn/start', args, { write: true }),
  setMode: (...args: StudyEndpoints['learn/mode']['args']) => study('learn/mode', args, { write: true }),
  setAssisted: (...args: StudyEndpoints['learn/assist']['args']) => study('learn/assist', args, { write: true }),
  setStatus: (...args: StudyEndpoints['learn/status']['args']) => study('learn/status', args, { write: true }),
  continueSession: (...args: StudyEndpoints['learn/resume']['args']) => study('learn/resume', args, { write: true }),
  advanceInvalid: (...args: StudyEndpoints['learn/repair']['args']) => study('learn/repair', args, { write: true }),
  recordAttempt: (...args: StudyEndpoints['learn/attempt']['args']) => study('learn/attempt', args, { write: true }),
  finishCurrent: (...args: StudyEndpoints['learn/finish']['args']) => study('learn/finish', args, { write: true }),
}
