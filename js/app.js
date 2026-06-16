// =====================================================
//   DADOS COMPARTILHADOS - LocalStorage + Firebase Sync
// =====================================================

// Escapa HTML para prevenir XSS em innerHTML com dados do Firebase (#15)
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Número amigável e fixo de cada posto (atribuído por ordem de criação).
function getPostoNumero(posto) {
  const n = Number(posto?.numero);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Rótulo "Nº X — Nome" (texto puro; escape fica a cargo de quem usa em HTML).
function formatPostoLabel(posto) {
  const n = getPostoNumero(posto);
  const nome = posto?.nome || 'Posto';
  return n ? `Nº ${n} — ${nome}` : nome;
}

// Garante que todo posto tenha um número fixo. Atribui aos que faltam,
// na ordem de criação (id ascendente), continuando do maior já usado.
// Idempotente: só grava se algo mudou. Não renumera nem altera os existentes.
function ensurePostoNumeros() {
  const postos = DB.get('postos', []);
  if (!Array.isArray(postos) || !postos.length) return postos;
  let maxNum = 0;
  postos.forEach(p => {
    const n = Number(p?.numero);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  });
  const semNumero = postos
    .filter(p => !(Number.isFinite(Number(p?.numero)) && Number(p?.numero) > 0))
    .sort((a, b) => Number(a?.id) - Number(b?.id));
  if (!semNumero.length) return postos;
  semNumero.forEach(p => { maxNum += 1; p.numero = maxNum; });
  DB.set('postos', postos);
  return postos;
}

window.getPostoNumero = getPostoNumero;
window.formatPostoLabel = formatPostoLabel;
window.ensurePostoNumeros = ensurePostoNumeros;

const DB = {
  get(key, def = []) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; }
    catch { return def; }
  },
  set(key, value, options = {}) {
    if (typeof savePrewriteSnapshot === 'function') savePrewriteSnapshot(key);
    localStorage.setItem(key, JSON.stringify(value));
    // Sincroniza com Firebase se disponível
    if (typeof pushToFirebase === 'function') pushToFirebase(key, value, options);
  }
};

function migrateDesignacoes() {
  const designacoes = DB.get('designacoes', []);
  if (!designacoes.length) return;

  let nextId = designacoes.reduce((maxId, designacao) => {
    const currentId = Number(designacao?.id);
    return Number.isFinite(currentId) ? Math.max(maxId, currentId) : maxId;
  }, Date.now());
  let changed = false;

  const normalized = designacoes.map(designacao => {
    const currentId = Number(designacao?.id);
    if (Number.isFinite(currentId)) return designacao;
    changed = true;
    nextId += 1;
    return { ...designacao, id: nextId };
  });

  if (changed) {
    DB.set('designacoes', normalized, { allowDestructive: true });
  }
}

