import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Wallet, ShieldAlert, TrendingDown, PackageX, Boxes } from 'lucide-react';

export default function InventoryValuation({ userRole }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const stats = useMemo(() => {
    let totalValue = 0;
    let availableStock = 0;
    let lowStock = 0;
    let outOfStock = 0;
    items.forEach((it) => {
      const stock = Number(it.currentStock || 0);
      const cost = Number(it.avgCost || 0);
      totalValue += stock * cost;
      availableStock += stock;
      if (stock <= 0) outOfStock += 1;
      else if (stock <= Number(it.reorderLevel || 0)) lowStock += 1;
    });
    return { totalValue, availableStock, lowStock, outOfStock };
  }, [items]);

  if (userRole !== 'admin' && userRole !== 'inventory_manager') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Inventory Valuation is restricted to Admin and Inventory Manager users.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Wallet className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Inventory Valuation</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Wallet} label="Total Inventory Value" value={`₹${stats.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`} color="emerald" />
        <StatCard icon={Boxes} label="Available Stock (units)" value={stats.availableStock} color="blue" />
        <StatCard icon={TrendingDown} label="Low Stock Alerts" value={stats.lowStock} color="amber" />
        <StatCard icon={PackageX} label="Out of Stock" value={stats.outOfStock} color="red" />
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Particulars</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Current Stock</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Avg Purchase Cost</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Valuation</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{it.particulars}</td>
                <td className="px-4 py-3 text-right">{it.currentStock}</td>
                <td className="px-4 py-3 text-right">₹{Number(it.avgCost || 0).toFixed(2)}</td>
                <td className="px-4 py-3 text-right font-medium">
                  ₹{(Number(it.currentStock || 0) * Number(it.avgCost || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">No items yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const COLORS = {
  emerald: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
};

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <div className={`inline-flex p-2 rounded-lg mb-3 ${COLORS[color]}`}>
        <Icon size={20} />
      </div>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}
