import { AuthScreen } from './components/AuthScreen.js';
import { useSession } from './hooks/useSession.js';
import { ToastProvider } from './hooks/useToast.js';
import { Workbench } from './Workbench.js';

export function App(): React.ReactElement {
  const session = useSession();
  const { state } = session;
  return (
    <ToastProvider>
      {state.status === 'loading' ? <div className="app-loading" role="status">Riff</div> : null}
      {state.status === 'signed-out' ? <AuthScreen session={session} /> : null}
      {/* A new account starts from a clean workbench rather than another person's state. */}
      {state.status === 'signed-in' ? <Workbench key={state.principal.id} session={session} principal={state.principal} /> : null}
    </ToastProvider>
  );
}
