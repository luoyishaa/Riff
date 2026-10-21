import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'success' | 'error';
interface Toast { id: number; message: string; tone: Tone }
type Notify = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Notify>(() => undefined);

const DURATION: Record<Tone, number> = { info: 3200, success: 2600, error: 5200 };

/** Transient feedback for actions; errors stay a little longer. */
export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback<Notify>((message, tone = 'info') => {
    const id = ++next.current;
    setToasts((current) => [...current.filter((toast) => toast.message !== message), { id, message, tone }].slice(-3));
    window.setTimeout(() => dismiss(id), DURATION[tone]);
  }, [dismiss]);
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <span>{toast.message}</span>
            <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismiss(toast.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
