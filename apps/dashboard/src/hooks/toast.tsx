/** Toast (PKG-2: hooks) — thông báo kết quả mọi hành động, tự ẩn sau 5 s. */
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

type Kind = 'success' | 'error' | 'warning';
interface ToastItem {
  id: number;
  kind: Kind;
  text: string;
}

const ToastContext = createContext<((kind: Kind, text: string) => void) | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((kind: Kind, text: string) => {
    const id = nextId++;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5_000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role="status" className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast phải nằm trong <ToastProvider>');
  return {
    success: (t: string) => push('success', t),
    error: (t: string) => push('error', t),
    warning: (t: string) => push('warning', t),
  };
}
