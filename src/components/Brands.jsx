import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import { collection, onSnapshot, addDoc, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { Tag, Plus } from 'lucide-react';
import { computeStockStatus } from '../lib/brands';

export default function Brands({ userRole, onSelectBrand }) {
  const [brands, setBrands] = useState([]);
  const [items, setItems] = useState([]);
  const [newBrand, setNewBrand] = useState('');
  const [error, setError] = useState('');
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
                </tr>
              );
            })}
            {brands.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No brands yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
