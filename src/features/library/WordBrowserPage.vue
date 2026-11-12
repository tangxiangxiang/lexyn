<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import { dateKey } from '../../../shared/domain/learning'
import type { Entry } from '../../../shared/domain/library'
import { hasFinalMeaning } from '../../../shared/domain/dictionary'
import { study } from '../../api/client'
import type { StudyEndpoints } from '../../../shared/contracts/study'
import AppIcon from '../../components/AppIcon.vue'
import { t, translateError, useI18n } from '../../i18n/useI18n'
import DictionaryMeaningView from '../dictionary/DictionaryMeaningView.vue'
import PhoneticsView from '../dictionary/PhoneticsView.vue'
import PronunciationButton from '../speech/PronunciationButton.vue'
import { pronunciationAccent } from '../../ui/pronunciationAccent'
import LibraryEditor from './LibraryEditor.vue'
import WordPlayer from './WordPlayer.vue'
import { readListeningBookmark, type ListeningBookmark, type Playlist } from './listeningBookmark'
import { downloadLibrary, useLibraryAction } from './library-ui'
import { useLibraryQuery } from './useLibraryQuery'
import { settingsRoute } from '../settings/navigation'

const props = defineProps<{ deckId: string }>()
const route = useRoute()
const { languageTag } = useI18n()
const page = ref(1)
const size = 60
const editing = ref(false)
const choosingPlaylist = ref(false)
const playlist = ref<Playlist>()
const bookmark = ref<ListeningBookmark>()
const { busy: restoringPlaylist, error: playlistError, run: restorePlaylist } = useLibraryAction()
const grouped = ref(true)
const showMeanings = ref(false)
const showSpellings = ref(true)
type WordArgs = StudyEndpoints['library/words']['args']
const filters = [
  { value: 'all', label: 'All words' },
  { value: 'learned', label: 'Learned' },
  { value: 'unlearned', label: 'Not yet learned' },
] as const
const filter = ref<WordArgs[3]>('all')
const sort = ref<WordArgs[4]>('added')
const groupByDate = computed(() => grouped.value && sort.value !== 'alphabetical')
const wordId = computed(() => typeof route.query.word === 'string' ? route.query.word : undefined)
const { busy, error: exportError, run } = useLibraryAction()
const { data: words, error, reload } = useLibraryQuery(
  () => [props.deckId, (page.value - 1) * size, size, filter.value, sort.value, undefined] as WordArgs,
  (args, signal) => study('library/words', args, { signal }),
  (args) => args.join('/'),
)
const { data: detail, error: detailError, reload: reloadDetail } = useLibraryQuery(
  () => [props.deckId, wordId.value] as const,
  ([deckId, id], signal) => id ? study('library/word-detail', [deckId, id], { signal }) : Promise.resolve(null),
  (args) => args.join('/'),
)
watch([() => props.deckId, filter, sort], () => {
  page.value = 1
  closeListening()
}, { flush: 'sync' })
watch(wordId, () => {
  editing.value = false
  closeListening()
})
watch(words, (data) => {
  if (data) page.value = Math.min(page.value, Math.max(1, Math.ceil(data.count / size)))
})
const groups = computed(() => {
  const grouped = new Map<string, Entry[]>()
  if (!words.value) return grouped
  for (const { entry, groupedAt } of words.value.entries) {
    const key = groupByDate.value ? groupedAt === null ? 'unlearned' : dateKey(groupedAt, words.value.timezone) : ''
    const group = grouped.get(key)
    if (group) group.push(entry)
    else grouped.set(key, [entry])
  }
  return grouped
})
const dayFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, { dateStyle: 'long', timeZone: 'UTC' }))
const memoryFormat = computed(() => new Intl.DateTimeFormat(languageTag.value, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: words.value?.timezone,
}))
const browser = computed(() => ({ name: 'library-words', params: { deckId: props.deckId } }))
const studyLists = computed(() => ({ name: 'library-deck', params: { deckId: props.deckId } }))

function changePage(next: number) {
  page.value = next
  window.scrollTo(0, 0)
}

function closeListening() {
  choosingPlaylist.value = false
  playlist.value = undefined
}

function openPlaylistPicker() {
  bookmark.value = readListeningBookmark(props.deckId)
  playlistError.value = ''
  choosingPlaylist.value = true
  window.scrollTo(0, 0)
}

function openPlaylist(playlistFilter: WordArgs[3], count: number) {
  if (!count) return
  playlist.value = { filter: playlistFilter, sort: sort.value, count, position: 0 }
}

function resumePlaylist() {
  const saved = bookmark.value
  if (!saved) return
  const deckId = props.deckId
  void restorePlaylist(async () => {
    const result = await study('library/words', [deckId, 0, 1, saved.filter, saved.sort, saved.entryId])
    if (props.deckId !== deckId || !choosingPlaylist.value || playlist.value) return
    if (!result?.count) throw new Error('The saved playlist is now empty.')
    playlist.value = { filter: saved.filter, sort: saved.sort, count: result.count, position: result.anchorPosition ?? 0 }
  })
}
</script>

