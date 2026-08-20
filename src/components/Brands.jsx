import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import { collection, onSnapshot, addDoc, updateDoc, doc, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { Tag, Plus, Pencil, Copy, X } from 'lucide-react';
import { computeStockStatus } from '../lib/brands';

export default function Brands({ userRole, onSelectBrand }) {
  const [brands, setBrands] = useState([]);
  const [items, setItems] = useState([]);
  const [newBrand, setNewBrand] = useState('');
  const [error, setError] = useState('');
  // Edit (rename) uses its own small modal rather than the inline "Add
  // Brand" field, since renaming an existing brand is a different action
  // from creating one. Clone re-uses the inline Add field — it just
  // pre-fills it with "<name> (Copy)" so the user tweaks and submits it
  // through the normal Add Brand flow.
  const [editingBrand, setEditingBrand] = useState(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const canEdit = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'brands'), orderBy('name', 'asc')), (snap) => {
      setBrands(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => {
      setItems(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, []);

  const stats = useMemo(() => {
    const byBrand = {};
    items.forEach((it) => {
      const b = it.brand || 'Unassigned';
      if (!byBrand[b]) byBrand[b] = { total: 0, stocked: 0, notStocked: 0, value: 0 };
      byBrand[b].total += 1;
      const status = computeStockStatus(it);
      if (status === 'Not Stocked') byBrand[b].notStocked += 1;
      else byBrand[b].stocked += 1;
      byBrand[b].value += Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0);
    });
    return byBrand;
  }, [items]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');
    const name = newBrand.trim().toUpperCase();
    if (!name) return;
    if (brands.some((b) => b.name.toUpperCase() === name)) {
      setError('That brand already exists.');
      return;
    }
    await addDoc(collection(db, 'brands'), {
      name,
      createdAt: serverTimestamp(),
      createdByEmail: auth.currentUser?.email || '',
    });
    setNewBrand('');
  };

  const openEdit = (brand) => {
    setEditingBrand(brand);
    setEditName(brand.name);
    setEditError('');
  };

  const openClone = (brand) => {
    setNewBrand(`${brand.name} (Copy)`);
    setError('');
  };

  const handleRename = async (e) => {
    e.preventDefault();
    setEditError('');
    const name = editName.trim().toUpperCase();
    if (!name) {
      setEditError('Brand name is required.');
      return;
    }
    if (brands.some((b) => b.name.toUpperCase() === name && b.id !== editingBrand.id)) {
      setEditError('That brand already exists.');
      return;
    }
    try {
      await updateDoc(doc(db, 'brands', editingBrand.id), { name });
      setEditingBrand(null);
    } catch (err) {
      setEditError(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Tag className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Brands</h1>
      </div>
      <p className="text-sm text-gray-500 max-w-2xl">
        Every spare part belongs to exactly one brand. Add new brands here at any time — they immediately become
        available in Manage Items, Import Data, Spare Search and Reports.
      </p>

      {canEdit && (
        <form onSubmit={handleAdd} className="bg-white rounded-lg shadow p-4 flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label className="block text-xs font-medium text-gray-500 mb-1">New Brand Name</label>
            <input
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
              placeholder="e.g., HOBART"
            />
          </div>
          <button type="submit" className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg">
            <Plus size={16} /> Add Brand
          </button>
        </form>
      )}
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Brand</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Total Parts (Master + Stocked)</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Physically Stocked</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Not Stocked (Catalogue only)</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Inventory Value</th>
              {canEdit && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const s = stats[b.name] || { total: 0, stocked: 0, notStocked: 0, value: 0 };
              return (
                <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onSelectBrand && onSelectBrand(b.name)}
                      className="font-semibold text-emerald-700 hover:text-emerald-900 hover:underline"
                      title={`View ${b.name} stock`}
                    >
                      {b.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">{s.total}</td>
                  <td className="px-4 py-3 text-right">{s.stocked}</td>
                  <td className="px-4 py-3 text-right">{s.notStocked}</td>
                  <td className="px-4 py-3 text-right">₹{s.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(b)} className="text-gray-400 hover:text-emerald-700" title="Edit">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => openClone(b)} className="text-gray-400 hover:text-emerald-700" title="Clone">
                          <Copy size={16} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {brands.length === 0 && (
              <tr><td colSpan={canEdit ? 6 : 5} className="px-4 py-8 text-center text-gray-400">No brands yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingBrand && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-800">Edit Brand</h2>
              <button onClick={() => setEditingBrand(null)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
              Renaming only changes this brand entry. Items already saved under the old name will keep showing
              the old name until each one is opened and re-saved.
            </p>
            {editError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded mb-3 text-sm">{editError}</div>
            )}
            <form onSubmit={handleRename} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Brand Name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg"
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
