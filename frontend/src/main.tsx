import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/animations.css'

// Diagnostic error collection — read by Tauri's health check to display on black-screen failures
declare global {
  interface Window { __syncedDiagErrors?: string[] }
}
window.__syncedDiagErrors = [];

// Global error handler — catches errors that happen before or outside React
// (e.g. WASM load failures, import errors, GPU-related crashes).
window.addEventListener('error', (e) => {
  window.__syncedDiagErrors?.push(e.message || String(e));
  const root = document.getElementById('root');
  if (root && root.children.length === 0) {
    // Build error UI with DOM APIs — never use innerHTML with untrusted data (XSS risk)
    const container = document.createElement('div');
    Object.assign(container.style, { display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', background:'#000', color:'#fff', fontFamily:'monospace', gap:'16px', padding:'24px', textAlign:'center' });
    const h1 = document.createElement('h1');
    Object.assign(h1.style, { fontSize:'2rem', margin:'0' });
    h1.textContent = 'STARTUP ERROR';
    const p = document.createElement('p');
    Object.assign(p.style, { color:'rgba(255,255,255,0.5)', fontSize:'0.875rem', maxWidth:'600px', wordBreak:'break-word' });
    p.textContent = e.message || 'An unexpected error occurred during startup.';
    const btn = document.createElement('button');
    Object.assign(btn.style, { padding:'8px 24px', border:'1px solid #fff', background:'transparent', color:'#fff', cursor:'pointer', fontFamily:'monospace', fontSize:'0.875rem', textTransform:'uppercase', letterSpacing:'0.05em' });
    btn.textContent = '[ RELOAD ]';
    btn.addEventListener('click', () => location.reload());
    container.append(h1, p, btn);
    root.appendChild(container);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  window.__syncedDiagErrors?.push('Promise: ' + msg);
  console.error('Unhandled promise rejection:', e.reason);
});

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
