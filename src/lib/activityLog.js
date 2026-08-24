// Central per-user activity trail. Every meaningful action in the app
// (imports, stock movements, item edits, adjustments, issues/returns, user
// management) calls logActivity so an admin can answer "who did what, when"
// from the Activity Log page at any time.
//
// Deliberately fire-and-forget: logging must never block or break the
// action itself, so failures are swallowed silently (worst case is a
// missing log line, never a failed import).
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export function logActivity(userEmail, action, details) {
  try {
    addDoc(collection(db, 'activityLogs'), {
      userEmail: userEmail || 'unknown',
      action: action || '',
      details: details || '',
      createdAt: serverTimestamp(),
    }).catch(() => {});
  } catch {
    // never let logging break the calling action
  }
}
