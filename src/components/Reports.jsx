import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { BarChart3, Download } from 'lucide-react';
import { daysPending, ageingColour, LOCATION_STATUS } from '../putaway';

function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

function download(filename, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}

export default function Reports({ userRole }) {
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [putawayLines, setPutawayLines] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    const unsubItems = onSnapshot(query(collection(db, 'items'), orderBy('sno', 'asc')), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubTxns = onSnapshot(query(collection(db, 'transactions'), orderBy('createdAt', 'desc')), (snap) => {
      setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubPutaway = onSnapshot(query(collection(db, 'putawayLines'), orderBy('createdAt', 'desc')), (snap) => {
      setPutawayLines(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      unsubItems();
      unsubTxns();
      unsubPutaway();
    };
  }, []);

  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  const filteredTxns = useMemo(() => {
    if (!startDate && !endDate) return transactions;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate + 'T23:59:59') : null;
    return transactions.filter((t) => {
      const d = toDate(t.createdAt);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [transactions, startDate, endDate]);

  const lowStock = items.filter((it) => Number(it.currentStock || 0) <= Number(it.reorderLevel || 0) && Number(it.currentStock || 0) > 0);
  const outOfStock = items.filter((it) => Number(it.currentStock || 0) <= 0);

  const exportStockSummary = () => {
    download(
      'stock_summary.xlsx',
      items.map((it) => ({
        'S.No': it.sno,
        Particulars: it.particulars,
        Unit: it.unit,
        'Rack No': it.rackNo,
        'HSN Code': it.hsnCode,
        'Current Stock': it.currentStock,
        'Reorder Level': it.reorderLevel,
        ...(canSeeValue ? { 'Avg Cost': it.avgCost, 'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || 0) } : {}),
      }))
    );
  };

  const exportLowStock = () => {
    download(
      'low_and_critical_stock.xlsx',
      [...outOfStock, ...lowStock].map((it) => ({
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Reorder Level': it.reorderLevel,
        Status: it.currentStock <= 0 ? 'Out of Stock' : 'Low Stock',
      }))
    );
  };

  const exportMovements = (filterType) => {
    const rows = filteredTxns
      .filter((t) => !filterType || t.type === filterType)
      .map((t) => ({
        Date: toDate(t.createdAt)?.toLocaleString() || '',
        Item: t.itemName,
        Type: t.type,
        Direction: t.direction,
        Quantity: t.quantity,
        'Unit Cost': t.unitCost || '',
        Reason: t.reason,
        'Performed By': t.performedByEmail,
      }));
    const name = filterType ? `${filterType}_movements.xlsx` : 'all_movements.xlsx';
    download(name, rows);
  };

  // --- Warehouse Put-away reports ---

  const exportPutawayReport = () => {
    download(
      'putaway_report.xlsx',
      putawayLines.map((l) => ({
        'Invoice Number': l.invoiceNumber,
        'Invoice Date': l.invoiceDate,
        Supplier: l.supplier,
        'Item Code': l.itemCode,
        Description: l.description,
        'Received Quantity': l.receivedQty,
        'Located Quantity': l.locatedQty,
        'Pending Quantity': l.pendingQty,
        Status: l.status,
      }))
    );
  };

  const exportPendingLocationReport = () => {
    const pending = putawayLines.filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
    download(
      'pending_location_report.xlsx',
      pending.map((l) => ({
        'Invoice Number': l.invoiceNumber,
        'Invoice Date': l.invoiceDate,
        Supplier: l.supplier,
        'Item Code': l.itemCode,
        Description: l.description,
        'Received Qty': l.receivedQty,
        'Located Qty': l.locatedQty,
        'Pending Qty': l.pendingQty,
        'Days Pending': daysPending(l.createdAt),
        Status: l.status,
      }))
    );
  };

  const exportCompletedLocationReport = () => {
    const completed = putawayLines.filter((l) => l.status === LOCATION_STATUS.COMPLETE);
    download(
      'completed_location_report.xlsx',
      completed.map((l) => ({
        'Invoice Number': l.invoiceNumber,
        Item: l.description,
        'Received Qty': l.receivedQty,
        Locations: (l.allocations || []).map((a) => `${a.locationCode} (${a.qty})`).join(', '),
      }))
    );
  };

  const exportAgeingReport = () => {
    const pending = putawayLines.filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
    download(
      'ageing_report.xlsx',
      pending
        .map((l) => ({ ...l, _days: daysPending(l.createdAt) }))
        .sort((a, b) => b._days - a._days)
        .map((l) => ({
          'Invoice Number': l.invoiceNumber,
          Item: l.description,
          'Pending Qty': l.pendingQty,
          'Days Pending': l._days,
          Band: l._days <= 2 ? 'Yellow (1-2 days)' : l._days <= 7 ? 'Orange (3-7 days)' : 'Red (8+ days)',
        }))
    );
  };

  const exportLocationWiseStock = (groupField) => {
    const rollup = {};
    putawayLines.forEach((l) => {
      (l.allocations || []).forEach((a) => {
        const parts = String(a.locationCode || '').split('-');
        const key = groupField === 'rack' ? parts[0] : groupField === 'shelf' ? parts[1] : groupField === 'bin' ? parts[2] : a.locationCode;
        if (!key) return;
        rollup[key] = (rollup[key] || 0) + Number(a.qty || 0);
      });
    });
    download(
      `${groupField}_wise_stock.xlsx`,
      Object.entries(rollup).map(([key, qty]) => ({ [groupField === 'location' ? 'Location Code' : groupField.charAt(0).toUpperCase() + groupField.slice(1)]: key, Quantity: qty }))
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Reports</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Quick Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Stock Summary" onClick={exportStockSummary} />
          <ReportButton label="Low / Critical Stock" onClick={exportLowStock} />
          <ReportButton label="Purchases Only" onClick={() => exportMovements('purchase')} />
          <ReportButton label="Issues Only" onClick={() => exportMovements('issue')} />
          <ReportButton label="All Transactions (raw)" onClick={() => exportMovements(null)} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Warehouse Put-away Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Put-away Report" onClick={exportPutawayReport} />
          <ReportButton label="Pending Location Report" onClick={exportPendingLocationReport} />
          <ReportButton label="Completed Location Report" onClick={exportCompletedLocationReport} />
          <ReportButton label="Ageing Report" onClick={exportAgeingReport} />
          <ReportButton label="Location-wise Stock" onClick={() => exportLocationWiseStock('location')} />
          <ReportButton label="Rack-wise Stock" onClick={() => exportLocationWiseStock('rack')} />
          <ReportButton label="Shelf-wise Stock" onClick={() => exportLocationWiseStock('shelf')} />
          <ReportButton label="Bin-wise Stock" onClick={() => exportLocationWiseStock('bin')} />
        </div>
        <p className="text-xs text-gray-400">
          For full Location History (every location change with user/date/time), see Warehouse Put-away &rarr;
          Location History in the left menu.
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Date-Range Movement Report</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <ReportButton label="Export Range" onClick={() => exportMovements(null)} />
        </div>

        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Type</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Reason</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">By</th>
              </tr>
            </thead>
            <tbody>
              {filteredTxns.slice(0, 50).map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-3 py-2">{toDate(t.createdAt)?.toLocaleString() || ''}</td>
                  <td className="px-3 py-2">{t.itemName}</td>
                  <td className="px-3 py-2 capitalize">{t.type} ({t.direction})</td>
                  <td className="px-3 py-2 text-right">{t.quantity}</td>
                  <td className="px-3 py-2">{t.reason}</td>
                  <td className="px-3 py-2">{t.performedByEmail}</td>
                </tr>
              ))}
              {filteredTxns.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">No transactions in range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReportButton({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-lg text-sm"
    >
      <Download size={16} /> {label}
    </button>
  );
}
