const day = 86_400_000

// Require repeated recent failures across practice sessions. A successful recent
// session reduces the error ratio; older errors remain in the word's history.
export const difficultWords = `
  SELECT word_id, sum(failed) AS failures, count(*) AS sessions
  FROM (
    SELECT a.word_id, session_id, max(json_extract(a.body, '$.correct')=0) AS failed
    FROM spelling_attempts a JOIN entries member ON member.word_id=a.word_id
      AND member.deck_id=@deckId AND member.active_term IS NOT NULL
    WHERE CAST(json_extract(a.body, '$.time') AS INTEGER) BETWEEN @recent AND @now
      AND json_extract(a.body, '$.assisted')=0
    GROUP BY a.word_id, session_id
  )
  GROUP BY word_id HAVING sum(failed)>=2 AND sum(failed)*2>=count(*)
`

export function spellingWindow(now: number) {
  return now - 30 * day
}