function removePostosAndDependencies(postoIds) {
  const ids = [...new Set((Array.isArray(postoIds) ? postoIds : [postoIds])
    .map(id => Number(id))
    .filter(Number.isFinite))];
  if (!ids.length) {
    return { removedPostos: 0, removedDesignacoes: 0, removedPedidos: 0 };
  }

  const postoIdSet = new Set(ids);
  const postos = DB.get('postos', []);
  const keptPostos = postos.filter(posto => !postoIdSet.has(Number(posto.id)));
  if (keptPostos.length !== postos.length) {
    DB.set('postos', keptPostos, { allowDestructive: true });
  }

  const designacoes = DB.get('designacoes', []);
  const removedDesignacoes = designacoes.filter(designacao => postoIdSet.has(Number(designacao.postoId)));
  const keptDesignacoes = designacoes.filter(designacao => !postoIdSet.has(Number(designacao.postoId)));
  if (keptDesignacoes.length !== designacoes.length) {
    DB.set('designacoes', keptDesignacoes, { allowDestructive: true });
  }

  const removedDesignacaoIds = removedDesignacoes
    .map(designacao => Number(designacao?.id))
    .filter(Number.isFinite);
  const removedDesignacaoIdSet = new Set(removedDesignacaoIds);

  const allCongConfigs = DB.get('cong_config', {});
  let congConfigChanged = false;
  Object.keys(allCongConfigs).forEach(congId => {
    const cfg = allCongConfigs[congId];
    if (!cfg || typeof cfg !== 'object') return;

    let sectionChanged = false;
    ['turnos', 'agendaConfig'].forEach(section => {
      if (!cfg[section] || typeof cfg[section] !== 'object') return;
      removedDesignacaoIds.forEach(designacaoId => {
        const key = String(designacaoId);
        if (Object.prototype.hasOwnProperty.call(cfg[section], key)) {
          delete cfg[section][key];
          sectionChanged = true;
        }
      });
    });

    if (sectionChanged) {
      congConfigChanged = true;
    }
  });
  if (congConfigChanged) {
    DB.set('cong_config', allCongConfigs, { allowDestructive: true });
  }

  const helpRequestKey = 'pedidos_ajuda_escala';
  const pedidos = DB.get(helpRequestKey, []);
  const keptPedidos = pedidos.filter(pedido => {
    const pedidoPostoId = Number(pedido?.postoId);
    const pedidoDesignacaoId = Number(pedido?.designacaoId);
    if (postoIdSet.has(pedidoPostoId)) return false;
    if (removedDesignacaoIdSet.has(pedidoDesignacaoId)) return false;
    return true;
  });
  if (keptPedidos.length !== pedidos.length) {
    DB.set(helpRequestKey, keptPedidos, { allowDestructive: true });
  }

  return {
    removedPostos: postos.length - keptPostos.length,
    removedDesignacoes: removedDesignacoes.length,
    removedPedidos: pedidos.length - keptPedidos.length,
  };
}

window.removePostosAndDependencies = removePostosAndDependencies;

function uniqStrings(values) {
  return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
}

function sameId(a, b) {
  return String(a) === String(b);
}

