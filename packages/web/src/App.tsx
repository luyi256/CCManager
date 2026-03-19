import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { WebSocketProvider } from './contexts/WebSocketContext';
import Layout from './components/Layout/AppLayout';
import HomePage from './pages/HomePage';
import ProjectPage from './pages/ProjectPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import { isAuthenticated, setApiToken } from './services/auth';

function checkUrlToken(): boolean {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token && /^[0-9a-f]{64}$/i.test(token)) {
    setApiToken(token);
    params.delete('token');
    const clean = params.toString();
    const url = window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash;
    window.history.replaceState({}, '', url);
    return true;
  }
  return false;
}

checkUrlToken();

function App() {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  return (
    <WebSocketProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/project/:projectId" element={<ProjectPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
    </WebSocketProvider>
  );
}

export default App;
