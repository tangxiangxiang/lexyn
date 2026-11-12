export const allStudyDays = 0b1111111
export const minutesPerDay = 24 * 60
const dayMilliseconds = minutesPerDay * 60_000

export function isStudyDay(day: string, weekdays: number) {
  const weekday = (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7
  return (weekdays & (1 << weekday)) !== 0
}

export function forecastStudyPlan(remaining: number, dailyWords: number, weekdays: number, today: string, completedToday: number) {
  if (!remaining) return { days: 0, completion: today }
  const todayTime = Date.parse(today + 'T00:00:00Z')
  const availableToday = isStudyDay(today, weekdays) ? Math.max(0, dailyWords - completedToday) : 0
  if (remaining <= availableToday) return { days: 1, completion: today }

  const daysAfterToday = Math.ceil((remaining - availableToday) / dailyWords)
  const studyOffsets = Array.from({ length: 7 }, (_, index) => index + 1).filter((offset) => {
    const day = new Date(todayTime + offset * dayMilliseconds).toISOString().slice(0, 10)
    return isStudyDay(day, weekdays)
  })
  const last = daysAfterToday - 1
  const weeks = Math.floor(last / studyOffsets.length)
  const offset = weeks * 7 + studyOffsets[last % studyOffsets.length]
  return {
    days: daysAfterToday + Number(availableToday > 0),
    completion: new Date(todayTime + offset * dayMilliseconds).toISOString().slice(0, 10),
  }
}
