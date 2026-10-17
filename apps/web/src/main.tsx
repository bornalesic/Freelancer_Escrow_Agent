import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AgentView } from './routes/AgentView';
import { ClientView } from './routes/ClientView';
import { FreelancerView } from './routes/FreelancerView';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/client" element={<ClientView />} />
        <Route path="/freelancer" element={<FreelancerView />} />
        <Route path="/agent" element={<AgentView />} />
        <Route path="*" element={<Navigate to="/agent" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
