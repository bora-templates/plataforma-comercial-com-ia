import {
  LayoutDashboard,
  Inbox,
  Megaphone,
  Users,
  Bot,
  Settings,
  KanbanSquare,
  TrendingUp,
  Zap,
  Building2,
  type LucideIcon,
} from 'lucide-react';
import { VOCAB } from '@/config/vocab';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // Itens adminOnly só aparecem para role 'admin'. Operadores não veem
  // Credenciais (escrita admin-only — antes a rota existia mas sem link,
  // deixando Configurações/Equipe/Conta inalcançáveis pela UI).
  adminOnly?: boolean;
  // Itens superAdminOnly só aparecem para o super admin da instância
  // (JWT is_super_admin). Ex.: console de Organizações (/admin).
  superAdminOnly?: boolean;
}

// Single source of truth for both the Sidebar and the router. Adding a new
// app section is a one-liner here.
// Base de Conhecimento, Follow-ups e Horário de atendimento viraram abas dentro
// de /ai-agent. Credenciais virou aba dentro de Configurações. Templates virou
// aba dentro de /campaigns (Módulo 1).
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: VOCAB.dashboard, icon: LayoutDashboard, adminOnly: true },
  { to: '/inbox', label: VOCAB.inbox, icon: Inbox },
  { to: '/funil', label: VOCAB.funnel, icon: KanbanSquare, adminOnly: true },
  { to: '/vendas', label: VOCAB.sales, icon: TrendingUp, adminOnly: true },
  { to: '/contacts', label: VOCAB.contacts, icon: Users },
  { to: '/campaigns', label: VOCAB.campaigns, icon: Megaphone },
  { to: '/automations', label: VOCAB.automations, icon: Zap, adminOnly: true },
  { to: '/ai-agent', label: VOCAB.aiAgent, icon: Bot, adminOnly: true },
  { to: '/settings/profile', label: VOCAB.settings, icon: Settings },
  { to: '/admin', label: VOCAB.orgs, icon: Building2, superAdminOnly: true },
];
