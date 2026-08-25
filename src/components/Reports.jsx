import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  doc,
  deleteDoc,
  getDocs,
  addDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { BarChart3, Download, Maximize2, X, Trash2, ShieldAlert } from 'lucide-react';
import { daysPending, LOCATION_STATUS } from '../putaway';
import { computeStockStatus } from '../lib/brands';
import { logActivity } from '../lib/activityLog';

function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

// Inventory Date-Based Stock Adjustment Rule: every report/ledger must key
// off the date the movement actually happened (transactionDate, entered on
// the form or read off the scanned document), not createdAt (when it was
// typed into the system). Older records written before this field existed
// fall back to createdAt so nothing in history breaks.
function effectiveDate(t) {
  if (t.transactionDate) {
    const d = new Date(`${t.transactionDate}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }
  return toDate(t.createdAt);
}

function download(filename, rows) {
  // json_to_sheet([]) produces a totally blank sheet with no header row at
  // all, which looks exactly like a broken/failed export. Make a genuinely
  // empty result set say so explicitly instead.
  const safeRows = rows && rows.length > 0 ? rows : [{ Note: 'No records found for this report.' }];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}

export default function Reports({ userRole, userEmail, exportBrands }) {
  const isAdmin = userRole === 'admin';
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [putawayLines, setPutawayLines] = useState([]);
  const [engineerIssues, setEngineerIssues] = useState([]);
  const [engineerReturns, setEngineerReturns] = useState([]);
  const [sparePartsUsed, setSparePartsUsed] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [ioStartDate, setIoStartDate] = useState('');
  const [ioEndDate, setIoEndDate] = useState('');
  const [showMovementModal, setShowMovementModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Firestore's onSnapshot listeners deliver data asynchronously — if a
  // report button is clicked before the first snapshot arrives, `items`
  // (and friends) are still their initial empty arrays, and every export
  // silently writes a blank spreadsheet with zero rows. Track when each
  // collection has delivered its first batch so we can disable the report
  // buttons (and explain why) until real data is in hand.
  const [loaded, setLoaded] = useState({
    items: false,
    transactions: false,
    putawayLines: false,
    engineerIssues: false,
    engineerReturns: false,
    sparePartsUsed: false,
  });
  const dataReady = Object.values(loaded).every(Boolean);

  useEffect(() => {
    const unsubItems = onSnapshot(query(collection(db, 'items'), orderBy('sno', 'asc')), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.items ? l : { ...l, items: true }));
    });
    const unsubTxns = onSnapshot(query(collection(db, 'transactions'), orderBy('createdAt', 'desc')), (snap) => {
      setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.transactions ? l : { ...l, transactions: true }));
    });
    const unsubPutaway = onSnapshot(query(collection(db, 'putawayLines'), orderBy('createdAt', 'desc')), (snap) => {
      setPutawayLines(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.putawayLines ? l : { ...l, putawayLines: true }));
    });
    const unsubIssues = onSnapshot(collection(db, 'engineerIssues'), (snap) => {
      setEngineerIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.engineerIssues ? l : { ...l, engineerIssues: true }));
    });
    const unsubReturns = onSnapshot(collection(db, 'engineerReturns'), (snap) => {
      setEngineerReturns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.engineerReturns ? l : { ...l, engineerReturns: true }));
    });
    const unsubUsed = onSnapshot(collection(db, 'sparePartsUsed'), (snap) => {
      setSparePartsUsed(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded((l) => (l.sparePartsUsed ? l : { ...l, sparePartsUsed: true }));
    });
    return () => {
      unsubItems();
      unsubTxns();
      unsubPutaway();
      unsubIssues();
      unsubReturns();
      unsubUsed();
    };
  }, []);

  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  const filteredTxns = useMemo(() => {
    // Sort by the real transaction date first (falling back to upload time
    // for old records), so a document entered late still lands in correct
    // chronological order rather than at the top just because it was
    // uploaded most recently.
    const sorted = [...transactions].sort((a, b) => (effectiveDate(b)?.getTime() || 0) - (effectiveDate(a)?.getTime() || 0));
    if (!startDate && !endDate) return sorted;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate + 'T23:59:59') : null;
    return sorted.filter((t) => {
      const d = effectiveDate(t);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [transactions, startDate, endDate]);

  // Independent date range for the Inward / Outward rollup reports below —
  // kept separate from the Date-Range Movement Report's own filter so
  // scoping one doesn't silently change the other.
  const ioFilteredTxns = useMemo(() => {
    const sorted = [...transactions].sort((a, b) => (effectiveDate(b)?.getTime() || 0) - (effectiveDate(a)?.getTime() || 0));
    if (!ioStartDate && !ioEndDate) return sorted;
    const start = ioStartDate ? new Date(ioStartDate) : null;
    const end = ioEndDate ? new Date(ioEndDate + 'T23:59:59') : null;
    return sorted.filter((t) => {
      const d = effectiveDate(t);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [transactions, ioStartDate, ioEndDate]);

  // --- Inward / Outward detailed reports (day / month / year / reference-number wise) ---
  // "Inward" = every transaction whose direction is 'in' (Purchase, Return,
  // and any admin Stock Adjustment marked increase). "Outward" = direction
  // 'out' (Issue, Delivery Challan/Sale, and decrease adjustments).
  // Each export lists every line item (part code, name, quantity) grouped
  // under its day/month/year/reference, with a subtotal after each group
  // and a grand total at the end — not just a rolled-up total row, so you
  // can see exactly which parts made up each number.
  const dayKey = (t) => {
    const d = effectiveDate(t);
    if (!d) return 'Unknown Date';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const monthKey = (t) => {
    const d = effectiveDate(t);
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'Unknown Month';
  };
  const yearKey = (t) => {
    const d = effectiveDate(t);
    return d ? String(d.getFullYear()) : 'Unknown Year';
  };
  const referenceGroupKey = (t) => (t.reason && t.reason.trim()) || '(No reference number)';

  const itemsById = useMemo(() => {
    const map = new Map();
    items.forEach((it) => map.set(it.id, it));
    return map;
  }, [items]);

  function exportDirectionRollup(direction, groupLabel, keyFn, filename) {
    const rows = ioFilteredTxns.filter((t) => t.direction === direction);

    const groups = new Map();
    rows.forEach((t) => {
      const key = keyFn(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => String(a).localeCompare(String(b)));

    const blankRow = () => ({
      [groupLabel]: '',
      'Transaction Date': '',
      'Part Code': '',
      Particulars: '',
      Brand: '',
      Quantity: '',
      Unit: '',
      ...(canSeeValue ? { 'Unit Cost': '', Value: '' } : {}),
      Type: '',
      'Supplier/Customer': '',
      'Reference / Doc No. (Packing List / Invoice / DC)': '',
      'Performed By': '',
    });

    const out = [];
    let grandQty = 0;
    let grandValue = 0;

    sortedKeys.forEach((key) => {
      const groupRows = groups.get(key).sort((a, b) => (effectiveDate(a)?.getTime() || 0) - (effectiveDate(b)?.getTime() || 0));
      let groupQty = 0;
      let groupValue = 0;
      groupRows.forEach((t) => {
        const it = itemsById.get(t.itemId);
        const partCode = (it && (it.partNumber || it.partCode)) || '';
        const qty = Number(t.quantity || 0);
        // Purchases (and imports that had a cost column) record their own
        // unitCost on the transaction. Stock Adjustments never ask for a
        // cost at all (they're corrections, not trades), and some older
        // Issue/DC rows never had one either — those used to show Value as
        // a flat 0/blank even though the part clearly has a known cost.
        // Fall back to the item's current Avg Cost so the report still
        // shows a real, useful estimate instead of "no value".
        const hasOwnCost = t.unitCost !== undefined && t.unitCost !== null && t.unitCost !== '';
        const fallbackCost = it ? Number(it.avgCost || it.purchaseCost || 0) : 0;
        const effectiveUnitCost = hasOwnCost ? Number(t.unitCost) : fallbackCost;
        const value = qty * effectiveUnitCost;
        groupQty += qty;
        groupValue += value;
        out.push({
          [groupLabel]: key,
          'Transaction Date': t.transactionDate || effectiveDate(t)?.toLocaleDateString() || '',
          'Part Code': partCode,
          Particulars: t.itemName || (it ? it.particulars : '') || '',
          Brand: t.brand || (it ? it.brand : '') || '',
          Quantity: qty,
          Unit: (it && it.unit) || '',
          ...(canSeeValue
            ? {
                'Unit Cost': effectiveUnitCost || '',
                Value: Math.round(value * 100) / 100,
              }
            : {}),
          Type: t.type || '',
          'Supplier/Customer': t.supplier || t.customerName || '',
          'Reference / Doc No. (Packing List / Invoice / DC)': t.reason || '(No reference number)',
          'Performed By': t.performedByEmail || '',
        });
      });
      out.push({
        ...blankRow(),
        [groupLabel]: `— Subtotal: ${key} —`,
        Quantity: groupQty,
        ...(canSeeValue ? { Value: Math.round(groupValue * 100) / 100 } : {}),
      });
      grandQty += groupQty;
      grandValue += groupValue;
    });

    out.push({
      ...blankRow(),
      [groupLabel]: `GRAND TOTAL (${rows.length} line${rows.length === 1 ? '' : 's'}, ${sortedKeys.length} ${groupLabel.toLowerCase()} group${sortedKeys.length === 1 ? '' : 's'})`,
      Quantity: grandQty,
      ...(canSeeValue ? { Value: Math.round(grandValue * 100) / 100 } : {}),
    });

    download(filename, out);
  }

  const lowStock = items.filter((it) => Number(it.currentStock || 0) <= Number(it.reorderLevel || 0) && Number(it.currentStock || 0) > 0);
  const outOfStock = items.filter((it) => Number(it.currentStock || 0) <= 0);

  const exportStockSummary = () => {
    // Only items actually in stock — the catalogue also holds thousands of
    // "Not Stocked" master entries (parts never received) that would
    // otherwise bury the items you actually hold. Matches Inventory
    // Valuation's export.
    const stockedItems = items.filter((it) => Number(it.currentStock || 0) > 0);
    const rows = stockedItems.map((it) => ({
      'S.No': it.sno,
      Particulars: it.particulars,
      Unit: it.unit,
      'Rack No': it.rackNo,
      'HSN Code': it.hsnCode,
      'Current Stock': it.currentStock,
      'Reorder Level': it.reorderLevel,
      ...(canSeeValue ? { 'Avg Cost': it.avgCost, 'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || 0) } : {}),
    }));
    if (canSeeValue) {
      const totalValue = stockedItems.reduce((sum, it) => sum + Number(it.currentStock || 0) * Number(it.avgCost || 0), 0);
      rows.push({
        'S.No': '',
        Particulars: `TOTAL (${stockedItems.length} items in stock)`,
        Unit: '',
        'Rack No': '',
        'HSN Code': '',
        'Current Stock': '',
        'Reorder Level': '',
        'Avg Cost': '',
        'Stock Value': totalValue,
      });
    }
    download('stock_summary.xlsx', rows);
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
        'Transaction Date': t.transactionDate || effectiveDate(t)?.toLocaleDateString() || '',
        'Uploaded On': toDate(t.createdAt)?.toLocaleString() || '',
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

  // --- Delete a wrongly-recorded transaction (admin only) ---
  // Unlike Stock Adjustment (which adds a compensating entry and keeps the
  // original), this permanently removes the transaction itself and reverses
  // its exact stock effect. Requested explicitly so a mistake like "recorded
  // as outward instead of inward" can be fully undone instead of leaving two
  // offsetting entries in the ledger forever. Guards against leaving stock
  // negative, cleans up any put-away line it created, and — since erasing
  // the record entirely removes all trace of it — leaves one minimal entry
  // in a separate deletedTransactionsLog so there's still an answer to
  // "did something get deleted here, by whom, and why" if that's ever asked.
  // Core single-transaction reversal + delete + cleanup + audit-log, shared
  // by both the single-row Delete button and the bulk "delete everything
  // under this reference number" tool below. Throws on failure (e.g. would
  // make stock negative) so callers can decide how to handle a partial
  // batch.
  async function deleteOneTransaction(t, reasonText) {
    await runTransaction(db, async (tx) => {
      const itemRef = doc(db, 'items', t.itemId);
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists()) {
        throw new Error(`${t.itemName}: item no longer exists — cannot safely reverse stock.`);
      }
      const current = Number(itemSnap.data().currentStock || 0);
      // Reversing an inward movement means removing what it added;
      // reversing an outward movement means putting back what it removed.
      const delta = t.direction === 'in' ? -Number(t.quantity || 0) : Number(t.quantity || 0);
      const newStock = current + delta;
      if (newStock < 0) {
        throw new Error(
          `${t.itemName}: would make stock negative (current ${current}). Some of this quantity may already have been issued or sold elsewhere.`
        );
      }
      tx.update(itemRef, { currentStock: newStock, updatedAt: serverTimestamp() });
      tx.delete(doc(db, 'transactions', t.id));
    });

    // Best-effort cleanup of any put-away line this transaction created —
    // otherwise a "LOCATION PENDING" line would be left pointing at a
    // transaction that no longer exists.
    try {
      const pq = query(collection(db, 'putawayLines'), where('transactionId', '==', t.id));
      const psnap = await getDocs(pq);
      await Promise.all(psnap.docs.map((d) => deleteDoc(doc(db, 'putawayLines', d.id))));
    } catch (e) {
      // Non-fatal — the main deletion already succeeded.
    }

    await addDoc(collection(db, 'deletedTransactionsLog'), {
      originalTransactionId: t.id,
      itemId: t.itemId,
      itemName: t.itemName,
      type: t.type,
      direction: t.direction,
      quantity: t.quantity,
      reference: t.reason || '',
      transactionDate: t.transactionDate || '',
      originallyPerformedByEmail: t.performedByEmail || '',
      deletedByEmail: userEmail || '',
      deleteReason: reasonText,
      deletedAt: serverTimestamp(),
    });
  }

  const confirmDeleteTransaction = async () => {
    if (!deleteTarget) return;
    if (!deleteReason.trim()) {
      setDeleteError('A reason is required before deleting.');
      return;
    }
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteOneTransaction(deleteTarget, deleteReason.trim());
      setDeleteTarget(null);
      setDeleteReason('');
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  // --- Bulk delete: every transaction tagged with a given reference number ---
  // For "we uploaded the same document wrong so many times, just wipe this
  // reference and let us start clean." Deletes in a stock-safe order — every
  // OUTWARD entry first (always safe, stock only goes up), then every INWARD
  // entry (safe once the outward reversals have created headroom) — so nets
  // to the correct pre-shipment baseline without ever dipping negative
  // mid-way, regardless of how tangled the history under that reference is.
  const [bulkRefInput, setBulkRefInput] = useState('');
  const [bulkPreview, setBulkPreview] = useState(null); // { key, rows } once previewed
  const [bulkReason, setBulkReason] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState('');
  const [bulkError, setBulkError] = useState('');

  const previewBulkDelete = () => {
    const key = bulkRefInput.trim().toLowerCase();
    setBulkResult('');
    setBulkError('');
    if (!key) {
      setBulkPreview(null);
      return;
    }
    const rows = transactions.filter((t) => String(t.reason || '').trim().toLowerCase() === key);
    setBulkPreview({ key: bulkRefInput.trim(), rows });
  };

  const runBulkDelete = async () => {
    if (!bulkPreview || bulkPreview.rows.length === 0) return;
    if (!bulkReason.trim()) {
      setBulkError('A reason is required before deleting.');
      return;
    }
    setBulkBusy(true);
    setBulkError('');
    setBulkResult('');
    const ordered = [
      ...bulkPreview.rows.filter((t) => t.direction === 'out'),
      ...bulkPreview.rows.filter((t) => t.direction === 'in'),
    ];
    let done = 0;
    const failed = [];
    for (const t of ordered) {
      try {
        await deleteOneTransaction(t, bulkReason.trim());
        done += 1;
      } catch (err) {
        failed.push(`${t.itemName} (${t.type}, ${t.direction}): ${err.message}`);
      }
    }
    setBulkBusy(false);
    let msg = `Deleted ${done} of ${ordered.length} transaction(s) for reference "${bulkPreview.key}".`;
    if (failed.length) {
      msg += ` ${failed.length} could not be deleted: ${failed.join(' | ')}`;
    }
    setBulkResult(msg);
    setBulkPreview(null);
    setBulkRefInput('');
    setBulkReason('');
  };

  // --- Warehouse Put-away reports ---

  // Every location this item is ALREADY sitting in, aggregated across every
  // put-away line's completed allocations (not just this one receipt) — so
  // when new stock of the same item arrives, it can go straight to the same
  // rack/shelf/bin instead of getting a new spot assigned by guesswork.
  const existingLocationsByItem = useMemo(() => {
    const map = {};
    putawayLines.forEach((l) => {
      (l.allocations || []).forEach((a) => {
        if (!a.locationCode || !Number(a.qty)) return;
        map[l.itemId] = map[l.itemId] || {};
        map[l.itemId][a.locationCode] = (map[l.itemId][a.locationCode] || 0) + Number(a.qty || 0);
      });
    });
    return map;
  }, [putawayLines]);

  function formatExistingLocations(itemId) {
    const byLoc = existingLocationsByItem[itemId];
    if (!byLoc || Object.keys(byLoc).length === 0) return '';
    return Object.entries(byLoc)
      .map(([code, qty]) => `${code} (${qty})`)
      .join(', ');
  }

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
        'Existing Stock': itemsById.get(l.itemId)?.currentStock ?? '',
        'Existing Locations (put new stock here)': formatExistingLocations(l.itemId) || '(new item — no existing location yet)',
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
        'Existing Stock': itemsById.get(l.itemId)?.currentStock ?? '',
        'Existing Locations (put new stock here)': formatExistingLocations(l.itemId) || '(new item — no existing location yet)',
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

  // --- Brand / master-catalogue reports ---

  const brands = useMemo(() => Array.from(new Set(items.map((it) => it.brand).filter(Boolean))).sort(), [items]);

  // Current Stock Report is the one report here that's brand-permission
  // aware: an admin can pick from every brand in the system, but anyone else
  // (e.g. a supervisor) only sees the brands the admin allowed them in
  // Manage Users -> Stock Export permission (users/{uid}.exportBrands) — the
  // same permission that already scopes the standalone Stock Export page.
  // Reusing it here means one place to grant/revoke a user's brand access
  // that covers both.
  const stockReportAllBrands = useMemo(
    () => [...new Set(items.map((it) => it.brand || 'Unassigned'))].sort(),
    [items]
  );
  const stockReportAllowedBrands = useMemo(
    () => (isAdmin ? stockReportAllBrands : stockReportAllBrands.filter((b) => (exportBrands || []).includes(b))),
    [isAdmin, stockReportAllBrands, exportBrands]
  );
  const [stockReportBrands, setStockReportBrands] = useState(new Set());
  useEffect(() => {
    setStockReportBrands(new Set(stockReportAllowedBrands));
  }, [stockReportAllowedBrands.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleStockReportBrand = (b) => {
    setStockReportBrands((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  };
  const stockedItemsForReport = useMemo(
    () => items.filter((it) => Number(it.currentStock || 0) > 0 && stockReportBrands.has(it.brand || 'Unassigned')),
    [items, stockReportBrands]
  );

  const exportBrandWise = () => {
    download(
      'brand_wise_inventory.xlsx',
      items.map((it) => ({
        Brand: it.brand || 'Unassigned',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        Category: it.category || '',
        'Current Stock': it.currentStock,
        Status: computeStockStatus(it),
        ...(canSeeValue ? { 'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0) } : {}),
      }))
    );
  };

  const exportByStatus = (status, filename) => {
    download(
      filename,
      items
        .filter((it) => computeStockStatus(it) === status)
        .map((it) => ({
          Brand: it.brand || 'Unassigned',
          'Part Number': it.partNumber || it.partCode || '',
          Particulars: it.particulars,
          'Current Stock': it.currentStock,
          'Reorder Level': it.reorderLevel,
          Status: status,
        }))
    );
  };

  const exportCurrentStockReport = () => {
    // Only items actually in stock — "Low Stock Report", "Out-of-Stock
    // Report" and "Not Stocked Parts" already cover those statuses on their
    // own buttons, so this one is purely "what do I currently hold." Scoped
    // to whichever brands are ticked in stockReportBrands (see above) —
    // for a non-admin that's never more than their allowed exportBrands.
    const stockedItems = stockedItemsForReport;
    const rows = stockedItems.map((it) => ({
      Brand: it.brand || 'Unassigned',
      'Part Number': it.partNumber || it.partCode || '',
      Particulars: it.particulars,
      'Current Stock': it.currentStock,
      'Reorder Level': it.reorderLevel,
      Status: computeStockStatus(it),
    }));
    rows.push({
      Brand: '',
      'Part Number': '',
      Particulars: `TOTAL (${stockedItems.length} items in stock)`,
      'Current Stock': stockedItems.reduce((sum, it) => sum + Number(it.currentStock || 0), 0),
      'Reorder Level': '',
      Status: '',
    });
    download('current_stock_report.xlsx', rows);
    logActivity(userEmail, 'Current Stock Report export', `${stockedItems.length} item(s) · ${[...stockReportBrands].sort().join(', ') || 'no brands'}`);
  };

  const exportInventoryValuation = () => {
    // Only items actually in stock — the catalogue is full of "Not Stocked"
    // master entries (e.g. thousands of RATIONAL parts never received) that
    // would otherwise bury the items that actually carry value. Matches the
    // on-screen Inventory Valuation page.
    const stockedRows = items
      .filter((it) => Number(it.currentStock || 0) > 0)
      .map((it) => {
        const cost = Number(it.avgCost || it.purchaseCost || 0);
        return {
          Brand: it.brand || 'Unassigned',
          'Part Number': it.partNumber || it.partCode || '',
          Particulars: it.particulars,
          'Current Stock': it.currentStock,
          'Avg / Purchase Cost': cost,
          'Stock Value': Number(it.currentStock || 0) * cost,
        };
      });
    const totalValue = stockedRows.reduce((sum, r) => sum + r['Stock Value'], 0);
    download('inventory_valuation.xlsx', [
      ...stockedRows,
      { Brand: '', 'Part Number': '', Particulars: `TOTAL (${stockedRows.length} items in stock)`, 'Current Stock': '', 'Avg / Purchase Cost': '', 'Stock Value': totalValue },
    ]);
  };

  const movementFrequency = useMemo(() => {
    const now = Date.now();
    const days90 = now - 90 * 24 * 60 * 60 * 1000;
    const days180 = now - 180 * 24 * 60 * 60 * 1000;
    const freq = {};
    const lastOut = {};
    transactions.forEach((t) => {
      if (t.direction !== 'out') return;
      const d = effectiveDate(t);
      if (!d) return;
      freq[t.itemId] = freq[t.itemId] || { last90: 0, lastMovement: 0 };
      if (d.getTime() >= days90) freq[t.itemId].last90 += 1;
      if (d.getTime() > (lastOut[t.itemId] || 0)) lastOut[t.itemId] = d.getTime();
    });
    return { freq, lastOut, days180 };
  }, [transactions]);

  const exportFastMoving = () => {
    const rows = items
      .filter((it) => (movementFrequency.freq[it.id]?.last90 || 0) >= 5)
      .map((it) => ({ Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Out-movements (90d)': movementFrequency.freq[it.id]?.last90 || 0, 'Current Stock': it.currentStock }));
    download('fast_moving_spares.xlsx', rows);
  };

  const exportSlowMoving = () => {
    const rows = items
      .filter((it) => {
        const c = movementFrequency.freq[it.id]?.last90 || 0;
        return c >= 1 && c < 5;
      })
      .map((it) => ({ Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Out-movements (90d)': movementFrequency.freq[it.id]?.last90 || 0, 'Current Stock': it.currentStock }));
    download('slow_moving_spares.xlsx', rows);
  };

  const exportDeadStock = () => {
    const rows = items
      .filter((it) => {
        if (Number(it.currentStock || 0) <= 0) return false;
        const last = movementFrequency.lastOut[it.id] || 0;
        return last === 0 || last < movementFrequency.days180;
      })
      .map((it) => ({
        Brand: it.brand || '',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Last Issued': movementFrequency.lastOut[it.id] ? new Date(movementFrequency.lastOut[it.id]).toLocaleDateString() : 'Never',
      }));
    download('dead_stock.xlsx', rows);
  };

  const exportMachineWise = () => {
    const rows = [];
    items.forEach((it) => {
      const models = String(it.machineModels || '').split(',').map((m) => m.trim()).filter(Boolean);
      if (models.length === 0) {
        rows.push({ 'Machine Model': '(unspecified)', Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock });
      } else {
        models.forEach((m) => rows.push({ 'Machine Model': m, Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock }));
      }
    });
    download('machine_wise_spares.xlsx', rows);
  };

  const exportSupplierWise = () => {
    download(
      'supplier_wise_spares.xlsx',
      items
        .filter((it) => it.supplier)
        .map((it) => ({ Supplier: it.supplier, Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock }))
    );
  };

  const exportReorderReport = () => {
    download(
      'reorder_report.xlsx',
      items
        .filter((it) => computeStockStatus(it) === 'Low Stock' || computeStockStatus(it) === 'Out of Stock')
        .map((it) => {
          const target = Number(it.maxStock) > 0 ? Number(it.maxStock) : Number(it.reorderLevel) * 2;
          const suggested = Math.max(0, target - Number(it.currentStock || 0));
          return {
            Brand: it.brand || '',
            'Part Number': it.partNumber || it.partCode || '',
            Particulars: it.particulars,
            Supplier: it.supplier || '',
            'Current Stock': it.currentStock,
            'Reorder Level': it.reorderLevel,
            'Suggested Reorder Qty': suggested,
          };
        })
    );
  };

  const exportOldNewPartNumbers = () => {
    download(
      'old_new_part_number_crossref.xlsx',
      items
        .filter((it) => (it.oldPartNumbers || []).length > 0)
        .map((it) => ({
          Brand: it.brand || '',
          'New Part Number': it.partNumber || it.partCode || '',
          'Old Part Number(s)': (it.oldPartNumbers || []).join(', '),
          Particulars: it.particulars,
          'Current Stock': it.currentStock,
        }))
    );
  };

  // --- Engineer issue/return/consumption reports ---

  const exportEngineerIssues = () => {
    const rows = [];
    engineerIssues.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, Customer: doc.customerName, Date: doc.date,
      'Part Number': it.partNumber, Description: it.description, 'Qty Issued': it.qtyIssued,
    })));
    download('engineer_wise_issue.xlsx', rows);
  };

  const exportEngineerReturns = () => {
    const rows = [];
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, 'Return Date': doc.returnDate,
      'Part Number': it.partNumber, 'Qty Returned': it.qtyReturned, Condition: it.condition,
    })));
    download('engineer_wise_return.xlsx', rows);
  };

  const exportConsumptionByEngineer = () => {
    const byEngineer = {};
    engineerIssues.forEach((doc) => {
      const jobKey = doc.serviceJobNo;
      sparePartsUsed.filter((u) => u.serviceJobNo === jobKey).forEach((u) => {
        (u.items || []).forEach((it) => {
          byEngineer[doc.engineerName] = byEngineer[doc.engineerName] || 0;
          byEngineer[doc.engineerName] += Number(it.qtyUsed || 0);
        });
      });
    });
    download('consumption_by_engineer.xlsx', Object.entries(byEngineer).map(([engineer, qty]) => ({ Engineer: engineer, 'Total Qty Consumed': qty })));
  };

  const exportCustomerWiseUsage = () => {
    const rows = [];
    sparePartsUsed.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      Customer: doc.customerName, 'Machine Model': doc.machineModel, 'Serial No': doc.serialNumber,
      'Service Job': doc.serviceJobNo, 'Part Number': it.partNumber, 'Qty Used': it.qtyUsed,
      'Warranty/Chargeable': it.warrantyOrChargeable, Remarks: it.remarks,
    })));
    download('customer_wise_spare_usage.xlsx', rows);
  };

  const exportJobWiseUsage = () => {
    const rows = [];
    sparePartsUsed.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Customer: doc.customerName, 'Part Number': it.partNumber,
      Description: it.description, 'Qty Used': it.qtyUsed, 'Warranty/Chargeable': it.warrantyOrChargeable,
    })));
    download('service_job_wise_spare_usage.xlsx', rows);
  };

  const exportPendingWithEngineers = () => {
    const key = (e, j, p) => `${e}||${j}||${p}`;
    const map = new Map();
    engineerIssues.forEach((doc) => (doc.items || []).forEach((it) => {
      const k = key(doc.engineerName, doc.serviceJobNo, it.partNumber);
      const r = map.get(k) || { engineer: doc.engineerName, job: doc.serviceJobNo, partNumber: it.partNumber, description: it.description, issued: 0, returned: 0, used: 0 };
      r.issued += Number(it.qtyIssued || 0);
      map.set(k, r);
    }));
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => {
      const k = key(doc.engineerName, doc.serviceJobNo, it.partNumber);
      const r = map.get(k) || { engineer: doc.engineerName, job: doc.serviceJobNo, partNumber: it.partNumber, description: '', issued: 0, returned: 0, used: 0 };
      r.returned += Number(it.qtyReturned || 0);
      map.set(k, r);
    }));
    sparePartsUsed.forEach((doc) => {
      const relatedIssue = engineerIssues.find((i) => i.serviceJobNo === doc.serviceJobNo);
      const engineer = relatedIssue ? relatedIssue.engineerName : '(unlinked job)';
      (doc.items || []).forEach((it) => {
        const k = key(engineer, doc.serviceJobNo, it.partNumber);
        const r = map.get(k) || { engineer, job: doc.serviceJobNo, partNumber: it.partNumber, description: it.description, issued: 0, returned: 0, used: 0 };
        r.used += Number(it.qtyUsed || 0);
        map.set(k, r);
      });
    });
    const rows = Array.from(map.values())
      .map((r) => ({ ...r, balance: r.issued - r.returned - r.used }))
      .filter((r) => r.balance > 0)
      .map((r) => ({ Engineer: r.engineer, 'Service Job': r.job, 'Part Number': r.partNumber, Description: r.description, Issued: r.issued, Returned: r.returned, Used: r.used, 'Pending with Engineer': r.balance }));
    download('pending_spare_parts_with_engineers.xlsx', rows);
  };

  const exportLostDamaged = () => {
    const rows = [];
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => {
      if (it.condition === 'Damaged') {
        rows.push({ 'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, 'Return Date': doc.returnDate, 'Part Number': it.partNumber, Quantity: it.qtyReturned, Condition: it.condition });
      }
    }));
    download('lost_or_damaged_spare_parts.xlsx', rows);
  };

  const exportMonthlyConsumption = () => {
    const byMonth = {};
    sparePartsUsed.forEach((doc) => {
      const d = doc.serviceDate ? new Date(`${doc.serviceDate}T00:00:00`) : toDate(doc.createdAt);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      (doc.items || []).forEach((it) => {
        byMonth[key] = (byMonth[key] || 0) + Number(it.qtyUsed || 0);
      });
    });
    download('monthly_spare_parts_consumption.xlsx', Object.entries(byMonth).sort().map(([month, qty]) => ({ Month: month, 'Total Qty Consumed': qty })));
  };

  const exportEngineerAuditTrail = () => {
    const rows = transactions
      .filter((t) => ['engineerIssue', 'engineerReturn', 'consumption'].includes(t.type))
      .map((t) => ({
        'Transaction Date': t.transactionDate || effectiveDate(t)?.toLocaleDateString() || '',
        'Uploaded On': toDate(t.createdAt)?.toLocaleString() || '',
        User: t.performedByEmail,
        Engineer: t.engineer || '',
        'Transaction Type': t.type,
        'Part Number': t.itemName,
        Quantity: t.quantity,
        'Balance Stock': t.balanceAfter ?? '',
        Remarks: t.reason,
      }));
    download('spare_parts_audit_trail.xlsx', rows);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Reports</h1>
      </div>

      {!dataReady && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2 rounded-lg text-sm">
          Loading data from the database — report buttons will switch on in a moment. Please don't
          export yet; exporting before this finishes produces an empty file.
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Quick Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton disabled={!dataReady} label="Stock Summary" onClick={exportStockSummary} />
          <ReportButton disabled={!dataReady} label="Low / Critical Stock" onClick={exportLowStock} />
          <ReportButton disabled={!dataReady} label="Purchases Only" onClick={() => exportMovements('purchase')} />
          <ReportButton disabled={!dataReady} label="Issues Only" onClick={() => exportMovements('issue')} />
          <ReportButton disabled={!dataReady} label="All Transactions (raw)" onClick={() => exportMovements(null)} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Brand &amp; Master Catalogue Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton disabled={!dataReady} label="Brand-wise Inventory" onClick={exportBrandWise} />
          <ReportButton disabled={!dataReady} label="Low Stock Report" onClick={() => exportByStatus('Low Stock', 'low_stock_report.xlsx')} />
          <ReportButton disabled={!dataReady} label="Out-of-Stock Report" onClick={() => exportByStatus('Out of Stock', 'out_of_stock_report.xlsx')} />
          <ReportButton disabled={!dataReady} label="Not Stocked Parts" onClick={() => exportByStatus('Not Stocked', 'not_stocked_parts.xlsx')} />
          <ReportButton disabled={!dataReady} label="Inventory Valuation" onClick={exportInventoryValuation} />
          <ReportButton disabled={!dataReady} label="Fast Moving Spares" onClick={exportFastMoving} />
          <ReportButton disabled={!dataReady} label="Slow Moving Spares" onClick={exportSlowMoving} />
          <ReportButton disabled={!dataReady} label="Dead Stock" onClick={exportDeadStock} />
          <ReportButton disabled={!dataReady} label="Machine-wise Spare Parts" onClick={exportMachineWise} />
          <ReportButton disabled={!dataReady} label="Supplier-wise Spare Parts" onClick={exportSupplierWise} />
          <ReportButton disabled={!dataReady} label="Reorder Report" onClick={exportReorderReport} />
          <ReportButton disabled={!dataReady} label="Old ↔ New Part Number Cross-ref" onClick={exportOldNewPartNumbers} />
        </div>
        {brands.length > 0 && <p className="text-xs text-gray-400">Brands in system: {brands.join(', ')}</p>}
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Current Stock Report — Select Brands</h2>
        {isAdmin || (exportBrands && exportBrands.length > 0) ? (
          <>
            <p className="text-sm text-gray-500 max-w-2xl">
              Tick the brands to include, then download — only those brands' currently-stocked items go into the file.
              {!isAdmin && ' You can only pick from the brands the admin has allowed for you.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {stockReportAllowedBrands.map((b) => (
                <label
                  key={b}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${
                    stockReportBrands.has(b) ? 'bg-emerald-50 border-emerald-400 text-emerald-800 font-semibold' : 'border-gray-300 text-gray-600'
                  }`}
                >
                  <input type="checkbox" checked={stockReportBrands.has(b)} onChange={() => toggleStockReportBrand(b)} />
                  {b}
                </label>
              ))}
              {stockReportAllowedBrands.length === 0 && (
                <span className="text-gray-400 text-sm">No brands available yet.</span>
              )}
            </div>
            <p className="text-sm text-gray-500">{stockedItemsForReport.length} item(s) will be included.</p>
            <ReportButton
              disabled={!dataReady || stockReportBrands.size === 0}
              label="Download Current Stock Report"
              onClick={exportCurrentStockReport}
            />
          </>
        ) : (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <ShieldAlert size={18} className="text-gray-400 shrink-0" />
            You don't have brand access set for this report yet. Ask the admin to allow brands for you in Manage Users
            (Stock Export permission) — the same setting also unlocks this report.
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Engineer Issue &amp; Return Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton disabled={!dataReady} label="Engineer-wise Issue" onClick={exportEngineerIssues} />
          <ReportButton disabled={!dataReady} label="Engineer-wise Return" onClick={exportEngineerReturns} />
          <ReportButton disabled={!dataReady} label="Consumption by Engineer" onClick={exportConsumptionByEngineer} />
          <ReportButton disabled={!dataReady} label="Customer-wise Usage" onClick={exportCustomerWiseUsage} />
          <ReportButton disabled={!dataReady} label="Service Job-wise Usage" onClick={exportJobWiseUsage} />
          <ReportButton disabled={!dataReady} label="Pending with Engineers" onClick={exportPendingWithEngineers} />
          <ReportButton disabled={!dataReady} label="Lost / Damaged Parts" onClick={exportLostDamaged} />
          <ReportButton disabled={!dataReady} label="Monthly Consumption" onClick={exportMonthlyConsumption} />
          <ReportButton disabled={!dataReady} label="Spare Parts Audit Trail" onClick={exportEngineerAuditTrail} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Warehouse Put-away Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton disabled={!dataReady} label="Put-away Report" onClick={exportPutawayReport} />
          <ReportButton disabled={!dataReady} label="Pending Location Report" onClick={exportPendingLocationReport} />
          <ReportButton disabled={!dataReady} label="Completed Location Report" onClick={exportCompletedLocationReport} />
          <ReportButton disabled={!dataReady} label="Ageing Report" onClick={exportAgeingReport} />
          <ReportButton disabled={!dataReady} label="Location-wise Stock" onClick={() => exportLocationWiseStock('location')} />
          <ReportButton disabled={!dataReady} label="Rack-wise Stock" onClick={() => exportLocationWiseStock('rack')} />
          <ReportButton disabled={!dataReady} label="Shelf-wise Stock" onClick={() => exportLocationWiseStock('shelf')} />
          <ReportButton disabled={!dataReady} label="Bin-wise Stock" onClick={() => exportLocationWiseStock('bin')} />
        </div>
        <p className="text-xs text-gray-400">
          "Put-away Report" and "Pending Location Report" now include an <strong>Existing Locations</strong> column —
          every rack/shelf/bin this same item already has stock in, pulled from its full put-away history — so new
          arrivals can go straight to where the item already lives instead of a new spot. Blank means it's genuinely
          new to a location. For full Location History (every location change with user/date/time), see Warehouse
          Put-away &rarr; Location History in the left menu.
        </p>
      </div>

      {isAdmin && (
        <div className="bg-white rounded-lg shadow p-6 space-y-4 border-2 border-red-100">
          <div className="flex items-center gap-2">
            <Trash2 className="text-red-600" size={20} />
            <h2 className="font-semibold text-gray-800">Bulk Delete by Reference Number</h2>
          </div>
          <p className="text-xs text-gray-400">
            For a reference number that was uploaded wrong repeatedly (e.g. a packing list that kept getting
            recorded as outward instead of inward) — enter the exact reference/document number, review every
            transaction it will affect, then delete all of them in one go. Each one's stock effect is correctly
            reversed and everything is removed in a safe order so stock never goes negative mid-way. Admin only.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference / Document No.</label>
              <input
                type="text"
                value={bulkRefInput}
                onChange={(e) => setBulkRefInput(e.target.value)}
                placeholder="e.g. 184134543"
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-red-500"
              />
            </div>
            <button
              onClick={previewBulkDelete}
              disabled={!bulkRefInput.trim()}
              className="border border-gray-400 text-gray-700 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              Find Transactions
            </button>
          </div>

          {bulkResult && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded text-sm">{bulkResult}</div>
          )}

          {bulkPreview && (
            <div className="border rounded-lg overflow-hidden">
              <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm font-medium text-red-800">
                {bulkPreview.rows.length === 0
                  ? `No transactions found for reference "${bulkPreview.key}".`
                  : `${bulkPreview.rows.length} transaction(s) found for reference "${bulkPreview.key}" — all of these will be permanently deleted:`}
              </div>
              {bulkPreview.rows.length > 0 && (
                <>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Type</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkPreview.rows.map((t) => (
                          <tr key={t.id} className="border-b last:border-0">
                            <td className="px-3 py-2">{t.transactionDate || effectiveDate(t)?.toLocaleDateString() || ''}</td>
                            <td className="px-3 py-2">{t.itemName}</td>
                            <td className="px-3 py-2 capitalize">{t.type} ({t.direction})</td>
                            <td className="px-3 py-2 text-right">{t.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="p-4 space-y-3 border-t">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Reason for deleting all of these *</label>
                      <input
                        type="text"
                        value={bulkReason}
                        onChange={(e) => setBulkReason(e.target.value)}
                        placeholder="e.g. Reference uploaded wrong multiple times — clearing to start fresh"
                        className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-red-500"
                      />
                    </div>
                    {bulkError && (
                      <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{bulkError}</div>
                    )}
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => setBulkPreview(null)}
                        disabled={bulkBusy}
                        className="px-4 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={runBulkDelete}
                        disabled={bulkBusy}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-50"
                      >
                        {bulkBusy ? 'Deleting...' : `Permanently Delete All ${bulkPreview.rows.length}`}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold text-gray-800">Date-Range Movement Report</h2>
          <button
            onClick={() => setShowMovementModal(true)}
            title="Open the data in a larger, zoomed view"
            className="flex items-center gap-1.5 text-emerald-700 hover:text-white border border-emerald-600 hover:bg-emerald-600 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <Maximize2 size={15} /> View / Zoom Data
          </button>
        </div>
        <p className="text-xs text-gray-400">
          Filters and sorts by each movement's actual <strong>Transaction Date</strong> — not when it was uploaded —
          so a document entered late still lands in the correct period. "Uploaded On" is kept alongside it as the
          audit-trail record of when it was actually typed into the system. Click "View / Zoom Data" to browse the
          rows in a larger window instead of scrolling this page.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <ReportButton disabled={!dataReady} label="Export Range" onClick={() => exportMovements(null)} />
        </div>
      </div>

      {showMovementModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setShowMovementModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[88vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <h3 className="font-semibold text-gray-800 text-lg">
                Date-Range Movement Report
                {filteredTxns.length > 0 && (
                  <span className="text-sm font-normal text-gray-400 ml-2">
                    (showing {Math.min(filteredTxns.length, 50)} of {filteredTxns.length})
                  </span>
                )}
              </h3>
              <button onClick={() => setShowMovementModal(false)} className="text-gray-400 hover:text-gray-700 p-1">
                <X size={22} />
              </button>
            </div>
            <div className="overflow-auto p-6">
              <table className="w-full text-base">
                <thead className="bg-gray-50 border-b sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Transaction Date</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Uploaded On</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Item</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Type</th>
                    <th className="text-right px-4 py-3 font-semibold text-gray-600">Qty</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Reason / Reference</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">By</th>
                    {isAdmin && <th className="text-center px-4 py-3 font-semibold text-gray-600">Delete</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredTxns.slice(0, 50).map((t) => (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="px-4 py-3">{t.transactionDate || effectiveDate(t)?.toLocaleDateString() || ''}</td>
                      <td className="px-4 py-3 text-gray-400">{toDate(t.createdAt)?.toLocaleString() || ''}</td>
                      <td className="px-4 py-3">{t.itemName}</td>
                      <td className="px-4 py-3 capitalize">{t.type} ({t.direction})</td>
                      <td className="px-4 py-3 text-right">{t.quantity}</td>
                      <td className="px-4 py-3">{t.reason}</td>
                      <td className="px-4 py-3">{t.performedByEmail}</td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => {
                              setDeleteTarget(t);
                              setDeleteReason('');
                              setDeleteError('');
                            }}
                            title="Permanently delete this transaction and reverse its stock effect"
                            className="text-red-600 hover:text-white hover:bg-red-600 border border-red-300 rounded-lg p-1.5 transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {filteredTxns.length === 0 && (
                    <tr>
                      <td colSpan={isAdmin ? 8 : 7} className="px-4 py-8 text-center text-gray-400">No transactions in range.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
          onClick={() => (deleting ? null : setDeleteTarget(null))}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-6 py-4 border-b">
              <ShieldAlert className="text-red-600" size={22} />
              <h3 className="font-semibold text-gray-800 text-lg">Delete Transaction</h3>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-gray-50 border rounded-lg px-4 py-3 text-sm space-y-1">
                <p><span className="text-gray-500">Item:</span> <span className="font-medium">{deleteTarget.itemName}</span></p>
                <p><span className="text-gray-500">Type:</span> <span className="capitalize">{deleteTarget.type} ({deleteTarget.direction})</span></p>
                <p><span className="text-gray-500">Quantity:</span> {deleteTarget.quantity}</p>
                <p><span className="text-gray-500">Date:</span> {deleteTarget.transactionDate || effectiveDate(deleteTarget)?.toLocaleDateString() || ''}</p>
                <p><span className="text-gray-500">Reference:</span> {deleteTarget.reason || '(none)'}</p>
                <p><span className="text-gray-500">Recorded by:</span> {deleteTarget.performedByEmail}</p>
              </div>
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                This permanently deletes the transaction and reverses its stock effect
                ({deleteTarget.direction === 'in'
                  ? `removes ${deleteTarget.quantity} from current stock`
                  : `adds ${deleteTarget.quantity} back to current stock`}
                ). This cannot be undone from within the app. A minimal log (who, when, why) is kept separately so
                there's still a trace that a deletion happened.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason for deleting *</label>
                <input
                  type="text"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="e.g. Recorded as outward by mistake — was actually an inward delivery"
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-red-500"
                  autoFocus
                />
              </div>
              {deleteError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{deleteError}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteTransaction}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Permanently Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Inward / Outward Stock Report</h2>
        <p className="text-xs text-gray-400">
          Inward = Purchases, Returns, and any admin stock-adjustment increases. Outward = Issues, Delivery
          Challans/Sales, and admin stock-adjustment decreases. Each export lists every part line — Part Code,
          Particulars, Quantity, and the Reference / Document Number (whatever was typed into "Reason / Reference"
          when it was recorded — the Packing List No, Invoice No, or DC No) — grouped under its Day/Month/Year/
          Reference with a subtotal after each group and a grand total at the end. Stock Adjustments (and any older
          entry that never had a cost recorded on it) show the item's current Avg Cost as an estimated value instead
          of a blank/zero — the actual invoice cost, when one exists, is always used first. Leave dates blank to include
          all history.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input type="date" value={ioStartDate} onChange={(e) => setIoStartDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input type="date" value={ioEndDate} onChange={(e) => setIoEndDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-emerald-800 mb-2">📥 Inward (Purchases / Returns)</h3>
          <div className="flex flex-wrap gap-3">
            <ReportButton disabled={!dataReady} label="Day-wise" onClick={() => exportDirectionRollup('in', 'Date', dayKey, 'inward_day_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Month-wise" onClick={() => exportDirectionRollup('in', 'Month', monthKey, 'inward_month_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Year-wise" onClick={() => exportDirectionRollup('in', 'Year', yearKey, 'inward_year_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Reference Number-wise" onClick={() => exportDirectionRollup('in', 'Reference / Document No.', referenceGroupKey, 'inward_reference_wise.xlsx')} />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-amber-800 mb-2">📤 Outward (Issues / DC / Sales)</h3>
          <div className="flex flex-wrap gap-3">
            <ReportButton disabled={!dataReady} label="Day-wise" onClick={() => exportDirectionRollup('out', 'Date', dayKey, 'outward_day_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Month-wise" onClick={() => exportDirectionRollup('out', 'Month', monthKey, 'outward_month_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Year-wise" onClick={() => exportDirectionRollup('out', 'Year', yearKey, 'outward_year_wise.xlsx')} />
            <ReportButton disabled={!dataReady} label="Reference Number-wise" onClick={() => exportDirectionRollup('out', 'Reference / Document No.', referenceGroupKey, 'outward_reference_wise.xlsx')} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportButton({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Loading data — please wait a moment before exporting.' : undefined}
      className={`flex items-center gap-2 border px-4 py-2 rounded-lg text-sm ${
        disabled
          ? 'border-gray-300 text-gray-400 cursor-not-allowed'
          : 'border-emerald-700 text-emerald-700 hover:bg-emerald-50'
      }`}
    >
      <Download size={16} /> {label}
    </button>
  );
}
