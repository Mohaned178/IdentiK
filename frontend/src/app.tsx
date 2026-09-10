import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SetupPage } from './pages/setup';
import { AdminSignInPage } from './pages/admin-sign-in';
import { DashboardPage } from './pages/dashboard';

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/sign-in" element={<AdminSignInPage />} />
        <Route path="/*" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