function applyCategoriaDateChanges(params = {}) {
  const categoriaId = params.categoriaId;
  const categoriaNome = String(params.categoriaNome || 'Categoria');
  const actorName = String(params.actorName || 'Administrador');
  const oldDatas = uniqStrings(params.oldDatas);
  const newDatas = uniqStrings(params.newDatas);

  if (!categoriaId || !oldDatas.length) {
    return {
      removedDates: [],
      impactedCongregacoes: 0,
      removedDesignacoes: 0,
      removedPedidos: 0,
      remappedTurnos: 0,
      remappedPedidos: 0,
      createdNotificacoes: 0,
    };
  }

  const removedDates = oldDatas.filter(data => !newDatas.includes(data));
  if (!removedDates.length) {
    return {
      removedDates: [],
      impactedCongregacoes: 0,
      removedDesignacoes: 0,
      removedPedidos: 0,
      remappedTurnos: 0,
      remappedPedidos: 0,
      createdNotificacoes: 0,
    };
  }

  const removedSet = new Set(removedDates);
  const postos = DB.get('postos', []);
  const postosCategoria = postos.filter(posto => sameId(posto?.categoriaId, categoriaId));
  const postoIdsSet = new Set(postosCategoria.map(posto => String(posto.id)));

  const oldKeyByDateAndPosto = new Map();
  const newKeyByDateAndPosto = new Map();
  postosCategoria.forEach(posto => {
    const postoId = String(posto.id);
    oldDatas.forEach((data, idx) => {
      oldKeyByDateAndPosto.set(`${postoId}__${data}`, `${posto.id}-${idx}`);
    });
    newDatas.forEach((data, idx) => {
      newKeyByDateAndPosto.set(`${postoId}__${data}`, `${posto.id}-${idx}`);
    });
  });

  const designacoes = DB.get('designacoes', []);
  const removedDesignacaoIds = new Set();
  const removedDesignacoes = [];
  const keptDesignacoes = designacoes.filter(designacao => {
    const postoId = String(designacao?.postoId);
    const data = String(designacao?.data || '').trim();
    const shouldRemove = postoIdsSet.has(postoId) && removedSet.has(data);
    if (shouldRemove) {
      removedDesignacaoIds.add(String(designacao?.id));
      removedDesignacoes.push(designacao);
    }
    return !shouldRemove;
  });
  if (keptDesignacoes.length !== designacoes.length) {
    DB.set('designacoes', keptDesignacoes, { allowDestructive: true });
  }

  const congConfig = DB.get('cong_config', {});
  let remappedTurnos = 0;
  let congConfigChanged = false;

  Object.keys(congConfig).forEach(congId => {
    const cfg = congConfig[congId];
    if (!cfg || typeof cfg !== 'object') return;

    let changed = false;
    ['turnos', 'agendaConfig'].forEach(section => {
      const source = cfg[section];
      if (!source || typeof source !== 'object') return;
      const next = { ...source };

      for (const posto of postosCategoria) {
        if (!sameId(posto?.congId, congId)) continue;
        const postoId = String(posto.id);

        for (const oldDate of oldDatas) {
          const oldKey = oldKeyByDateAndPosto.get(`${postoId}__${oldDate}`);
          if (!oldKey || !Object.prototype.hasOwnProperty.call(next, oldKey)) continue;

          if (removedSet.has(oldDate)) {
            delete next[oldKey];
            remappedTurnos += 1;
            changed = true;
            continue;
          }

          const newKey = newKeyByDateAndPosto.get(`${postoId}__${oldDate}`);
          if (!newKey || newKey === oldKey) continue;

          const oldValue = next[oldKey];
          if (Object.prototype.hasOwnProperty.call(next, newKey) && section === 'turnos') {
            const merged = { ...next[newKey] };
            Object.keys(oldValue || {}).forEach(slotKey => {
              const atual = Array.isArray(merged[slotKey]) ? merged[slotKey] : [];
              const antigos = Array.isArray(oldValue[slotKey]) ? oldValue[slotKey] : [];
              merged[slotKey] = atual.concat(antigos);
            });
            next[newKey] = merged;
          } else {
            next[newKey] = oldValue;
          }
          delete next[oldKey];
          remappedTurnos += 1;
          changed = true;
        }
      }

      if (changed) cfg[section] = next;
      congConfigChanged = congConfigChanged || changed;
    });
  });
  if (congConfigChanged) {
    DB.set('cong_config', congConfig, { allowDestructive: true });
  }

  const helpRequestKey = 'pedidos_ajuda_escala';
  const pedidos = DB.get(helpRequestKey, []);
  const nextPedidos = [];
  let removedPedidos = 0;
  let remappedPedidos = 0;

  pedidos.forEach(pedido => {
    const postoId = String(pedido?.postoId);
    const data = String(pedido?.data || '').trim();
    const isCategoriaPosto = postoIdsSet.has(postoId);

    if (isCategoriaPosto && removedSet.has(data)) {
      removedPedidos += 1;
      return;
    }

    if (removedDesignacaoIds.has(String(pedido?.designacaoId))) {
      removedPedidos += 1;
      return;
    }

    if (isCategoriaPosto && data) {
      const oldKey = oldKeyByDateAndPosto.get(`${postoId}__${data}`);
      const newKey = newKeyByDateAndPosto.get(`${postoId}__${data}`);
      if (oldKey && newKey && oldKey !== newKey && String(pedido.designacaoId) === oldKey) {
        nextPedidos.push({ ...pedido, designacaoId: newKey });
        remappedPedidos += 1;
        return;
      }
    }

    nextPedidos.push(pedido);
  });

  if (nextPedidos.length !== pedidos.length || remappedPedidos > 0) {
    DB.set(helpRequestKey, nextPedidos, { allowDestructive: true });
  }

  const impactedCongIds = new Set();
  removedDesignacoes.forEach(designacao => {
    if (designacao?.congId) impactedCongIds.add(String(designacao.congId));
  });
  postosCategoria.forEach(posto => {
    if (posto?.congId) impactedCongIds.add(String(posto.congId));
  });

  const notificacoesKey = 'notificacoes_congregacoes';
  const notificacoes = DB.get(notificacoesKey, []);
  const existingKey = new Set(
    notificacoes
      .filter(item => item?.tipo === 'categoria_data_removida')
      .map(item => `${item.congId}__${item.categoriaId}__${item.dataRemovida}`)
  );

  const novasNotificacoes = [];
  impactedCongIds.forEach(congId => {
    removedDates.forEach(data => {
      const sig = `${congId}__${categoriaId}__${data}`;
      if (existingKey.has(sig)) return;
      novasNotificacoes.push({
        id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        tipo: 'categoria_data_removida',
        congId,
        categoriaId,
        categoriaNome,
        dataRemovida: data,
        mensagem: `O administrador removeu sua congregação da data ${data.split('-').reverse().join('/')} na categoria ${categoriaNome}.`,
        criadoEm: now(),
        lida: false,
        origem: actorName,
      });
    });
  });

  if (novasNotificacoes.length) {
    DB.set(notificacoesKey, novasNotificacoes.concat(notificacoes));
  }

  return {
    removedDates,
    impactedCongregacoes: impactedCongIds.size,
    removedDesignacoes: designacoes.length - keptDesignacoes.length,
    removedPedidos,
    remappedTurnos,
    remappedPedidos,
    createdNotificacoes: novasNotificacoes.length,
  };
}

