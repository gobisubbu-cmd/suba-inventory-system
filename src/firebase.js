import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBrHBwVqRx5TNz9nDahQe7wZsFdZFi2gh0",
  authDomain: "suba-stock-management.firebaseapp.com",
  projectId: "suba-stock-management",
  storageBucket: "suba-stock-management.firebasestorage.app",
  messagingSenderId: "281583872642",
  appId: "1:281583872642:web:a4587df0c8f497c9eae29b"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persistent local cache: the browser keeps a copy of the catalogue on disk
// (IndexedDB) and Firestore only downloads documents that changed since the
// last visit, instead of re-reading all ~7,500 items on every page open.
// This keeps daily read usage far inside the free (Spark) quota.
// persistentMultipleTabManager lets several open tabs share one cache safely.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  // Added 24 Aug 2026: Firestore's default streaming write channel was found
  // hanging on this network (write POSTs to .../Write/channel never got a
  // response, while reads and plain HTTPS worked fine) — so every write from
  // ~Aug 20 sat "pending" forever: blank dates in Search/Activity logs, and
  // items/transactions queued in the browser instead of reaching the server.
  // Something between the browser and Google (proxy/antivirus/VPN-style
  // software) breaks streamed uploads. Forcing long-polling makes Firestore
  // use ordinary request/response HTTPS, which that middleware can't break.
  experimentalForceLongPolling: true,
});

export default app;
