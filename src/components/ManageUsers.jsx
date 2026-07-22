import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import app from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  doc,
  updateDoc,
} from 'firebase/firestore';
import {
  initializeApp,
  deleteApp,
} from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
} from 'firebase/auth';
import { Users, ShieldAlert, UserPlus, Mail } from 'lucide-react';

const ROLES = [
  { id: 'staff', label: 'Staff' },
  { id: 'inventory_manager', label: 'Inventory Manager' },
  { id: 'admin', label: 'Admin' },
];

export default function ManageUsers({ userRole }) {
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('staff');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'users'), orderBy('email', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Manage Users is restricted to Admin users.</p>
      </div>
    );
  }

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!email.trim() || password.length < 6) {
      setError('Enter a valid email and a password of at least 6 characters.');
      return;
    }
    setSaving(true);

    // Use a secondary, temporary Firebase app instance so creating a new
    // user does not sign the current admin out of their own session.
    const secondaryApp = initializeApp(app.options, 'SecondaryUserCreation');
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email.trim(), password);
      await setDoc(doc(db, 'users', cred.user.uid), {
        email: email.trim(),
        role,
        createdAt: new Date(),
      });
      await secondaryAuth.signOut();
      setSuccess(`User ${email.trim()} created with role ${role}.`);
      setEmail('');
      setPassword('');
      setRole('staff');
    } catch (err) {
      setError(err.message);
    } finally {
      await deleteApp(secondaryApp);
      setSaving(false);
    }
  };

  const handleRoleChange = async (u, newRole) => {
    try {
      await updateDoc(doc(db, 'users', u.id), { role: newRole });
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResetPassword = async (u) => {
    setError('');
    setSuccess('');
    const secondaryApp = initializeApp(app.options, 'SecondaryReset' + Date.now());
    const secondaryAuth = getAuth(secondaryApp);
    try {
      await sendPasswordResetEmail(secondaryAuth, u.email);
      setSuccess(`Password reset email sent to ${u.email}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      await deleteApp(secondaryApp);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Users className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Manage Users</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <UserPlus size={18} /> Create New User
        </h2>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">{error}</div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded mb-4 text-sm">{success}</div>
        )}
        <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              placeholder="At least 6 characters"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-4">
            <button
              type="submit"
              disabled={saving}
              className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Role</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u, e.target.value)}
                    className="px-2 py-1 border rounded-lg text-sm"
                  >
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleResetPassword(u)}
                    className="flex items-center gap-1 text-emerald-700 hover:underline text-sm"
                  >
                    <Mail size={14} /> Send password reset
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-400">No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
