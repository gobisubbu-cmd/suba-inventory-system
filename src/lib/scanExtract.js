// Shared document-extraction helpers, factored out of ImportData.jsx so the
// mobile Quick Scan flow (MobileQuickScan.jsx) can reuse the exact same
// AI-scan + spreadsheet-parsing + item-matching logic as the desktop Import
// Data screen, instead of drifting out of sync with a second copy.
//
// ImportData.jsx keeps its own original copies of these functions untouched
// (no risk to the existing desktop flow) — this module is a clean parallel
// implementation used only by the new mobile screens.

import * as XLSX from 'xlsx';
import { SCAN_BACKEND_URL } from '../scanConfig';
import { allPartNumbers } from './brands';

export const FIELD_ALIASES = {
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

export const MOVEMENT_TYPES = [
  { id: 'purchase', label: 'Purchase (In)', direction: 'in' },
  { id: 'return', label: 'Return (In)', direction: 'in' },
  { id: 'issue', label: 'Issue (Out)', direction: 'out' },
  { id: 'dc', label: 'Delivery Challan / Sale (Out)', direction: 'out' },
];

export const DOC_TYPE_LABELS = {
  purchase: 'Purchase Invoice',
  dc: 'Delivery Challan',
  issue: 'Sales Invoice',
  return: 'Return / Credit Note',
};

const NUMERIC_FIELDS = ['quantity', 'avgCost', 'purchaseCost', 'sellingPrice', 'reorderLevel', 'minStock', 'maxStock'];
const ALL_ALIASES = new Set(Object.values(FIELD_ALIASES).flat());

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

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

export function findBestMatch(name, existingItems, partCode) {
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
    const codesOf = (it) =>
      allPartNumbers(it).flatMap((pn) =>
        String(pn)
          .split('/')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
      );
    let match = existingItems.find((it) => codesOf(it).includes(target));
    if (match) return match;
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
  return (
    tryMatchByPartNumber(codeTarget) ||
    tryMatchByPartNumber(nameTarget) ||
    tryMatchByText(nameTarget)
  );
}

function findHeaderRowIndex(grid) {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!Array.isArray(row)) continue;
    const matches = row.filter((cell) => ALL_ALIASES.has(normalizeHeader(cell))).length;
    if (matches >= 2) return i;
  }
  return 0;
}

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

// Best-effort parse of a document date into yyyy-mm-dd for <input type="date">.
// Mirrors ImportData.jsx's normalizeDateForInput so mobile-recorded
// transactions get the same auto-filled Transaction Date behaviour.
export function normalizeDateForInput(raw) {
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

export async function extractRowsFromFile(file) {
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
