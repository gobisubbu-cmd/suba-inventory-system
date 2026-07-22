import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Search, Package } from 'lucide-react';

export default function Dashboard({ userRole }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return items;
    return items.filter(
      (it) =>
        (it.particulars || '').toLowerCase().includes(s) ||
        (it.rackNo || '').toLowerCase().includes(s) ||
        (it.hsnCode || '').toLowerCase().includes(s) ||
        String(it.sno || '').includes(s)
    );
  }, [items, search]);

  const statusFor = (it) => {
    const stock = Number(it.currentStock || 0);
    const reorder = Number(it.reorderLevel || 0);
    if (stock <= 0) return { label: 'Out of Stock', color: 'bg-red-100 text-red-700' };
    if (stock <= reorder) return { label: 'Low Stock', color: 'bg-amber-100 text-amber-700' };
    return { label: 'OK', color: 'bg-green-100 text-green-700' };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Package className="text-emerald-700" size={28} />
          <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by particulars, rack no, HSN code, S.No..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600"
        />
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">S.No</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Particulars</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Unit</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Rack No</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Current Stock</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Reorder Level</th>
              {canSeeValue && (
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Stock Value</th>
              )}
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canSeeValue ? 8 : 7} className="px-4 py-8 text-center text-gray-400">
                  No items found.
                </td>
              </tr>
            )}
            {filtered.map((it) => {
              const status = statusFor(it);
              const value = Number(it.currentStock || 0) * Number(it.avgCost || 0);
              return (
                <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">{it.sno}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{it.particulars}</td>
                  <td className="px-4 py-3">{it.unit}</td>
                  <td className="px-4 py-3">{it.rackNo}</td>
                  <td className="px-4 py-3 text-right">{it.currentStock}</td>
                  <td className="px-4 py-3 text-right">{it.reorderLevel}</td>
                  {canSeeValue && (
                    <td className="px-4 py-3 text-right">
                      ₹{value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${status.color}`}>
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
