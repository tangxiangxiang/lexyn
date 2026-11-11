import { dateKey } from '../../shared/domain/learning.ts'

export function weekStart(now: number, timezone: string) {
  const monday = new Date(dateKey(now, timezone) + 'T00:00:00Z')
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const key = monday.toISOString().slice(0, 10)
  const day = 24 * 60 * 60 * 1000
  let low = monday.getTime() - day
  let high = monday.getTime() + day
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (dateKey(middle, timezone) < key) low = middle
    else high = middle
  }
  return high
}

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
