// ================================================================
//   AUTH.JS — Sistema de autenticação (localStorage)
//   Corrida Internacional de Praia Grande
// ================================================================

const SESSION_TTL_MS  = 12 * 60 * 60 * 1000; // 12 horas
const RATE_LIMIT_KEY  = 'auth_rate_v1';
const RATE_LIMIT_MAX  = 5;
const RATE_LIMIT_WIN  = 5 * 60 * 1000; // 5 minutos

function _rlRead() {
  try { return JSON.parse(localStorage.getItem(RATE_LIMIT_KEY)) || {}; }
  catch { return {}; }
}

// Retorna false se o limite foi atingido
function checkRateLimit(type) {
  const now  = Date.now();
  const data = _rlRead();
  const e    = data[type] || { count: 0, resetAt: now + RATE_LIMIT_WIN };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + RATE_LIMIT_WIN; }
  e.count += 1;
  data[type] = e;
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
  return e.count <= RATE_LIMIT_MAX;
}

function resetRateLimit(type) {
  const data = _rlRead();
  delete data[type];
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
}

// Segundos restantes até liberar novamente (0 = livre)
function getRateLimitWait(type) {
  const now  = Date.now();
  const data = _rlRead();
  const e    = data[type];
  if (!e || now > e.resetAt || e.count <= RATE_LIMIT_MAX) return 0;
  return Math.ceil((e.resetAt - now) / 1000);
}

