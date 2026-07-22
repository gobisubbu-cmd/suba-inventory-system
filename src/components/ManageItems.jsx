import React, { useState, useEffect } from 'react';
import { db, auth } from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { Boxes, Plus, Pencil, ArrowLeftRight, X } from 'lucide-react';

const MOVEMENT_TYPES = [
  { id: 'purchase', label: 'Purchase (In)', direction: 'in' },
  { id: 'return', label: 'Return (In)', direction: 'in' },
  { id: 'issue', label: 'Issue (Out)', direction: 'out' },
  { id: 'dc', label: 'Delivery Challan (Out)', direction: 'out' },
];

export default function ManageItems({ userRole }) {
  const [items, setItems] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [movementItem, setMovementItem] = useState(null);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    particulars: '',
    unit: '',
    rackNo: '',
    reorderLevel: '',
    hsnCode: '',
    avgCost: '',
    openingStock: '',
  });

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const resetForm = () => {
    setForm({ particulars: '', unit: '', rackNo: '', reorderLevel: '', hsnCode: '', avgCost: '', openingStock: '' });
    setEditingItem(null);
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (item) => {
    setEditingItem(item);
    setForm({
      particulars: item.particulars || '',
      unit: item.unit || '',
      rackNo: item.rackNo || '',
      reorderLevel: item.reorderLevel ?? '',
      hsnCode: item.hsnCode || '',
      avgCost: item.avgCost ?? '',
      openingStock: '',
    });
    setError('');
    setShowForm(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    const name = form.particulars.trim();
    if (!name) {
      setError('Particulars is required.');
      return;
    }
    const duplicate = items.some(
      (it) => it.particulars?.trim().toLowerCase() === name.toLowerCase() && it.id !== editingItem?.id
    );
    if (duplicate) {
      setError('An item with this name already exists. Item names must be unique.');
      return;
    }

    try {
      if (editingItem) {
        await updateDoc(doc(db, 'items', editingItem.id), {
          particulars: name,
          unit: form.unit.trim(),
          rackNo: form.rackNo.trim(),
          reorderLevel: Number(form.reorderLevel) || 0,
          hsnCode: form.hsnCode.trim(),
          avgCost: Number(form.avgCost) || 0,
          updatedAt: serverTimestamp(),
        });
      } else {
        const nextSno = items.length ? Math.max(...items.map((it) => Number(it.sno) || 0)) + 1 : 1;
        const opening = Number(form.openingStock) || 0;
        const newItemRef = await addDoc(collection(db, 'items'), {
          sno: nextSno,
          particulars: name,
          unit: form.unit.trim(),
          rackNo: form.rackNo.trim(),
          reorderLevel: Number(form.reorderLevel) || 0,
          hsnCode: form.hsnCode.trim(),
          avgCost: Number(form.avgCost) || 0,
          currentStock: opening,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (opening > 0) {
          await addDoc(collection(db, 'transactions'), {
            itemId: newItemRef.id,
            itemName: name,
            type: 'opening',
            direction: 'in',
            quantity: opening,
            reason: 'Opening stock',
            performedByEmail: auth.currentUser?.email || '',
            createdAt: serverTimestamp(),
          });
        }
      }
      setShowForm(false);
      resetForm();
    } catch (err) {
      setError(err.message);
    }
  };

  const canEdit = userRole === 'admin' || userRole === 'inventory_manager';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Boxes className="text-emerald-700" size={28} />
          <h1 className="text-3xl font-bold text-gray-800">Manage Items</h1>
        </div>
        {canEdit && (
          <button
            onClick={openAdd}
            className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg"
          >
            <Plus size={18} /> Add New Item
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">S.No</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Particulars</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Unit</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Rack No</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">HSN Code</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Current Stock</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Reorder Level</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Avg Cost</th>
              {canEdit && <th className="text-left px-4 py-3 font-semibold text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">{it.sno}</td>
                <td className="px-4 py-3 font-medium text-gray-800">{it.particulars}</td>
                <td className="px-4 py-3">{it.unit}</td>
                <td className="px-4 py-3">{it.rackNo}</td>
                <td className="px-4 py-3">{it.hsnCode}</td>
                <td className="px-4 py-3 text-right">{it.currentStock}</td>
                <td className="px-4 py-3 text-right">{it.reorderLevel}</td>
                <td className="px-4 py-3 text-right">₹{Number(it.avgCost || 0).toFixed(2)}</td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(it)} className="text-gray-500 hover:text-emerald-700" title="Edit">
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => setMovementItem(it)}
                        className="text-gray-500 hover:text-emerald-700"
                        title="Record Movement"
                      >
                        <ArrowLeftRight size={16} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  No items yet. Click "Add New Item" to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-800">{editingItem ? 'Edit Item' : 'Add New Item'}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">
                {error}
              </div>
            )}
            <form onSubmit={handleSave} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Particulars *</label>
                <input
                  type="text"
                  value={form.particulars}
                  onChange={(e) => setForm({ ...form, particulars: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                  <input
                    type="text"
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="pcs, kg, box..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rack No</label>
                  <input
                    type="text"
                    value={form.rackNo}
                    onChange={(e) => setForm({ ...form, rackNo: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Level</label>
                  <input
                    type="number"
                    value={form.reorderLevel}
                    onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">HSN Code</label>
                  <input
                    type="text"
                    value={form.hsnCode}
                    onChange={(e) => setForm({ ...form, hsnCode: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Avg Cost (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.avgCost}
                    onChange={(e) => setForm({ ...form, avgCost: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
                {!editingItem && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Opening Stock</label>
                    <input
                      type="number"
                      value={form.openingStock}
                      onChange={(e) => setForm({ ...form, openingStock: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                )}
              </div>
              <button
                type="submit"
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg mt-2"
              >
                {editingItem ? 'Save Changes' : 'Add Item'}
              </button>
            </form>
          </div>
        </div>
      )}

      {movementItem && (
        <MovementModal item={movementItem} onClose={() => setMovementItem(null)} />
      )}
    </div>
  );
}

function MovementModal({ item, onClose }) {
  const [type, setType] = useState('purchase');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError('Enter a valid quantity greater than 0.');
      return;
    }
    const movement = MOVEMENT_TYPES.find((m) => m.id === type);
    setSaving(true);
    try {
      await runTransaction(db, async (tx) => {
        const itemRef = doc(db, 'items', item.id);
        const itemSnap = await tx.get(itemRef);
        if (!itemSnap.exists()) throw new Error('Item no longer exists.');
        const current = Number(itemSnap.data().currentStock || 0);
        const delta = movement.direction === 'in' ? qty : -qty;
        const newStock = current + delta;
        if (newStock < 0) throw new Error('This would make stock negative. Check the quantity.');

        const updates = { currentStock: newStock, updatedAt: serverTimestamp() };
        if (movement.id === 'purchase' && unitCost) {
          updates.avgCost = Number(unitCost);
        }
        tx.update(itemRef, updates);

        const txnRef = doc(collection(db, 'transactions'));
        tx.set(txnRef, {
          itemId: item.id,
          itemName: item.particulars,
          type: movement.id,
          direction: movement.direction,
          quantity: qty,
          unitCost: unitCost ? Number(unitCost) : null,
          reason: reason.trim(),
          performedByEmail: auth.currentUser?.email || '',
          createdAt: serverTimestamp(),
        });
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">Record Movement — {item.particulars}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">Current stock: {item.currentStock} {item.unit}</p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Movement Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
            >
              {MOVEMENT_TYPES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
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
          {type === 'purchase' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit Cost (₹, optional — updates Avg Cost)</label>
              <input
                type="number"
                step="0.01"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason / Reference</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              placeholder="Invoice no., customer, notes..."
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Record Movement'}
          </button>
        </form>
      </div>
    </div>
  );
}
