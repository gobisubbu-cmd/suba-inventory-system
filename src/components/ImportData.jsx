import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  updateDoc,
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
  Tags,
  Coins,
  PackageSearch,
  Layers,
} from 'lucide-react';
import { SCAN_BACKEND_URL } from '../scanConfig';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import { createPutawayLine, getExistingLocationsForItem } from '../putaway';
import { fetchBrands, ensureSeedBrands, allPartNumbers } from '../lib/brands';
import { logActivity } from '../lib/activityLog';

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
  brandOverride: ['brand', 'brand name', 'group'],
  machineModels: ['machine model(s)', 'machine model', 'model', 'models'],
  supplier: ['supplier'],
  notes: ['notes', 'remarks', 'notes / source'],
};

const MOVEMENT_TYPES = [
  { id: 'purchase', label: 'Purchase (In) — stock goes UP', direction: 'in' },
  { id: 'return', label: 'Return (In) — stock goes UP', direction: 'in' },
  { id: 'issue', label: 'Issue (Out) — stock goes DOWN', direction: 'out' },
  { id: 'dc', label: 'Delivery Challan / Sale (Out) — stock goes DOWN', direction: 'out' },
];

// "Delivery Challan" is just a shipping-document type — it does NOT by
// itself mean stock is leaving. If a SUPPLIER sends you a DC, that's an
// inward delivery for you and should be recorded as a Purchase, not a DC
// movement. One reliable tell: the document's detected "party name" is your
// OWN business, not an actual supplier/customer — a supplier's own DC often
// lists your company as the "Deliver To" / consignee, which the scan can
// mistake for the counterparty name. When that happens, warn loudly instead
// of silently trusting the auto-detected (usually outward) direction.
const OWN_BUSINESS_NAME_HINTS = ['suba'];

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
    // Stored part numbers are often combined strings like
    // "40.00.404 / 40.07.493P" — split on "/" so each individual code can
    // match on its own.
    const codesOf = (it) =>
      allPartNumbers(it).flatMap((pn) =>
        String(pn)
          .split('/')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
      );
    // 1) exact match against any individual code fragment
    let match = existingItems.find((it) => codesOf(it).includes(target));
    if (match) return match;
    // 2) partial match — covers suffix differences like "42.00.413" vs
    // "42.00.413P". Only for reasonably long codes, to avoid false hits.
    if (target.length >= 5) {
      match = existingItems.find((it) =>
        codesOf(it).some(
          (pn) => pn.length >= 5 && (pn.includes(target) || target.includes(pn))
        )
      );
      if (match) return match;
    }
    return null;
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

// Used when someone selects multiple files or an entire folder (folder
// picking via the browser's directory input has no way to filter by type
// up front, so a folder full of scanned invoices often also picks up
// .DS_Store, Thumbs.db, or other junk). Silently drop anything that isn't a
// spreadsheet/PDF/image rather than surfacing a scary error for every one.
function isSupportedImportFile(file) {
  return /\.(xlsx|xls|csv)$/i.test(file.name) || file.type === 'application/pdf' || file.type.startsWith('image/');
}

// Shared props spread onto every "select multiple files" input in this file
// — lets a folder be dragged/selected as a whole via the OS folder picker on
// top of the normal multi-file selection.
const MULTI_FILE_PROPS = { multiple: true };
const FOLDER_PICKER_PROPS = { webkitdirectory: 'true', directory: 'true', multiple: true };

