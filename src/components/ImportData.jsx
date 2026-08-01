import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  updateDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  query,
  where,
  getDocs,
  orderBy,
  limit,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import {
  UploadCloud,
  ShieldAlert,
  Trash2,
  FileSpreadsheet,
  ScanLine,
  Loader2,
  CheckCircle2,
  PackagePlus,
  ArrowLeftRight,
  AlertTriangle,
  History,
} from 'lucide-react';
import { SCAN_BACKEND_URL } from '../scanConfig';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import { createPutawayLine, getExistingLocationsForItem } from '../putaway';
import { fetchBrands, ensureSeedBrands, allPartNumbers } from '../lib/brands';

const FIELD_ALIASES = {
  particulars: ['particulars', 'particular', 'item', 'item name', 'name', 'part name', 'material', 'description'],
  description: ['description', 'part description'],
  partCode: ['part number', 'part no', 'partno', 'part code', 'code', 'item code', 'new part number'],
  oldPartCode: ['old part number', 'old part no', 'superseded by', 'replaced by'],
  unit: ['unit', 'uom', 'units', 'unit of measure'],
  quantity: ['quantity', 'qty', 'opening stock', 'stock', 'current stock', 'stock qty'],
  rackNo: ['rack no', 'rack', 'location', 'bin', 'rack number', 'storage location', 'storage area'],
  hsnCode: ['hsn code', 'hsn', 'hsn/sac'],
  avgCost: ['avg cost', 'average cost', 'rate', 'unit cost', 'cost'],
  purchaseCost: ['standard purchase cost', 'purchase cost', 'purchase price'],
  sellingPrice: ['standard selling price', 'selling price', 'selling cost', 'price', 'non-binding recommended retail gross price', 'standard selling price (inr, indicative)'],
  reorderLevel: ['reorder level', 'reorder', 'min level', 'minimum stock', 'min stock'],
  minStock: ['minimum stock', 'min stock'],
  maxStock: ['maximum stock', 'max stock'],
  category: ['category'],
  machineModels: ['machine model(s)', 'machine model', 'model', 'models'],
  supplier: ['supplier'],
  notes: ['notes', 'remarks', 'notes / source'],
};

const MOVEMENT_TYPES = [
  { id: 'purchase', label: 'Purchase (In)', direction: 'in' },
  { id: 'return', label: 'Return (In)', direction: 'in' },
  { id: 'issue', label: 'Issue (Out)', direction: 'out' },
  { id: 'dc', label: 'Delivery Challan / Sale (Out)', direction: 'out' },
];

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

const NUMERIC_FIELDS = ['quantity', 'avgCost', 'purchaseCost', 'sellingPrice', 'reorderLevel', 'minStock', 'maxStock'];

// Real-world invoices/DCs/handwritten chits write numbers messily — "1 No.",
// "3 Nos.", "Rs. 1,250/-", "₹150" — pull out just the numeric core so these
// don't silently become 0 / NaN downstream.
function cleanNumeric(v) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v).replace(/,/g, '');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? m[0] : v;
}

function mapRow(rawRow) {
  const out = {};
  Object.keys(FIELD_ALIASES).forEach((f) => (out[f] = ''));
  const keys = Object.keys(rawRow);
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    const matchKey = keys.find((k) => aliases.includes(normalizeHeader(k)));
    if (matchKey && rawRow[matchKey] !== null && rawRow[matchKey] !== undefined) {
      out[field] = rawRow[matchKey];
    }
  });
  NUMERIC_FIELDS.forEach((f) => {
    out[f] = cleanNumeric(out[f]);
  });
  return out;
}

