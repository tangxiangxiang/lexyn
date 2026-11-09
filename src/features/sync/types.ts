import type { DependencyCode, LibrarySnapshot } from '../../../shared/contracts/sync'
import type { ReviewCard } from '../../../shared/domain/review'

export interface SyncState {
  key: 'state'
  deviceId: string
  ownerId?: string
  origin?: string
  cursor: number
  bootstrapped: boolean
  through?: number
  lastSuccessAt?: number
  leaseId?: string
  leaseUntil?: number
}

export interface SyncIssue {
  opId: string
  entityKey: string
  status: 'conflict' | 'rejected' | 'resolved'
  reason: string
  code?: DependencyCode
  remote?: LibrarySnapshot
  blocking?: LibrarySnapshot
}

export interface SyncShadow {
  key: string
  seq: number
  dirty: 0 | 1
  ackThrough?: number
  record?: LibrarySnapshot | { kind: 'card'; value: ReviewCard }
}
