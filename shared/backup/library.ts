import { libraryFormatVersion, type LibraryExport } from '../contracts/library.ts'
import { fields, integer, isUuid, object, time, validateCardState, validateEntity, validateEvent, validateSpellingPreferences, validateTimezone } from '../contracts/validation.ts'
import { stableJson } from '../contracts/json.ts'
import type { SpellingAttempt } from '../domain/spelling.ts'
import { normalizeSpelling, type LearnProgress } from '../domain/learning.ts'
import { allStudyDays, minutesPerDay } from '../domain/study-plan.ts'
import { listSizes, type DeckList, type DeckListMember, type Entry } from '../domain/library.ts'
import { REVIEW_DIRECTION, reviewCardId, wordReviewCardId, type ReviewCard, type ReviewCardState, type ReviewEvent } from '../domain/review.ts'
import { recordWordCompletion, wordKey, type Word, type WordCardLink, type WordHistoryLink, type WordProgress } from '../domain/word.ts'
import { createReviewScheduler, rebuildCardFromEvents, schedulerConfigSnapshot } from '../srs/scheduler.ts'

export const MAX_LIBRARY_BACKUP_BYTES = 64 * 1024 * 1024

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function rows<T>(value: unknown, label: string, identify: (record: Record<string, unknown>) => string): T[] {
  requireValid(Array.isArray(value), `Invalid ${label} list.`)
  const ids = new Set<string>()
  for (const row of value) {
    const id = identify(object(row))
    requireValid(!ids.has(id), `Duplicate ID in ${label}.`)
    ids.add(id)
  }
  return value as T[]
}

function uniqueSlots<T>(events: T[], key: (event: T) => string, message: string) {
  requireValid(new Set(events.map(key)).size === events.length, message)
}

export function sameReviewState(snapshot: ReviewCardState, replay: ReviewCardState) {
  // Different JS engines may round the FSRS floating point fields differently.
  const { stability, stabilityFast, difficulty, scheduledDays, ...exact } = snapshot
  const { stability: s, stabilityFast: sf, difficulty: d, scheduledDays: days, ...expected } = replay
  return stableJson(exact) === stableJson(expected) && [[stability, s], [stabilityFast, sf], [difficulty, d], [scheduledDays, days]]
    .every(([left, right]) => Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(right)))
}

export interface LibraryRestorePlan {
  backup: LibraryExport
  reviewChanges: { event: ReviewEvent; card: ReviewCard }[]
}

