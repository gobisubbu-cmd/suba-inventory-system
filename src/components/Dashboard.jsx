import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, addDoc, serverTimestamp } from 'firebase/firestore';
import { Search, Package, AlertTriangle, PackageX } from 'lucide-react';
import { LOCATION_STATUS, computePutawayStats } from '../putaway';

export default function Dashboard({ userRole, userEmail }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [putawayStats, setPutawayStats] = useState(null);
  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'putawayLines'), (snap) => {
      const pending = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
      setPutawayStats(computePutawayStats(pending));
    });
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return items;
    return items.filter(
      (it) =>
        (it.particulars || '').toLowerCase().includes(s) ||
        (it.partCode || '').toLowerCase().includes(s) ||
        (it.rackNo || '').toLowerCase().includes(s) ||
        (it.hsnCode || '').toLowerCase().includes(s) ||
        String(it.sno || '').includes(s)
    );
  }, [items, search]);

  // Log searches (debounced) so admin can review demand/gaps later.
  useEffect(() => {
    const s = search.trim();
    if (s.length < 2) return;
    const handle = setTimeout(() => {
      addDoc(collection(db, 'searchLogs'), {
        query: s,
        resultsCount: filtered.length,
        userEmail: userEmail || '',
        createdAt: serverTimestamp(),
      }).catch(() => {});
    }, 900);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Items at or below their reorder level, worst (most depleted) first.
  const lowStockItems = useMemo(() => {
    return items
      .filter((it) => {
        const reorder = Number(it.reorderLevel || 0);
        if (reorder <= 0) return false;
        return Number(it.currentStock || 0) <= reorder;
      })
      .sort((a, b) => Number(a.currentStock || 0) - Number(b.currentStock || 0));
  }, [items]);

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

      {putawayStats && putawayStats.pendingItems > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <PackageX className="text-amber-600 shrink-0" size={20} />
            <h2 className="font-bold text-amber-800">Warehouse locations pending</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Purchase Invoices</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingInvoices}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Items</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingItems}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Quantity</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingQty}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Oldest / Newest Pending</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.oldestDays}d / {putawayStats.newestDays}d</p>
            </div>
          </div>
        </div>
      )}

      {lowStockItems.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="text-red-600 shrink-0" size={20} />
            <h2 className="font-bold text-red-800">
              {lowStockItems.length} item{lowStockItems.length > 1 ? 's need' : ' needs'} reordering
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {lowStockItems.map((it) => {
              const stock = Number(it.currentStock || 0);
              const out = stock <= 0;
              return (
                <button
                  key={it.id}
                  onClick={() => setSearch(it.particulars || '')}
                  title="Click to filter the table to this item"
                  className={`text-left px-3 py-2 rounded-lg border text-sm transition hover:shadow ${
                    out
                      ? 'bg-red-100 border-red-300 text-red-800'
                      : 'bg-amber-50 border-amber-300 text-amber-900'
                  }`}
                >
                  <span className="font-semibold">{it.particulars}</span>
                  <span className="block text-xs mt-0.5">
                    {out ? 'Out of stock' : `${stock} ${it.unit || ''} left`} · reorder at {it.reorderLevel}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by particulars, part code, rack no, HSN code, S.No..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600"
        />
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">S.No</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Part Code</th>
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
                <td colSpan={canSeeValue ? 9 : 8} className="px-4 py-8 text-center text-gray-400">
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
                  <td className="px-4 py-3 font-semibold text-emerald-700">{it.partCode || '-'}</td>
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
