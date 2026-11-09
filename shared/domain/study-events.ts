export interface PracticeEvent {
  kind: 'practice'
  activity: 'spelling' | 'dictation' | 'listen'
  occurredAt: number
}

export interface ReviewEvent {
  kind: 'review'
  rating: 'again' | 'hard' | 'good' | 'easy'
  occurredAt: number
}
