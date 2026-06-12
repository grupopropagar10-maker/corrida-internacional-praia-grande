// =====================================================
//   FIREBASE — Sincronização em tempo real
// =====================================================

const firebaseConfig = {
  apiKey: "AIzaSyC3BDRg1RotadIw8nLKbLJ0IUp21GsiezY",
  authDomain: "corrida-praia-grande.firebaseapp.com",
  databaseURL: "https://corrida-praia-grande-default-rtdb.firebaseio.com",
  projectId: "corrida-praia-grande",
  storageBucket: "corrida-praia-grande.firebasestorage.app",
  messagingSenderId: "215654577416",
  appId: "1:215654577416:web:18d874aad45e4e71ffa8bd"
};

// Inicializa Firebase
firebase.initializeApp(firebaseConfig);
const rtdb = firebase.database();
const IS_LOCAL_FILE = location.protocol === 'file:';

// Chaves que devem ser sincronizadas com o Firebase
const SYNC_KEYS = ['postos', 'congregacoes', 'distribuicoes', 'postos_init', 'admin_creds', 'sub_admins', 'designacoes', 'categorias', 'cong_config', 'evento_config', 'pedidos_ajuda_escala', 'ajustes_manuais_escala'];
const CRITICAL_KEYS = ['congregacoes', 'postos', 'designacoes', 'cong_config'];
const BACKUP_STORAGE_KEY = 'firebase_sync_backups_v1';
const BACKUP_LATEST_KEY = 'firebase_sync_backup_latest';
const PREWRITE_BACKUP_KEY = 'firebase_prewrite_backup_latest';
const PENDING_WRITE_STORAGE_KEY = 'firebase_pending_writes_v1';
const BACKUP_LIMIT = 8;
let restoreInFlight = false;

function safeJsonParse(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getBackupPayload() {
  return SYNC_KEYS.reduce((acc, key) => {
    acc[key] = safeJsonParse(localStorage.getItem(key), null);
    return acc;
  }, {});
}

function getCollectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value == null ? 0 : 1;
}

function getLatestSafeBackup() {
  const latest = safeJsonParse(localStorage.getItem(BACKUP_LATEST_KEY), null);
  if (latest && (latest.source === 'pull' || latest.source === 'bootstrap')) return latest;
  const history = safeJsonParse(localStorage.getItem(BACKUP_STORAGE_KEY), []);
  return history.find(item => item && (item.source === 'pull' || item.source === 'bootstrap')) || null;
}

function savePrewriteSnapshot(triggerKey) {
  const snapshot = {
    ts: new Date().toISOString(),
    source: 'prewrite',
    key: triggerKey,
    payload: getBackupPayload(),
  };
  localStorage.setItem(PREWRITE_BACKUP_KEY, JSON.stringify(snapshot));
  return snapshot;
}

function getLatestRestoreSnapshot() {
  return safeJsonParse(localStorage.getItem(PREWRITE_BACKUP_KEY), null) || getLatestSafeBackup();
}

function isSuspiciousWrite(key, nextValue) {
  if (!CRITICAL_KEYS.includes(key)) return false;
  const latest = getLatestSafeBackup();
  if (!latest) return false; // Sem backup ainda — 1ª inicialização, libera
  const prevValue = latest?.payload?.[key];
  const prevSize  = getCollectionSize(prevValue);
  const nextSize  = getCollectionSize(nextValue);

  if (prevSize === 0) return false; // Baseline vazio — não há referência confiável
  if (nextSize === 0) return true;  // Tentativa de zerar dados existentes
  if (prevSize >= 3 && nextSize <= 1) return true;
  if (prevSize >= 5 && nextSize / prevSize <= 0.35) return true;
  return false;
}

function restoreFullBackup(reason) {
  const latest = getLatestRestoreSnapshot();
  if (!latest?.payload) return false;
  restoreInFlight = true;
  Object.entries(latest.payload).forEach(([key, value]) => {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  });
  Promise.all(
    Object.entries(latest.payload)
      .filter(([key]) => SYNC_KEYS.includes(key))
      .map(([key, value]) =>
        rtdb.ref(key).set(value).catch(err => {
          console.warn(`[Firebase] Falha ao restaurar backup completo em ${key}:`, err);
        })
      )
  ).finally(() => {
    restoreInFlight = false;
  });
  window.dispatchEvent(new CustomEvent('db-restore-blocked-write', { detail: { reason, backupTs: latest.ts, source: latest.source } }));
  return true;
}

function saveLocalBackup(source, key) {
  const snapshot = {
    ts: new Date().toISOString(),
    source,
    key,
    payload: getBackupPayload(),
  };
  localStorage.setItem(BACKUP_LATEST_KEY, JSON.stringify(snapshot));
  const history = safeJsonParse(localStorage.getItem(BACKUP_STORAGE_KEY), []);
  history.unshift(snapshot);
  localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(history.slice(0, BACKUP_LIMIT)));
}

function getPendingWrites() {
  return safeJsonParse(localStorage.getItem(PENDING_WRITE_STORAGE_KEY), {});
}

function savePendingWrites(pending) {
  localStorage.setItem(PENDING_WRITE_STORAGE_KEY, JSON.stringify(pending));
}