function normalizeAiItem(item) {
  return {
    particulars: item.particulars || '',
    description: item.description || '',
    partCode: item.partCode || '',
    oldPartCode: item.oldPartCode || '',
    unit: item.unit || '',
    quantity: cleanNumeric(item.quantity ?? ''),
    rackNo: item.rackNo || '',
    hsnCode: item.hsnCode || '',
    avgCost: cleanNumeric(item.avgCost ?? ''),
    purchaseCost: cleanNumeric(item.purchaseCost ?? ''),
    sellingPrice: cleanNumeric(item.sellingPrice ?? ''),
    reorderLevel: cleanNumeric(item.reorderLevel ?? ''),
    minStock: cleanNumeric(item.minStock ?? ''),
    maxStock: cleanNumeric(item.maxStock ?? ''),
    category: item.category || '',
    machineModels: item.machineModels || '',
    supplier: item.supplier || '',
    notes: item.notes || '',
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

function findBestMatch(name, existingItems, partCode) {
  const tryMatchByText = (target) => {
    if (!target) return null;
    let match = existingItems.find((it) => it.particulars?.trim().toLowerCase() === target);
    if (match) return match;
    match = existingItems.find(
      (it) =>
        it.particulars?.trim().toLowerCase().includes(target) ||
        target.includes(it.particulars?.trim().toLowerCase())
    );
    return match || null;
  };
  const tryMatchByPartNumber = (code) => {
    if (!code) return null;
    const target = String(code).trim().toLowerCase();
    if (!target) return null;
    return (
      existingItems.find((it) =>
        allPartNumbers(it).some((pn) => String(pn).trim().toLowerCase() === target)
      ) || null
    );
  };
  const nameTarget = String(name || '').trim().toLowerCase();
  const codeTarget = String(partCode || '').trim().toLowerCase();
  // Real-world invoices/DCs often list a part CODE in what looks like a
  // "Particulars" column — try an exact part-number match first (covers
  // both the dedicated partCode field and the case where the particulars
  // text itself is actually a part code), then fall back to fuzzy text.
  return (
    tryMatchByPartNumber(codeTarget) ||
    tryMatchByPartNumber(nameTarget) ||
    tryMatchByText(nameTarget)
  );
}

const ALL_ALIASES = new Set(Object.values(FIELD_ALIASES).flat());

// Real invoices/DCs/registers frequently have a handful of metadata rows
// (company name, document number, date, customer) above the actual item
// table. Scan for the first row that looks like a real header — i.e. has
// at least two cells matching a known column alias — instead of blindly
// assuming row 1 is the header.
function findHeaderRowIndex(grid) {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!Array.isArray(row)) continue;
    const matches = row.filter((cell) => ALL_ALIASES.has(normalizeHeader(cell))).length;
    if (matches >= 2) return i;
  }
  return 0;
}

const DOC_TYPE_LABELS = {
  purchase: 'Purchase Invoice',
  dc: 'Delivery Challan',
  issue: 'Sales Invoice',
  return: 'Return / Credit Note',
};

// Real invoices/DCs/chits usually have a few header rows above the item
// table (company name, document number, date, customer/supplier). Scan
// those rows for common clues so we can (a) guess whether this document is
// a Purchase / DC / Sale / Return, and (b) pre-fill the reference number
// and party name instead of making the person retype them.
function detectDocumentMeta(metaRows) {
  const fieldMap = {};
  const blobParts = [];
  (metaRows || []).forEach((row) => {
    if (!Array.isArray(row)) return;
    const cells = row.map((c) => (c === null || c === undefined ? '' : String(c).trim())).filter(Boolean);
    cells.forEach((c) => blobParts.push(c));
    if (cells.length >= 2) {
      fieldMap[normalizeHeader(cells[0])] = cells[1];
    }
  });
  const blob = blobParts.join(' | ');

  let documentType = null;
  if (/delivery\s*(note|challan)/i.test(blob)) documentType = 'dc';
  else if (/credit\s*note|sales?\s*return|purchase\s*return/i.test(blob)) documentType = 'return';
  else if (/purchase\s*(invoice|order|bill)/i.test(blob)) documentType = 'purchase';
  else if (/tax\s*invoice|sale\s*invoice|bill of supply|\binvoice\b/i.test(blob)) documentType = 'issue';

  let documentNumber = null;
  for (const [label, value] of Object.entries(fieldMap)) {
    if (/no\.?$|number$/i.test(label) && !/hsn|gst|pan|phone|mobile/i.test(label)) {
      documentNumber = value;
      break;
    }
  }
  if (!documentNumber) {
    const m = blob.match(/(?:d\.?c\.?|delivery\s*note|invoice|order|challan)[^\d]{0,15}(\d[\w\-/]*)/i);
    if (m) documentNumber = m[1];
  }

  let partyName = null;
  for (const [label, value] of Object.entries(fieldMap)) {
    if (/customer|supplier|party|buyer|vendor/i.test(label)) {
      partyName = value;
      break;
    }
  }

  let documentDate = null;
  for (const [label, value] of Object.entries(fieldMap)) {
    if (/date$/i.test(label)) {
      documentDate = value;
      break;
    }
  }

  if (!documentType && !documentNumber && !partyName) return null;
  return { documentType, documentNumber, partyName, documentDate };
}