window.applyCategoriaDateChanges = applyCategoriaDateChanges;

function getManualScaleRequests() {
  return DB.get('ajustes_manuais_escala', []);
}

function saveManualScaleRequests(requests) {
  DB.set('ajustes_manuais_escala', requests, { allowDestructive: true });
}

function getManualScaleTipoLabel(tipo) {
  return tipo === 'horario_extra'
    ? 'adicionar horário extra em outro dia'
    : 'dobrar outro dia';
}

function buildManualScaleDesignacao(request) {
  const posto = DB.get('postos', []).find(item => sameId(item?.id, request.postoId));
  const categoria = DB.get('categorias', []).find(item => sameId(item?.id, request.categoriaId || posto?.categoriaId));
  if (!posto || !categoria || !request.dataAlvo) return null;

  const inicio = String(categoria.horario || '').trim();
  const fim = String(categoria.horarioFim || '').trim();
  if (!inicio || !fim) return null;

  return {
    id: Date.now(),
    postoId: posto.id,
    congId: posto.congId,
    data: request.dataAlvo,
    inicio,
    fim,
    slots: [{ inicio, fim }],
    irmaos: 0,
    obs: request.nota || posto.obs || '',
    responsavel: posto.responsavel || '',
    manualAjuste: true,
    manualAjusteTipo: request.tipo,
    manualAjustePedidoId: request.id,
    recursoTipo: posto.recursoTipo || '',
  };
}

