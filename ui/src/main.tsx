import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CopilotKitProvider } from '@copilotkit/react-core/v2'
import '@copilotkit/react-core/v2/styles.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      <App />
    </CopilotKitProvider>
  </StrictMode>,
)
