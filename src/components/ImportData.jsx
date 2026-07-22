import React, { useState, useEffect, useRef } from 'react';
import { db, auth } from '../firebase';
import { collection, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { UploadCloud, ShieldAlert, Trash2, FileSpreadsheet, ScanLine, Loader2, CheckCircle2 } from 'lucide-react';
import { SCAN_BACKEND_URL } from '../scanConfig';

const FIELD_ALIASES = {
  particulars: ['particulars', 'item', 'item name', 'name', 'description', 'material'],
  unit: ['unit', 'uom', 'units'],
  quantity: ['quantity', 'qty', 'opening stock', 'stock', 'current stock', 'stock qty'],
  rackNo: ['rack no', 'rack', 'location', 'bin', 'rack number'],
  hsnCode: ['hsn code', 'hsn', 'hsn/sac'],
  avgCost: ['avg cost', 'average cost', 'rate', 'price', 'unit cost', 'unit price', 'cost'],
  reorderLevel: ['reorder level', 'reorder', 'min level', 'minimum stock', 'min stock'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function mapRow(rawRow) {
  const out = { particulars: '', unit: '', quantity: '', rackNo: '', hsnCode: '', avgCost: '', reorderLevel: '' };
  const keys = Object.keys(rawRow);
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    const matchKey = keys.find((k) => aliases.includes(normalizeHeader(k)));
    if (matchKey && rawRow[matchKey] !== null && rawRow[matchKey] !== undefined) {
      out[field] = rawRow[matchKey];
    }
  });
  return out;
}

function normalizeAiItem(item) {
  return {
    particulars: item.particulars || '',
    unit: item.unit || '',
    quantity: item.quantity ?? '',
    rackNo: item.rackNo || '',
    hsnCode: item.hsnCode || '',
    avgCost: item.avgCost ?? '',
    reorderLevel: item.reorderLevel ?? '',
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ImportData({ userRole }) {
  const [existingItems, setExistingItems] = useState([]);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => {
      setExistingItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin' && userRole !== 'inventory_manager') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Import Data is restricted to Admin and Inventory Manager users.</p>
      </div>
    );
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setSuccess('');
    setRows([]);
    setSourceLabel(file.name);

    const isSpreadsheet = /\.(xlsx|xls|csv)$/i.test(file.name);
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');

    try {
      if (isSpreadsheet) {
        setBusy(true);
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });
        const mapped = rawRows.map(mapRow).filter((r) => r.particulars);
        if (mapped.length === 0) {
          setError('No recognizable item rows found in that spreadsheet. Check the column headers.');
        }
        setRows(mapped);
      } else if (isPdf || isImage) {
        if (!SCAN_BACKEND_URL || SCAN_BACKEND_URL.includes('YOUR-')) {
          setError('The AI scanning backend is not configured yet.');
          return;
        }
        setBusy(true);
        const base64Data = await fileToBase64(file);
        const response = await fetch(`${SCAN_BACKEND_URL}/api/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mimeType: file.type || 'application/pdf', base64Data }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'AI extraction failed.');
        }
        const mapped = (data.items || []).map(normalizeAiItem).filter((r) => r.particulars);
        if (mapped.length === 0) {
          setError('The AI could not find any recognizable stock items in that file.');
        }
        setRows(mapped);
      } else {
        setError('Unsupported file type. Upload an Excel/CSV file, a photo (JPG/PNG), or a PDF.');
      }
    } catch (err) {
      setError(err.message || 'Failed to read that file.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateRow = (idx, field, value) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };

  const removeRow = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleImportAll = async () => {
    setError('');
    setSuccess('');
    const clean = rows.map((r) => ({ ...r, particulars: String(r.particulars || '').trim() })).filter((r) => r.particulars);
    if (clean.length === 0) {
      setError('Nothing to import.');
      return;
    }

    const existingNames = new Set(existingItems.map((it) => it.particulars?.trim().toLowerCase()));
    const seenInBatch = new Set();
    const skipped = [];
    const toImport = [];
    clean.forEach((r) => {
      const key = r.particulars.toLowerCase();
      if (existingNames.has(key) || seenInBatch.has(key)) {
        skipped.push(r.particulars);
      } else {
        seenInBatch.add(key);
        toImport.push(r);
      }
    });

    if (toImport.length === 0) {
      setError('All of these items already exist. Nothing new to import.');
      return;
    }

    setBusy(true);
    try {
      let nextSno = existingItems.length ? Math.max(...existingItems.map((it) => Number(it.sno) || 0)) + 1 : 1;
      for (const r of toImport) {
        const opening = Number(r.quantity) || 0;
        const newItemRef = await addDoc(collection(db, 'items'), {
          sno: nextSno,
          particulars: r.particulars,
          unit: String(r.unit || '').trim(),
          rackNo: String(r.rackNo || '').trim(),
          reorderLevel: Number(r.reorderLevel) || 0,
          hsnCode: String(r.hsnCode || '').trim(),
          avgCost: Number(r.avgCost) || 0,
          currentStock: opening,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (opening > 0) {
          await addDoc(collection(db, 'transactions'), {
            itemId: newItemRef.id,
            itemName: r.particulars,
            type: 'opening',
            direction: 'in',
            quantity: opening,
            reason: `Imported from ${sourceLabel}`,
            performedByEmail: auth.currentUser?.email || '',
            createdAt: serverTimestamp(),
          });
        }
        nextSno += 1;
      }
      setSuccess(
        `Imported ${toImport.length} item(s).` +
          (skipped.length ? ` Skipped ${skipped.length} already-existing item(s): ${skipped.join(', ')}.` : '')
      );
      setRows([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScanLine className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Import Data</h1>
      </div>
      <p className="text-gray-500 text-sm max-w-2xl">
        Upload an Excel/CSV stock list for instant import, or a photo/PDF of a paper stock register, invoice, or
        price list — an AI model will read it and extract the item rows for you to review before anything is
        saved.
      </p>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg cursor-pointer">
            <UploadCloud size={18} />
            Choose File
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,image/*,application/pdf"
              onChange={handleFile}
              className="hidden"
            />
          </label>
          <span className="text-sm text-gray-500 flex items-center gap-2">
            <FileSpreadsheet size={16} /> Excel / CSV, or
            <ScanLine size={16} /> photo / PDF (AI scan)
          </span>
          {busy && (
            <span className="text-sm text-emerald-700 flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Processing {sourceLabel}...
            </span>
          )}
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm flex items-start gap-2">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {success}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="font-semibold text-gray-800">Review extracted rows ({rows.length})</h2>
            <button
              onClick={handleImportAll}
              disabled={busy}
              className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
            >
              {busy ? 'Importing...' : `Import ${rows.length} Item(s)`}
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Particulars</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Unit</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Opening Qty</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Rack No</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">HSN Code</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Avg Cost</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Reorder Level</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="px-2 py-1">
                    <input
                      value={r.particulars}
                      onChange={(e) => updateRow(idx, 'particulars', e.target.value)}
                      className="w-full px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={r.unit}
                      onChange={(e) => updateRow(idx, 'unit', e.target.value)}
                      className="w-20 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={r.quantity}
                      onChange={(e) => updateRow(idx, 'quantity', e.target.value)}
                      className="w-24 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={r.rackNo}
                      onChange={(e) => updateRow(idx, 'rackNo', e.target.value)}
                      className="w-20 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={r.hsnCode}
                      onChange={(e) => updateRow(idx, 'hsnCode', e.target.value)}
                      className="w-24 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={r.avgCost}
                      onChange={(e) => updateRow(idx, 'avgCost', e.target.value)}
                      className="w-24 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={r.reorderLevel}
                      onChange={(e) => updateRow(idx, 'reorderLevel', e.target.value)}
                      className="w-20 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button onClick={() => removeRow(idx)} className="text-red-500 hover:text-red-700" title="Remove row">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
