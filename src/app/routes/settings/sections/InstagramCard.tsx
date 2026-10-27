import { Instagram, Loader2, RefreshCw } from 'lucide-react';
import type { InstagramStatus } from '@/lib/zernio-connect-flow';

// Card do Instagram (via Zernio) dentro de Canais. Mostra o estado real: as
// contas de Instagram que a sincronização da Zernio guardou para a
// organização (zernio_instagram_account_ids), que é o que o zernio-webhook usa
// para achar a organização da DM. Antes havia aqui um campo de token que
// gravava instagram_access_token, que nenhum código lia; essa credencial fica
// no banco, sem uso.
export function InstagramCard({
  status,
  canSync,
  syncing,
  onSync,
}: {
  status: InstagramStatus | null;
  canSync: boolean;
  syncing: boolean;
  onSync: () => void;
}) {
  const connected = status?.connected ?? false;

  return (
    <div className="rounded-xl border border-[rgba(212,165,116,0.15)] bg-white/[0.02] p-5 backdrop-blur-[40px]">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[rgba(225,48,108,0.25)] bg-[rgba(225,48,108,0.08)]">
          <Instagram className="h-5 w-5 text-[#E1306C]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#94A3B8]">
              Instagram
            </span>
            {status === null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-text-secondary)]" />
            ) : (
              <span
                className={
                  connected
                    ? 'rounded-full bg-[rgba(16,185,129,0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#10B981]'
                    : 'rounded-full bg-[rgba(148,163,184,0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--color-text-secondary)]'
                }
              >
                {connected ? 'Conectado' : 'Não conectado'}
              </span>
            )}
          </div>

          {status !== null && connected ? (
            <>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                As DMs destas contas caem no inbox e a IA já começa a conversar.
              </p>
              <ul className="mt-3 space-y-1.5">
                {status.accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(212,165,116,0.15)] bg-white/[0.02] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                  >
                    <span className="truncate">
                      {account.username ? `@${account.username.replace(/^@/, '')}` : 'Conta de Instagram'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">
                      {account.id}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : status !== null ? (
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              Conecte o Instagram no painel da Zernio e clique em Sincronizar números.
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={onSync}
              disabled={!canSync || syncing}
              className="inline-flex items-center gap-2 rounded-lg border border-[rgba(212,165,116,0.25)] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition hover:border-[var(--accent-primary)] disabled:opacity-50"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Sincronizar números
            </button>
            {!canSync ? (
              <span className="text-xs text-[var(--color-text-secondary)]">
                Salve a Zernio API Key acima para sincronizar.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
