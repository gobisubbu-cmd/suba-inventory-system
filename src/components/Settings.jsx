import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Settings as SettingsIcon, ShieldAlert, CheckCircle2 } from 'lucide-react';

const DEFAULT_ALERT_EMAIL = 'subabake@gmail.com';

export default function Settings({ userRole }) {
  const [email, setEmail] = useState('');
  const [storesManagerEmail, setStoresManagerEmail] = useState('');
  const [generalManagerEmail, setGeneralManagerEmail] = useState('');
  const [managingDirectorEmail, setManagingDirectorEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'general'));
        if (snap.exists()) {
          const data = snap.data();
          setEmail(data.lowStockAlertEmail || DEFAULT_ALERT_EMAIL);
          setStoresManagerEmail(data.storesManagerEmail || DEFAULT_ALERT_EMAIL);
          setGeneralManagerEmail(data.generalManagerEmail || DEFAULT_ALERT_EMAIL);
          setManagingDirectorEmail(data.managingDirectorEmail || DEFAULT_ALERT_EMAIL);
        } else {
          setEmail(DEFAULT_ALERT_EMAIL);
          setStoresManagerEmail(DEFAULT_ALERT_EMAIL);
          setGeneralManagerEmail(DEFAULT_ALERT_EMAIL);
          setManagingDirectorEmail(DEFAULT_ALERT_EMAIL);
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
        {
          lowStockAlertEmail: email.trim(),
          storesManagerEmail: storesManagerEmail.trim(),
          generalManagerEmail: generalManagerEmail.trim(),
          managingDirectorEmail: managingDirectorEmail.trim(),
          updatedAt: serverTimestamp(),
        },
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
          <h2 className="font-semibold text-gray-800 mb-1">Alert Email (Administrator)</h2>
          <p className="text-sm text-gray-500 mb-3">
            Used for two things: (1) low-stock alerts, sent the moment any item's stock drops to or below its
            reorder level; (2) the daily 9:00 AM warehouse put-away reminder, sent only when there are pending
            locations.
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
            <form onSubmit={handleSave} className="space-y-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                required
              />

              <div className="pt-2 border-t">
                <h3 className="font-semibold text-gray-800 mb-1 mt-3">Warehouse Put-away Escalation</h3>
                <p className="text-sm text-gray-500 mb-3">
                  If any item stays LOCATION PENDING past these thresholds, the daily reminder email is also CC'd to:
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Stores Manager (CC after 3 days pending)</label>
                    <input
                      type="email"
                      value={storesManagerEmail}
                      onChange={(e) => setStoresManagerEmail(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">General Manager (CC after 7 days pending)</label>
                    <input
                      type="email"
                      value={generalManagerEmail}
                      onChange={(e) => setGeneralManagerEmail(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Managing Director (CC after 15 days pending)</label>
                    <input
                      type="email"
                      value={managingDirectorEmail}
                      onChange={(e) => setManagingDirectorEmail(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                </div>
              </div>

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
