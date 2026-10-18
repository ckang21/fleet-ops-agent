import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The browser talks to one origin; Vite forwards API calls to the agent and the simulator.
const agent = process.env.AGENT_URL ?? 'http://localhost:4000'
const fleet = process.env.FLEET_URL ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: agent, changeOrigin: true },
      '/query': { target: fleet, changeOrigin: true },
    },
  },
})
