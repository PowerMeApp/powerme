import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Thiếu #root trong index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
