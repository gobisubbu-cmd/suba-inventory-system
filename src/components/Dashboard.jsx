import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, addDoc, serverTimestamp } from 'firebase/firestore';
import { Search, Package } from 'lucide-react';
import { computeStockStatus, STOCK_STATUS_STYLES } from '../lib/brands';

const PAGE_SIZE = 100;

// Dashboard is now the search-first landing page: just the search box and
// the items it matches. Stats, brand breakdown, put-away alerts and recent
// activity have moved to the Overview page; low/out-of-stock items needing
// reorder have moved to the Reorder Items page (see Navigation.jsx).
export default function Dashboard({ userRole, userEmail }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('All');
  const [page, setPage] = useState(0);
  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const brandOptions = useMemo(() => {
    const set = new Set(items.map((it) => it.brand || 'Unassigned'));
    return ['All', ...[...set].sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items.filter((it) => {
      if (brandFilter !== 'All' && (it.brand || 'Unassigned') !== brandFilter) return false;
      if (!s) return true;
      return (
        (it.particulars || '').toLowerCase().includes(s) ||
        (it.partNumber || it.partCode || '').toLowerCase().includes(s) ||
        (it.rackNo || '').toLowerCase().includes(s) ||
        (it.hsnCode || '').toLowerCase().includes(s) ||
        String(it.sno || '').includes(s)
      );
    });
  }, [items, search, brandFilter]);

  useEffect(() => setPage(0), [search, brandFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Package className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by particulars, part number, rack no, HSN code, S.No..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600"
          />
        </div>
        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
          {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <span className="text-sm text-gray-500 pb-2">{filtered.length} of {items.length} items</span>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">S.No</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Brand</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Part Number</th>
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
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={canSeeValue ? 10 : 9} className="px-4 py-8 text-center text-gray-400">
                  {search.trim() ? 'No items found.' : 'Start typing to search the catalogue.'}
                </td>
              </tr>
            )}
            {pageItems.map((it) => {
              const status = computeStockStatus(it);
              const value = Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0);
              return (
                <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">{it.sno}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block bg-emerald-50 text-emerald-800 text-xs font-semibold px-2 py-1 rounded">{it.brand || 'Unassigned'}</span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-emerald-700">{it.partNumber || it.partCode || '-'}</td>
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
                    <span className={`inline-block text-xs font-semibold px-2 py-1 rounded border ${STOCK_STATUS_STYLES[status]}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm text-gray-500">
            <span>Page {page + 1} of {pageCount}</span>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 border rounded disabled:opacity-40">Prev</button>
              <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 border rounded disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
