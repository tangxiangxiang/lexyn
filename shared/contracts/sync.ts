import type { Deck, Entry } from '../domain/library.ts'
import type { PracticeEvent, LearnProgress } from '../domain/learning.ts'
import type { ReviewCard, ReviewEvent } from '../domain/review.ts'
import type { OutboxOperation } from './library.ts'

export const SYNC_VERSION = 1
export const PUSH_LIMIT = 32
export const PULL_LIMIT = 100

export interface OwnerSession {
  ownerId: string
  expiresAt: number
}

export type LibrarySnapshot =
  | { kind: 'deck'; value: Deck; serverRevision: number }
  | { kind: 'entry'; value: Entry; serverRevision: number }

export type SyncRecord =
  | LibrarySnapshot
  | { kind: 'practice'; event: PracticeEvent; progress?: LearnProgress }
  | { kind: 'review'; event: ReviewEvent; card: ReviewCard }

export interface PushRequest {
  schemaVersion: typeof SYNC_VERSION
  deviceId: string
  cursor: number
  operations: OutboxOperation[]
}

export type DependencyCode = 'MISSING_DECK' | 'MISSING_ENTRY'

export type PushResult =
  | { opId: string; status: 'accepted' | 'already_applied'; serverSeq: number | null }
  | { opId: string; status: 'conflict'; code?: DependencyCode; reason: string; remote?: LibrarySnapshot; blocking?: LibrarySnapshot }
  | { opId: string; status: 'rejected'; code?: DependencyCode; reason: string }

export interface PushResponse {
  schemaVersion: typeof SYNC_VERSION
  results: PushResult[]
}

export interface SyncPage {
  schemaVersion: typeof SYNC_VERSION
  ownerId: string
  serverSeq: number
  nextCursor: number
  hasMore: boolean
  changes: { seq: number; record: SyncRecord }[]
}

/** Compare JSON values regardless of property order or omitted optional fields. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
}
