import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { MarketProvider } from './lib/hooks';
import { ClientJob } from './routes/client/ClientJob';
import { MyListings } from './routes/client/MyListings';
import { NewListing } from './routes/client/NewListing';
import { FreelancerJob } from './routes/freelancer/FreelancerJob';
import { Marketplace } from './routes/freelancer/Marketplace';
import { MyJobs } from './routes/freelancer/MyJobs';
import { HowItWorks } from './routes/HowItWorks';
import { RoleChoice } from './routes/RoleChoice';
import { Service } from './routes/Service';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MarketProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RoleChoice />} />
          <Route path="/client" element={<MyListings />} />
          <Route path="/client/new" element={<NewListing />} />
          <Route path="/client/jobs/:id" element={<ClientJob />} />
          <Route path="/freelancer" element={<Marketplace />} />
          <Route path="/freelancer/mine" element={<MyJobs />} />
          <Route path="/freelancer/jobs/:id" element={<FreelancerJob />} />
          <Route path="/how" element={<HowItWorks />} />
          <Route path="/service" element={<Service />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </MarketProvider>
  </StrictMode>,
);
