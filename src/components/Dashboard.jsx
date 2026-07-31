import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, limit, addDoc, serverTimestamp } from 'firebase/firestore';
import { Search, Package, AlertTriangle, PackageX, Wallet, Layers, PackageCheck, Clock } from 'lucide-react';
import { LOCATION_STATUS, computePutawayStats } from '../putaway';
import { computeStockStatus, STOCK_STATUS_STYLES } from '../lib/brands';

const PAGE_SIZE = 100;

export default function Dashboard({ userRole, userEmail }) {
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('All');
  const [page, setPage] = useState(0);
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
    const q = query(collection(db, 'transactions'), orderBy('createdAt', 'desc'), limit(30));
    const unsub = onSnapshot(q, (snap) => {
      setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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

  const summary = useMemo(() => {
    let totalValue = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let notStocked = 0;
    let pendingReorder = 0;
    const byBrand = {};
    items.forEach((it) => {
      const status = computeStockStatus(it);
      const value = Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0);
      totalValue += value;
      if (status === 'Low Stock') { lowStock += 1; pendingReorder += 1; }
      if (status === 'Out of Stock') { outOfStock += 1; pendingReorder += 1; }
      if (status === 'Not Stocked') notStocked += 1;
      const b = it.brand || 'Unassigned';
      byBrand[b] = (byBrand[b] || 0) + 1;
    });
    return { totalValue, lowStock, outOfStock, notStocked, pendingReorder, total: items.length, byBrand };
  }, [items]);

  const lowStockItems = useMemo(() => {
    return items
      .filter((it) => computeStockStatus(it) === 'Low Stock' || computeStockStatus(it) === 'Out of Stock')
      .sort((a, b) => Number(a.currentStock || 0) - Number(b.currentStock || 0))
      .slice(0, 24);
  }, [items]);

  const brandOptions = ['All', ...Object.keys(summary.byBrand).sort()];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Package className="text-emerald-700" size={28} />
          <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard icon={Layers} label="Total Spare Parts" value={summary.total.toLocaleString('en-IN')} />
        {canSeeValue && (
          <SummaryCard icon={Wallet} label="Total Inventory Value" value={`₹${summary.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} />
        )}
        <SummaryCard icon={AlertTriangle} label="Low + Out of Stock" value={summary.pendingReorder.toLocaleString('en-IN')} tone="amber" />
        <SummaryCard icon={PackageX} label="Not Stocked (catalogue only)" value={summary.notStocked.toLocaleString('en-IN')} tone="gray" />
      </div>

      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2"><Layers size={16} /> Brand-wise Stock</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary.byBrand).sort().map(([brand, count]) => (
            <button
              key={brand}
              onClick={() => setBrandFilter(brand)}
              className={`px-3 py-2 rounded-lg border text-sm ${brandFilter === brand ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'}`}
            >
              {brand}: <span className="font-semibold">{count}</span>
            </button>
          ))}
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
              {summary.pendingReorder} item{summary.pendingReorder > 1 ? 's need' : ' needs'} reordering (showing first 24)
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
                    out ? 'bg-red-100 border-red-300 text-red-800' : 'bg-amber-50 border-amber-300 text-amber-900'
                  }`}
                >
                  <span className="font-semibold">[{it.brand || '—'}] {it.particulars}</span>
                  <span className="block text-xs mt-0.5">
                    {out ? 'Out of stock' : `${stock} ${it.unit || ''} left`} · reorder at {it.reorderLevel}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <RecentActivity title="Recently Issued Parts" icon={PackageX} tone="red" txns={transactions.filter((t) => t.direction === 'out').slice(0, 8)} />
        <RecentActivity title="Recently Purchased Parts" icon={PackageCheck} tone="green" txns={transactions.filter((t) => t.type === 'purchase' || t.type === 'opening').slice(0, 8)} />
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
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
                  No items found.
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

function SummaryCard({ icon: Icon, label, value, tone = 'emerald' }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-gray-100 text-gray-600',
  };
  return (
    <div className="bg-white rounded-lg shadow p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${tones[tone]}`}><Icon size={20} /></div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-lg font-bold text-gray-800">{value}</p>
      </div>
    </div>
  );
}

function RecentActivity({ title, icon: Icon, tone, txns }) {
  const tones = { red: 'text-red-600', green: 'text-green-600' };
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2"><Icon size={16} className={tones[tone]} /> {title}</h2>
      {txns.length === 0 ? (
        <p className="text-sm text-gray-400">No recent activity.</p>
      ) : (
        <ul className="space-y-2">
          {txns.map((t) => (
            <li key={t.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
              <div>
                <span className="font-medium text-gray-800">{t.itemName}</span>
                {t.brand && <span className="text-gray-400 ml-1">[{t.brand}]</span>}
              </div>
              <div className="flex items-center gap-2 text-gray-500">
                <span>{t.quantity}</span>
                <Clock size={12} />
                <span className="text-xs">{t.createdAt?.toDate ? t.createdAt.toDate().toLocaleDateString() : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
