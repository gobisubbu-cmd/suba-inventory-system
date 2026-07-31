import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { ClipboardList, ChevronDown, ChevronRight, AlertTriangle, PackageX } from 'lucide-react';
import { computeStockStatus, STOCK_STATUS_STYLES } from '../lib/brands';
import { groupByCategory } from '../lib/categorize';

// Dedicated "needs reordering" page (Low Stock + Out of Stock items),
// grouped by category so purchasing can work through one group at a time.
// Categories come from the item's own `category` field when set, otherwise
// they're inferred from the part description (see src/lib/categorize.js).
export default function ReorderItems({ userRole }) {
  const [items, setItems] = useState([]);
  const [brandFilter, setBrandFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const needsReorder = useMemo(
    () => items.filter((it) => {
      const status = computeStockStatus(it);
      return status === 'Low Stock' || status === 'Out of Stock';
    }),
    [items]
  );

  const brandOptions = useMemo(() => {
    const set = new Set(needsReorder.map((it) => it.brand || 'Unassigned'));
    return ['All', ...[...set].sort()];
  }, [needsReorder]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return needsReorder.filter((it) => {
      if (brandFilter !== 'All' && (it.brand || 'Unassigned') !== brandFilter) return false;
      if (!s) return true;
      return (
        (it.particulars || '').toLowerCase().includes(s) ||
        (it.partNumber || it.partCode || '').toLowerCase().includes(s)
      );
    });
  }, [needsReorder, brandFilter, search]);

  const groups = useMemo(() => groupByCategory(filtered), [filtered]);

  const outCount = filtered.filter((it) => computeStockStatus(it) === 'Out of Stock').length;
  const lowCount = filtered.length - outCount;

  const toggle = (cat) => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ClipboardList className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Reorder Items</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Total needing reorder</p>
          <p className="text-lg font-bold text-gray-800">{filtered.length}</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-xs text-red-600 flex items-center gap-1"><PackageX size={12} /> Out of Stock</p>
          <p className="text-lg font-bold text-red-800">{outCount}</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle size={12} /> Low Stock</p>
          <p className="text-lg font-bold text-amber-800">{lowCount}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search particulars or part number..."
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600"
          />
        </div>
        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
          {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      {groups.length === 0 && (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-400">
          Nothing needs reordering right now.
        </div>
      )}

      <div className="space-y-4">
        {groups.map(([category, catItems]) => {
          const isCollapsed = collapsed[category];
          return (
            <div key={category} className="bg-white rounded-lg shadow overflow-hidden">
              <button
                onClick={() => toggle(category)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 border-b hover:bg-gray-100 transition"
              >
                <span className="font-semibold text-gray-700 flex items-center gap-2">
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  {category}
                </span>
                <span className="text-sm text-gray-500">{catItems.length} item{catItems.length > 1 ? 's' : ''}</span>
              </button>
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-gray-600">Brand</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-600">Part Number</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-600">Particulars</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-600">Rack No</th>
                        <th className="text-right px-4 py-2 font-semibold text-gray-600">Current Stock</th>
                        <th className="text-right px-4 py-2 font-semibold text-gray-600">Reorder Level</th>
                        {canSeeValue && <th className="text-right px-4 py-2 font-semibold text-gray-600">Supplier</th>}
                        <th className="text-left px-4 py-2 font-semibold text-gray-600">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catItems
                        .sort((a, b) => Number(a.currentStock || 0) - Number(b.currentStock || 0))
                        .map((it) => {
                          const status = computeStockStatus(it);
                          return (
                            <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                              <td className="px-4 py-2">
                                <span className="inline-block bg-emerald-50 text-emerald-800 text-xs font-semibold px-2 py-1 rounded">{it.brand || 'Unassigned'}</span>
                              </td>
                              <td className="px-4 py-2 font-semibold text-emerald-700">{it.partNumber || it.partCode || '-'}</td>
                              <td className="px-4 py-2 font-medium text-gray-800">{it.particulars}</td>
                              <td className="px-4 py-2">{it.rackNo || '-'}</td>
                              <td className="px-4 py-2 text-right">{it.currentStock}</td>
                              <td className="px-4 py-2 text-right">{it.reorderLevel}</td>
                              {canSeeValue && <td className="px-4 py-2 text-right">{it.supplier || '-'}</td>}
                              <td className="px-4 py-2">
                                <span className={`inline-block text-xs font-semibold px-2 py-1 rounded border ${STOCK_STATUS_STYLES[status]}`}>
                                  {status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
