import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Bot, BookOpen, Clock, FlaskConical, Image, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { AIAgentSettings } from '../settings/sections/AIAgentSettings';
import { AgentMediaSettings } from '../settings/sections/AgentMediaSettings';
import { BusinessHoursSettings } from '../settings/sections/BusinessHoursSettings';
import KnowledgePage from '../knowledge/KnowledgePage';
import { VOCAB } from '@/config/vocab';

type TabId = 'agent' | 'media' | 'knowledge' | 'hours';

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
  render: (ctx: TabContext) => React.ReactNode;
}

interface TabContext {
  onTestModeChange: (on: boolean) => void;
}

const TABS: TabDef[] = [
  { id: 'agent', label: 'Agente', icon: Bot, render: (ctx) => <AIAgentSettings onTestModeChange={ctx.onTestModeChange} /> },
  { id: 'media', label: 'Mídias', icon: Image, render: () => <AgentMediaSettings /> },
  { id: 'knowledge', label: 'Base de Conhecimento', icon: BookOpen, render: () => <KnowledgePage /> },
  { id: 'hours', label: 'Horário de atendimento', icon: Clock, render: () => <BusinessHoursSettings /> },
];

export default function AIAgentPage() {
  const { role, loading } = useAppUser();
  const [active, setActive] = useState<TabId>('agent');
  // Selo "Modo de teste ligado": a aba Agente (aberta por padrão) informa ao
  // carregar e ao salvar.
  const [testModeOn, setTestModeOn] = useState(false);
  const current = TABS.find((t) => t.id === active) ?? TABS[0];

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" />
      </div>
    );
  }
  // Tela admin-only: configuração do agente, mídias, base, follow-ups e horário.
  if (role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Bot className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-display">{VOCAB.aiAgent}</h1>
            {testModeOn && (
              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold bg-[rgba(245,158,11,0.12)] text-[#FBBF24]">
                <FlaskConical className="h-3 w-3" /> Modo de teste ligado
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Configuração do agente, base de conhecimento, follow-ups e horário
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[rgba(212,165,116,0.1)]">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-[var(--accent-primary)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>{current.render({ onTestModeChange: setTestModeOn })}</div>
    </div>
  );
}
