import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { createAuthClient } from './auth/api-client.ts';
import { AuthSession } from './auth/session.ts';
import { API_BASE_URL } from './config.ts';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root element #root was not found in index.html');
}

const session = new AuthSession({
  client: createAuthClient(API_BASE_URL),
  storage: window.sessionStorage,
  baseUrl: API_BASE_URL,
});

createRoot(container).render(
  <StrictMode>
    <AuthProvider session={session}>
      <App />
    </AuthProvider>
  </StrictMode>,
);
