import { createApp } from 'vue'
import App from './app/App.vue'
import { router } from './router'
import './styles/base.css'
import './styles/library.css'

createApp(App).use(router).mount('#app')
