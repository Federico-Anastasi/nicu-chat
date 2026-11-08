import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { segnalaNuovaVersione } from './lib/chat'
import { registraServiceWorker } from './lib/offline'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

registraServiceWorker(segnalaNuovaVersione)
