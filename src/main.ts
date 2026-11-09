import { createApp } from 'vue'
import App from './app/App.vue'
import { startSyncCoordinator } from './features/sync/coordinator'
import { router } from './router'
import './styles/base.css'
import './styles/library.css'
import './styles/learn.css'

createApp(App).use(router).mount('#app')

startSyncCoordinator()