export async function prepareLibraryRestore(text: string): Promise<LibraryRestorePlan> {
  requireValid(new TextEncoder().encode(text).byteLength <= MAX_LIBRARY_BACKUP_BYTES, 'The backup exceeds 64 MiB.')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('The file is not valid JSON.') }
  const root = object(raw)
  const version = root.formatVersion
  requireValid(root.format === 'lexyn-library' && (version === 4 || version === 5 || version === 6 || version === 7 || version === libraryFormatVersion),
    'Only Lexyn library backup formats v4, v5, v6, v7 and v8 are supported.')
  const globalWords = version === libraryFormatVersion
  fields(root, 'format formatVersion exportedAt metadata decks entries practiceEvents learnProgress settings reviewCards reviewEvents schedulerConfig'
    + (version >= 6 ? ' lists listMembers' : '') + (version >= 7 ? ' spellingAttempts' : '')
    + (globalWords ? ' words wordProgress wordCards practiceWords spellingWords' : ''))
  const meta = object(root.metadata)
  fields(meta, 'scope')
  requireValid(meta.scope === 'library' || meta.scope === 'deck', 'Unsupported backup metadata.')
  requireValid(typeof root.exportedAt === 'string' && time(Date.parse(root.exportedAt)), 'Invalid export time.')
  const settings = object(root.settings)
  fields(settings, 'dailyNewWords timezone studyWeekdays reviewResetMinutes' + (version >= 7 ? ' spelling' : ''))
  if (version >= 7) validateSpellingPreferences(settings.spelling)
  requireValid(integer(settings.dailyNewWords, 1, 100), 'Invalid daily new words limit.')
  requireValid(settings.studyWeekdays === undefined || integer(settings.studyWeekdays, 1, allStudyDays), 'Invalid weekly study plan.')
  requireValid(settings.reviewResetMinutes === undefined || integer(settings.reviewResetMinutes, 0, minutesPerDay - 1), 'Invalid review reset time.')
  validateTimezone(settings.timezone)
  const config = schedulerConfigSnapshot(await createReviewScheduler())
  requireValid(stableJson(root.schedulerConfig) === stableJson(config), 'Unsupported scheduler configuration.')

  const decks = rows<LibraryExport['decks'][number]>(root.decks, 'decks', (deck) => {
    requireValid(version >= 6 || deck.listSize === undefined, 'List size requires backup format v6.')
    return validateEntity(deck, 'deck')
  })
  const deckIds = new Set(decks.map(({ id }) => id))
  requireValid(meta.scope !== 'deck' || decks.length === 1, 'A deck backup must contain exactly one deck.')
  const activeTerms = new Set<string>()
  const entries = rows<Entry>(root.entries, 'entries', (entry) => {
    requireValid(version !== 4 || entry.dictionaryMeaning === undefined, 'Full dictionary meanings require backup format v5.')
    const id = validateEntity(entry, 'entry', globalWords)
    requireValid(deckIds.has(entry.deckId as string), 'An entry refers to a missing deck.')
    if (entry.deletedAt === undefined) {
      const key = `${entry.deckId}:${entry.normalizedTerm}`
      requireValid(!activeTerms.has(key), 'Duplicate active spelling in a deck.')
      activeTerms.add(key)
    }
    return id
  })
  const entryDecks = new Map(entries.map(({ id, deckId }) => [id, deckId]))
  const listDecks = new Map<string, string>()
  if (version >= 6) {
    const lists = rows<DeckList>(root.lists, 'deck lists', (list) => {
      fields(list, 'id deckId name order')
      requireValid(isUuid(list.id) && isUuid(list.deckId) && deckIds.has(list.deckId)
        && typeof list.name === 'string' && list.name === list.name.trim() && list.name.length > 0 && list.name.length <= 100
        && integer(list.order, 1), 'Invalid deck list.')
      return list.id
    })
    uniqueSlots(lists, ({ deckId, order }) => `${deckId}:${order}`, 'Duplicate list order in a deck.')
    const listCounts = new Map<string, number>()
    for (const { deckId } of lists) listCounts.set(deckId, (listCounts.get(deckId) ?? 0) + 1)
    requireValid(lists.every(({ deckId, order }) => order <= listCounts.get(deckId)!), 'List order is incomplete.')
    for (const { id, deckId } of lists) listDecks.set(id, deckId)
    const members = rows<DeckListMember>(root.listMembers, 'list members', (member) => {
      fields(member, 'entryId listId position')
      requireValid(isUuid(member.entryId) && isUuid(member.listId) && listDecks.has(member.listId)
        && entryDecks.get(member.entryId) === listDecks.get(member.listId)
        && integer(member.position, 1, listSizes.max), 'Invalid list membership.')
      return member.entryId
    })
    uniqueSlots(members, ({ listId, position }) => `${listId}:${position}`, 'Duplicate position in a list.')
    requireValid(members.length === entries.length && new Set(members.map(({ listId }) => listId)).size === lists.length,
      'List membership is incomplete.')
  }
  function checkEntry(record: Record<string, unknown>) {
    requireValid(isUuid(record.entryId) && isUuid(record.deckId) && entryDecks.get(record.entryId) === record.deckId,
      'Study history refers to a missing entry or the wrong deck.')
  }
  const practiceEvents = rows<LibraryExport['practiceEvents'][number]>(root.practiceEvents, 'practice events', (event) => {
    checkEntry(event)
    requireValid(version >= 7 || (event.source === undefined && event.round === undefined),
      'Spelling rounds require backup format v7.')
    requireValid(event.listId === undefined || globalWords && listDecks.get(event.listId as string) === event.deckId,
      'A practice event refers to the wrong list.')
    return validateEvent(event, 'practice', config, globalWords)
  })
  uniqueSlots(practiceEvents, (event) => `${event.sessionId}:${event.entryId}:${event.round ?? 0}`,
    'A Learn session has duplicate results for one entry.')
  const progressFromEvents = new Map<string, LearnProgress>()
  for (const event of practiceEvents) {
    if (event.outcome !== 'completed' || event.source === 'free') continue
    const { entryId, completedAt } = event
    const previous = progressFromEvents.get(entryId)
    progressFromEvents.set(entryId, { entryId, firstCompletedAt: Math.min(previous?.firstCompletedAt ?? completedAt, completedAt),
      lastPracticedAt: Math.max(previous?.lastPracticedAt ?? completedAt, completedAt), completedCount: (previous?.completedCount ?? 0) + 1 })
  }
  const learnProgress = rows<LearnProgress>(root.learnProgress, 'learn progress', (progress) => {
    requireValid(isUuid(progress.entryId) && progressFromEvents.has(progress.entryId)
      && stableJson(progress) === stableJson(progressFromEvents.get(progress.entryId)), 'Learn progress does not match the practice history.')
    return progress.entryId
  })
  requireValid(learnProgress.length === progressFromEvents.size, 'Learn progress is incomplete.')
  const attempts = version >= 7 ? rows<SpellingAttempt>(root.spellingAttempts, 'spelling attempts', (record) => {
      fields(record, 'id entryId sessionId round attempt spelling termChangedAt time source mode keyboard assisted correct errors' + (globalWords ? ' listId' : ''))
      const { id, entryId, sessionId, spelling, correct, errors } = record
      requireValid(isUuid(id) && isUuid(entryId) && entryDecks.has(entryId) && isUuid(sessionId)
        && integer(record.round, 0, 3) && integer(record.attempt, 1)
        && typeof spelling === 'string' && spelling.length >= 1 && spelling.length <= 1000 && spelling === normalizeSpelling(spelling)
        && (record.termChangedAt === undefined || time(record.termChangedAt)) && time(record.time)
        && (record.source === 'learn' || record.source === 'free') && (record.mode === 'copy' || record.mode === 'dictation')
        && (record.keyboard === 'full' || record.keyboard === 'simplified')
        && typeof record.assisted === 'boolean' && typeof correct === 'boolean'
        && Array.isArray(errors) && errors.length <= 1240 && correct === (errors.length === 0), 'Invalid spelling attempt.')
      requireValid(record.listId === undefined || globalWords && listDecks.get(record.listId as string) === entryDecks.get(entryId),
        'A spelling attempt refers to the wrong list.')
      const letters = [...spelling]
      for (const error of errors) {
        const value = object(error)
        fields(value, 'position expected type')
        requireValid((value.type === 'incorrect' || value.type === 'missing' || value.type === 'extra')
          && integer(value.position, 0, value.type === 'extra' ? letters.length : letters.length - 1)
          && value.expected === (letters[value.position] ?? ''), 'Invalid spelling error.')
      }
      return id
    }) : []
  uniqueSlots(attempts, ({ sessionId, entryId, round, attempt }) => `${sessionId}:${entryId}:${round}:${attempt}`,
    'Duplicate spelling attempt.')
  const reviewEvents = rows<ReviewEvent>(root.reviewEvents, 'review events', (value) => {
    checkEntry(value)
    return validateEvent(value, 'review', config, globalWords)
  })
  uniqueSlots(reviewEvents, (event) => `${event.sessionId}:${event.cardId}`,
    'A Review session has duplicate ratings for one card.')
  const reviewCards = rows<ReviewCard>(root.reviewCards, 'review cards', (card) => {
    checkEntry(card)
    fields(card, 'id entryId deckId direction revision lastEventId createdAt updatedAt schedulerConfigVersion schedulerState dueAt scheduleStatus')
    requireValid((globalWords || card.id === reviewCardId(card.entryId as string)) && typeof card.id === 'string' && card.direction === REVIEW_DIRECTION
      && integer(card.revision, 1) && isUuid(card.lastEventId) && time(card.createdAt) && time(card.updatedAt)
      && card.schedulerConfigVersion === config.version && time(card.dueAt), 'Invalid review card metadata.')
    validateCardState(card.schedulerState, card.id as string)
    const state = card.schedulerState as ReviewCardState
    requireValid(card.dueAt === state.dueAt && card.scheduleStatus === state.scheduleStatus, 'Invalid review card projection.')
    return card.id as string
  })
  if (globalWords) {
    const words = rows<Word>(root.words, 'global words', (word) => {
      fields(word, 'id language normalizedTerm term variant createdAt updatedAt revision')
      requireValid(isUuid(word.id) && typeof word.term === 'string' && word.term.length > 0 && word.term.length <= 240
        && word.term === word.term.trim().normalize('NFC') && !/[\r\n\t]/.test(word.term)
        && typeof word.language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(word.language)
        && typeof word.variant === 'string' && time(word.createdAt) && time(word.updatedAt)
        && word.updatedAt >= word.createdAt && integer(word.revision, 1), 'Invalid global Word.')
      const key = wordKey(word.term, word.language)
      requireValid(word.normalizedTerm === key.normalizedTerm
        && (word.variant === key.variant || word.variant.startsWith('legacy:') && isUuid(word.variant.slice(7))),
      'Invalid global Word key.')
      return word.id
    })
    uniqueSlots(words, (word) => JSON.stringify([word.language, word.normalizedTerm, word.variant]), 'Duplicate global Word key.')
    const byWord = new Map(words.map((word) => [word.id, word]))
    for (const entry of entries) {
      const word = byWord.get(entry.wordId!)
      const key = word && wordKey(entry.term, word.language)
      requireValid(word && key?.normalizedTerm === word.normalizedTerm && key.variant === word.variant,
        'An entry does not match its global Word.')
    }

    function historyLinks(value: unknown, events: { id: string }[]) {
      const ids = new Set(events.map(({ id }) => id))
      const links = rows<WordHistoryLink>(value, 'Word history links', (link) => {
        fields(link, 'id wordId')
        requireValid(isUuid(link.id) && ids.has(link.id) && isUuid(link.wordId) && byWord.has(link.wordId),
          'Invalid global Word history link.')
        return link.id
      })
      requireValid(links.length === ids.size, 'Global Word history links are incomplete.')
      return new Map(links.map(({ id, wordId }) => [id, wordId]))
    }
    const practiceWords = historyLinks(root.practiceWords, practiceEvents)
    historyLinks(root.spellingWords, attempts)
    const expected = new Map<string, WordProgress>()
    for (const event of practiceEvents) {
      if (event.outcome !== 'completed' || event.source === 'free') continue
      const wordId = practiceWords.get(event.id)!
      expected.set(wordId, recordWordCompletion(expected.get(wordId), wordId, event.completedAt))
    }
    const progress = rows<WordProgress>(root.wordProgress, 'global learning progress', (value) => {
      requireValid(isUuid(value.wordId) && expected.has(value.wordId)
        && stableJson(value) === stableJson(expected.get(value.wordId)), 'Global progress does not match the practice history.')
      return value.wordId
    })
    requireValid(progress.length === expected.size, 'Global learning progress is incomplete.')
    const cards = new Map(reviewCards.map((card) => [card.id, card]))
    const links = rows<WordCardLink>(root.wordCards, 'Word review links', (link) => {
      fields(link, 'wordId cardId direction active')
      requireValid(typeof link.cardId === 'string' && isUuid(link.wordId) && byWord.has(link.wordId)
        && link.direction === REVIEW_DIRECTION && typeof link.active === 'boolean', 'Invalid Word review link.')
      const card = cards.get(link.cardId)
      requireValid(card && (link.cardId === reviewCardId(card.entryId) || link.cardId === wordReviewCardId(link.wordId))
        && (!link.active || !byWord.get(link.wordId)!.variant.startsWith('legacy:')), 'Invalid Word review card.')
      return link.cardId
    })
    requireValid(links.length === cards.size, 'Word review links are incomplete.')
    uniqueSlots(links.filter(({ active }) => active), ({ wordId, direction }) => `${wordId}:${direction}`,
      'Multiple active review cards for one Word.')
  }
  const histories = new Map<string, ReviewEvent[]>()
  for (const event of reviewEvents) {
    const history = histories.get(event.cardId)
    if (history) history.push(event)
    else histories.set(event.cardId, [event])
  }
  requireValid(histories.size === reviewCards.length, 'Review cards and event histories are incomplete.')
  const reviewChanges: LibraryRestorePlan['reviewChanges'] = []
  for (const snapshot of reviewCards) {
    const history = histories.get(snapshot.id)
    requireValid(history?.length === snapshot.revision, 'A review history is missing events.')
    let revision = 0
    let createdAt = 0
    let previous: ReviewCardState | undefined
    await rebuildCardFromEvents(history, (event, schedulerState) => {
      const reviewedAt = event.reviewedAt
      requireValid(sameReviewState(event.resultingCardState, schedulerState)
        && (previous ? event.previousCardState && sameReviewState(event.previousCardState, previous) : !event.previousCardState),
      'A review event does not match its FSRS history.')
      previous = schedulerState
      if (++revision === 1) {
        requireValid(snapshot.entryId === event.entryId && snapshot.deckId === event.deckId, 'A review card refers to the wrong origin.')
        createdAt = reviewedAt
      }
      const { dueAt, scheduleStatus } = schedulerState
      if (revision === history.length) {
        requireValid(snapshot.lastEventId === event.id && snapshot.createdAt === createdAt
          && sameReviewState(snapshot.schedulerState, schedulerState), 'A review card does not match its FSRS history. Export a new backup from the server.')
      }
      reviewChanges.push({ event, card: { ...snapshot, createdAt, revision, lastEventId: event.id, schedulerState, dueAt,
        scheduleStatus, updatedAt: revision === history.length ? snapshot.updatedAt : reviewedAt } })
    })
  }
  const backup = root as unknown as LibraryExport
  return { backup, reviewChanges }
}