const Auth = {
  KEY: 'cip_session',

  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(this.KEY));
      if (!s) return null;
      // Expiração: sessão inválida após SESSION_TTL_MS
      if (s.ts && Date.now() - s.ts > SESSION_TTL_MS) {
        localStorage.removeItem(this.KEY);
        return null;
      }
      return s;
    } catch { return null; }
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

  // adminOnly = false       → qualquer usuário autenticado
  // adminOnly = true        → admin ou sub-admin
  // adminOnly = 'admin-only'→ apenas admin
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

  // SHA-256 com salt fixo — exposto como método para uso em admin.html
  async hashPassword(str) {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('cipg26:' + str)
    );
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },

  // Retorna true | false | 'rate_limited'
  async loginAdmin(senha) {
    if (!checkRateLimit('admin')) return 'rate_limited';
    // Fallback: se admin_creds nunca foi gravado no Firebase usa a senha padrão
    const creds = DB.get('admin_creds', { senha: 'corrida2026' });

    let ok = false;
    if (creds._hashed) {
      ok = (await this.hashPassword(senha)) === creds.senha;
    } else {
      ok = senha === creds.senha;
      if (ok) {
        // Faz upgrade automático para hash na 1ª autenticação com senha plaintext
        const hash = await this.hashPassword(senha);
        DB.set('admin_creds', { senha: hash, _hashed: true });
      }
    }
    if (ok) {
      resetRateLimit('admin');
      this.setSession({ type: 'admin', nome: 'Administrador', congId: null });
    }
    return ok;
  },

  // Retorna true | false | 'rate_limited'
  async loginSubAdmin(usuario, senha) {
    if (!checkRateLimit('subadmin')) return 'rate_limited';
    const lista = DB.get('sub_admins', []);
    const sa = lista.find(s => s.usuario === usuario);
    if (!sa) return false;

    let ok = false;
    if (sa._hashed) {
      ok = (await this.hashPassword(senha)) === sa.senha;
    } else {
      ok = sa.senha === senha;
      if (ok) {
        // Faz upgrade automático para hash
        const hash = await this.hashPassword(senha);
        const idx  = lista.findIndex(s => s.id === sa.id);
        if (idx >= 0) {
          lista[idx] = { ...lista[idx], senha: hash, _hashed: true };
          DB.set('sub_admins', lista);
        }
      }
    }
    if (ok) {
      resetRateLimit('subadmin');
      this.setSession({
        type: 'subadmin',
        nome: sa.nome,
        subAdminId: sa.id,
        permissoes: sa.permissoes,
        categorias: sa.categorias || [],
        modoEspecial: sa.modoEspecial || '',
      });
    }
    return ok;
  },

  findTapaBuracoInvite(usuario, senha) {
    const evento  = DB.get('evento_config', {});
    const invites = Array.isArray(evento?.tapaBuraco?.invites) ? evento.tapaBuraco.invites : [];
    const invite  = invites.find(item => item && item.usuario === usuario && item.senha === senha && item.ativo !== false);
    return invite ? { invite } : null;
  },

  findLiveInvite(usuario, senha) {
    const foundTapaBuraco = this.findTapaBuracoInvite(usuario, senha);
    if (foundTapaBuraco) return { ...foundTapaBuraco, mode: 'tapa_buraco' };
    const all = DB.get('cong_config', {});
    return Object.entries(all).reduce((found, [congId, cfg]) => {
      if (found) return found;
      const invites = Array.isArray(cfg?.liveRequests?.invites) ? cfg.liveRequests.invites : [];
      const invite  = invites.find(item => item && item.usuario === usuario && item.senha === senha && item.ativo !== false);
      return invite ? { congId: parseInt(congId, 10), invite, mode: 'congregacao' } : null;
    }, null);
  },

  loginLiveInvite(usuario, senha) {
    const found = this.findLiveInvite(usuario, senha);
    if (!found) return false;
    if (found.mode === 'tapa_buraco') {
      const evento = DB.get('evento_config', {});
      evento.tapaBuraco = evento.tapaBuraco && typeof evento.tapaBuraco === 'object' ? evento.tapaBuraco : {};
      evento.tapaBuraco.invites = Array.isArray(evento.tapaBuraco.invites) ? evento.tapaBuraco.invites : [];
      const invite = evento.tapaBuraco.invites.find(item => item && item.id === found.invite.id);
      if (invite) {
        invite.loginCount      = Number(invite.loginCount || 0) + 1;
        invite.ultimoAcessoEm  = new Date().toLocaleString('pt-BR');
        DB.set('evento_config', evento);
      }
      this.setSession({
        type: 'live', nome: found.invite.nome, congId: null,
        liveInviteId: found.invite.id, liveUsuario: found.invite.usuario,
        liveMode: 'tapa_buraco',
      });
      return true;
    }

    const all    = DB.get('cong_config', {});
    const cfg    = all[found.congId] || {};
    const invites = Array.isArray(cfg?.liveRequests?.invites) ? cfg.liveRequests.invites : [];
    const invite  = invites.find(item => item && item.id === found.invite.id);
    if (invite) {
      invite.loginCount     = Number(invite.loginCount || 0) + 1;
      invite.ultimoAcessoEm = new Date().toLocaleString('pt-BR');
      all[found.congId] = {
        ...cfg,
        liveRequests: { enabled: !!cfg?.liveRequests?.enabled, invites },
      };
      DB.set('cong_config', all);
    }
    this.setSession({
      type: 'live', nome: found.invite.nome, congId: found.congId,
      liveInviteId: found.invite.id, liveUsuario: found.invite.usuario,
      liveMode: 'congregacao',
    });
    return true;
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

  registrarAtividade(acao, detalhes = '', meta = null) {
    const s = this.getSession();
    if (!s || s.type !== 'subadmin') return;
    const lista = DB.get('sub_admins', []);
    const sa    = lista.find(x => x.id === s.subAdminId);
    if (!sa) return;
    if (!sa.atividades) sa.atividades = [];
    const entry = { acao, detalhes, ts: new Date().toLocaleString('pt-BR') };
    if (meta && typeof meta === 'object') Object.assign(entry, meta);
    sa.atividades.unshift(entry);
    if (sa.atividades.length > 50) sa.atividades = sa.atividades.slice(0, 50);
    DB.set('sub_admins', lista);
  },

  // Senhas de congregação ficam em plaintext — admin precisa visualizá-las
  loginCong(congId, senha) {
    const cong = DB.get('congregacoes', []).find(c => c.id == congId);
    if (cong && cong.senha && cong.senha === senha) {
      this.setSession({ type: 'cong', nome: cong.nome, congId: parseInt(congId) });
      return true;
    }
    return false;
  },

  injectNavUser() {
    const user = this.getSession();
    if (!user) return;
    const nav = document.querySelector('.navbar');
    if (!nav) return;
    nav.querySelector('.user-badge')?.remove();

    const badge = document.createElement('div');
    badge.className = 'user-badge';
    badge.style.cssText = 'display:flex;align-items:center;gap:0.6rem;flex-shrink:0;';
    const adminLink = user.type === 'admin'
      ? `<a href="admin.html" style="background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.4);color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.78rem;font-weight:700;white-space:nowrap;text-decoration:none;">🔑 Painel Admin</a>`
      : user.type === 'subadmin'
        ? `<a href="sub-admin.html" style="background:rgba(255,165,0,0.3);border:1px solid rgba(255,165,0,0.5);color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.78rem;font-weight:700;white-space:nowrap;text-decoration:none;">🛡️ Meu Painel</a>`
        : user.type === 'live'
          ? `<a href="pedidos-ao-vivo.html" style="background:rgba(40,167,69,0.3);border:1px solid rgba(40,167,69,0.5);color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.78rem;font-weight:700;white-space:nowrap;text-decoration:none;">📲 Meu acesso</a>`
          : '';
    badge.innerHTML = `
      ${adminLink}
      <span style="color:rgba(255,255,255,0.85);font-size:0.82rem;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;">
        ${user.type === 'admin' ? '🔑' : user.type === 'subadmin' ? '🛡️' : user.type === 'live' ? '📲' : '🏃'} <strong>${user.nome}</strong>
      </span>
      <button onclick="Auth.logout()" style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);color:white;padding:0.3rem 0.8rem;border-radius:6px;cursor:pointer;font-size:0.78rem;font-weight:600;white-space:nowrap;">
        ↩ Sair
      </button>`;
    nav.appendChild(badge);
  },

  migrateCongs() {
    if (location.protocol === 'file:') return;
    const congs = DB.get('congregacoes', []);
    if (!congs.length) return;
    let changed = false;
    const normalized = congs.map(c => {
      const needsMigration = c.senha == null || c.contato == null || c.telefone == null || c.confirmada == null;
      if (needsMigration) changed = true;
      return {
        ...c,
        senha:      c.senha      ?? '',
        contato:    c.contato    ?? '',
        telefone:   c.telefone   ?? '',
        confirmada: c.confirmada ?? false,
      };
    });
    if (changed) DB.set('congregacoes', normalized);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Auth.migrateCongs();
  Auth.injectNavUser();
});
