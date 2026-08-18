import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, loadTheme } from './state/theme'

// Applied before the first render (not inside a component effect) so the
// persisted theme is already on the root element for the very first paint
// -- an effect would paint one frame in the wrong theme first.
applyTheme(loadTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