const AI_DOC_TYPE_MAP = {
  purchase_invoice: 'purchase',
  delivery_challan: 'dc',
  sales_invoice: 'issue',
  credit_note: 'return',
  stock_register: null,
  price_list: null,
  other: null,
};

function mapAiDocumentMeta(docInfo) {
  if (!docInfo) return null;
  const documentType = AI_DOC_TYPE_MAP[docInfo.documentType] ?? null;
  if (!documentType && !docInfo.documentNumber && !docInfo.partyName) return null;
  return {
    documentType,
    documentNumber: docInfo.documentNumber || null,
    partyName: docInfo.partyName || null,
    documentDate: docInfo.documentDate || null,
  };
}

async function extractRowsFromFile(file) {
  const isSpreadsheet = /\.(xlsx|xls|csv)$/i.test(file.name);
  const isPdf = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (isSpreadsheet) {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const headerIdx = findHeaderRowIndex(grid);
    const headers = (grid[headerIdx] || []).map((h) => String(h || '').trim());
    const rawRows = grid
      .slice(headerIdx + 1)
      .filter((r) => Array.isArray(r) && r.some((c) => c !== null && String(c).trim() !== ''))
      .map((r) => {
        const obj = {};
        headers.forEach((h, idx) => {
          if (h) obj[h] = r[idx] ?? null;
        });
        return obj;
      });
    const rows = rawRows
      .map(mapRow)
      .filter((r) => r.particulars && !/^total\b/i.test(String(r.particulars).trim()));
    const meta = detectDocumentMeta(grid.slice(0, headerIdx));
    return { rows, meta };
  }

  if (isPdf || isImage) {
    if (!SCAN_BACKEND_URL || SCAN_BACKEND_URL.includes('YOUR-')) {
      throw new Error('The AI scanning backend is not configured yet.');
    }
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
    const rows = (data.items || []).map(normalizeAiItem).filter((r) => r.particulars);
    const meta = mapAiDocumentMeta(data.document);
    return { rows, meta };
  }

  throw new Error('Unsupported file type. Upload an Excel/CSV file, a photo (JPG/PNG), or a PDF.');
}

