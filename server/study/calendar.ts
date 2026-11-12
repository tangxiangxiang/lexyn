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

export function reviewDayBounds(now: number, timezone: string, resetMinutes: number) {
  const [start, end] = dayBounds(now, timezone)
  if (!resetMinutes) return [start, end] as const

  const minuteMs = 60_000
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  function cutoff(dayStart: number, dayEnd: number) {
    const localMidnight = Date.parse(dateKey(dayStart, timezone) + 'T00:00:00Z')
    const localMinutes = (time: number) => {
      const [hours, minutes] = localTime.format(time).split(':').map(Number)
      return hours * 60 + minutes
    }
    const lastMinute = dayEnd - minuteMs
    const offsetAt = (time: number) => localMidnight + localMinutes(time) * minuteMs - time
    const candidates = [dayStart, lastMinute].map((time) => localMidnight + resetMinutes * minuteMs - offsetAt(time))
      .filter((time) => time >= dayStart && time < dayEnd && localMinutes(time) === resetMinutes)
    if (candidates.length) return Math.min(...candidates)

    // If the requested clock time is skipped, use the first valid instant after the jump.
    let low = dayStart
    let high = dayEnd
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (localMinutes(middle) < resetMinutes) low = middle
      else high = middle
    }
    return localMinutes(dayStart) >= resetMinutes ? dayStart : high
  }

  const todayReset = cutoff(start, end)
  return now < todayReset
    ? [cutoff(dayBounds(start - 1, timezone)[0], start), todayReset] as const
    : [todayReset, cutoff(end, dayBounds(end, timezone)[1])] as const
}
