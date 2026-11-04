import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './router'
import { themeVariables } from './styles/theme'
import './styles/main.css'

for (const [name, value] of Object.entries(themeVariables)) {
  document.documentElement.style.setProperty(name, value)
}

const app = createApp(App)
const router = createAppRouter()
app.use(createPinia())
app.use(router)
await router.isReady()
app.mount('#app')
