import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import type { LearnSession } from '../../../shared/domain/learning'

export type LearnSessionRecord = LearnSession & { revision: number }
export const learn = {
  getDailyState: (id: string | undefined, signal?: AbortSignal) => study('learn/daily', [id], { signal }),
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