function valuesMatch(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function markPendingWrite(key, value) {
  const pending = getPendingWrites();
  const entry = {
    ts: new Date().toISOString(),
    value,
  };
  pending[key] = entry;
  savePendingWrites(pending);
  return entry.ts;
}

function clearPendingWrite(key, ts) {
  const pending = getPendingWrites();
  if (!pending[key]) return;
  if (ts && pending[key].ts !== ts) return;
  delete pending[key];
  savePendingWrites(pending);
}

function applyPendingWritesToLocal() {
  const pending = getPendingWrites();
  Object.entries(pending).forEach(([key, entry]) => {
    if (!SYNC_KEYS.includes(key) || !entry) return;
    localStorage.setItem(key, JSON.stringify(entry.value));
  });
}

function flushPendingWrites() {
  if (IS_LOCAL_FILE || restoreInFlight) return Promise.resolve();
  const pending = getPendingWrites();
  const entries = Object.entries(pending).filter(([key, entry]) => SYNC_KEYS.includes(key) && entry);
  if (!entries.length) return Promise.resolve();

  return Promise.all(entries.map(([key, entry]) =>
    rtdb.ref(key).set(entry.value)
      .then(() => clearPendingWrite(key, entry.ts))
      .catch(err => {
        console.warn(`[Firebase] Erro ao reenviar dado pendente em ${key}:`, err);
      })
  ));
}

window.FirebaseBackup = {
  latest() {
    return safeJsonParse(localStorage.getItem(BACKUP_LATEST_KEY), null);
  },
  history() {
    return safeJsonParse(localStorage.getItem(BACKUP_STORAGE_KEY), []);
  },
  restoreLatestToLocal() {
    const latest = this.latest();
    if (!latest?.payload) return false;
    Object.entries(latest.payload).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    });
    return true;
  }
};

let _syncStarted = false; // Garante que listeners só são registrados uma vez (#10)

// Escuta mudanças em tempo real e atualiza localStorage automaticamente
function startSync() {
  if (_syncStarted) return;
  _syncStarted = true;
  SYNC_KEYS.forEach(key => {
    rtdb.ref(key).on('value', snapshot => {
      const val = snapshot.val();
      if (val !== null) {
        const pending = getPendingWrites()[key];
        if (pending) {
          if (valuesMatch(pending.value, val)) {
            clearPendingWrite(key, pending.ts);
          } else {
            localStorage.setItem(key, JSON.stringify(pending.value));
            return;
          }
        }
        localStorage.setItem(key, JSON.stringify(val));
        saveLocalBackup('pull', key);
        window.dispatchEvent(new CustomEvent('db-sync', { detail: { key } }));
      } else {
        // Chave removida do Firebase — mantém dado local (pode ser escrita pendente)
        console.warn(`[Firebase] Chave "${key}" retornou null — dado local preservado.`);
      }
    });
  });
}

// Salva snapshot completo no Firebase (até 5 cópias rotativas) — #13
function saveFirebaseBackup() {
  if (IS_LOCAL_FILE) return;
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = getBackupPayload();
  rtdb.ref(`system_backups/${ts}`).set({ ts: new Date().toISOString(), payload })
    .catch(err => console.warn('[Firebase] Backup remoto falhou:', err));
  // Mantém apenas as 5 últimas cópias
  rtdb.ref('system_backups').once('value').then(snap => {
    const bks = snap.val();
    if (!bks) return;
    const keys = Object.keys(bks).sort();
    if (keys.length > 5) {
      keys.slice(0, keys.length - 5).forEach(k =>
        rtdb.ref(`system_backups/${k}`).remove().catch(() => {})
      );
    }
  }).catch(() => {});
}

// Envia dado ao Firebase (chamado pelo DB.set)
function pushToFirebase(key, value, options = {}) {
  if (!SYNC_KEYS.includes(key)) return;
  if (IS_LOCAL_FILE) return;
  if (restoreInFlight) return;
  if (!options.allowDestructive && isSuspiciousWrite(key, value)) {
    const restored = restoreFullBackup('suspicious-write');
    console.warn(`[Firebase] Escrita suspeita bloqueada em ${key}. Snapshot completo ${restored ? 'restaurado' : 'indisponivel'}.`);
    return;
  }
  const writeTs = markPendingWrite(key, value);
  // Evento de status: salvando — #14
  window.dispatchEvent(new CustomEvent('db-sync-status', { detail: { state: 'pending', key } }));
  rtdb.ref(key).set(value)
    .then(() => {
      clearPendingWrite(key, writeTs);
      window.dispatchEvent(new CustomEvent('db-sync-status', { detail: { state: 'saved', key } }));
    })
    .catch(err => {
      console.warn('[Firebase] Erro ao salvar:', err);
      window.dispatchEvent(new CustomEvent('db-sync-status', { detail: { state: 'error', key } }));
      restoreFullBackup('write-error');
    });
}

// Carrega dados do Firebase uma vez ao iniciar (garante dados frescos)
function pullFromFirebase() {
  return Promise.all(
    SYNC_KEYS.map(key =>
      rtdb.ref(key).once('value').then(snap => {
        const val = snap.val();
        if (val !== null) localStorage.setItem(key, JSON.stringify(val));
      })
    )
  ).then(() => {
    applyPendingWritesToLocal();
    saveLocalBackup('bootstrap', 'all');
    return flushPendingWrites();
  });
}

window.DB_SYNC_READY = pullFromFirebase()
  .then(() => {
    // Salva backup remoto uma vez por sessão após dados carregados — #13
    saveFirebaseBackup();
  })
  .catch(err => {
    console.warn('[Firebase] Erro ao carregar dados iniciais:', err);
  });

// Inicia sincronização assim que o Firebase estiver pronto
startSync();
window.addEventListener('online', () => { flushPendingWrites(); });
