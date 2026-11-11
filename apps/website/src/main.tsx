import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/vazirmatn';
import { LocaleProvider } from './i18n.js';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
