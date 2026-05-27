// =====================================================
//   DADOS COMPARTILHADOS - LocalStorage + Firebase Sync
// =====================================================

const DB = {
  get(key, def = []) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; }
    catch { return def; }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    // Sincroniza com Firebase se disponível
    if (typeof pushToFirebase === 'function') pushToFirebase(key, value);
  }
};

// Dados iniciais de postos
function initData() {
  if (!localStorage.getItem('postos_init')) {
    DB.set('postos', [
      { id: 1, nome: 'Posto 1 - Largada',      km: '0',    local: 'Av. Pres. Kennedy, s/n – frente ao mar',       status: 'ativo',   responsavel: 'Irmão Carlos',   publicacoes: 50, contatos: 0 },
      { id: 2, nome: 'Posto 2 - Boqueirão',     km: '3',    local: 'Praia do Boqueirão – próx. ao calçadão',       status: 'ativo',   responsavel: 'Irmã Maria',     publicacoes: 50, contatos: 0 },
      { id: 3, nome: 'Posto 3 - Guilhermina',   km: '6',    local: 'Praia Guilhermina – quiosque central',         status: 'ativo',   responsavel: 'Irmão João',     publicacoes: 50, contatos: 0 },
      { id: 4, nome: 'Posto 4 - Canto do Forte', km: '9',   local: 'Av. Marechal Mallet – Canto do Forte',        status: 'standby', responsavel: 'Irmã Ana',       publicacoes: 50, contatos: 0 },
      { id: 5, nome: 'Posto 5 - Virada',        km: '12,5', local: 'Ponto de virada – Guaratuba (divisa)',         status: 'ativo',   responsavel: 'Irmão Paulo',    publicacoes: 50, contatos: 0 },
      { id: 6, nome: 'Posto 6 - Melvi',         km: '16',   local: 'Praia do Melvi – posto salva-vidas',           status: 'ativo',   responsavel: 'Irmã Lúcia',     publicacoes: 50, contatos: 0 },
      { id: 7, nome: 'Posto 7 - Tupiry',        km: '19',   local: 'Av. Costa Brava – Tupiry',                    status: 'standby', responsavel: 'Irmão Daniel',   publicacoes: 50, contatos: 0 },
      { id: 8, nome: 'Posto 8 - Chegada',       km: '21',   local: 'Av. Pres. Kennedy – Linha de Chegada',        status: 'ativo',   responsavel: 'Irmão Roberto',  publicacoes: 50, contatos: 0 },
    ]);
    DB.set('distribuicoes', []);
    DB.set('postos_init', true);
  }
}

// Toast notification
function showToast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type]}</span> ${msg}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Formata data/hora
function now() {
  return new Date().toLocaleString('pt-BR');
}

// Hamburger menu
document.addEventListener('DOMContentLoaded', () => {
  initData();
  const hamburger = document.querySelector('.hamburger');
  const nav = document.querySelector('.navbar-nav');
  if (hamburger && nav) {
    hamburger.addEventListener('click', () => nav.classList.toggle('open'));
  }
  // Marca link ativo
  const links = document.querySelectorAll('.navbar-nav a');
  links.forEach(l => {
    if (l.href === location.href) l.classList.add('active');
  });
});