<template>
  <section class="page spell-subpage spell-word-browser"
    :class="{ 'spell-word-list': !wordId && !choosingPlaylist && !playlist }">
    <WordPlayer v-if="playlist" :deck-id="deckId" :playlist="playlist" @close="closeListening" />
    <template v-else-if="choosingPlaylist && words">
      <header class="spell-subpage-toolbar">
        <button type="button" class="icon-control" :aria-label="t('Open word list')" @click="closeListening"><AppIcon name="close" /></button>
      </header>
      <h1>{{ t('Word player') }}</h1>
      <div class="spell-playlist-options">
        <button type="button" :disabled="!words.counts.today || restoringPlaylist" @click="openPlaylist('today', words.counts.today)">
          {{ t('Studied today') }} <span>{{ words.counts.today }}</span>
        </button>
        <button type="button" :disabled="!words.counts.week || restoringPlaylist" @click="openPlaylist('week', words.counts.week)">
          {{ t('Studied this week') }} <span>{{ words.counts.week }}</span>
        </button>
        <button type="button" :disabled="!words.counts.all || restoringPlaylist" @click="openPlaylist('all', words.counts.all)">
          {{ t('My words') }} <span>{{ words.counts.all }}</span>
        </button>
        <button type="button" :disabled="!words.count || restoringPlaylist" @click="openPlaylist(filter, words.count)">
          {{ t('Current list') }} <span>{{ words.count }}</span>
        </button>
      </div>
      <NAlert v-if="playlistError" type="error" role="alert">{{ translateError(playlistError) }}</NAlert>
      <button v-if="bookmark" type="button" class="spell-chip spell-resume-playlist" :disabled="restoringPlaylist" @click="resumePlaylist">
        {{ t('Resume playback') }}
      </button>
    </template>
    <template v-else>
    <header class="spell-subpage-toolbar">
      <div class="spell-word-list-nav">
        <RouterLink v-if="!wordId" class="spell-word-account" :to="settingsRoute(route.fullPath, 'account')"
          :aria-label="t('Owner account')" :title="t('Owner account')">
          <AppIcon name="account" />
        </RouterLink>
        <RouterLink class="icon-control" :to="wordId ? browser : '/study'" :aria-label="t(wordId ? 'Open word list' : 'Lexyn home')">
          <AppIcon :name="wordId ? 'chevronLeft' : 'close'" />
        </RouterLink>
      </div>
      <div v-if="!wordId" class="spell-word-tools">
        <span class="spell-word-language">{{ t('English words') }}</span>
        <details class="spell-word-options" @keydown.esc.stop="($event.currentTarget as HTMLDetailsElement).open = false">
          <summary class="icon-control" :aria-label="t('Word list options')"><AppIcon name="filter" /></summary>
          <div class="spell-word-options-panel">
            <RouterLink class="spell-word-options-link" :to="studyLists">{{ t('Study lists') }} <AppIcon name="chevronRight" /></RouterLink>
            <button v-for="option in filters" :key="option.value" type="button" :aria-pressed="filter === option.value"
              @click="filter = option.value">
              {{ t(option.label) }} <span>{{ words?.counts[option.value] }}</span>
            </button>
            <label><input v-model="showSpellings" type="checkbox" />{{ t('Show spellings') }}</label>
            <label><input v-model="showMeanings" type="checkbox" :disabled="!showSpellings" />{{ t('Show meanings') }}</label>
            <label>{{ t('Sort words') }}
              <select v-model="sort">
                <option value="added">{{ t('Recently added') }}</option>
                <option value="learned">{{ t('Recently learned') }}</option>
                <option value="alphabetical">{{ t('Alphabetical') }}</option>
              </select>
            </label>
            <label><input v-model="grouped" type="checkbox" :disabled="sort === 'alphabetical'" />{{ t('Group by date') }}</label>
          </div>
        </details>
      </div>
    </header>
    <template v-if="wordId">
      <NAlert v-if="detailError" type="error">
        {{ t('Lexyn could not read these words.') }} <NButton text @click="reloadDetail">{{ t('Retry') }}</NButton>
      </NAlert>
      <p v-else-if="detail === undefined" aria-live="polite">{{ t('Loading words…') }}</p>
      <p v-else-if="!detail">{{ t('Word unavailable') }}</p>
      <template v-else>
        <h1 class="spell-detail-term">{{ detail.entry.term }}</h1>
        <div class="spell-pronunciation">
          <PronunciationButton :entry-id="detail.entry.id" :revision="detail.entry.revision" label="Play pronunciation"
            :phonetics="detail.entry.phonetics" :legacy-phonetic="detail.entry.phonetic" :accent="pronunciationAccent" />
        </div>
        <section class="spell-detail-section" aria-labelledby="word-meaning-heading">
          <div class="spell-detail-heading">
            <h2 id="word-meaning-heading">{{ t('Meaning') }}</h2>
            <button v-if="!detail.archived" class="spell-chip" type="button" @click="editing = true">{{ t('Edit word') }}</button>
          </div>
          <DictionaryMeaningView v-if="hasFinalMeaning(detail.entry.dictionaryMeaning)" :meaning="detail.entry.dictionaryMeaning!" />
          <p v-else class="library-preserve">{{ detail.entry.meaning || t('Meaning not added yet') }}</p>
        </section>
        <details v-if="detail.entry.example" class="spell-detail-section" open>
          <summary>{{ t('Example') }}</summary>
          <p class="spell-detail-panel library-preserve">{{ detail.entry.example }}</p>
        </details>
        <details class="spell-detail-section" open>
          <summary>{{ t('Memory') }}</summary>
          <dl class="spell-detail-panel spell-memory" v-if="detail.nextDueAt !== undefined || detail.reviews.length || detail.learnedAt !== undefined">
            <div v-if="detail.nextDueAt !== undefined"><dt>{{ t('Next review') }}</dt><dd>{{ memoryFormat.format(detail.nextDueAt) }}</dd></div>
            <div v-for="(time, index) in detail.reviews" :key="index"><dt>{{ t('Reviewed') }}</dt><dd>{{ memoryFormat.format(time) }}</dd></div>
            <div v-if="detail.learnedAt !== undefined"><dt>{{ t('First learned') }}</dt><dd>{{ memoryFormat.format(detail.learnedAt) }}</dd></div>
          </dl>
          <p v-else class="spell-detail-panel">{{ t('No learning or review history yet.') }}</p>
        </details>
        <LibraryEditor v-if="editing" :editor="{ type: 'entry', deckId, entry: detail.entry }"
          @close="editing = false" @saved="editing = false; reloadDetail()" />
      </template>
    </template>
    <template v-else>
      <h1 class="spell-word-list-title">{{ t('My words') }} <span v-if="words">({{ words.count }})</span></h1>
      <NAlert v-if="error" type="error">
        {{ t('Lexyn could not read these words.') }} <NButton text @click="reload">{{ t('Retry') }}</NButton>
      </NAlert>
      <p v-else-if="words === undefined" aria-live="polite">{{ t('Loading words…') }}</p>
      <p v-else-if="!words || !groups.size">{{ t(!words ? 'Deck not found' : filter === 'all' ? 'This deck has no words yet' : 'No words match this filter.') }}</p>
      <template v-else>
        <component :is="day ? 'details' : 'div'" v-for="[day, entries] in groups" :key="day" class="spell-date-group" :open="day ? true : undefined">
          <summary v-if="day">
            <span v-if="day === 'unlearned'">{{ t('Not yet learned') }}</span>
            <time v-else :datetime="day">{{ dayFormat.format(new Date(day + 'T00:00:00Z')) }}</time>
          </summary>
          <ul>
            <li v-for="entry in entries" :key="entry.id">
              <RouterLink class="spell-chip spell-word-chip" :to="{ ...browser, query: { word: entry.id } }"
                :aria-label="showSpellings ? entry.term : undefined">
                <div class="spell-word-label">
                  <template v-if="showSpellings">
                    <strong lang="en">{{ entry.term }}</strong>
                    <PhoneticsView :phonetics="entry.phonetics" :legacy="entry.phonetic" />
                  </template>
                  <template v-if="showMeanings || !showSpellings">
                    <DictionaryMeaningView v-if="hasFinalMeaning(entry.dictionaryMeaning)" :meaning="entry.dictionaryMeaning!" compact />
                    <span v-else class="spell-word-gloss">{{ entry.meaning || t('Meaning not added yet') }}</span>
                  </template>
                </div>
                <AppIcon class="spell-word-arrow" name="chevronRight" />
              </RouterLink>
            </li>
          </ul>
        </component>
        <div v-if="words.count > size" class="spell-page-actions">
          <button class="spell-chip" :disabled="page === 1" @click="changePage(page - 1)">{{ t('Previous') }}</button>
          <button class="spell-chip" :disabled="page * size >= words.count" @click="changePage(page + 1)">{{ t('Next') }}</button>
        </div>
      </template>
      <NAlert v-if="exportError" type="error" role="alert">{{ translateError(exportError) }}</NAlert>
      <footer v-if="words" class="spell-word-dock" :aria-label="t('Study actions')">
        <button type="button" class="icon-control" :disabled="!words.counts.all" :aria-label="t('Listen to words')" @click="openPlaylistPicker"><AppIcon name="headphones" /></button>
        <RouterLink class="icon-control" :to="{ path: '/review', query: { deckId } }" :aria-label="t('Review')"><AppIcon name="flame" /></RouterLink>
        <button class="icon-control" :disabled="busy" :aria-label="t('Export deck')" @click="run(() => downloadLibrary(deckId))"><AppIcon name="share" /></button>
      </footer>
    </template>
    </template>
  </section>
</template>
