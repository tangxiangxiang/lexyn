export const speechVoices = {
  English_CalmWoman: 'Calm Woman',
  English_PatientMan: 'Patient Man',
} as const

export type SpeechVoice = keyof typeof speechVoices
export const defaultSpeechVoice: SpeechVoice = 'English_CalmWoman'
export const playbackRates = [0.8, 1, 1.2] as const
export type PlaybackRate = typeof playbackRates[number]

export interface SpeechSettings {
  voiceId: SpeechVoice
  playbackRate: PlaybackRate
  credentialStatus: 'missing' | 'configured' | 'unavailable'
}

export type SpeechSettingsUpdate = Pick<SpeechSettings, 'voiceId' | 'playbackRate'> & {
  apiKey?: string
  clearKey?: boolean
}

export interface PreparedSpeech {
  audioId: string
  playbackRate: PlaybackRate
}
