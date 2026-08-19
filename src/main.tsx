import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Convite e recuperação de senha chegam com a sessão no fragmento da URL. O
// destino depende do Site URL / allow-list do projeto Supabase, e quando essa
// configuração não bate o link cai na raiz: a pessoa entraria autenticada sem
// nunca definir a senha, e ficaria sem conseguir voltar. Redirecionamos para a
// tela certa antes do React montar (e antes de o client consumir o fragmento).
(() => {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  const type = params.get('type');
  // /invite atende os dois casos: define a senha via updateUser.
  if (type !== 'invite' && type !== 'recovery') return;
  if (window.location.pathname === '/invite') return;
  window.history.replaceState(null, '', `/invite${window.location.search}${hash}`);
})();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element is missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
