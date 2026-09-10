import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SetupPage } from './pages/setup';
import { AdminSignInPage } from './pages/admin-sign-in';
import { DashboardPage } from './pages/dashboard';
import { EndUserSignUpPage } from './pages/end-user-sign-up';
import { VerifyEmailResultPage } from './pages/verify-email-result';
import { ForgotPasswordPage } from './pages/forgot-password';
import { ResetPasswordPage } from './pages/reset-password';
import { AcceptInvitationPage } from './pages/accept-invitation';

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/sign-in" element={<AdminSignInPage />} />
        <Route path="/administrators/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="/end-users/sign-up" element={<EndUserSignUpPage />} />
        <Route path="/end-users/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/end-users/reset-password" element={<ResetPasswordPage />} />
        <Route path="/end-users/verify-email/result" element={<VerifyEmailResultPage />} />
        <Route path="/*" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
