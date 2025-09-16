import { StrictMode } from 'react';
import { Buffer } from 'buffer';

// Polyfill Buffer globally for browser compatibility
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.Buffer = Buffer;
}
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
