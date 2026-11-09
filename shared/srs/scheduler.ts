import { DefaultScheduler } from 'ts-fsrs'

export const FSRS_MODEL = 'FSRS-7'
export const DEFAULT_DESIRED_RETENTION = 0.9

export function createReviewScheduler() {
  return DefaultScheduler({
    version: FSRS_MODEL,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
  })
}
