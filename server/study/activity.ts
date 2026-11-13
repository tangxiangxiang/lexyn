import { dateKey } from '../../shared/domain/learning.ts'
import type { StudyStore } from './store.ts'

export function studyActivity(store: StudyStore, now: number) {
  const timezone = store.settings().timezone
  const today = dateKey(now, timezone)
  const dates = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short' })
  const timestamps = store.db.prepare(`
    SELECT CAST(json_extract(body, '$.firstCompletedAt') AS INTEGER) AS at
    FROM word_progress WHERE json_extract(body, '$.firstCompletedAt') IS NOT NULL
    UNION SELECT reviewed_at AS at FROM review_events
  `).pluck().all() as number[]
  const days = new Set(timestamps.filter((time) => time <= now).map((time) => dates.format(time)))
  const cursor = new Date(today + 'T00:00:00Z')
  if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1)
  let streak = 0
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return { today, days: [...days].sort(), streak }
}
