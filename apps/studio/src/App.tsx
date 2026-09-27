/**
 * Studio shell (EXPD-024).
 *
 * Nothing inside the shell is drawn until the server has confirmed the
 * signed-in person is on the Explorer team. Every other state has its own
 * screen, and none of them shows a route.
 */

import { useAuthState } from './auth/AuthProvider.tsx';
import { AccessDeniedPage } from './pages/AccessDeniedPage.tsx';
import { ChooseOrganisationPage } from './pages/ChooseOrganisationPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { usePath } from './router.tsx';
import { ROUTES } from './routes.tsx';
import { Shell } from './shell/Shell.tsx';
import { Loading } from './shell/ui.tsx';

export function App() {
  const state = useAuthState();
  const path = usePath();

  switch (state.status) {
    case 'loading':
      return <Loading />;
    case 'signed-out':
      return <SignInPage error={state.error} />;
    case 'choosing-organisation':
      return (
        <ChooseOrganisationPage
          displayName={state.displayName}
          organisations={state.organisations}
          error={state.error}
        />
      );
    case 'denied':
      return <AccessDeniedPage displayName={state.displayName} />;
    case 'signed-in': {
      const Page = ROUTES.find((route) => route.path === path)?.page ?? NotFoundPage;
      return (
        <Shell>
          <Page />
        </Shell>
      );
    }
  }
}