export default function ImportData({ userRole, userEmail }) {
  const [mode, setMode] = useState('newItems'); // 'newItems' | 'movement'
  const [existingItems, setExistingItems] = useState([]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScanLine className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Import Data</h1>
      </div>

      <div className="flex gap-2 bg-gray-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setMode('newItems')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'newItems' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <PackagePlus size={16} /> Brand Catalogue / Stock Import
        </button>
        <button
          onClick={() => setMode('movement')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'movement' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <ArrowLeftRight size={16} /> Record Purchase / Issue / DC
        </button>
      </div>

      {mode === 'newItems' ? (
        <NewItemsImport existingItems={existingItems} userEmail={userEmail} onSuggestMovement={() => setMode('movement')} />
      ) : (
        <MovementImport existingItems={existingItems} userEmail={userEmail} />
      )}
    </div>
  );
}

function NewItemsImport({ existingItems, userEmail, onSuggestMovement }) {
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [importMode, setImportMode] = useState('upsert'); // 'upsert' | 'replace'
  const [confirmText, setConfirmText] = useState('');
  const [rows, setRows] = useState([]);
  const [updateStockOnMatch, setUpdateStockOnMatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [detectedMeta, setDetectedMeta] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    ensureSeedBrands(userEmail).then(() => fetchBrands().then(setBrands));
  }, [userEmail]);

  const brandItems = useMemo(() => existingItems.filter((it) => it.brand === brand), [existingItems, brand]);

  const duplicatesInFile = useMemo(() => {
    const seen = new Map();
    const dups = new Set();
    rows.forEach((r) => {
      const key = String(r.partCode || r.particulars || '').trim().toLowerCase();
      if (!key) return;
      if (seen.has(key)) dups.add(key);
      seen.set(key, true);
    });
    return dups;
  }, [rows]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setSuccess('');
    setRows([]);
    setDetectedMeta(null);
    setSourceLabel(file.name);
    setBusy(true);
    try {
      const { rows: mapped, meta } = await extractRowsFromFile(file);
      if (mapped.length === 0) {
        setError('No recognizable item rows found in that file.');
      }
      setRows(mapped);
      setDetectedMeta(meta);
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

  const logImportHistory = async (summary) => {
    await addDoc(collection(db, 'importHistory'), {
      brand,
      mode: importMode,
      fileName: sourceLabel,
      importedByEmail: userEmail || '',
      importedAt: serverTimestamp(),
      ...summary,
    });
  };

  const handleImportAll = async () => {
    setError('');
    setSuccess('');
    if (!brand) {
      setError('Select a brand before importing — every spare part must belong to one brand.');
      return;
    }
    if (importMode === 'replace' && confirmText.trim().toUpperCase() !== brand) {
      setError(`Type "${brand}" in the confirmation box to replace this brand's entire inventory.`);
      return;
    }
    const clean = rows.map((r) => ({ ...r, particulars: String(r.particulars || '').trim() })).filter((r) => r.particulars);
    if (clean.length === 0) {
      setError('Nothing to import.');
      return;
    }

    setBusy(true);
    try {
      if (importMode === 'replace') {
        // Completely overwrite this brand's inventory: delete every existing
        // doc for this brand, then insert the uploaded list fresh. Other
        // brands are never touched by this query (scoped by brand ==).
        const existingSnap = await getDocs(query(collection(db, 'items'), where('brand', '==', brand)));
        const deleteBatchSize = 400;
        const docsToDelete = existingSnap.docs;
        for (let i = 0; i < docsToDelete.length; i += deleteBatchSize) {
          const batch = writeBatch(db);
          docsToDelete.slice(i, i + deleteBatchSize).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }

        let nextSno = existingItems.length ? Math.max(...existingItems.map((it) => Number(it.sno) || 0)) + 1 : 1;
        const addBatchSize = 400;
        for (let i = 0; i < clean.length; i += addBatchSize) {
          const batch = writeBatch(db);
          clean.slice(i, i + addBatchSize).forEach((r) => {
            const qty = Number(r.quantity) || 0;
            const newRef = doc(collection(db, 'items'));
            batch.set(newRef, buildItemDoc(r, brand, nextSno, qty));
            nextSno += 1;
          });
          await batch.commit();
        }

        await logImportHistory({
          rowsAdded: clean.length,
          rowsUpdated: 0,
          rowsSkipped: 0,
          deletedExisting: docsToDelete.length,
        });
        setSuccess(
          `Replaced ${brand} inventory: removed ${docsToDelete.length} old record(s), added ${clean.length} verified record(s).`
        );
        setRows([]);
        setConfirmText('');
      } else {
        // Upsert: match by Part Number first (new or old), then by exact
        // name within the same brand. Never touches other brands. Existing
        // stock quantities are preserved unless "update stock" is checked.
        let nextSno = existingItems.length ? Math.max(...existingItems.map((it) => Number(it.sno) || 0)) + 1 : 1;
        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const r of clean) {
          const code = String(r.partCode || '').trim().toLowerCase();
          const oldCode = String(r.oldPartCode || '').trim().toLowerCase();
          const match = brandItems.find((it) => {
            const itNew = String(it.partNumber || it.partCode || '').trim().toLowerCase();
            const itOld = (it.oldPartNumbers || []).map((o) => o.toLowerCase());
            if (code && (itNew === code || itOld.includes(code))) return true;
            if (oldCode && (itNew === oldCode || itOld.includes(oldCode))) return true;
            if (!code && !oldCode) {
              return it.particulars?.trim().toLowerCase() === r.particulars.trim().toLowerCase();
            }
            return false;
          });

          if (match) {
            const updates = buildItemDoc(r, brand, match.sno, null);
            delete updates.sno;
            delete updates.currentStock;
            delete updates.createdAt;
            if (updateStockOnMatch && r.quantity !== '' && r.quantity !== null && r.quantity !== undefined) {
              updates.currentStock = Number(r.quantity) || 0;
              updates.masterOnly = false;
            }
            await updateDoc(doc(db, 'items', match.id), updates);
            updated += 1;
          } else {
            const qty = Number(r.quantity) || 0;
            const newRef = await addDoc(collection(db, 'items'), buildItemDoc(r, brand, nextSno, qty));
            nextSno += 1;
            if (qty > 0) {
              await addDoc(collection(db, 'transactions'), {
                itemId: newRef.id,
                itemName: r.particulars,
                brand,
                type: 'opening',
                direction: 'in',
                quantity: qty,
                reason: `Imported from ${sourceLabel}`,
                performedByEmail: userEmail || '',
                createdAt: serverTimestamp(),
              });
              checkAndSendLowStockAlert(newRef.id);
            }
            added += 1;
          }
        }
        await logImportHistory({ rowsAdded: added, rowsUpdated: updated, rowsSkipped: skipped });
        setSuccess(`${brand}: added ${added} new part(s), updated ${updated} existing part(s).`);
        setRows([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-gray-500 text-sm max-w-2xl">
        Upload a brand's Excel/CSV master list (or a photo/PDF of a paper register / price list — an AI model will
        read it) to build the Master Spare Parts Catalogue. Every row must belong to the brand selected below; other
        brands are never touched by this import.
      </p>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Brand *</label>
            <select value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
              <option value="">Select brand...</option>
              {brands.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Import Mode *</label>
            <select value={importMode} onChange={(e) => setImportMode(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
              <option value="upsert">Add / Update this brand's parts (safe — preserves existing stock)</option>
              <option value="replace">Replace this brand's entire inventory (deletes everything not in the file)</option>
            </select>
          </div>
        </div>

        {importMode === 'upsert' && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={updateStockOnMatch} onChange={(e) => setUpdateStockOnMatch(e.target.checked)} />
            Also overwrite Current Stock for parts that already exist and are matched (leave unchecked to only add new/master-catalogue parts)
          </label>
        )}

        {importMode === 'replace' && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded text-sm flex gap-2">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">This deletes every existing {brand || '(brand)'} record not in the uploaded file.</p>
              <p className="mt-1">Type the brand name to confirm:</p>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={brand}
                className="mt-2 px-3 py-1.5 border rounded w-48"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <label className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg cursor-pointer ${brand ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-gray-300 pointer-events-none'}`}>
            <UploadCloud size={18} />
            Choose File
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,image/*,application/pdf"
              onChange={handleFile}
              className="hidden"
              disabled={!brand}
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

        {detectedMeta && detectedMeta.documentType && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded text-sm flex items-start gap-2">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                This looks like a {DOC_TYPE_LABELS[detectedMeta.documentType] || 'movement document'}
                {detectedMeta.documentNumber ? ` (#${detectedMeta.documentNumber})` : ''}
                {detectedMeta.partyName ? ` — ${detectedMeta.partyName}` : ''}, not a new-items catalogue list.
              </p>
              <p className="mt-1">
                This tab only adds/updates catalogue entries. Switch to <strong>"Record Purchase / Issue / DC"</strong> so
                it updates stock and the ledger correctly.
              </p>
              {onSuggestMovement && (
                <button
                  onClick={onSuggestMovement}
                  className="mt-2 text-xs font-semibold bg-amber-100 hover:bg-amber-200 text-amber-900 px-3 py-1.5 rounded"
                >
                  Switch tab now
                </button>
              )}
            </div>
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm flex items-start gap-2">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {success}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <div className="flex items-center justify-between p-4 border-b flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800">
              Review extracted rows ({rows.length})
              {duplicatesInFile.size > 0 && (
                <span className="ml-2 text-amber-700 text-xs font-normal bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                  {duplicatesInFile.size} duplicate part number(s) in this file
                </span>
              )}
            </h2>
            <button
              onClick={handleImportAll}
              disabled={busy}
              className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
            >
              {busy ? 'Importing...' : `Import ${rows.length} Row(s)`}
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Particulars</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Part Number</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Old Part No.</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Unit</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Stock Qty</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Storage</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Selling Price</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const key = String(r.partCode || r.particulars || '').trim().toLowerCase();
                const isDup = key && duplicatesInFile.has(key);
                return (
                <tr key={idx} className={`border-b last:border-0 ${isDup ? 'bg-amber-50' : ''}`}>
                  <td className="px-2 py-1">
                    <input value={r.particulars} onChange={(e) => updateRow(idx, 'particulars', e.target.value)} className="w-48 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input value={r.partCode} onChange={(e) => updateRow(idx, 'partCode', e.target.value)} className="w-28 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input value={r.oldPartCode} onChange={(e) => updateRow(idx, 'oldPartCode', e.target.value)} className="w-28 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input value={r.unit} onChange={(e) => updateRow(idx, 'unit', e.target.value)} className="w-16 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input type="number" value={r.quantity} onChange={(e) => updateRow(idx, 'quantity', e.target.value)} className="w-20 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input value={r.rackNo} onChange={(e) => updateRow(idx, 'rackNo', e.target.value)} className="w-24 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <input type="number" value={r.sellingPrice} onChange={(e) => updateRow(idx, 'sellingPrice', e.target.value)} className="w-24 px-2 py-1 border rounded" />
                  </td>
                  <td className="px-2 py-1">
                    <button onClick={() => removeRow(idx)} className="text-red-500 hover:text-red-700" title="Remove row">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ImportHistoryPanel />
    </div>
  );
}

function buildItemDoc(r, brand, sno, quantityOrNull) {
  const oldPartNumbers = String(r.oldPartCode || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const qty = quantityOrNull === null ? undefined : Number(quantityOrNull) || 0;
  const docData = {
    sno,
    brand,
    particulars: String(r.particulars || '').trim(),
    description: String(r.description || '').trim(),
    partNumber: String(r.partCode || '').trim(),
    partCode: String(r.partCode || '').trim(),
    oldPartNumbers,
    machineModels: String(r.machineModels || '').trim(),
    category: String(r.category || '').trim(),
    unit: String(r.unit || '').trim(),
    supplier: String(r.supplier || '').trim(),
    purchaseCost: Number(r.purchaseCost) || 0,
    sellingPrice: Number(r.sellingPrice) || 0,
    rackNo: String(r.rackNo || '').trim(),
    minStock: Number(r.minStock) || 0,
    maxStock: Number(r.maxStock) || 0,
    reorderLevel: Number(r.reorderLevel) || 0,
    hsnCode: String(r.hsnCode || '').trim(),
    avgCost: Number(r.avgCost || r.purchaseCost) || 0,
    remarks: String(r.notes || '').trim(),
    updatedAt: serverTimestamp(),
  };
  if (qty !== undefined) {
    docData.currentStock = qty;
    docData.masterOnly = qty <= 0;
    docData.createdAt = serverTimestamp();
  }
  return docData;
}

function ImportHistoryPanel() {
  const [history, setHistory] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'importHistory'), orderBy('importedAt', 'desc'), limit(20)), (snap) => {
      setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (history.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <div className="flex items-center gap-2 p-4 border-b">
        <History size={18} className="text-gray-500" />
        <h2 className="font-semibold text-gray-800">Import History</h2>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">When</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Brand</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Mode</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">File</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">By</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Added</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Updated</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Deleted</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id} className="border-b last:border-0">
              <td className="px-3 py-2 text-gray-500">{h.importedAt?.toDate ? h.importedAt.toDate().toLocaleString() : ''}</td>
              <td className="px-3 py-2 font-medium">{h.brand}</td>
              <td className="px-3 py-2">{h.mode === 'replace' ? 'Replace' : 'Add/Update'}</td>
              <td className="px-3 py-2 text-gray-500">{h.fileName}</td>
              <td className="px-3 py-2 text-gray-500">{h.importedByEmail}</td>
              <td className="px-3 py-2 text-right">{h.rowsAdded || 0}</td>
              <td className="px-3 py-2 text-right">{h.rowsUpdated || 0}</td>
              <td className="px-3 py-2 text-right">{h.deletedExisting || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MovementImport({ existingItems, userEmail }) {
  const [movementType, setMovementType] = useState('purchase');
  const [rows, setRows] = useState([]);
  const [reason, setReason] = useState('');
  const [supplier, setSupplier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [existingLocationsByItem, setExistingLocationsByItem] = useState({});
  const [detectedMeta, setDetectedMeta] = useState(null);
  const fileInputRef = useRef(null);

  const movement = MOVEMENT_TYPES.find((m) => m.id === movementType);
  const showUnitCost = movementType === 'purchase';
  const isReceiving = movement.direction === 'in';

  const itemOptions = useMemo(
    () => [...existingItems].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')),
    [existingItems]
  );

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setSuccess('');
    setRows([]);
    setDetectedMeta(null);
    setSourceLabel(file.name);
    setReason(file.name.replace(/\.[^/.]+$/, ''));
    setBusy(true);
    try {
      const { rows: mapped, meta } = await extractRowsFromFile(file);
      if (mapped.length === 0) {
        setError('No recognizable item rows found in that file.');
      }
      const withMatches = mapped.map((r) => {
        const match = findBestMatch(r.particulars, existingItems, r.partCode);
        return {
          particulars: r.particulars,
          quantity: r.quantity ?? '',
          unitCost: r.avgCost ?? '',
          itemId: match ? match.id : '',
        };
      });
      setRows(withMatches);
      setDetectedMeta(meta);
      // Auto-pick the movement type and pre-fill reference/party from what
      // was detected in the document — the person can still override both.
      if (meta?.documentType && MOVEMENT_TYPES.some((m) => m.id === meta.documentType)) {
        setMovementType(meta.documentType);
      }
      if (meta?.documentNumber) {
        setReason(meta.documentNumber);
      }
      if (meta?.partyName) {
        setSupplier(meta.partyName);
      }
      if (isReceiving) {
        const entries = await Promise.all(
          withMatches
            .filter((r) => r.itemId)
            .map(async (r) => [r.itemId, await getExistingLocationsForItem(r.itemId)])
        );
        setExistingLocationsByItem(Object.fromEntries(entries));
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
    if (field === 'itemId' && value && isReceiving) {
      getExistingLocationsForItem(value).then((locs) => {
        setExistingLocationsByItem((prev) => ({ ...prev, [value]: locs }));
      });
    }
  };

  const removeRow = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleRecord = async () => {
    setError('');
    setSuccess('');
    const withQty = rows.filter((r) => Number(r.quantity) > 0);
    if (withQty.length === 0) {
      setError('Enter a quantity greater than 0 for at least one row.');
      return;
    }
    const matched = withQty.filter((r) => r.itemId);
    const unmatched = withQty.filter((r) => !r.itemId);

    if (matched.length === 0) {
      setError('None of these rows are matched to an existing item. Select an item for each row, or add the item first via Manage Items.');
      return;
    }

    setBusy(true);
    let recorded = 0;
    const failed = [];
    try {
      for (const r of matched) {
        const qty = Number(r.quantity);
        let committedItemName = '';
        let committedItemCode = '';
        let committedTxnId = '';
        try {
          await runTransaction(db, async (tx) => {
            const itemRef = doc(db, 'items', r.itemId);
            const itemSnap = await tx.get(itemRef);
            if (!itemSnap.exists()) throw new Error('Item no longer exists.');
            const current = Number(itemSnap.data().currentStock || 0);
            const delta = movement.direction === 'in' ? qty : -qty;
            const newStock = current + delta;
            if (newStock < 0) {
              throw new Error(`${itemSnap.data().particulars}: would make stock negative (current ${current}, qty ${qty}).`);
            }

            const updates = { currentStock: newStock, updatedAt: serverTimestamp(), masterOnly: false };
            if (movement.id === 'purchase' && r.unitCost) {
              updates.avgCost = Number(r.unitCost);
            }
            tx.update(itemRef, updates);

            const txnRef = doc(collection(db, 'transactions'));
            tx.set(txnRef, {
              itemId: r.itemId,
              itemName: itemSnap.data().particulars,
              brand: itemSnap.data().brand || '',
              type: movement.id,
              direction: movement.direction,
              quantity: qty,
              unitCost: r.unitCost ? Number(r.unitCost) : null,
              reason: reason.trim() || `Imported from ${sourceLabel}`,
              performedByEmail: userEmail || '',
              createdAt: serverTimestamp(),
            });
            committedItemName = itemSnap.data().particulars;
            committedItemCode = itemSnap.data().sno;
            committedTxnId = txnRef.id;
          });
          await checkAndSendLowStockAlert(r.itemId);
          if (isReceiving) {
            await createPutawayLine({
              itemId: r.itemId,
              itemName: committedItemName,
              itemCode: committedItemCode,
              quantity: qty,
              invoiceNumber: reason.trim() || sourceLabel || 'N/A',
              invoiceDate: new Date().toISOString().slice(0, 10),
              supplier: supplier.trim(),
              transactionId: committedTxnId,
              userEmail,
            });
          }
          recorded += 1;
        } catch (err) {
          failed.push(err.message);
        }
      }

      let message = `Recorded ${recorded} of ${matched.length} matched movement(s).`;
      if (unmatched.length) {
        message += ` ${unmatched.length} row(s) had no matching item and were skipped: ${unmatched
          .map((r) => r.particulars)
          .join(', ')}.`;
      }
      if (failed.length) {
        message += ` ${failed.length} failed: ${failed.join(' ')}`;
      }
      setSuccess(message);
      setRows((prev) => prev.filter((r) => !matched.includes(r) || failed.some((f) => f.includes(r.particulars))));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-gray-500 text-sm max-w-2xl">
        Upload a purchase invoice, delivery challan / sale document, or an Excel/CSV of movement lines. Each row is
        matched to an existing item by name — review and correct the match, quantity, and (for purchases) unit
        cost before recording. This updates stock and writes to the ledger, it does not create new items.
      </p>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Movement Type</label>
          <select
            value={movementType}
            onChange={(e) => setMovementType(e.target.value)}
            className="px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
          >
            {MOVEMENT_TYPES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

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

        {rows.length > 0 && (
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isReceiving ? 'Invoice / Reference Number' : 'Reason / Reference'} (applies to all rows)
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full max-w-md px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                placeholder="Invoice no., customer, notes..."
              />
            </div>
            {isReceiving && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                <input
                  type="text"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  className="w-full max-w-md px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  placeholder="Supplier name"
                />
              </div>
            )}
          </div>
        )}
        {isReceiving && rows.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Recording this will update stock immediately. Warehouse locations stay <strong>LOCATION PENDING</strong> until
            someone physically puts the goods away and the completed Put-away Report is uploaded — see the
            "Put-away" section in the left menu.
          </p>
        )}

        {detectedMeta && (detectedMeta.documentType || detectedMeta.documentNumber || detectedMeta.partyName) && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2 rounded text-sm">
            Detected: {DOC_TYPE_LABELS[detectedMeta.documentType] || 'Document'}
            {detectedMeta.documentNumber ? ` #${detectedMeta.documentNumber}` : ''}
            {detectedMeta.partyName ? ` — ${detectedMeta.partyName}` : ''}
            {detectedMeta.documentType ? '. Movement Type set automatically above — change it if that\'s wrong.' : '.'}
          </div>
        )}

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
              onClick={handleRecord}
              disabled={busy}
              className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
            >
              {busy ? 'Recording...' : `Record ${rows.length} Movement(s)`}
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Extracted Name</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Matched Item</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Quantity</th>
                {showUnitCost && <th className="text-left px-3 py-2 font-semibold text-gray-600">Unit Cost</th>}
                {isReceiving && <th className="text-left px-3 py-2 font-semibold text-gray-600">Existing Stock Locations</th>}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const existingLocs = existingLocationsByItem[r.itemId] || [];
                return (
                <tr key={idx} className="border-b last:border-0">
                  <td className="px-2 py-1 text-gray-600">{r.particulars}</td>
                  <td className="px-2 py-1">
                    <select
                      value={r.itemId}
                      onChange={(e) => updateRow(idx, 'itemId', e.target.value)}
                      className={`w-56 px-2 py-1 border rounded ${!r.itemId ? 'border-red-300 text-red-600' : ''}`}
                    >
                      <option value="">No match — select item...</option>
                      {itemOptions.map((it) => (
                        <option key={it.id} value={it.id}>{it.brand ? `[${it.brand}] ` : ''}{it.particulars} (stock: {it.currentStock})</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={r.quantity}
                      onChange={(e) => updateRow(idx, 'quantity', e.target.value)}
                      className="w-24 px-2 py-1 border rounded"
                    />
                  </td>
                  {showUnitCost && (
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        step="0.01"
                        value={r.unitCost}
                        onChange={(e) => updateRow(idx, 'unitCost', e.target.value)}
                        className="w-24 px-2 py-1 border rounded"
                      />
                    </td>
                  )}
                  {isReceiving && (
                    <td className="px-2 py-1 text-xs text-gray-500">
                      {!r.itemId ? (
                        '—'
                      ) : existingLocs.length === 0 ? (
                        <span className="italic">No existing location on record</span>
                      ) : (
                        existingLocs.map((l) => (
                          <span key={l.locationCode} className="inline-block bg-gray-100 rounded px-2 py-0.5 mr-1 mb-1">
                            {l.locationCode} · Qty {l.qty}
                          </span>
                        ))
                      )}
                    </td>
                  )}
                  <td className="px-2 py-1">
                    <button onClick={() => removeRow(idx)} className="text-red-500 hover:text-red-700" title="Remove row">
                      <Trash2 size={16} />
                    </button>
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
}
