import { randomUUID } from 'node:crypto'
import type { LearnMode, LearnSession } from '../../shared/domain/learning.ts'
import type { ReviewSession } from '../../shared/domain/review.ts'
import type { createLearnService } from './learn.ts'
import type { createReviewService } from './review.ts'
import { StudyError, type StudyStore, type Versioned } from './store.ts'

export function createAllStudy(store: StudyStore, learn: ReturnType<typeof createLearnService>, review: ReturnType<typeof createReviewService>) {
  function sessions(deckId: string, flowId: string) {
    return {
      learning: store.one<Versioned<LearnSession>>(
        "SELECT body FROM learn_sessions WHERE deck_id=? AND json_extract(body, '$.studyFlowId')=? ORDER BY rowid DESC LIMIT 1",
        deckId, flowId),
      reviewing: store.one<Versioned<ReviewSession>>(
        "SELECT body FROM review_sessions WHERE deck_id=? AND json_extract(body, '$.studyFlowId')=? ORDER BY rowid DESC LIMIT 1",
        deckId, flowId),
    }
  }

  return function advance(deckId: string, mode: LearnMode, now: number, requestedFlow?: string) {
    const deck = store.deck(deckId)
    if (!deck || deck.archivedAt !== undefined) throw new StudyError('Choose an active deck to start learning.')
    const openLearn = store.openLearn()
    const openReview = store.openReview()
    // Recover the handoff if another device finished Review and left before Learn started.
    const handoff = store.one<ReviewSession>(`SELECT r.body FROM review_sessions r
      WHERE r.deck_id=? AND r.status='completed' AND json_extract(r.body, '$.studyFlowId') IS NOT NULL
      AND coalesce(json_extract(r.body, '$.studyFlowFinished'), 0)=0
      AND NOT EXISTS (SELECT 1 FROM learn_sessions l
        WHERE json_extract(l.body, '$.studyFlowId')=json_extract(r.body, '$.studyFlowId'))
      AND NOT EXISTS (SELECT 1 FROM review_sessions newer
        WHERE newer.rowid > r.rowid AND json_extract(newer.body, '$.studyFlowId')=json_extract(r.body, '$.studyFlowId'))
      ORDER BY r.rowid DESC LIMIT 1`, deckId)
    const existing = requestedFlow
      ?? (openLearn?.deckId === deckId ? openLearn.studyFlowId : undefined)
      ?? (openReview?.deckId === deckId ? openReview.studyFlowId : undefined)
      ?? handoff?.studyFlowId
    const flowId = existing ?? randomUUID()
    const { learning, reviewing } = sessions(deckId, flowId)
    if (requestedFlow && !learning && !reviewing) throw new StudyError('This study flow is unavailable.', 404)

    function complete(ended = false) {
      const reviewed = store.db.prepare(`SELECT count(*) FROM review_events e JOIN review_sessions r
        ON r.id=json_extract(e.body, '$.sessionId') WHERE r.deck_id=? AND json_extract(r.body, '$.studyFlowId')=?`)
        .pluck().get(deckId, flowId) as number
      const { due, firstRecall } = review.overview(deckId, now)
      const pending = learn.getDailyState(deckId, now).pendingNew + due + firstRecall
      return { kind: 'complete' as const, flowId, reviewed, learned: learning?.firstCompletedEntryIds.length ?? 0, pending, ended }
    }

    if (learning?.status === 'abandoned' || reviewing?.status === 'abandoned') return complete(true)
    if (learning?.status === 'completed' || reviewing?.studyFlowFinished) return complete()
    if (learning) {
      const session = learning.status === 'paused' ? learn.continueSession(learning.sessionId, learning.revision, now) : learning
      return { kind: 'learn' as const, flowId, session: { ...session, currentLastSubmitted: undefined, currentCorrectSpelling: undefined } }
    }

    if (openReview && (openReview.deckId !== deckId || openReview.listId || (openReview.studyFlowId && openReview.studyFlowId !== flowId))) {
      return { kind: 'review-conflict' as const, flowId: existing, session: review.openSession()! }
    }
    let latestReview = reviewing
    let next = review.start(deckId, now, true, flowId)
    if (next.kind === 'round' && next.round.session.status === 'completed') {
      latestReview = store.review(next.round.session.sessionId)
      next = review.start(deckId, now, true, flowId)
    }
    if (next.kind === 'round') return { kind: 'review' as const, flowId, session: next.round.session }
    if (next.kind === 'conflict') return { kind: 'review-conflict' as const, flowId: existing, session: next.session }

    const daily = learn.getDailyState(deckId, now)
    if (openLearn && (daily.pendingNew || daily.hasNewWordSession)) {
      if (!daily.hasNewWordSession || (openLearn.studyFlowId && openLearn.studyFlowId !== flowId)) {
        return { kind: 'learn-conflict' as const, flowId: latestReview ? flowId : existing,
          session: { deckId: openLearn.deckId, listId: openLearn.listId, sessionId: openLearn.sessionId, revision: openLearn.revision } }
      }
      const linked = store.saveLearn({ ...openLearn, studyFlowId: flowId })
      const session = linked.status === 'paused' ? learn.continueSession(linked.sessionId, linked.revision, now) : linked
      return { kind: 'learn' as const, flowId, session: { ...session, currentLastSubmitted: undefined, currentCorrectSpelling: undefined } }
    }
    if (daily.candidates.length) {
      const session = learn.startSession(deckId, mode, daily.candidates.map(({ id }) => id), true, now, undefined, flowId)
      return { kind: 'learn' as const, flowId, session }
    }
    if (!latestReview) return { kind: 'empty' as const }
    store.saveReview({ ...latestReview, studyFlowFinished: true })
    return complete()
  }
}