export default function ImportData({ userRole, userEmail }) {
  // Staff are allowed in, but ONLY for the "Record Purchase / Issue / DC"
  // (inward/outward) mode — the master-catalogue and bulk-update modes can
  // rewrite the whole item database, so those stay admin/inventory-manager.
  const staffOnly = userRole === 'staff';
  const [mode, setMode] = useState(staffOnly ? 'movement' : 'newItems'); // 'newItems' | 'movement' | 'bulkBrand' | 'bulkPrice' | 'bulkCategory' | 'unmatched'
  const [existingItems, setExistingItems] = useState([]);
  const [pendingUnmatchedCount, setPendingUnmatchedCount] = useState(0);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => {
      setExistingItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'unmatchedImports'), where('status', '==', 'pending')), (snap) => {
      setPendingUnmatchedCount(snap.size);
    });
    return unsub;
  }, []);

  if (userRole !== 'admin' && userRole !== 'inventory_manager' && userRole !== 'staff') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Import Data is restricted to signed-in users.</p>
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
        {!staffOnly && (
        <button
          onClick={() => setMode('newItems')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'newItems' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <PackagePlus size={16} /> Brand Catalogue / Stock Import
        </button>
        )}
        <button
          onClick={() => setMode('movement')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'movement' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <ArrowLeftRight size={16} /> Record Purchase / Issue / DC
        </button>
        {!staffOnly && (<>
        <button
          onClick={() => setMode('bulkBrand')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'bulkBrand' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Tags size={16} /> Bulk Update Brand
        </button>
        <button
          onClick={() => setMode('bulkPrice')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'bulkPrice' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Coins size={16} /> Bulk Update Price
        </button>
        <button
          onClick={() => setMode('bulkCategory')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'bulkCategory' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Layers size={16} /> Bulk Update Category
        </button>
        <button
          onClick={() => setMode('unmatched')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            mode === 'unmatched' ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <PackageSearch size={16} /> No-Match Report
          {pendingUnmatchedCount > 0 && (
            <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">
              {pendingUnmatchedCount}
            </span>
          )}
        </button>
        </>)}
      </div>

      {mode === 'newItems' && !staffOnly && (
        <NewItemsImport existingItems={existingItems} userEmail={userEmail} onSuggestMovement={() => setMode('movement')} />
      )}
      {mode === 'movement' && (
        <MovementImport existingItems={existingItems} userEmail={userEmail} />
      )}
      {mode === 'bulkBrand' && !staffOnly && (
        <BulkBrandUpdate existingItems={existingItems} userEmail={userEmail} />
      )}
      {mode === 'bulkPrice' && !staffOnly && (
        <BulkPriceUpdate existingItems={existingItems} userEmail={userEmail} />
      )}
      {mode === 'bulkCategory' && !staffOnly && (
        <BulkCategoryUpdate existingItems={existingItems} userEmail={userEmail} />
      )}
      {mode === 'unmatched' && !staffOnly && (
        <UnmatchedImportsPanel existingItems={existingItems} userEmail={userEmail} />
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
  const folderInputRef = useRef(null);

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
    const allSelected = Array.from(e.target.files || []);
    const files = allSelected.filter(isSupportedImportFile);
    const skipped = allSelected.length - files.length;
    if (!files.length) {
      if (allSelected.length) setError('No Excel/CSV/photo/PDF files found in that selection.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      return;
    }
    setError('');
    setSuccess('');
    setRows([]);
    setDetectedMeta(null);
    setSourceLabel(files.length === 1 ? files[0].name : `${files.length} files (${files.map((f) => f.name).join(', ')})`);
    setBusy(true);
    const allRows = [];
    let firstMeta = null;
    const fileErrors = [];
    try {
      for (const file of files) {
        try {
          const { rows: mapped, meta } = await extractRowsFromFile(file);
          allRows.push(...mapped);
          if (!firstMeta && meta) firstMeta = meta;
        } catch (err) {
          fileErrors.push(`${file.name}: ${err.message || 'failed to read'}`);
        }
      }
      if (allRows.length === 0) {
        setError(fileErrors.length ? fileErrors.join(' ') : 'No recognizable item rows found in that file.');
      } else {
        const notes = [];
        if (fileErrors.length) notes.push(`${fileErrors.length} of ${files.length} file(s) could not be read: ${fileErrors.join(' ')}`);
        if (skipped) notes.push(`${skipped} unsupported file(s) in that selection were skipped.`);
        if (notes.length) setError(notes.join(' '));
      }
      setRows(allRows);
      setDetectedMeta(firstMeta);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const updateRow = (idx, field, value) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };

  const removeRow = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const logImportHistory = async (summary, brandOverride) => {
    await addDoc(collection(db, 'importHistory'), {
      brand: brandOverride || brand,
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

    if (importMode === 'upsert') {
      const knownBrands = new Set(brands.map((b) => b.name));
      const unknownBrands = [...new Set(
        clean
          .map((r) => String(r.brandOverride || '').trim().toUpperCase())
          .filter((b) => b && !knownBrands.has(b))
      )];
      if (unknownBrands.length) {
        setError(
          `File references brand(s) that don't exist yet: ${unknownBrands.join(', ')}. Create them on the Brands page first, then re-upload.`
        );
        return;
      }
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
        logActivity(userEmail, 'Catalogue import (replace)', `${brand}: removed ${docsToDelete.length}, added ${clean.length} items`);
        setSuccess(
          `Replaced ${brand} inventory: removed ${docsToDelete.length} old record(s), added ${clean.length} verified record(s).`
        );
        setRows([]);
        setConfirmText('');
      } else {
        // Upsert: match by Part Number first (new or old), then by exact
        // name within the same brand. Never touches other brands. Existing
        // stock quantities are preserved unless "update stock" is checked.
        //
        // Matching is done in plain JS first (no network calls), then every
        // write goes through chunked writeBatch commits (~400 ops each)
        // instead of one awaited addDoc/updateDoc per row. For a small
        // upload this is barely noticeable, but for a large master-catalogue
        // import (thousands of rows) it's the difference between a few
        // seconds and sitting through thousands of sequential round trips.
        let nextSno = existingItems.length ? Math.max(...existingItems.map((it) => Number(it.sno) || 0)) + 1 : 1;
        const matchedOps = []; // { ref, updates }
        const newItemOps = []; // { itemRef, itemData, txnRef|null, txnData|null, qty }

        // A row may carry its own "Brand" column (e.g. a combined multi-brand
        // catalogue file) — when present it wins over the brand selected in
        // the dropdown above, so one upload can seed several brands at once.
        // Rows without that column behave exactly as before.
        const usedBrands = new Set();
        for (const r of clean) {
          const rowBrand = String(r.brandOverride || '').trim().toUpperCase();
          const effBrand = rowBrand || brand;
          usedBrands.add(effBrand);
          const candidates = rowBrand ? existingItems.filter((it) => it.brand === effBrand) : brandItems;
          const code = String(r.partCode || '').trim().toLowerCase();
          const oldCode = String(r.oldPartCode || '').trim().toLowerCase();
          const match = candidates.find((it) => {
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
            const updates = buildPartialUpdateDoc(r, match);
            if (updateStockOnMatch && r.quantity !== '' && r.quantity !== null && r.quantity !== undefined) {
              updates.currentStock = Number(r.quantity) || 0;
              updates.masterOnly = false;
            }
            matchedOps.push({ ref: doc(db, 'items', match.id), updates });
          } else {
            const qty = Number(r.quantity) || 0;
            const itemRef = doc(collection(db, 'items'));
            const itemData = buildItemDoc(r, effBrand, nextSno, qty);
            nextSno += 1;
            let txnRef = null;
            let txnData = null;
            if (qty > 0) {
              txnRef = doc(collection(db, 'transactions'));
              txnData = {
                itemId: itemRef.id,
                itemName: r.particulars,
                brand: effBrand,
                type: 'opening',
                direction: 'in',
                quantity: qty,
                reason: `Imported from ${sourceLabel}`,
                performedByEmail: userEmail || '',
                createdAt: serverTimestamp(),
              };
            }
            newItemOps.push({ itemRef, itemData, txnRef, txnData, qty });
          }
        }

        const CHUNK = 400;
        for (let i = 0; i < matchedOps.length; i += CHUNK) {
          const batch = writeBatch(db);
          matchedOps.slice(i, i + CHUNK).forEach((op) => batch.update(op.ref, op.updates));
          await batch.commit();
        }
        // Each new item may also need a transaction doc, so keep pairs
        // together and stay under ~400 total writes per batch.
        let i = 0;
        while (i < newItemOps.length) {
          const batch = writeBatch(db);
          let opsInBatch = 0;
          while (i < newItemOps.length && opsInBatch < CHUNK - 1) {
            const op = newItemOps[i];
            batch.set(op.itemRef, op.itemData);
            opsInBatch += 1;
            if (op.txnRef) {
              batch.set(op.txnRef, op.txnData);
              opsInBatch += 1;
            }
            i += 1;
          }
          await batch.commit();
        }
        newItemOps.forEach((op) => {
          if (op.qty > 0) checkAndSendLowStockAlert(op.itemRef.id);
        });

        const added = newItemOps.length;
        const updated = matchedOps.length;
        const brandSummary = usedBrands.size > 1 ? `MULTIPLE (${[...usedBrands].sort().join(', ')})` : brand;
        await logImportHistory({ rowsAdded: added, rowsUpdated: updated, rowsSkipped: 0 }, brandSummary);
        logActivity(userEmail, 'Catalogue import', `${brandSummary}: added ${added}, updated ${updated}`);
        setSuccess(
          usedBrands.size > 1
            ? `Imported across ${usedBrands.size} brands: added ${added} new part(s), updated ${updated} existing part(s).`
            : `${brand}: added ${added} new part(s), updated ${updated} existing part(s).`
        );
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
        brands are never touched by this import. Tip: if your file has its own "Brand" column, each row uses that
        brand instead — handy for uploading one combined file across several brands at once (every brand named in
        the file must already exist on the Brands page).
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
            Choose File(s)
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,image/*,application/pdf"
              onChange={handleFile}
              className="hidden"
              disabled={!brand}
              {...MULTI_FILE_PROPS}
            />
          </label>
          <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer border-2 ${brand ? 'border-emerald-700 text-emerald-700 hover:bg-emerald-50' : 'border-gray-300 text-gray-400 pointer-events-none'}`}>
            <UploadCloud size={18} />
            Choose Folder
            <input
              ref={folderInputRef}
              type="file"
              onChange={handleFile}
              className="hidden"
              disabled={!brand}
              {...FOLDER_PICKER_PROPS}
            />
          </label>
          <span className="text-sm text-gray-500 flex items-center gap-2">
            <FileSpreadsheet size={16} /> Excel / CSV, or
            <ScanLine size={16} /> photo / PDF (AI scan) — select multiple, or a whole folder of scans
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

// Shared stock-commit logic for one matched movement row. Used both by the
// normal "Record Purchase / Issue / DC" flow and by the No-Match Report
// panel (when someone goes back later and picks the correct item for a row
// that had no match at import time). Runs the stock update + ledger entry
// as one Firestore transaction, then a low-stock check and (for incoming
// movements) a putaway line — exactly what handleRecord used to do inline.
async function commitStockMovement({
  itemId,
  quantity,
  unitCost,
  movementId,
  reason,
  remarks,
  extractedName,
  supplier,
  isReceiving,
  transactionDate,
  userEmail,
  sourceLabel,
}) {
  const movement = MOVEMENT_TYPES.find((m) => m.id === movementId);
  if (!movement) throw new Error('Unknown movement type.');
  const qty = Number(quantity);
  if (!qty || qty <= 0) throw new Error('Quantity must be greater than 0.');

  const referenceKey = String(reason || '').trim().toLowerCase();
  let committedItemName = '';
  let committedItemCode = '';
  let committedTxnId = '';

  await runTransaction(db, async (tx) => {
    const itemRef = doc(db, 'items', itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists()) throw new Error('Item no longer exists.');
    const current = Number(itemSnap.data().currentStock || 0);
    const delta = movement.direction === 'in' ? qty : -qty;
    const newStock = current + delta;
    if (newStock < 0) {
      throw new Error(`${itemSnap.data().particulars}: would make stock negative (current ${current}, qty ${qty}).`);
    }

    const updates = { currentStock: newStock, updatedAt: serverTimestamp(), masterOnly: false };
    if (movement.id === 'purchase' && unitCost) {
      updates.avgCost = Number(unitCost);
    }
    tx.update(itemRef, updates);

    const txnRef = doc(collection(db, 'transactions'));
    tx.set(txnRef, {
      itemId,
      itemName: itemSnap.data().particulars,
      brand: itemSnap.data().brand || '',
      type: movement.id,
      direction: movement.direction,
      quantity: qty,
      unitCost: unitCost ? Number(unitCost) : null,
      reason: String(reason || '').trim() || `Imported from ${sourceLabel || 'file'}`,
      referenceKey,
      remarks: String(remarks || '').trim(),
      extractedName: extractedName || '',
      ...(isReceiving ? { supplier: String(supplier || '').trim() } : { customerName: String(supplier || '').trim() }),
      performedByEmail: userEmail || '',
      transactionDate,
      createdAt: serverTimestamp(),
    });
    committedItemName = itemSnap.data().particulars;
    committedItemCode = itemSnap.data().sno;
    committedTxnId = txnRef.id;
  });

  await checkAndSendLowStockAlert(itemId);
  if (isReceiving) {
    await createPutawayLine({
      itemId,
      itemName: committedItemName,
      itemCode: committedItemCode,
      quantity: qty,
      invoiceNumber: String(reason || '').trim() || sourceLabel || 'N/A',
      invoiceDate: transactionDate,
      supplier: String(supplier || '').trim(),
      transactionId: committedTxnId,
      userEmail,
    });
  }

  return { itemName: committedItemName, itemCode: committedItemCode, txnId: committedTxnId };
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

// Used when UPDATING an already-matched item (never for brand-new items).
// A plain buildItemDoc() would overwrite every field with '' / 0 for any
// column the uploaded file didn't include — on a partial master-list or
// price-list upload that silently erases real data (storage location,
// category, supplier, HSN code, reorder level, old-part-number history,
// etc.) that the file never touched. This only writes a field when the
// uploaded row actually has a non-empty value for it, and merges (never
// replaces) old part numbers so a re-import can only ever add cross-
// references, not delete ones a previous import already recorded.
function buildPartialUpdateDoc(r, match) {
  const updates = { updatedAt: serverTimestamp() };
  const setIfPresent = (key, rawVal, transform = (v) => v) => {
    if (rawVal === undefined || rawVal === null) return;
    const s = String(rawVal).trim();
    if (s === '') return;
    updates[key] = transform(rawVal);
  };
  setIfPresent('particulars', r.particulars, (v) => String(v).trim());
  setIfPresent('description', r.description, (v) => String(v).trim());
  if (r.partCode !== undefined && String(r.partCode).trim() !== '') {
    updates.partNumber = String(r.partCode).trim();
    updates.partCode = String(r.partCode).trim();
  }
  setIfPresent('machineModels', r.machineModels, (v) => String(v).trim());
  setIfPresent('category', r.category, (v) => String(v).trim());
  setIfPresent('unit', r.unit, (v) => String(v).trim());
  setIfPresent('supplier', r.supplier, (v) => String(v).trim());
  setIfPresent('purchaseCost', r.purchaseCost, (v) => Number(v) || 0);
  setIfPresent('sellingPrice', r.sellingPrice, (v) => Number(v) || 0);
  setIfPresent('rackNo', r.rackNo, (v) => String(v).trim());
  setIfPresent('minStock', r.minStock, (v) => Number(v) || 0);
  setIfPresent('maxStock', r.maxStock, (v) => Number(v) || 0);
  setIfPresent('reorderLevel', r.reorderLevel, (v) => Number(v) || 0);
  setIfPresent('hsnCode', r.hsnCode, (v) => String(v).trim());
  if ((r.avgCost !== undefined && String(r.avgCost).trim() !== '') || (r.purchaseCost !== undefined && String(r.purchaseCost).trim() !== '')) {
    updates.avgCost = Number(r.avgCost || r.purchaseCost) || 0;
  }
  if (r.notes !== undefined && String(r.notes).trim() !== '') {
    updates.remarks = String(r.notes).trim();
  }

  // Old part numbers: merge, never overwrite.
  const newOld = String(r.oldPartCode || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (newOld.length) {
    const existingOld = Array.isArray(match.oldPartNumbers) ? match.oldPartNumbers : [];
    const merged = [...existingOld];
    newOld.forEach((code) => {
      if (!merged.some((c) => c.toLowerCase() === code.toLowerCase())) merged.push(code);
    });
    updates.oldPartNumbers = merged;
  }
  return updates;
}

// Best-effort parse of a document date (from AI scan or a spreadsheet cell —
// could be "10/07/2026", "2026-07-10", "10-Jul-2026", etc.) into the
// yyyy-mm-dd shape <input type="date"> needs. Returns null rather than
// guessing wrong, so the field just falls back to defaulting to today.
function normalizeDateForInput(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    d = d.padStart(2, '0');
    m = m.padStart(2, '0');
    if (Number(m) <= 12 && Number(d) <= 31) return `${y}-${m}-${d}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
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

// Searchable replacement for a plain <select> of hundreds of items.
// Click to open, type to filter by name / brand / current or old part
// number, click a row to pick it. Used wherever a scanned/extracted row
// needs to be matched (or re-matched) to an item without scrolling a
// giant dropdown — e.g. when handwriting is misread and the auto-match
// is wrong.
function SearchableItemSelect({ items, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  const selected = items.find((it) => it.id === value);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 50);
    return items
      .filter((it) => {
        const hay = [it.particulars, it.brand, it.partNumber, it.partCode, ...(it.oldPartNumbers || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 50);
  }, [items, query]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-56 px-2 py-1 border rounded text-left truncate bg-white ${!value ? 'border-red-300 text-red-600' : ''}`}
      >
        {selected
          ? `${selected.brand ? `[${selected.brand}] ` : ''}${selected.particulars} (stock: ${selected.currentStock})`
          : 'No match — select item...'}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-96 bg-white border rounded-lg shadow-lg">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type name or part code (old or new) to search..."
            className="w-full px-2 py-1.5 border-b outline-none text-sm rounded-t-lg"
          />
          <div className="max-h-64 overflow-y-auto">
            <div
              onClick={() => {
                onChange('');
                setOpen(false);
                setQuery('');
              }}
              className="px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 cursor-pointer"
            >
              No match — clear selection
            </div>
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-gray-400 italic">No items match "{query}"</div>
            )}
            {filtered.map((it) => (
              <div
                key={it.id}
                onClick={() => {
                  onChange(it.id);
                  setOpen(false);
                  setQuery('');
                }}
                className={`px-2 py-1.5 text-sm hover:bg-emerald-50 cursor-pointer ${it.id === value ? 'bg-emerald-100' : ''}`}
              >
                {it.brand ? `[${it.brand}] ` : ''}
                {it.particulars}
                <span className="text-gray-400"> · {it.partNumber || it.partCode || '—'} · stock {it.currentStock}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
  // Effective date of the movement — auto-filled from the document's own
  // date when the scan/parse detects one, editable either way. Kept
  // separate from createdAt (upload time) so a document entered late still
  // posts, reports and audits against the date printed on it, not today.
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // Duplicate-reference guard: if this reference/invoice number was already
  // used on a previous recorded movement, warn before letting it happen
  // again — accidentally importing the same DC/invoice twice is exactly how
  // stock gets double-counted.
  const [dupMatches, setDupMatches] = useState([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  const movement = MOVEMENT_TYPES.find((m) => m.id === movementType);
  const showUnitCost = movementType === 'purchase';
  const isReceiving = movement.direction === 'in';

  // See OWN_BUSINESS_NAME_HINTS above — a document whose detected party
  // name matches your own business is a strong sign this is actually an
  // inward delivery, not the outward movement the scan assumed.
  const partyLooksLikeOwnBusiness = Boolean(
    detectedMeta?.partyName &&
      OWN_BUSINESS_NAME_HINTS.some((hint) => detectedMeta.partyName.toLowerCase().includes(hint))
  );

  useEffect(() => {
    setConfirmDuplicate(false);
    const key = reason.trim();
    if (!key || key.length < 2 || rows.length === 0) {
      setDupMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const lower = key.toLowerCase();
        const [byKeySnap, byTextSnap] = await Promise.all([
          getDocs(query(collection(db, 'transactions'), where('referenceKey', '==', lower), limit(5))),
          getDocs(query(collection(db, 'transactions'), where('reason', '==', key), limit(5))),
        ]);
        if (cancelled) return;
        const byId = new Map();
        [...byKeySnap.docs, ...byTextSnap.docs].forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
        setDupMatches(Array.from(byId.values()));
      } catch (err) {
        // Non-fatal — this is a safety warning, not a hard requirement.
        console.warn('Duplicate reference check failed:', err);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reason, rows.length]);

  const itemOptions = useMemo(
    () => [...existingItems].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')),
    [existingItems]
  );

  const handleFile = async (e) => {
    const allSelected = Array.from(e.target.files || []);
    const files = allSelected.filter(isSupportedImportFile);
    const skipped = allSelected.length - files.length;
    if (!files.length) {
      if (allSelected.length) setError('No Excel/CSV/photo/PDF files found in that selection.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      return;
    }
    setError('');
    setSuccess('');
    setRows([]);
    setDetectedMeta(null);
    const label = files.length === 1 ? files[0].name : `${files.length} files (${files.map((f) => f.name).join(', ')})`;
    setSourceLabel(label);
    setReason(files.length === 1 ? files[0].name.replace(/\.[^/.]+$/, '') : label);
    setBusy(true);
    // Multiple files are treated as pages of ONE document — rows from every
    // file are combined into a single review table, but reference/party/date
    // auto-fill below only comes from the FIRST file's detected metadata, so
    // uploading several different invoices at once won't have a later one
    // silently overwrite the reason/supplier/date already filled from an
    // earlier one. This matches the common real case (a multi-page invoice
    // photographed as separate JPGs) rather than "several unrelated docs".
    const allMapped = [];
    let firstMeta = null;
    const fileErrors = [];
    try {
      for (const file of files) {
        try {
          const { rows: mapped, meta } = await extractRowsFromFile(file);
          allMapped.push(...mapped);
          if (!firstMeta && meta) firstMeta = meta;
        } catch (err) {
          fileErrors.push(`${file.name}: ${err.message || 'failed to read'}`);
        }
      }
      if (allMapped.length === 0) {
        setError(fileErrors.length ? fileErrors.join(' ') : 'No recognizable item rows found in that file.');
        return;
      }
      const notes = [];
      if (fileErrors.length) notes.push(`${fileErrors.length} of ${files.length} file(s) could not be read: ${fileErrors.join(' ')}`);
      if (skipped) notes.push(`${skipped} unsupported file(s) in that selection were skipped.`);
      if (notes.length) setError(notes.join(' '));

      const withMatches = allMapped.map((r) => {
        const match = findBestMatch(r.particulars, existingItems, r.partCode);
        return {
          particulars: r.particulars,
          partCode: r.partCode || '',
          quantity: r.quantity ?? '',
          unitCost: r.avgCost ?? '',
          itemId: match ? match.id : '',
          remarks: '',
        };
      });
      setRows(withMatches);
      // Auto-pick the movement type and pre-fill reference/party from what
      // was detected in the (first) document — the person can still override
      // both.
      //
      // A document TYPE alone (e.g. "Delivery Challan") never actually says
      // which direction stock is moving — a supplier's own DC addressed to
      // us is inbound, not outbound. The one reliable signal we have before
      // any human looks at it is the detected party name: if it matches our
      // OWN business, this was almost certainly addressed TO us, so flip
      // the auto-selected outward type to its inward equivalent instead of
      // just warning about it after the fact — this exact mistake (RATIONAL
      // packing lists auto-set to "Delivery Challan / Sale (Out)") has
      // repeatedly caused wrong stock-outs, so don't rely on someone
      // catching the warning banner every single time.
      const meta = firstMeta;
      let effectiveDocType = meta?.documentType || null;
      let autoCorrectedFrom = null;
      if (meta?.documentType && MOVEMENT_TYPES.some((m) => m.id === meta.documentType)) {
        const partyLooksOwn = Boolean(
          meta.partyName && OWN_BUSINESS_NAME_HINTS.some((hint) => meta.partyName.toLowerCase().includes(hint))
        );
        const outwardToInward = { dc: 'purchase', issue: 'return' };
        if (partyLooksOwn && outwardToInward[meta.documentType]) {
          autoCorrectedFrom = meta.documentType;
          effectiveDocType = outwardToInward[meta.documentType];
        }
        setMovementType(effectiveDocType);
      }
      setDetectedMeta(meta ? { ...meta, autoCorrectedFrom } : meta);
      if (meta?.documentNumber) {
        setReason(meta.documentNumber);
      }
      if (meta?.partyName) {
        setSupplier(meta.partyName);
      }
      const parsedDate = normalizeDateForInput(meta?.documentDate);
      if (parsedDate) {
        setTransactionDate(parsedDate);
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
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const updateRow = (idx, field, value) => {
    let autoMatchedId = null;
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const updated = { ...r, [field]: value };
        // Typing/correcting the Part Code retries the match automatically —
        // e.g. the scan missed the code on a row (came back blank, so only
        // the fuzzy name match ran and failed), and the code is visible
        // right on the paper document. Only auto-fills when nothing is
        // matched yet, so it never clobbers a match someone already picked
        // by hand in the dropdown.
        if (field === 'partCode' && !r.itemId) {
          const match = findBestMatch(r.particulars, existingItems, value);
          if (match) {
            updated.itemId = match.id;
            autoMatchedId = match.id;
          }
        }
        return updated;
      })
    );
    const matchedId = field === 'itemId' ? value : autoMatchedId;
    if (matchedId && isReceiving) {
      getExistingLocationsForItem(matchedId).then((locs) => {
        setExistingLocationsByItem((prev) => ({ ...prev, [matchedId]: locs }));
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
    // Rows with a blank/zero quantity were previously dropped with zero
    // indication anywhere — not recorded, not sent to the No-Match Report,
    // not even mentioned in the success message. On a large multi-row
    // packing list it's very easy to record before every row has a
    // quantity filled in, and the rows silently vanish the moment you
    // navigate away (this state only lives in memory until then). Now
    // they're always called out explicitly so nothing goes missing quietly.
    const zeroQty = rows.filter((r) => !(Number(r.quantity) > 0));
    if (withQty.length === 0) {
      setError('Enter a quantity greater than 0 for at least one row.');
      return;
    }
    const matched = withQty.filter((r) => r.itemId);
    // A "Service Charges" (or similar) line on an invoice/DC isn't a spare
    // part at all, so it will never match a catalogue item — it used to
    // land in the No-Match Report and sit there forever since there's no
    // item to pick for it. Route these straight to the standalone Service
    // Charges ledger instead, so they're recorded properly the first time.
    const SERVICE_CHARGE_RE = /service\s*charge|handling\s*charge|visit\s*charge|labou?r\s*charge/i;
    const allUnmatched = withQty.filter((r) => !r.itemId);
    const serviceChargeRows = allUnmatched.filter((r) => SERVICE_CHARGE_RE.test(r.particulars || ''));
    const unmatched = allUnmatched.filter((r) => !SERVICE_CHARGE_RE.test(r.particulars || ''));

    if (matched.length === 0 && serviceChargeRows.length === 0) {
      setError('None of these rows are matched to an existing item. Select an item for each row, or add the item first via Manage Items.');
      return;
    }

    setBusy(true);
    let recorded = 0;
    const failed = [];
    try {
      if (serviceChargeRows.length) {
        const scBatch = writeBatch(db);
        serviceChargeRows.forEach((r) => {
          const qty = Number(r.quantity) || 1;
          const unitCost = Number(r.unitCost) || 0;
          const ref = doc(collection(db, 'serviceCharges'));
          scBatch.set(ref, {
            date: transactionDate,
            referenceNumber: reason.trim(),
            customerName: supplier.trim(),
            amount: unitCost ? unitCost * qty : qty,
            notes: r.remarks?.trim() || `Auto-filed from ${sourceLabel || 'import'} (was: ${r.particulars})`,
            loggedByEmail: userEmail || '',
            createdAt: serverTimestamp(),
          });
        });
        await scBatch.commit();
        logActivity(userEmail, 'Auto-filed service charge(s) from import', `${serviceChargeRows.length} row(s) · ${reason.trim()}`);
      }
      for (const r of matched) {
        try {
          await commitStockMovement({
            itemId: r.itemId,
            quantity: r.quantity,
            unitCost: r.unitCost,
            movementId: movement.id,
            reason,
            remarks: r.remarks,
            extractedName: r.particulars,
            supplier,
            isReceiving,
            transactionDate,
            userEmail,
            sourceLabel,
          });
          recorded += 1;
        } catch (err) {
          failed.push(err.message);
        }
      }

      // Rows with no matching item aren't just dropped — save them to the
      // No-Match Report so an admin can come back later, pick the correct
      // item, and add it to stock then (see UnmatchedImportsPanel below).
      if (unmatched.length) {
        const batch = writeBatch(db);
        unmatched.forEach((r) => {
          const ref = doc(collection(db, 'unmatchedImports'));
          batch.set(ref, {
            extractedName: r.particulars || '',
            partCode: r.partCode || '',
            quantity: Number(r.quantity) || 0,
            unitCost: r.unitCost ? Number(r.unitCost) : null,
            remarks: r.remarks?.trim() || '',
            movementType: movement.id,
            direction: movement.direction,
            reason: reason.trim(),
            supplier: supplier.trim(),
            transactionDate,
            sourceLabel,
            status: 'pending',
            importedByEmail: userEmail || '',
            createdAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }

      let message = `Recorded ${recorded} of ${matched.length} matched movement(s).`;
      if (serviceChargeRows.length) {
        message += ` ${serviceChargeRows.length} service charge row(s) were filed to the Service Charges page (not stock): ${serviceChargeRows
          .map((r) => r.particulars)
          .join(', ')}.`;
      }
      if (unmatched.length) {
        message += ` ${unmatched.length} row(s) had no matching item and were saved to the No-Match Report for later review: ${unmatched
          .map((r) => r.particulars)
          .join(', ')}.`;
      }
      if (zeroQty.length) {
        message += ` ⚠️ ${zeroQty.length} row(s) still have NO QUANTITY entered and were NOT recorded (still shown below — fill in a quantity and click Record again, or they will be lost if you leave this page): ${zeroQty
          .map((r) => r.particulars)
          .join(', ')}.`;
      }
      if (failed.length) {
        message += ` ${failed.length} failed: ${failed.join(' ')}`;
      }
      setSuccess(message);
      logActivity(
        userEmail,
        `Stock ${movement.direction === 'in' ? 'inward' : 'outward'} (${movement.label || movement.id})`,
        `Recorded ${recorded} movement(s)${reason.trim() ? ` · ${reason.trim()}` : ''}${supplier.trim() ? ` · ${supplier.trim()}` : ''}${unmatched.length ? ` · ${unmatched.length} unmatched` : ''}`
      );
      setRows((prev) => prev.filter((r) => (!matched.includes(r) && !serviceChargeRows.includes(r)) || failed.some((f) => f.includes(r.particulars))));
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
        cost before recording. This updates stock and writes to the ledger, it does not create new items. Rows with
        no match are saved to the <strong>No-Match Report</strong> tab above so they can be corrected and added to
        stock later instead of being lost.
      </p>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Movement Type</label>
          <select
            value={movementType}
            onChange={(e) => setMovementType(e.target.value)}
            className={`px-3 py-2 border-2 rounded-lg focus:outline-none font-medium ${
              isReceiving
                ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
                : 'border-amber-400 bg-amber-50 text-amber-900'
            }`}
          >
            {MOVEMENT_TYPES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div
          className={`px-4 py-2.5 rounded-lg text-sm font-semibold border-2 ${
            isReceiving
              ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
              : 'bg-amber-50 border-amber-300 text-amber-900'
          }`}
        >
          {isReceiving
            ? '📥 Stock will go UP — this records goods coming IN to your inventory (e.g. from a supplier).'
            : '📤 Stock will go DOWN — this records goods going OUT of your inventory (e.g. to a customer or engineer).'}
          {' '}If that's backwards for this document, change Movement Type above before uploading or recording.
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg cursor-pointer">
            <UploadCloud size={18} />
            Choose File(s)
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,image/*,application/pdf"
              onChange={handleFile}
              className="hidden"
              {...MULTI_FILE_PROPS}
            />
          </label>
          <label className="flex items-center gap-2 border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-lg cursor-pointer">
            <UploadCloud size={18} />
            Choose Folder
            <input
              ref={folderInputRef}
              type="file"
              onChange={handleFile}
              className="hidden"
              {...FOLDER_PICKER_PROPS}
            />
          </label>
          <span className="text-sm text-gray-500 flex items-center gap-2">
            <FileSpreadsheet size={16} /> Excel / CSV, or
            <ScanLine size={16} /> photo / PDF (AI scan) — select multiple pages of one document, or a whole folder
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
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Transaction Date
              </label>
              <input
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
                className="px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                title="The date on the document itself — auto-filled from the scan when detected. Reports and stock ledgers use this date, not today's upload date."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isReceiving ? 'Supplier' : 'Customer'}
              </label>
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="w-full max-w-md px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                placeholder={isReceiving ? 'Supplier name' : 'Customer name'}
                title={
                  isReceiving
                    ? 'Correct this if the scan misread the supplier name'
                    : 'Correct this if the scan misread the customer name (e.g. bad handwriting on the chit)'
                }
              />
            </div>
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
            {detectedMeta.documentType
              ? `. Movement Type was set to "${movement.label}" automatically — a document TYPE alone doesn't tell us direction, so please check the ${isReceiving ? 'green (stock UP)' : 'amber (stock DOWN)'} box above matches this actual document before recording.`
              : '.'}
          </div>
        )}

        {detectedMeta && detectedMeta.autoCorrectedFrom && (
          <div className="bg-emerald-50 border-2 border-emerald-300 text-emerald-800 px-4 py-3 rounded text-sm flex items-start gap-2">
            <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                Auto-corrected: the document said "{DOC_TYPE_LABELS[detectedMeta.autoCorrectedFrom]}", but the party
                name detected ("{detectedMeta.partyName}") is your own business — so this was addressed{' '}
                <strong>TO</strong> you, not sent by you. Movement Type has been set to{' '}
                <strong>{movement.label}</strong> instead. Please still confirm this is right before recording.
              </p>
            </div>
          </div>
        )}

        {detectedMeta && partyLooksLikeOwnBusiness && !detectedMeta.autoCorrectedFrom && (
          <div className="bg-red-50 border-2 border-red-300 text-red-800 px-4 py-3 rounded text-sm flex items-start gap-2">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                The name detected on this document ("{detectedMeta.partyName}") looks like your own business, not an
                outside supplier or customer.
              </p>
              <p className="mt-1">
                That usually means this document was addressed <strong>TO</strong> you — e.g. a supplier's own
                Delivery Challan listing you as the consignee. If so, this is an <strong>inward</strong> delivery and
                Movement Type above should be <strong>Purchase (In)</strong> or <strong>Return (In)</strong>, not
                Delivery Challan / Sale (Out).
              </p>
            </div>
          </div>
        )}

        {dupMatches.length > 0 && (
          <div className="bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded text-sm space-y-2">
            <p className="font-semibold flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              Reference "{reason.trim()}" was already recorded before — this may be a duplicate entry:
            </p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              {dupMatches.slice(0, 5).map((m) => (
                <li key={m.id}>
                  {m.itemName || m.extractedName} × {m.quantity} ({DOC_TYPE_LABELS[m.type] || m.type || 'movement'}) on{' '}
                  {m.transactionDate || (m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : 'unknown date')}
                  {m.performedByEmail ? ` by ${m.performedByEmail}` : ''}
                </li>
              ))}
            </ul>
            <label className="flex items-center gap-2 font-medium cursor-pointer">
              <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />
              I've checked — this is not a duplicate, record anyway
            </label>
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
            <h2 className="font-semibold text-gray-800">Review extracted rows ({rows.length})</h2>
            <div className="flex items-center gap-3">
              <span
                className={`text-xs font-bold px-2 py-1 rounded-full ${
                  isReceiving ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
                }`}
              >
                {isReceiving ? 'STOCK UP' : 'STOCK DOWN'}
              </span>
              <button
                onClick={handleRecord}
                disabled={busy || (dupMatches.length > 0 && !confirmDuplicate)}
                title={dupMatches.length > 0 && !confirmDuplicate ? 'Confirm the duplicate-reference warning above first' : ''}
                className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
              >
                {busy ? 'Recording...' : `Record ${rows.length} Movement(s)`}
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Extracted Name</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Part Code</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Matched Item</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Quantity</th>
                {showUnitCost && <th className="text-left px-3 py-2 font-semibold text-gray-600">Unit Cost</th>}
                {isReceiving && <th className="text-left px-3 py-2 font-semibold text-gray-600">Existing Stock Locations</th>}
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Remarks</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const existingLocs = existingLocationsByItem[r.itemId] || [];
                return (
                <tr key={idx} className="border-b last:border-0">
                  <td className="px-2 py-1">
                    <input
                      type="text"
                      value={r.particulars}
                      onChange={(e) => updateRow(idx, 'particulars', e.target.value)}
                      className="w-40 px-2 py-1 border rounded text-gray-700"
                      title="Correct this if the scan misread the code/name (e.g. bad handwriting)"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="text"
                      value={r.partCode || ''}
                      onChange={(e) => updateRow(idx, 'partCode', e.target.value)}
                      placeholder="e.g. 40.05.919P"
                      className="w-28 px-2 py-1 border rounded text-gray-700"
                      title="Part code as printed on the document. If the scan missed it or the auto-match is wrong, type/correct it here to retry the match."
                    />
                  </td>
                  <td className="px-2 py-1">
                    <SearchableItemSelect
                      items={itemOptions}
                      value={r.itemId}
                      onChange={(id) => updateRow(idx, 'itemId', id)}
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
                    <input
                      type="text"
                      value={r.remarks}
                      onChange={(e) => updateRow(idx, 'remarks', e.target.value)}
                      placeholder="e.g. handwriting mismatch, corrected code"
                      className="w-48 px-2 py-1 border rounded text-xs"
                    />
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
    </div>
  );
}

// Bulk Update Brand — the app's usual Import Data flow adds/updates items
// scoped to ONE brand per upload; it was never meant to bulk-edit the brand
// field on rows that already exist. This mode fills that gap: upload a
// sheet with S.No + Brand columns (exactly what "Current Stock Report" /
// the brand-marking export produces), match each row to an existing item by
// its S.No, and update only the brand field — everything else about the
// item (stock, cost, location, etc.) is left untouched.
const SNO_ALIASES = ['s.no', 'sno', 's no', 'serial no', 'serial number', 's. no'];
const BULK_BRAND_ALIASES = ['brand'];

function parseBulkBrandFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        // Prefer a sheet literally called "Mark Brands" (what this app's own
        // export produces); otherwise scan every sheet for one whose header
        // row has both an S.No-like column and a Brand column.
        const sheetOrder = wb.SheetNames.includes('Mark Brands')
          ? ['Mark Brands', ...wb.SheetNames.filter((n) => n !== 'Mark Brands')]
          : wb.SheetNames;

        for (const name of sheetOrder) {
          const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
          for (let i = 0; i < Math.min(grid.length, 10); i++) {
            const headerRow = (grid[i] || []).map((h) => normalizeHeader(h));
            const snoIdx = headerRow.findIndex((h) => SNO_ALIASES.includes(h));
            const brandIdx = headerRow.findIndex((h) => BULK_BRAND_ALIASES.includes(h));
            if (snoIdx !== -1 && brandIdx !== -1) {
              const rows = grid
                .slice(i + 1)
                .map((r) => ({ sno: r[snoIdx], brand: r[brandIdx] }))
                .filter((r) => r.sno !== null && r.sno !== undefined && r.sno !== '');
              resolve(rows);
              return;
            }
          }
        }
        reject(new Error('Could not find both an "S.No" column and a "Brand" column in this file.'));
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsBinaryString(file);
  });
}

function BulkBrandUpdate({ existingItems, userEmail }) {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleFile = async (e) => {
    const allSelected = Array.from(e.target.files || []);
    const files = allSelected.filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    const skipped = allSelected.length - files.length;
    if (!files.length) {
      if (allSelected.length) setError('No Excel/CSV files found in that selection.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      return;
    }
    setError('');
    setResult(null);
    setBusy(true);

    // A local, immutable-update copy of the S.No -> item lookup, kept in
    // sync as each file is processed — so if the same S.No appears in two
    // files in this batch (e.g. corrections split across two sheets), the
    // second file's "already has that brand" check sees the FIRST file's
    // change rather than stale data from before the batch started.
    const bySno = new Map();
    existingItems.forEach((it) => bySno.set(Number(it.sno), it));

    let updated = 0;
    let unchanged = 0;
    let notFound = 0;
    let leftUnassigned = 0;
    let total = 0;
    const fileErrors = [];

    try {
      for (const file of files) {
        try {
          const rows = await parseBulkBrandFile(file);
          total += rows.length;
          const toWrite = [];

          // Plain for...of (not rows.forEach(...)) so this isn't a function
          // declared inside the outer file loop closing over the running
          // totals below — same result, but keeps ESLint's no-loop-func
          // warning from firing on every file processed.
          for (const r of rows) {
            const sno = Number(r.sno);
            const newBrand = String(r.brand || '').trim();
            if (!newBrand || newBrand.toLowerCase() === 'unassigned') {
              leftUnassigned += 1;
              continue;
            }
            const item = bySno.get(sno);
            if (!item) {
              notFound += 1;
              continue;
            }
            if ((item.brand || '') === newBrand) {
              unchanged += 1;
              continue;
            }
            toWrite.push({ id: item.id, brand: newBrand, sno });
          }

          const batchSize = 400;
          for (let i = 0; i < toWrite.length; i += batchSize) {
            const batch = writeBatch(db);
            toWrite.slice(i, i + batchSize).forEach((w) => {
              batch.update(doc(db, 'items', w.id), { brand: w.brand, updatedAt: serverTimestamp() });
            });
            await batch.commit();
            updated += Math.min(batchSize, toWrite.length - i);
          }
          toWrite.forEach((w) => bySno.set(w.sno, { ...bySno.get(w.sno), brand: w.brand }));

          await addDoc(collection(db, 'importHistory'), {
            brand: 'ALL',
            mode: 'bulkBrandUpdate',
            fileName: file.name,
            importedByEmail: userEmail || '',
            importedAt: serverTimestamp(),
            rowsAdded: 0,
            rowsUpdated: toWrite.length,
            rowsSkipped: rows.length - toWrite.length,
          });
        } catch (err) {
          fileErrors.push(`${file.name}: ${err.message || 'failed to process'}`);
        }
      }

      const notes = [];
      if (fileErrors.length) notes.push(fileErrors.join(' '));
      if (skipped) notes.push(`${skipped} unsupported file(s) in that selection were skipped.`);
      if (notes.length) setError(notes.join(' '));

      if (total > 0 || updated > 0) {
        setResult({ updated, unchanged, notFound, leftUnassigned, total });
      } else if (!fileErrors.length) {
        setError('No rows found under the S.No / Brand columns.');
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <p className="text-sm text-gray-600 max-w-2xl">
        Upload a sheet with an <strong>S.No</strong> column and a <strong>Brand</strong> column — exactly what you get
        from Reports &rarr; Current Stock Report, or the brand-marking list. Each row is matched to an existing item
        by its S.No and only its <strong>Brand</strong> field is updated; stock, cost, location and everything else
        on the item is left exactly as it was. Rows left as "Unassigned" are skipped, so you can send this back
        partly filled in and finish the rest later.
      </p>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded text-sm space-y-1">
          <p className="font-semibold">Done — {result.updated} item(s) updated.</p>
          <p>
            {result.unchanged} already had that brand &middot; {result.leftUnassigned} left as Unassigned (skipped)
            {result.notFound > 0 && <> &middot; {result.notFound} S.No not found (item may have been deleted/renumbered)</>}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg cursor-pointer w-fit ${busy ? 'bg-gray-300 pointer-events-none' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
          {busy ? 'Applying...' : 'Upload S.No + Brand File(s)'}
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="hidden" disabled={busy} {...MULTI_FILE_PROPS} />
        </label>
        <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer w-fit border-2 ${busy ? 'border-gray-300 text-gray-400 pointer-events-none' : 'border-emerald-700 text-emerald-700 hover:bg-emerald-50'}`}>
          <UploadCloud size={16} />
          Choose Folder
          <input ref={folderInputRef} type="file" onChange={handleFile} className="hidden" disabled={busy} {...FOLDER_PICKER_PROPS} />
        </label>
      </div>
    </div>
  );
}

// Bulk Update Price — the regular "Add/Update" import rewrites every field
// on a matched row (unit, rack, reorder level, etc.), so re-uploading a
// price-only file through that path would blank out everything else on
// items that already exist. This mode matches by Part Number (new or old)
// within one brand and updates ONLY Purchase Cost / Avg Cost — the two
// fields Inventory Valuation actually reads (avgCost, falling back to
// purchaseCost) — leaving stock, particulars, location, etc. untouched.
const PRICE_PN_ALIASES = ['part number', 'new part number', 'part no', 'partno', 'part code', 'code'];
const PRICE_OLD_PN_ALIASES = ['old part number', 'old part number(s)', 'old part no', 'old part no.', 'superseded by', 'replaced by'];
const PRICE_VALUE_ALIASES = ['price', 'purchase cost', 'standard purchase cost', 'cost', 'list price', 'selling price', 'standard selling price'];

function parsePriceValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[₹$]/g, '').trim();
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    // European thousands+decimal, e.g. "1.473,00"
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    // European decimal only, e.g. "99,00"
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parsePriceFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        for (const name of wb.SheetNames) {
          const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
          for (let i = 0; i < Math.min(grid.length, 10); i++) {
            const headerRow = (grid[i] || []).map((h) => normalizeHeader(h));
            const pnIdx = headerRow.findIndex((h) => PRICE_PN_ALIASES.includes(h));
            const oldIdx = headerRow.findIndex((h) => PRICE_OLD_PN_ALIASES.includes(h));
            const priceIdx = headerRow.findIndex((h) => PRICE_VALUE_ALIASES.includes(h));
            if (pnIdx !== -1 && priceIdx !== -1) {
              const rows = grid
                .slice(i + 1)
                .map((r) => ({
                  partNumber: String(r[pnIdx] || '').trim(),
                  oldPartNumbers: oldIdx !== -1
                    ? String(r[oldIdx] || '').split(',').map((s) => s.trim()).filter(Boolean)
                    : [],
                  price: parsePriceValue(r[priceIdx]),
                }))
                .filter((r) => r.partNumber || r.oldPartNumbers.length);
              resolve(rows);
              return;
            }
          }
        }
        reject(new Error('Could not find a Part Number column and a Price column in this file.'));
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsBinaryString(file);
  });
}

function BulkPriceUpdate({ existingItems, userEmail }) {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetchBrands().then(setBrands);
  }, []);

  const brandItems = useMemo(() => existingItems.filter((it) => it.brand === brand), [existingItems, brand]);

  const handleFile = async (e) => {
    const allSelected = Array.from(e.target.files || []);
    const files = allSelected.filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    const skipped = allSelected.length - files.length;
    if (!files.length) {
      if (allSelected.length) setError('No Excel/CSV files found in that selection.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      return;
    }
    setError('');
    setResult(null);
    if (!brand) {
      setError('Select a brand first — pricing updates are scoped to one brand at a time.');
      return;
    }
    setBusy(true);

    // Index every existing item in this brand by every part number it's
    // known under (current + old), so a price row matches regardless of
    // which number the item was originally entered with. Kept as a mutable
    // local snapshot of avgCost/purchaseCost so if the same part number
    // appears in two files in this batch, the second file's "unchanged"
    // check compares against the price the FIRST file just set, not stale
    // data from before the batch started.
    const byPartNumber = new Map();
    brandItems.forEach((it) => {
      const keys = [...allPartNumbers(it), it.partCode]
        .map((p) => String(p || '').trim().toLowerCase())
        .filter(Boolean);
      keys.forEach((k) => {
        if (!byPartNumber.has(k)) byPartNumber.set(k, new Set());
        byPartNumber.get(k).add(it.id);
      });
    });
    const itemById = new Map(brandItems.map((it) => [it.id, { ...it }]));

    let notFound = 0;
    let skippedNoPrice = 0;
    let unchanged = 0;
    let updated = 0;
    let total = 0;
    const fileErrors = [];

    try {
      for (const file of files) {
        try {
          const rows = await parsePriceFile(file);
          total += rows.length;
          const toWrite = new Map(); // item id -> price

          // Plain for...of loops (not .forEach(...)) here too — see the
          // comment in BulkBrandUpdate above for why: avoids declaring a
          // function inside the outer per-file loop that closes over the
          // running totals below.
          for (const r of rows) {
            if (r.price === null) {
              skippedNoPrice += 1;
              continue;
            }
            const keys = [r.partNumber, ...r.oldPartNumbers]
              .map((p) => String(p || '').trim().toLowerCase())
              .filter(Boolean);
            const matchedIds = new Set();
            for (const k of keys) {
              const ids = byPartNumber.get(k);
              if (ids) ids.forEach((id) => matchedIds.add(id));
            }
            if (matchedIds.size === 0) {
              notFound += 1;
              continue;
            }
            matchedIds.forEach((id) => toWrite.set(id, r.price));
          }

          const finalWrites = [];
          for (const [id, price] of toWrite) {
            const item = itemById.get(id);
            const currentCost = Number(item.avgCost || item.purchaseCost || 0);
            if (currentCost === Number(price)) {
              unchanged += 1;
              continue;
            }
            finalWrites.push({ id, price });
          }

          const batchSize = 400;
          for (let i = 0; i < finalWrites.length; i += batchSize) {
            const batch = writeBatch(db);
            finalWrites.slice(i, i + batchSize).forEach((w) => {
              batch.update(doc(db, 'items', w.id), {
                purchaseCost: Number(w.price),
                avgCost: Number(w.price),
                updatedAt: serverTimestamp(),
              });
            });
            await batch.commit();
          }
          finalWrites.forEach((w) => {
            const item = itemById.get(w.id);
            if (item) {
              item.avgCost = Number(w.price);
              item.purchaseCost = Number(w.price);
            }
          });
          updated += finalWrites.length;

          await addDoc(collection(db, 'importHistory'), {
            brand,
            mode: 'bulkPriceUpdate',
            fileName: file.name,
            importedByEmail: userEmail || '',
            importedAt: serverTimestamp(),
            rowsAdded: 0,
            rowsUpdated: finalWrites.length,
            rowsSkipped: rows.length - finalWrites.length,
          });
        } catch (err) {
          fileErrors.push(`${file.name}: ${err.message || 'failed to process'}`);
        }
      }

      const notes = [];
      if (fileErrors.length) notes.push(fileErrors.join(' '));
      if (skipped) notes.push(`${skipped} unsupported file(s) in that selection were skipped.`);
      if (notes.length) setError(notes.join(' '));

      if (total > 0) {
        setResult({ updated, unchanged, notFound, skippedNoPrice, total });
      } else if (!fileErrors.length) {
        setError('No rows found under the Part Number / Price columns.');
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <p className="text-sm text-gray-600 max-w-2xl">
        Upload a price list with a <strong>Part Number</strong> column (optionally <strong>Old Part Number(s)</strong>) and a{' '}
        <strong>Price</strong> column. Each row is matched to an existing item in the brand selected below by its current or old
        part number, and only its <strong>Purchase Cost</strong> / <strong>Avg Cost</strong> fields are updated — stock,
        particulars, rack location and everything else on the item is left exactly as it was. These are the two fields
        Inventory Valuation reads to compute a value, so this is what fixes a brand showing ₹0.
      </p>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Brand *</label>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full sm:w-64 px-3 py-2 border rounded-lg">
          <option value="">Select brand...</option>
          {brands.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded text-sm space-y-1">
          <p className="font-semibold">Done — {result.updated} item(s) priced.</p>
          <p>
            {result.unchanged} already had that price &middot; {result.notFound} part number(s) not found in {brand}
            {result.skippedNoPrice > 0 && <> &middot; {result.skippedNoPrice} row(s) had no readable price</>}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg cursor-pointer w-fit ${busy || !brand ? 'bg-gray-300 pointer-events-none' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
          {busy ? 'Applying...' : 'Upload Part Number + Price File(s)'}
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="hidden" disabled={busy || !brand} {...MULTI_FILE_PROPS} />
        </label>
        <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer w-fit border-2 ${busy || !brand ? 'border-gray-300 text-gray-400 pointer-events-none' : 'border-emerald-700 text-emerald-700 hover:bg-emerald-50'}`}>
          <UploadCloud size={16} />
          Choose Folder
          <input ref={folderInputRef} type="file" onChange={handleFile} className="hidden" disabled={busy || !brand} {...FOLDER_PICKER_PROPS} />
        </label>
      </div>
    </div>
  );
}

// Bulk Update Category — splits a brand's stock into sections like
// "Equipment" vs "Spares" (or any other label) by matching an uploaded
// invoice/PO/packing-list against existing items and stamping every matched
// item with one chosen category. Reuses extractRowsFromFile (so it accepts
// the same Excel/CSV/photo/PDF a real invoice comes in as, with AI scanning
// for photos/PDFs) and findBestMatch (matches by part number first, then
// fuzzy name) — the same matching engine "Record Purchase/Issue/DC" uses,
// just applied to the Category field instead of stock quantity.
const CATEGORY_PRESETS = ['Equipment', 'Spares'];

function BulkCategoryUpdate({ existingItems, userEmail }) {
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetchBrands().then(setBrands);
  }, []);

  const brandItems = useMemo(() => existingItems.filter((it) => it.brand === brand), [existingItems, brand]);

  const handleFile = async (e) => {
    const allSelected = Array.from(e.target.files || []);
    const files = allSelected.filter(isSupportedImportFile);
    const skipped = allSelected.length - files.length;
    if (!files.length) {
      if (allSelected.length) setError('No Excel/CSV/photo/PDF files found in that selection.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      return;
    }
    setError('');
    setResult(null);
    if (!brand) {
      setError('Select a brand first.');
      return;
    }
    if (!category.trim()) {
      setError('Enter (or pick) a category to apply — e.g. "Equipment" or "Spares".');
      return;
    }
    setBusy(true);
    const catValue = category.trim();
    let matched = 0;
    let alreadySet = 0;
    let notMatched = 0;
    let total = 0;
    const notMatchedNames = [];
    const fileErrors = [];

    try {
      for (const file of files) {
        try {
          const { rows } = await extractRowsFromFile(file);
          total += rows.length;
          const toWrite = [];
          for (const r of rows) {
            const match = findBestMatch(r.particulars, brandItems, r.partCode);
            if (!match) {
              notMatched += 1;
              if (notMatchedNames.length < 20) notMatchedNames.push(r.particulars || r.partCode || '(blank)');
              continue;
            }
            if ((match.category || '') === catValue) {
              alreadySet += 1;
              continue;
            }
            toWrite.push(match.id);
          }
          const uniqueIds = [...new Set(toWrite)];
          const batchSize = 400;
          for (let i = 0; i < uniqueIds.length; i += batchSize) {
            const batch = writeBatch(db);
            uniqueIds.slice(i, i + batchSize).forEach((id) => {
              batch.update(doc(db, 'items', id), { category: catValue, updatedAt: serverTimestamp() });
            });
            await batch.commit();
          }
          matched += uniqueIds.length;

          await addDoc(collection(db, 'importHistory'), {
            brand,
            mode: 'bulkCategoryUpdate',
            fileName: `${file.name} → "${catValue}"`,
            importedByEmail: userEmail || '',
            importedAt: serverTimestamp(),
            rowsAdded: 0,
            rowsUpdated: uniqueIds.length,
            rowsSkipped: rows.length - uniqueIds.length,
          });
        } catch (err) {
          fileErrors.push(`${file.name}: ${err.message || 'failed to process'}`);
        }
      }

      const notes = [];
      if (fileErrors.length) notes.push(fileErrors.join(' '));
      if (skipped) notes.push(`${skipped} unsupported file(s) in that selection were skipped.`);
      if (notes.length) setError(notes.join(' '));

      if (total > 0) {
        setResult({ matched, alreadySet, notMatched, notMatchedNames, total, category: catValue, brand });
        logActivity(userEmail, 'Bulk category update', `${brand}: ${matched} item(s) set to "${catValue}"${notMatched ? `, ${notMatched} not matched` : ''}`);
      } else if (!fileErrors.length) {
        setError('No recognizable item rows found in that file.');
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <p className="text-sm text-gray-600 max-w-2xl">
        Splits a brand's stock into sections — e.g. <strong>Equipment</strong> vs <strong>Spares</strong> for RATIONAL.
        Upload the invoice/PO/packing-list (Excel/CSV, or a photo/PDF — it's AI-scanned the same way as "Record
        Purchase/Issue/DC") that lists the items belonging to one category. Every matched item gets its{' '}
        <strong>Category</strong> field set to whatever you type below — nothing else about the item (stock, cost,
        location) is touched. Once tagged, use the Category dropdown on the Dashboard to view just that section.
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Brand *</label>
          <select value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
            <option value="">Select brand...</option>
            {brands.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Category to apply *</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Equipment"
            list="category-presets"
            className="w-full px-3 py-2 border rounded-lg"
          />
          <datalist id="category-presets">
            {CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className="flex gap-2 mt-1.5">
            {CATEGORY_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`text-xs px-2 py-1 rounded border ${category === c ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-semibold' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded text-sm space-y-1">
          <p className="font-semibold">
            Done — {result.matched} item(s) in {result.brand} set to "{result.category}".
          </p>
          <p>
            {result.alreadySet} already had that category
            {result.notMatched > 0 && <> &middot; {result.notMatched} row(s) had no matching item in {result.brand}</>}
          </p>
          {result.notMatchedNames.length > 0 && (
            <p className="text-xs text-emerald-700">
              Not matched: {result.notMatchedNames.join(', ')}{result.notMatched > result.notMatchedNames.length ? ', ...' : ''}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg cursor-pointer w-fit ${busy || !brand || !category.trim() ? 'bg-gray-300 pointer-events-none' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
          {busy ? 'Applying...' : 'Upload File(s) to Match & Tag'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,image/*,application/pdf"
            onChange={handleFile}
            className="hidden"
            disabled={busy || !brand || !category.trim()}
            {...MULTI_FILE_PROPS}
          />
        </label>
        <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer w-fit border-2 ${busy || !brand || !category.trim() ? 'border-gray-300 text-gray-400 pointer-events-none' : 'border-emerald-700 text-emerald-700 hover:bg-emerald-50'}`}>
          <UploadCloud size={16} />
          Choose Folder
          <input
            ref={folderInputRef}
            type="file"
            onChange={handleFile}
            className="hidden"
            disabled={busy || !brand || !category.trim()}
            {...FOLDER_PICKER_PROPS}
          />
        </label>
      </div>
    </div>
  );
}

// No-Match Report — every row from "Record Purchase / Issue / DC" that
// couldn't be auto-matched to a catalogue item gets saved here (see
// handleRecord in MovementImport) instead of just being skipped. An admin
// can come back anytime, pick the correct item for a row, and add it to
// stock right from this panel — it runs the exact same stock-commit logic
// as the normal Record flow.
function UnmatchedImportsPanel({ existingItems, userEmail }) {
  const [pending, setPending] = useState([]);
  const [showResolved, setShowResolved] = useState(false);
  const [resolved, setResolved] = useState([]);
  const [selections, setSelections] = useState({}); // rowId -> itemId
  const [rowBusy, setRowBusy] = useState({});
  const [rowError, setRowError] = useState({});
  const [rowDone, setRowDone] = useState({});

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'unmatchedImports'), where('status', '==', 'pending'), orderBy('createdAt', 'desc'), limit(300)),
      (snap) => setPending(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return unsub;
  }, []);

  useEffect(() => {
    if (!showResolved) {
      setResolved([]);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'unmatchedImports'), where('status', '==', 'resolved'), orderBy('resolvedAt', 'desc'), limit(100)),
      (snap) => setResolved(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return unsub;
  }, [showResolved]);

  const itemOptions = useMemo(
    () => [...existingItems].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')),
    [existingItems]
  );

  const handleAddToStock = async (row) => {
    const itemId = selections[row.id];
    if (!itemId) {
      setRowError((p) => ({ ...p, [row.id]: 'Select the correct item first.' }));
      return;
    }
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: '' }));
    try {
      await commitStockMovement({
        itemId,
        quantity: row.quantity,
        unitCost: row.unitCost,
        movementId: row.movementType,
        reason: row.reason,
        remarks: row.remarks,
        extractedName: row.extractedName,
        supplier: row.supplier,
        isReceiving: row.direction === 'in',
        transactionDate: row.transactionDate,
        userEmail,
        sourceLabel: row.sourceLabel,
      });
      await updateDoc(doc(db, 'unmatchedImports', row.id), {
        status: 'resolved',
        resolvedItemId: itemId,
        resolvedByEmail: userEmail || '',
        resolvedAt: serverTimestamp(),
      });
      setRowDone((p) => ({ ...p, [row.id]: true }));
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || 'Failed to add to stock.' }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  };

  const handlePartCodeEdit = (row, code) => {
    if (!selections[row.id]) {
      const match = findBestMatch(row.extractedName, existingItems, code);
      if (match) setSelections((p) => ({ ...p, [row.id]: match.id }));
    }
  };

  // Older rows (like a "Service Charges" line on an invoice) that predate
  // the auto-filing fix above are stuck here with no real item to match —
  // this lets someone resolve them properly by moving the row to the
  // standalone Service Charges ledger instead of forcing a fake stock match.
  const handleMoveToServiceCharges = async (row) => {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: '' }));
    try {
      const qty = Number(row.quantity) || 1;
      const unitCost = Number(row.unitCost) || 0;
      await addDoc(collection(db, 'serviceCharges'), {
        date: row.transactionDate || new Date().toISOString().slice(0, 10),
        referenceNumber: (row.reason || '').trim(),
        customerName: (row.supplier || '').trim(),
        amount: unitCost ? unitCost * qty : qty,
        notes: `Moved from No-Match Report (was: ${row.extractedName})`,
        loggedByEmail: userEmail || '',
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'unmatchedImports', row.id), {
        status: 'resolved',
        resolvedAsServiceCharge: true,
        resolvedByEmail: userEmail || '',
        resolvedAt: serverTimestamp(),
      });
      logActivity(userEmail, 'Moved No-Match row to Service Charges', `${row.extractedName} · ${row.reason || ''}`);
      setRowDone((p) => ({ ...p, [row.id]: true }));
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || 'Failed to move to Service Charges.' }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  };

  const renderRow = (row, isResolved) => (
    <tr key={row.id} className="border-b last:border-0 align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-gray-800">{row.extractedName || '(blank)'}</div>
        <div className="text-xs text-gray-400">
          {row.createdAt?.toDate ? row.createdAt.toDate().toLocaleString() : ''}
          {row.sourceLabel ? ` · ${row.sourceLabel}` : ''}
        </div>
      </td>
      <td className="px-3 py-2">
        {isResolved ? (
          row.partCode || '—'
        ) : (
          <input
            type="text"
            defaultValue={row.partCode || ''}
            onBlur={(e) => handlePartCodeEdit(row, e.target.value)}
            placeholder="e.g. 40.05.919P"
            className="w-28 px-2 py-1 border rounded text-gray-700"
            title="Part code as printed on the document. Correct it here to retry the match."
          />
        )}
      </td>
      <td className="px-3 py-2 text-gray-600">{DOC_TYPE_LABELS[row.movementType] || row.movementType}</td>
      <td className="px-3 py-2 text-gray-600">{row.reason || '—'}</td>
      <td className="px-3 py-2 text-gray-600">{row.supplier || '—'}</td>
      <td className="px-3 py-2 text-right text-gray-600">{row.quantity}</td>
      <td className="px-3 py-2">
        {isResolved ? (
          <span className="text-emerald-700 text-xs">
            Matched {row.resolvedByEmail ? `by ${row.resolvedByEmail}` : ''}
            {row.resolvedAt?.toDate ? ` on ${row.resolvedAt.toDate().toLocaleDateString()}` : ''}
          </span>
        ) : (
          <SearchableItemSelect
            items={itemOptions}
            value={selections[row.id] || ''}
            onChange={(id) => setSelections((p) => ({ ...p, [row.id]: id }))}
          />
        )}
      </td>
      {!isResolved && (
        <td className="px-3 py-2">
          {rowDone[row.id] ? (
            <span className="text-emerald-700 text-xs flex items-center gap-1">
              <CheckCircle2 size={14} /> Done
            </span>
          ) : (
            <div className="flex flex-col gap-1 items-start">
              <button
                onClick={() => handleAddToStock(row)}
                disabled={rowBusy[row.id]}
                className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50"
              >
                {rowBusy[row.id] ? 'Adding...' : 'Add to Stock'}
              </button>
              <button
                onClick={() => handleMoveToServiceCharges(row)}
                disabled={rowBusy[row.id]}
                title="Use this if the row isn't really a spare part — e.g. a Service Charges line on an invoice."
                className="border border-amber-400 text-amber-800 hover:bg-amber-50 text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50"
              >
                Not a part — move to Service Charges
              </button>
            </div>
          )}
          {rowError[row.id] && <div className="text-red-600 text-xs mt-1 max-w-[14rem]">{rowError[row.id]}</div>}
        </td>
      )}
    </tr>
  );

  return (
    <div className="space-y-4">
      <p className="text-gray-500 text-sm max-w-2xl">
        Rows from "Record Purchase / Issue / DC" that couldn't be matched to a catalogue item land here instead of
        being lost. Pick the correct item for a row and click <strong>Add to Stock</strong> to commit it — the
        original quantity, cost, reference number and date from the import are kept. If a row isn't actually a spare
        part (e.g. a Service Charges line on an invoice), use <strong>Not a part — move to Service Charges</strong>
        instead — new imports now file these automatically, so this is mainly for older stuck rows.
      </p>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold text-gray-800">Pending ({pending.length})</h2>
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-gray-400 italic px-4 py-6">Nothing waiting for review.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Extracted Name</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Part Code</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Type</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Reference</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Supplier / Customer</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Correct Item</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>{pending.map((row) => renderRow(row, false))}</tbody>
          </table>
        )}
      </div>

      <button
        onClick={() => setShowResolved((s) => !s)}
        className="text-sm text-gray-500 hover:text-gray-700 underline"
      >
        {showResolved ? 'Hide resolved' : 'Show resolved'}
      </button>

      {showResolved && (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <div className="flex items-center gap-2 p-4 border-b">
            <History size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-800">Resolved ({resolved.length})</h2>
          </div>
          {resolved.length === 0 ? (
            <p className="text-sm text-gray-400 italic px-4 py-6">Nothing resolved yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Extracted Name</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Type</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Reference</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Supplier / Customer</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Resolved</th>
                </tr>
              </thead>
              <tbody>{resolved.map((row) => renderRow(row, true))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
