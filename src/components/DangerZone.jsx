import React, { useState } from 'react';
import { db } from '../firebase';
import { collection, getDocs, writeBatch } from 'firebase/firestore';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

const CONFIRM_PHRASE = 'DELETE-ALL-DATA';

export default function DangerZone({ userRole }) {
  const [confirmText, setConfirmText] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (userRole !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Danger Zone is restricted to Admin users.</p>
      </div>
    );
  }

  const wipeCollection = async (name) => {
    const snap = await getDocs(collection(db, name));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return docs.length;
  };

  const handleWipe = async () => {
    setError('');
    setMessage('');
    if (confirmText !== CONFIRM_PHRASE) {
      setError(`Type "${CONFIRM_PHRASE}" exactly to confirm.`);
      return;
    }
    setWorking(true);
    try {
      const itemsDeleted = await wipeCollection('items');
      const txnsDeleted = await wipeCollection('transactions');
      setMessage(`Wiped ${itemsDeleted} items and ${txnsDeleted} transactions. User accounts were left untouched.`);
      setConfirmText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <AlertTriangle className="text-red-600" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Danger Zone</h1>
      </div>

      <div className="bg-red-50 border border-red-200 rounded-lg p-6 space-y-4">
        <p className="text-red-800 font-semibold">Wipe all stock data</p>
        <p className="text-sm text-red-700">
          This permanently deletes every item and every transaction (the full ledger). User accounts are not affected.
          This cannot be undone. Only do this to reset a demo/test environment.
        </p>
        {error && (
          <div className="bg-white border border-red-300 text-red-700 px-4 py-2 rounded text-sm">{error}</div>
        )}
        {message && (
          <div className="bg-white border border-green-300 text-green-700 px-4 py-2 rounded text-sm">{message}</div>
        )}
        <div>
          <label className="block text-sm font-medium text-red-800 mb-1">
            Type <span className="font-mono">{CONFIRM_PHRASE}</span> to confirm
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="w-full px-3 py-2 border border-red-300 rounded-lg focus:outline-none focus:border-red-500"
          />
        </div>
        <button
          onClick={handleWipe}
          disabled={working || confirmText !== CONFIRM_PHRASE}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-40"
        >
          {working ? 'Wiping...' : 'Permanently Delete All Stock Data'}
        </button>
      </div>
    </div>
  );
}
