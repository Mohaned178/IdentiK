import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SetupPage } from './pages/setup';
import { AdminSignInPage } from './pages/admin-sign-in';
import { DashboardPage } from './pages/dashboard';
import { EndUserSignUpPage } from './pages/end-user-sign-up';
import { VerifyEmailResultPage } from './pages/verify-email-result';

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/sign-in" element={<AdminSignInPage />} />
        <Route path="/end-users/sign-up" element={<EndUserSignUpPage />} />
        <Route path="/end-users/verify-email/result" element={<VerifyEmailResultPage />} />
        <Route path="/*" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
