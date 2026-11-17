import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { recoverExportsOnOpen } from './api/local-service'
import './styles/global.css'

// 再次打开应用：把因页面关闭而遗留的「执行中」明细文件恢复为可检查、可续做的中断态
recoverExportsOnOpen()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
