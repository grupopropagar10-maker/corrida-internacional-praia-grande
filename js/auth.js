// ================================================================
//   AUTH.JS — Sistema de autenticação (localStorage)
//   Corrida Internacional de Praia Grande
// ================================================================

const Auth = {
  KEY: 'cip_session',

  getSession() {
    try { return JSON.parse(localStorage.getItem(this.KEY)); }
    catch { return null; }
  },

  setSession(data) {
    localStorage.setItem(this.KEY, JSON.stringify({ ...data, ts: Date.now() }));
  },

  logout() {
    localStorage.removeItem(this.KEY);
    window.location.href = 'login.html';
  },

  isAdmin() {
    return this.getSession()?.type === 'admin';
  },

  getUser() {
    return this.getSession();
  },

  // Redireciona para login se não autenticado.
  // adminOnly = true → redireciona congregação para sua própria página.
  check(adminOnly = false) {
    const s = this.getSession();
    if (!s) { window.location.href = 'login.html'; return null; }
    if (adminOnly && s.type !== 'admin' && s.type !== 'subadmin') {
      window.location.href = 'minha-congregacao.html';
      return null;
    }
    if (adminOnly === 'admin-only' && s.type !== 'admin') {
      window.location.href = s.type === 'subadmin' ? 'sub-admin.html' : 'login.html';
      return null;
    }
    return s;
  },

  loginAdmin(senha) {
    const creds = DB.get('admin_creds', { senha: 'corrida2026' });
    if (senha === creds.senha) {
      this.setSession({ type: 'admin', nome: 'Administrador', congId: null });
      return true;
    }
    return false;
  },

  loginSubAdmin(usuario, senha) {
    const lista = DB.get('sub_admins', []);
    const sa = lista.find(s => s.usuario === usuario && s.senha === senha);
    if (sa) {
      this.setSession({
        type: 'subadmin',
        nome: sa.nome,
        subAdminId: sa.id,
        permissoes: sa.permissoes,
        categorias: sa.categorias || [],
      });
      return true;
    }
    return false;
  },

  isSubAdmin() {
    return this.getSession()?.type === 'subadmin';
  },

  canDo(permissao) {
    const s = this.getSession();
    if (s?.type === 'admin') return true;
    if (s?.type === 'subadmin') return !!s.permissoes?.[permissao];
    return false;
  },

  registrarAtividade(acao, detalhes = '') {
    const s = this.getSession();
    if (!s || s.type !== 'subadmin') return;
    const lista = DB.get('sub_admins', []);
    const sa = lista.find(x => x.id === s.subAdminId);
    if (!sa) return;
    if (!sa.atividades) sa.atividades = [];
    sa.atividades.unshift({ acao, detalhes, ts: new Date().toLocaleString('pt-BR') });
    if (sa.atividades.length > 50) sa.atividades = sa.atividades.slice(0, 50);
    DB.set('sub_admins', lista);
  },

  loginCong(congId, senha) {
    const cong = DB.get('congregacoes', []).find(c => c.id == congId);
    if (cong && cong.senha && cong.senha === senha) {
      this.setSession({ type: 'cong', nome: cong.nome, congId: parseInt(congId) });
      return true;
    }
    return false;
  },

  // Injeta badge de usuário + botão sair na navbar
  injectNavUser() {
    const user = this.getSession();
    if (!user) return;
    const nav = document.querySelector('.navbar');
    if (!nav) return;

    // Remove badge anterior se existir
    nav.querySelector('.user-badge')?.remove();

    const badge = document.createElement('div');
    badge.className = 'user-badge';
    badge.style.cssText = 'display:flex;align-items:center;gap:0.6rem;flex-shrink:0;';
    const adminLink = user.type === 'admin'
      ? `<a href="admin.html"
           style="background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.4);
                  color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;
                  font-size:0.78rem;font-weight:700;white-space:nowrap;text-decoration:none;">
           🔑 Painel Admin
         </a>`
      : user.type === 'subadmin'
        ? `<a href="sub-admin.html"
             style="background:rgba(255,165,0,0.3);border:1px solid rgba(255,165,0,0.5);
                    color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;
                    font-size:0.78rem;font-weight:700;white-space:nowrap;text-decoration:none;">
             🛡️ Meu Painel
           </a>`
        : '';
    badge.innerHTML = `
      ${adminLink}
      <span style="color:rgba(255,255,255,0.85);font-size:0.82rem;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;">
        ${user.type === 'admin' ? '🔑' : user.type === 'subadmin' ? '🛡️' : '⛪'} <strong>${user.nome}</strong>
      </span>
      <button onclick="Auth.logout()"
        style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);
               color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;
               font-size:0.78rem;font-weight:600;white-space:nowrap;">
        ↩ Sair
      </button>`;
    nav.appendChild(badge);
  },

  // Migra congregações existentes adicionando campos novos se ausentes
  migrateCongs() {
    if (location.protocol === 'file:') return;
    const congs = DB.get('congregacoes', []);
    const normalized = congs.map(c => ({
      ...c,
      senha: c.senha || '',
      contato: c.contato || '',
      telefone: c.telefone || '',
      confirmada: c.confirmada === undefined ? false : c.confirmada,
    }));
    if (normalized.length) {
      localStorage.setItem('congregacoes', JSON.stringify(normalized));
    }
  }
};

// Auto-injeta badge na navbar quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  Auth.migrateCongs();
  Auth.injectNavUser();
});
