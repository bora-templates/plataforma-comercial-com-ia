import { useCallback, useEffect, useState } from 'react';
import { Instagram, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/app/providers/AuthProvider';

// Card de conexão do Instagram (via Zernio). Vive dentro de Canais: era a única
// tela que gravava instagram_access_token e ficou inalcançável quando
// Credenciais saiu do router. O token entra cifrado no banco (CRYPTO_KEY) via
// /api/credentials — nunca em .env, nunca no front depois de salvo.
export function InstagramCard({ onSaved }: { onSaved?: () => void }) {
  const { session } = useAuth();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/credentials?keys=instagram_access_token', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as Record<string, { exists: boolean }>;
      setConnected(Boolean(body.instagram_access_token?.exists));
    } catch {
      setConnected(false);
    }
  }, [session]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const save = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ credentials: { instagram_access_token: token.trim() } }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao salvar.');
      toast.success('Instagram conectado.');
      setToken('');
      setConnected(true);
      onSaved?.();
    } catch (err) {
      toast.error('Falha ao conectar o Instagram', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[rgba(var(--accent-rgb),0.15)] bg-white/[0.02] p-5 backdrop-blur-[40px]">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[rgba(225,48,108,0.25)] bg-[rgba(225,48,108,0.08)]">
          <Instagram className="h-5 w-5 text-[#E1306C]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#94A3B8]">
              Instagram
            </span>
            {connected === null ? (
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
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            DMs do Instagram caem no inbox e a IA já começa a conversar. Conecte a conta no
            Zernio e cole o token de acesso abaixo.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={connected ? 'Colar novo token para reconectar…' : 'Instagram Access Token (via Zernio)'}
              className="flex-1 rounded-lg border border-[rgba(var(--accent-rgb),0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <button
              onClick={save}
              disabled={saving || !token.trim()}
              className="rounded-lg bg-gradient-to-br from-[var(--accent-deep)] to-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Salvando…' : connected ? 'Reconectar' : 'Conectar'}
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-secondary)] opacity-70">
            O token é cifrado no banco (AES-256-GCM). Nunca fica em .env nem trafega pro navegador depois de salvo.
          </p>
        </div>
      </div>
    </div>
  );
}
