// ============================================================================
// invite-team-member
// ----------------------------------------------------------------------------
// Admin manda e-mail + role. Dois caminhos, na mesma chamada:
//   1. tenta inviteUserByEmail, que dispara o e-mail do Supabase (so funciona
//      com SMTP próprio configurado; o serviço padrão do Supabase entrega
//      apenas para membros da organização do projeto, 2 por hora);
//   2. sempre devolve um link de convite copiável (generateLink type=invite),
//      para o admin mandar por WhatsApp quando o e-mail nao sai.
// O trigger `handle_new_user` lê `invited_role` + `invited_org_id` do metadata
// e provisiona o app_user, nos dois caminhos.
//
// mode: 'link' regenera o link de um convite pendente, sem tocar no e-mail.
//
// Portão de segurança: generateLink(type=invite) num e-mail JÁ cadastrado
// devolve um link que dá sessão naquela conta. Sem checar antes, um admin
// poderia gerar link para o e-mail de outra organização ou do super admin e
// assumir a conta. A RPC invite_target_state decide quem pode receber link.
//
// Only `admin` callers may invite. Email is normalized to lowercase.
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient, getAuthAdminClient } from '../_shared/supabase-admin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

type Role = 'admin' | 'operator';

const ROLES = new Set<Role>(['admin', 'operator']);

// Traduz mensagens do gotrue (em inglês) para manter a UI em pt-BR.
function friendlyAuthError(raw: string): string {
  if (/invalid email|invalid format|Email address.*invalid/i.test(raw)) {
    return 'E-mail inválido ou domínio não suportado pelo provedor de auth.';
  }
  if (/already.*registered|User already registered/i.test(raw)) {
    return 'Já existe um usuário com esse e-mail.';
  }
  if (/rate limit/i.test(raw)) {
    return 'Muitos convites em sequência. Aguarde alguns minutos e tente de novo.';
  }
  if (/error sending|smtp|mail/i.test(raw)) {
    return 'O projeto não conseguiu enviar o e-mail. Configure um SMTP próprio no Supabase ou use o link.';
  }
  return raw;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: { email?: string; role?: Role; app_url?: string; mode?: 'invite' | 'link' };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    const email = (body.email ?? '').trim().toLowerCase();
    const role = body.role as Role | undefined;
    const mode = body.mode === 'link' ? 'link' : 'invite';

    // Regex mais estrita: bloqueia HTML/JS na parte local e exige TLD com 2+ chars.
    if (!email || email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
      return jsonResponse({ ok: false, error: 'E-mail inválido.' }, { status: 400 });
    }
    if (mode === 'invite' && (!role || !ROLES.has(role))) {
      return jsonResponse({ ok: false, error: 'role inválido.' }, { status: 400 });
    }

    const admin = getAuthAdminClient();
    const db = getAdminClient();

    // Portão: o que existe neste e-mail, na visão da org de quem convida.
    const { data: state, error: stateError } = await db.rpc('invite_target_state', {
      p_email: email,
      p_org_id: caller.orgId,
    });
    if (stateError) {
      return jsonResponse(
        { ok: false, error: `Falha ao verificar o e-mail: ${stateError.message}` },
        { status: 500 },
      );
    }
    if (state === 'member') {
      return jsonResponse({ ok: false, error: 'Essa pessoa já faz parte da equipe.' }, { status: 409 });
    }
    if (state !== 'none' && state !== 'pending') {
      // other_org / super_admin / orphan: não revelamos qual, só barramos.
      return jsonResponse(
        { ok: false, error: 'Não é possível convidar este e-mail.' },
        { status: 409 },
      );
    }
    if (mode === 'link' && state !== 'pending') {
      return jsonResponse(
        { ok: false, error: 'Não há convite pendente para este e-mail.' },
        { status: 404 },
      );
    }

    // redirectTo aponta o link do convite para a tela /invite, onde a pessoa
    // define a senha. Prioridade:
    //   1. credencial `app_url` (URL de produção registrada no setup);
    //   2. `app_url` enviado pelo frontend (window.location.origin), garante
    //      que o link vá para o domínio real onde o app está rodando (Vercel),
    //      nunca localhost, mesmo sem a credencial configurada;
    //   3. sem nada válido: cai no Site URL do projeto Supabase.
    const isValidAppUrl = (u: string) => /^https:\/\/[^\s/]+\.[^\s/]+/.test(u);
    const credUrl = (await getCredential(caller.orgId, 'app_url'))?.replace(/\/$/, '') || '';
    const bodyUrl = (body.app_url ?? '').trim().replace(/\/$/, '');
    const appUrl = credUrl || (isValidAppUrl(bodyUrl) ? bodyUrl : '');
    const redirectTo = appUrl ? `${appUrl}/invite` : undefined;

    const inviteMeta = {
      invited_role: role,
      // O trigger handle_new_user EXIGE invited_org_id para vincular o novo
      // usuário à organização de quem convidou.
      invited_org_id: caller.orgId,
      invited_by: caller.email,
    };

    // Passo 1: e-mail. Só faz sentido para convite novo; falha de envio não
    // aborta nada, o link do passo 2 é o caminho garantido.
    let emailed = false;
    let emailError: string | null = null;
    if (mode === 'invite' && state === 'none') {
      const { error } = await admin.auth.admin.inviteUserByEmail(email, {
        data: inviteMeta,
        ...(redirectTo ? { redirectTo } : {}),
      });
      if (error) {
        const raw = error.message ?? '';
        // "Já registrado" aqui significa corrida com outro convite: para o fluxo,
        // porque o passo 2 geraria link de uma conta que não acabamos de criar.
        if (/already.*registered|User already registered/i.test(raw)) {
          return jsonResponse({ ok: false, error: friendlyAuthError(raw) }, { status: 409 });
        }
        emailError = friendlyAuthError(raw);
      } else {
        emailed = true;
      }
    }

    // Passo 2: link copiável. Cria o usuário quando o e-mail não criou, ou
    // apenas regenera o link quando o convite já existe.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        ...(mode === 'invite' ? { data: inviteMeta } : {}),
        ...(redirectTo ? { redirectTo } : {}),
      },
    });

    if (linkError) {
      return jsonResponse(
        { ok: false, error: friendlyAuthError(linkError.message ?? '') },
        { status: linkError.status ?? 400 },
      );
    }

    return jsonResponse({
      ok: true,
      email,
      role: role ?? null,
      emailed,
      email_error: emailError,
      invite_link: link?.properties?.action_link ?? null,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('invite-team-member error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
