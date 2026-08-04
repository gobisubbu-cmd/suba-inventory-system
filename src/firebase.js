import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getStorage } from 'firebase/storage';
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
});

// Used once a day for the automatic stock safety-backup — a JSON snapshot of
// the whole catalogue is written here, completely separate from the live
// "items" collection, so a bad import/bug in the app can never touch it.
export const storage = getStorage(app);

export default app;
