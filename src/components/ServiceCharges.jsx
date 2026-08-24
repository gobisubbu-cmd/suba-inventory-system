import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { Wallet, Plus, Pencil, Trash2, X, ShieldAlert, IndianRupee } from 'lucide-react';
import { logActivity } from '../lib/activityLog';

// Service charges are money collected on a supply (e.g. "no specific spare
// was advised, so a flat visit/handling charge was billed instead") — they
// are NOT stock movements and must never touch the items/transactions
// collections. This page is a simple standalone ledger: date, reference
// number, party, amount, notes. Kept deliberately separate from Import Data
// so these entries can never accidentally affect stock quantities.
const emptyForm = { date: new Date().toISOString().slice(0, 10), referenceNumber: '', customerName: '', amount: '', notes: '' };

export default function ServiceCharges({ userRole, userEmail }) {
  const [charges, setCharges] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  // Same access level as Import Data's "Record Purchase / Issue / DC" —
  // staff are the ones actually raising these charges out in the field.
  const canEdit = userRole === 'admin' || userRole === 'inventory_manager' || userRole === 'staff';

  useEffect(() => {
    const q = query(collection(db, 'serviceCharges'), orderBy('date', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setCharges(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  // These must run on every render, before any early return below — React
  // requires hooks to be called in the same order every time, and the
  // no-permission return further down would otherwise skip them on some
  // renders and not others.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return charges;
    return charges.filter((c) =>
      [c.referenceNumber, c.customerName, c.notes].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }, [charges, search]);

  const total = useMemo(() => filtered.reduce((sum, c) => sum + (Number(c.amount) || 0), 0), [filtered]);

  if (!canEdit) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Service Charges is not available for this role.</p>
      </div>
    );
  }

  const openAdd = () => {
    setForm(emptyForm);
    setEditing(null);
    setError('');
    setShowForm(true);
  };

  const openEdit = (row) => {
    setForm({
      date: row.date || new Date().toISOString().slice(0, 10),
      referenceNumber: row.referenceNumber || '',
      customerName: row.customerName || '',
      amount: row.amount ?? '',
      notes: row.notes || '',
    });
    setEditing(row);
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setError('');
    if (!form.date) {
      setError('Date is required.');
      return;
    }
    if (!form.referenceNumber.trim()) {
      setError('Reference number is required.');
      return;
    }
    const amount = Number(form.amount);
    if (!amount || amount <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        date: form.date,
        referenceNumber: form.referenceNumber.trim(),
        customerName: form.customerName.trim(),
        amount,
        notes: form.notes.trim(),
      };
      if (editing) {
        await updateDoc(doc(db, 'serviceCharges', editing.id), {
          ...payload,
          updatedAt: serverTimestamp(),
          updatedByEmail: userEmail || '',
        });
        logActivity(userEmail, 'Edited service charge', `${payload.referenceNumber}: ₹${amount}`);
      } else {
        await addDoc(collection(db, 'serviceCharges'), {
          ...payload,
          loggedByEmail: userEmail || '',
          createdAt: serverTimestamp(),
        });
        logActivity(userEmail, 'Added service charge', `${payload.referenceNumber}: ₹${amount}${payload.customerName ? ` · ${payload.customerName}` : ''}`);
      }
      setShowForm(false);
      setForm(emptyForm);
      setEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete the service charge entry for "${row.referenceNumber}" (₹${row.amount})? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'serviceCharges', row.id));
      logActivity(userEmail, 'Deleted service charge', `${row.referenceNumber}: ₹${row.amount}`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Wallet className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Service Charges</h1>
      </div>
      <p className="text-gray-500 text-sm max-w-2xl">
        A simple record of service/handling charges billed on a supply when no specific spare part advice was given
        yet — just the date, reference number, party and amount. This is completely separate from stock: entries
        here never add, remove, or match against any item or inventory quantity.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reference, customer, notes..."
          className="px-3 py-2 border rounded-lg w-72 focus:outline-none focus:border-emerald-600"
        />
        <button
          onClick={openAdd}
          className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg"
        >
          <Plus size={18} /> Add Service Charge
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-lg shadow p-6 space-y-4 border-2 border-emerald-200">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">{editing ? 'Edit' : 'Add'} Service Charge</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
              <X size={20} />
            </button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference Number *</label>
              <input
                type="text"
                value={form.referenceNumber}
                onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
                placeholder="e.g. SK208/26-27"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer / Party</label>
              <input
                type="text"
                value={form.customerName}
                onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
                placeholder="e.g. NONVEE FOODS PRIVATE LIMITED"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹) *</label>
              <input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional — reason, engineer name, etc."
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
          </div>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Entry'}
          </button>
        </div>
      )}

      {error && !showForm && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold text-gray-800">Entries ({filtered.length})</h2>
          <span className="flex items-center gap-1 text-emerald-800 font-bold">
            <IndianRupee size={16} /> {total.toLocaleString('en-IN')}
          </span>
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 italic px-4 py-8 text-center">No service charge entries yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Reference</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Customer / Party</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Amount</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Notes</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Logged By</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">{c.date}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{c.referenceNumber}</td>
                  <td className="px-4 py-3 text-gray-600">{c.customerName || '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">₹{Number(c.amount || 0).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-gray-500">{c.notes || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{c.loggedByEmail || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(c)} className="text-emerald-700 hover:text-emerald-900" title="Edit">
                        <Pencil size={16} />
                      </button>
                      <button onClick={() => handleDelete(c)} className="text-red-500 hover:text-red-700" title="Delete">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
