import { Routes, Route } from 'react-router-dom';
import { WebSocketProvider } from './contexts/WebSocketContext';
import Layout from './components/Layout/AppLayout';
import HomePage from './pages/HomePage';
import ProjectPage from './pages/ProjectPage';

function App() {
  return (
    <WebSocketProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/project/:projectId" element={<ProjectPage />} />
        </Routes>
      </Layout>
    </WebSocketProvider>
  );
}

export default App;
