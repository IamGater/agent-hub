import './nonce.js';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .catch((err) => console.warn('service worker not registered:', err.message));
}

createRoot(document.getElementById('root')).render(<App />);
