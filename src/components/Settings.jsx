import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Settings as SettingsIcon, ShieldAlert, CheckCircle2 } from 'lucide-react';

const DEFAULT_ALERT_EMAIL = 'subabake@gmail.com';

export default function Settings({ userRole }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'general'));
        if (snap.exists() && snap.data().lowStockAlertEmail) {
          setEmail(snap.data().lowStockAlertEmail);
        } else {
          setEmail(DEFAULT_ALERT_EMAIL);
        }
      } catch (e) {
        setEmail(DEFAULT_ALERT_EMAIL);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (userRole !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Settings is restricted to Admin users.</p>
      </div>
    );
  }

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!email.trim()) {
      setError('Enter an email address.');
      return;
    }
    setSaving(true);
    try {
      await setDoc(
        doc(db, 'settings', 'general'),
        { lowStockAlertEmail: email.trim(), updatedAt: serverTimestamp() },
        { merge: true }
      );
      setSuccess('Saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Settings</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-gray-800 mb-1">Low Stock Alert Email</h2>
          <p className="text-sm text-gray-500 mb-3">
            When any item's stock drops to or below its reorder level, an email alert is sent to this
            address automatically.
          </p>
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-3 text-sm">{error}</div>
          )}
          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded mb-3 text-sm flex items-center gap-2">
              <CheckCircle2 size={16} /> {success}
            </div>
          )}
          {!loading && (
            <form onSubmit={handleSave} className="flex flex-wrap gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 min-w-[240px] px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                required
              />
              <button
                type="submit"
                disabled={saving}
                className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
