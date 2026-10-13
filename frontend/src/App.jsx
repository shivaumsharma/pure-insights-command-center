import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import { Layout } from './components/Layout.jsx';
import { LiveProvider } from './live/LiveContext.jsx';
import AiReview from './pages/AiReview.jsx';
import Alerts from './pages/Alerts.jsx';
import Costs from './pages/Costs.jsx';
import DataQuality from './pages/DataQuality.jsx';
import Login from './pages/Login.jsx';
import { Gate, NotFound } from './pages/Misc.jsx';
import Orphans from './pages/Orphans.jsx';
import Overview from './pages/Overview.jsx';
import ReportDetail from './pages/ReportDetail.jsx';
import Reports from './pages/Reports.jsx';

function RequireAuth({ WebSocketImpl }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return (
    <LiveProvider WebSocketImpl={WebSocketImpl}>
      <Layout />
    </LiveProvider>
  );
}

export default function App({ WebSocketImpl }) {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth WebSocketImpl={WebSocketImpl} />}>
        <Route index element={<Overview />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:id" element={<ReportDetail />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="costs" element={<Gate capability="costs"><Costs /></Gate>} />
        <Route path="orphans" element={<Gate capability="orphans"><Orphans /></Gate>} />
        <Route path="ai-review" element={<Gate capability="aiReview"><AiReview /></Gate>} />
        <Route path="data-quality" element={<Gate capability="dataQuality"><DataQuality /></Gate>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