function criarSolicitacaoManualEscala(params = {}) {
  const postoId = Number(params.postoId);
  const dataAlvo = String(params.dataAlvo || '').trim();
  const tipo = params.tipo === 'horario_extra' ? 'horario_extra' : 'dobrar_dia';
  const actorName = String(params.actorName || 'Administrador');
  const nota = String(params.nota || '').trim();

  if (!postoId || !dataAlvo) {
    return { ok: false, reason: 'dados_invalidos' };
  }

  const posto = DB.get('postos', []).find(item => sameId(item?.id, postoId));
  if (!posto?.congId) {
    return { ok: false, reason: 'posto_sem_congregacao' };
  }

  const categoria = DB.get('categorias', []).find(item => sameId(item?.id, posto.categoriaId));
  if (!categoria) {
    return { ok: false, reason: 'categoria_indisponivel' };
  }

  const existingDesignacao = DB.get('designacoes', []).find(desig =>
    sameId(desig?.postoId, postoId) &&
    String(desig?.data || '') === dataAlvo &&
    String(desig?.inicio || '') === String(categoria.horario || '') &&
    String(desig?.fim || '') === String(categoria.horarioFim || '')
  );
  if (existingDesignacao) {
    return { ok: false, reason: 'data_ja_existe' };
  }

  const requests = getManualScaleRequests();
  const duplicate = requests.find(item =>
    item && item.status === 'pendente' &&
    sameId(item.postoId, postoId) &&
    String(item.dataAlvo || '') === dataAlvo &&
    String(item.tipo || '') === tipo
  );
  if (duplicate) {
    return { ok: false, reason: 'solicitacao_duplicada', request: duplicate };
  }

  const request = {
    id: `msr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    tipo,
    tipoLabel: getManualScaleTipoLabel(tipo),
    postoId: posto.id,
    postoNome: posto.nome || 'Posto',
    congId: posto.congId,
    congNome: DB.get('congregacoes', []).find(item => sameId(item?.id, posto.congId))?.nome || posto.nome || 'Congregação',
    categoriaId: categoria.id,
    categoriaNome: categoria.nome || 'Categoria',
    dataAlvo,
    dataAlvoFmt: dataAlvo.split('-').reverse().join('/'),
    status: 'pendente',
    criadoEm: now(),
    criadoPor: actorName,
    nota,
    aviso: `Sua congregação foi escolhida para ${getManualScaleTipoLabel(tipo)} em ${dataAlvo.split('-').reverse().join('/')}. Você aceita?`,
  };

  saveManualScaleRequests([request].concat(requests));
  return { ok: true, request };
}

function responderSolicitacaoManualEscala(requestId, accepted) {
  const requests = getManualScaleRequests();
  const idx = requests.findIndex(item => String(item?.id) === String(requestId));
  if (idx < 0) return { ok: false, reason: 'nao_encontrado' };

  const request = requests[idx];
  if (request.status !== 'pendente') {
    return { ok: false, reason: 'ja_processada', request };
  }

  if (!accepted) {
    requests[idx] = {
      ...request,
      status: 'recusado',
      respondidoEm: now(),
    };
    saveManualScaleRequests(requests);
    return { ok: true, request: requests[idx], createdDesignacao: null };
  }

  const designacao = buildManualScaleDesignacao(request);
  if (!designacao) {
    return { ok: false, reason: 'nao_pode_criar_designacao', request };
  }

  const designacoes = DB.get('designacoes', []);
  const duplicada = designacoes.some(item =>
    sameId(item?.postoId, designacao.postoId) &&
    String(item?.data || '') === String(designacao.data || '') &&
    String(item?.inicio || '') === String(designacao.inicio || '') &&
    String(item?.fim || '') === String(designacao.fim || '')
  );
  if (duplicada) {
    return { ok: false, reason: 'designacao_ja_existe', request };
  }

  designacoes.push(designacao);
  DB.set('designacoes', designacoes, { allowDestructive: true });

  requests[idx] = {
    ...request,
    status: 'aceito',
    respondidoEm: now(),
    designacaoCriadaId: designacao.id,
  };
  saveManualScaleRequests(requests);

  return { ok: true, request: requests[idx], createdDesignacao: designacao };
}

window.criarSolicitacaoManualEscala = criarSolicitacaoManualEscala;
window.responderSolicitacaoManualEscala = responderSolicitacaoManualEscala;

// Dados iniciais de postos
function initData() {
  const existingPostos = DB.get('postos', []);
  const existingDistribuicoes = DB.get('distribuicoes', []);
  if (existingPostos.length || existingDistribuicoes.length) {
    localStorage.setItem('postos_init', true);
    return;
  }
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
document.addEventListener('DOMContentLoaded', async () => {
  await (window.DB_SYNC_READY || Promise.resolve());
  migrateDesignacoes();
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
