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

// Chaves que devem ser sincronizadas com o Firebase
const SYNC_KEYS = ['postos', 'congregacoes', 'distribuicoes', 'postos_init', 'admin_creds', 'sub_admins', 'designacoes', 'categorias'];

// Escuta mudanças em tempo real e atualiza localStorage automaticamente
function startSync() {
  SYNC_KEYS.forEach(key => {
    rtdb.ref(key).on('value', snapshot => {
      const val = snapshot.val();
      if (val !== null) {
        localStorage.setItem(key, JSON.stringify(val));
        // Dispara evento para páginas atualizarem a UI sem recarregar
        window.dispatchEvent(new CustomEvent('db-sync', { detail: { key } }));
      }
    });
  });
}

// Envia dado ao Firebase (chamado pelo DB.set)
function pushToFirebase(key, value) {
  if (SYNC_KEYS.includes(key)) {
    rtdb.ref(key).set(value).catch(err => console.warn('[Firebase] Erro ao salvar:', err));
  }
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
  );
}

// Inicia sincronização assim que o Firebase estiver pronto
startSync();
