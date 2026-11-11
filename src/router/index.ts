import { watchEffect } from 'vue'
import { t } from '../i18n/useI18n'
import { createRouter, createWebHistory } from 'vue-router'
import EmptyPage from '../components/EmptyPage.vue'
import DeckPage from '../features/library/DeckPage.vue'
import SettingsPage from '../features/settings/SettingsPage.vue'
import LibraryPage from '../features/library/LibraryPage.vue'
import LearnPage from '../features/learn/LearnPage.vue'
import ReviewPage from '../features/review/ReviewPage.vue'
import ProgressPage from '../features/progress/ProgressPage.vue'
import ActivityPage from '../features/progress/ActivityPage.vue'
import WordBrowserPage from '../features/library/WordBrowserPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/study' },
    { path: '/study', component: LibraryPage, props: { resumeCurrentBook: true }, meta: { title: 'Current book' } },
    { path: '/library', component: LibraryPage, meta: { title: 'Library' } },
    { path: '/learn', component: LearnPage, meta: { title: 'Learn' } },
    { path: '/learn/read', component: LearnPage, meta: { title: 'Learn the word' } },
    { path: '/learn/spell', component: LearnPage, meta: { title: 'Spelling practice' } },
    { path: '/review', component: ReviewPage, meta: { title: 'Review' } },
    { path: '/progress', component: ProgressPage, meta: { title: 'Progress' } },
    { path: '/activity', component: ActivityPage, meta: { title: 'Study activity' } },
    { path: '/settings', component: SettingsPage, meta: { title: 'Settings' } },
    { path: '/library/:deckId', name: 'library-deck', component: DeckPage, props: true, meta: { title: 'Library' } },
    { path: '/library/:deckId/words', name: 'library-words', component: WordBrowserPage, props: true, meta: { title: 'My words' } },
    {
      path: '/:pathMatch(.*)*',
      component: EmptyPage,
      meta: { title: 'Page not found' },
      props: {
        title: 'Page not found',
        description: 'This address does not point to a Lexyn page.',
        emptyTitle: 'Find your way back',
        emptyDescription: 'Return to your library to keep exploring.',
        icon: 'missing',
        recovery: true,
      },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

watchEffect(() => {
  document.title = `${t(String(router.currentRoute.value.meta.title ?? 'Library'))} · Lexyn`
})
