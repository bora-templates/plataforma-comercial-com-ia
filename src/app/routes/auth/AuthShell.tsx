import type { ReactNode } from 'react';
import { BRAND } from '@/config/brand';

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Shared chrome for /auth/login and /auth/signup — keeps both pages visually
// consistent with /setup without repeating the logo + card + layout code.
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-3">
            <img
              src={BRAND.mark}
              alt={BRAND.product}
              className="h-12 w-12 rounded-xl shadow-[0_0_30px_rgba(212,165,116,0.35)]"
            />
            <div>
              {BRAND.owner ? <div className="text-label">{BRAND.owner}</div> : null}
              <div className="text-xl font-bold text-display">{BRAND.product}</div>
            </div>
          </div>
        </div>

        <div className="glass-card p-8 space-y-6">
          <header className="space-y-1">
            <h1 className="text-2xl font-bold text-display">{title}</h1>
            {subtitle && (
              <p className="text-sm text-[var(--color-text-secondary)]">{subtitle}</p>
            )}
          </header>

          {children}
        </div>

        {footer && (
          <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
            {footer}
          </p>
        )}
      </div>
    </div>
  );
}
