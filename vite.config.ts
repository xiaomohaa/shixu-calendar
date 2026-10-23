import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: './', plugins: [react()], server: { host: '127.0.0.1', port: 5173, strictPort: true }, build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'calendar', test: /node_modules[\\/]@fullcalendar/ }, { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }] } } } } });
