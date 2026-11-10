import { dateKey } from '../../shared/domain/learning.ts'

export function dayBounds(now: number, timezone: string) {
  const day = dateKey(now, timezone)
  // Search for the first instant of the local calendar day. DST can make days shorter or longer.
  const boundary = (lo: number, hi: number, before: (time: number) => boolean) => {
    while (hi - lo > 1) {
      const middle = Math.floor((lo + hi) / 2)
      if (before(middle)) lo = middle
      else hi = middle
    }
    return hi
  }
  const range = 48 * 60 * 60 * 1000
  return [
    boundary(now - range, now, (time) => dateKey(time, timezone) < day),
    boundary(now, now + range, (time) => dateKey(time, timezone) <= day),
  ] as const
}
