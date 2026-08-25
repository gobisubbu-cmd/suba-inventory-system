import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { FileDown, FileSpreadsheet, FileText, ShieldAlert } from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { computeStockStatus } from '../lib/brands';
import { logActivity } from '../lib/activityLog';

// Special permission page: lets a user download the CURRENT STOCK LIST as
// Excel or PDF, but ONLY for the brands/groups the admin has allowed for
// them (users/{uid}.exportBrands, set from Manage Users). Admins can export
// any brand. No cost/value columns are included — this is a quantity list,
// safe to hand to a supervisor. Every download is written to the Activity
// Log so the admin can always see who took which list and when.
export default function StockExport({ userRole, userEmail, exportBrands }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(new Set());

  const isAdmin = userRole === 'admin';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const allBrands = useMemo(
    () => [...new Set(items.map((it) => it.brand || 'Unassigned'))].sort(),
    [items]
  );
  const allowedBrands = useMemo(
    () => (isAdmin ? allBrands : allBrands.filter((b) => (exportBrands || []).includes(b))),
    [isAdmin, allBrands, exportBrands]
  );

  // Default: everything the user is allowed to export starts ticked.
  useEffect(() => {
    setSelected(new Set(allowedBrands));
  }, [allowedBrands.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin && (!exportBrands || exportBrands.length === 0)) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>You don't have stock export permission yet. Ask the admin to allow brands for you in Manage Users.</p>
      </div>
    );
  }

  const toggle = (b) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  };

  const allSelected = allowedBrands.length > 0 && allowedBrands.every((b) => selected.has(b));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allowedBrands));
  };

  const rows = items
    .filter((it) => selected.has(it.brand || 'Unassigned'))
    .map((it) => ({
      'S.No': it.sno || '',
      Brand: it.brand || 'Unassigned',
      'Part Number': it.partNumber || it.partCode || '',
      Particulars: it.particulars || '',
      Unit: it.unit || '',
      'Rack No': it.rackNo || '',
      'Current Stock': Number(it.currentStock || 0),
      Status: computeStockStatus(it),
    }));

  const stamp = new Date().toISOString().slice(0, 10);
  const brandLabel = [...selected].sort().join(', ');

  const downloadExcel = () => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 20 }, { wch: 55 }, { wch: 8 }, { wch: 22 }, { wch: 13 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Current Stock');
    XLSX.writeFile(wb, `current_stock_${stamp}.xlsx`);
    logActivity(userEmail, 'Stock export (Excel)', `${rows.length} items · ${brandLabel}`);
  };

  const downloadPdf = () => {
    if (!rows.length) return;
    const doc = new jsPDF('landscape', 'pt');
    doc.setFontSize(13);
    doc.text(`SUBA Stock — Current Stock List (${stamp})`, 40, 32);
    doc.setFontSize(9);
    doc.text(`Brands: ${brandLabel}`, 40, 48, { maxWidth: 760 });
    autoTable(doc, {
      startY: 62,
      head: [['S.No', 'Brand', 'Part Number', 'Particulars', 'Unit', 'Rack No', 'Stock', 'Status']],
      body: rows.map((r) => [r['S.No'], r.Brand, r['Part Number'], r.Particulars, r.Unit, r['Rack No'], r['Current Stock'], r.Status]),
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [4, 120, 87] },
      columnStyles: { 3: { cellWidth: 260 } },
    });
    doc.save(`current_stock_${stamp}.pdf`);
    logActivity(userEmail, 'Stock export (PDF)', `${rows.length} items · ${brandLabel}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FileDown className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Stock Export</h1>
      </div>
      <p className="text-sm text-gray-500 max-w-2xl">
        Download the current stock list for the brands/groups you are allowed to see.
        {isAdmin ? ' (Admin: all brands available.)' : ''}
      </p>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Choose brands / groups</h2>
          {allowedBrands.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              {allSelected ? 'Deselect all' : 'Select all'}
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {allowedBrands.map((b) => (
            <label
              key={b}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${
                selected.has(b) ? 'bg-emerald-50 border-emerald-400 text-emerald-800 font-semibold' : 'border-gray-300 text-gray-600'
              }`}
            >
              <input type="checkbox" checked={selected.has(b)} onChange={() => toggle(b)} />
              {b}
            </label>
          ))}
          {allowedBrands.length === 0 && (
            <span className="text-gray-400 text-sm">No brands available yet.</span>
          )}
        </div>
        <p className="text-sm text-gray-500">{rows.length} item(s) selected for export.</p>
        <div className="flex gap-3">
          <button
            onClick={downloadExcel}
            disabled={!rows.length}
            className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            <FileSpreadsheet size={18} /> Download Excel
          </button>
          <button
            onClick={downloadPdf}
            disabled={!rows.length}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            <FileText size={18} /> Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}
