import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

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
export const db = getFirestore(app);
export default app;
