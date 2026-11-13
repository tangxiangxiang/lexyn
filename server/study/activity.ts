import { dateKey } from '../../shared/domain/learning.ts'
import type { StudyStore } from './store.ts'

export function studyActivity(store: StudyStore, now: number) {
  const timezone = store.settings().timezone
  const today = dateKey(now, timezone)
  const dates = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short' })
  const counts = store.db.prepare(`
    SELECT CAST(json_extract(body, '$.firstCompletedAt') AS INTEGER) AS at, 1 AS learned, 0 AS reviews
    FROM word_progress WHERE json_extract(body, '$.firstCompletedAt')<=?
    UNION ALL SELECT reviewed_at AS at, 0, count(*) FROM review_events WHERE reviewed_at<=? GROUP BY reviewed_at
  `).all(now, now) as { at: number; learned: number; reviews: number }[]
  const daily: Record<string, { learned: number; reviews: number }> = {}
  for (const { at, learned, reviews } of counts) {
    const day = dates.format(at)
    const stats = daily[day] ??= { learned: 0, reviews: 0 }
    stats.learned += learned
    stats.reviews += reviews
  }
  const cursor = new Date(today + 'T00:00:00Z')
  if (!daily[today]) cursor.setUTCDate(cursor.getUTCDate() - 1)
  let streak = 0
  while (daily[cursor.toISOString().slice(0, 10)]) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return { today, days: Object.keys(daily).sort(), daily, streak }
}
