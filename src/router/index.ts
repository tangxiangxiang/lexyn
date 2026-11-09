import { createRouter, createWebHistory } from 'vue-router'
import EmptyPage from '../components/EmptyPage.vue'
import LibraryPage from '../features/library/LibraryPage.vue'
import DeckPage from '../features/library/DeckPage.vue'
import LearnPage from '../features/learn/LearnPage.vue'
import ReviewPage from '../features/review/ReviewPage.vue'
import ProgressPage from '../features/progress/ProgressPage.vue'
import SettingsPage from '../features/settings/SettingsPage.vue'
import type { IconName } from '../ui/icons'

export const navigation = [
  { path: '/library', title: 'Library', icon: 'library', component: LibraryPage },
  { path: '/learn', title: 'Learn', icon: 'learn', component: LearnPage },
  { path: '/review', title: 'Review', icon: 'review', component: ReviewPage },
  { path: '/progress', title: 'Progress', icon: 'progress', component: ProgressPage },
  { path: '/settings', title: 'Settings', icon: 'settings', component: SettingsPage },
] satisfies { path: string; title: string; icon: IconName; component: object }[]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    ...navigation.map(({ path, title, component }) => ({ path, component, meta: { title } })),
    { path: '/library/:deckId', name: 'library-deck', component: DeckPage, props: true, meta: { title: 'Library' } },
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

router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'Library'} · Lexyn`
})
