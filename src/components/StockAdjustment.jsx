import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { SlidersHorizontal, ShieldAlert } from 'lucide-react';

export default function StockAdjustment({ userRole, userEmail }) {
  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState('');
  const [direction, setDirection] = useState('increase');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('particulars', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Stock Adjustment is restricted to Admin users.</p>
      </div>
    );
  }

  const selectedItem = items.find((it) => it.id === itemId);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!itemId) {
      setError('Select an item.');
      return;
    }
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError('Enter a valid quantity greater than 0.');
      return;
    }
    if (!reason.trim()) {
      setError('A reason is required for stock adjustments.');
      return;
    }

    setSaving(true);
    try {
      await runTransaction(db, async (tx) => {
        const itemRef = doc(db, 'items', itemId);
        const itemSnap = await tx.get(itemRef);
        if (!itemSnap.exists()) throw new Error('Item no longer exists.');
        const current = Number(itemSnap.data().currentStock || 0);
        const delta = direction === 'increase' ? qty : -qty;
        const newStock = current + delta;
        if (newStock < 0) throw new Error('This would make stock negative. Check the quantity.');

        tx.update(itemRef, { currentStock: newStock, updatedAt: serverTimestamp() });

        const txnRef = doc(collection(db, 'transactions'));
        tx.set(txnRef, {
          itemId,
          itemName: itemSnap.data().particulars,
          type: 'adjustment',
          direction: direction === 'increase' ? 'in' : 'out',
          quantity: qty,
          reason: reason.trim(),
          performedByEmail: userEmail || '',
          createdAt: serverTimestamp(),
        });
      });
      setSuccess('Stock adjustment recorded.');
      setQuantity('');
      setReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <SlidersHorizontal className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Stock Adjustment</h1>
      </div>
      <p className="text-gray-500 text-sm">
        Use this only for corrections outside normal purchase/issue flow — e.g. damage, loss, or count corrections. Every adjustment is recorded in the ledger with a reason.
      </p>

      <div className="bg-white rounded-lg shadow p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">{error}</div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded mb-4 text-sm">{success}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Item</label>
            <select
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              required
            >
              <option value="">Select an item...</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>{it.particulars} (current: {it.currentStock})</option>
              ))}
            </select>
          </div>
          {selectedItem && (
            <p className="text-sm text-gray-500">Current stock: {selectedItem.currentStock} {selectedItem.unit}</p>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Adjustment</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2">
                <input type="radio" checked={direction === 'increase'} onChange={() => setDirection('increase')} />
                Increase
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={direction === 'decrease'} onChange={() => setDirection('decrease')} />
                Decrease
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason *</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              placeholder="e.g. Physical count correction, damaged stock..."
              required
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Record Adjustment'}
          </button>
        </form>
      </div>
    </div>
  );
}
