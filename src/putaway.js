// Shared helpers for the Warehouse Put-away Management module.
//
// Data model (new Firestore collections):
//
// locations/{id}
//   warehouse, rack, shelf, bin, locationCode (auto "RACK-SHELF-BIN"),
//   maxCapacity, currentOccupancy, status ('ACTIVE' | 'INACTIVE'),
//   createdAt, updatedAt
//
// putawayLines/{id}   -- one per received goods line (created the moment a
//                         Purchase/Return "in" movement is recorded)
//   invoiceNumber, invoiceDate, supplier, itemId, itemCode (sno), description,
//   receivedQty, locatedQty, pendingQty, status ('LOCATION PENDING' | 'PARTIAL' | 'COMPLETE'),
//   allocations: [{ locationCode, qty, allocatedAt, allocatedByEmail }],
//   transactionId, createdAt, updatedAt
//
// locationAuditLog/{id}
//   action ('PURCHASE_ENTRY' | 'LOCATION_UPLOAD' | 'LOCATION_CHANGE'),
//   putawayLineId, itemId, itemName, userEmail, oldLocationCode, newLocationCode,
//   qty, createdAt

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

export const LOCATION_STATUS = {
  PENDING: 'LOCATION PENDING',
  PARTIAL: 'PARTIAL',
  COMPLETE: 'COMPLETE',
};

// Colour-coded ageing bands per spec:
// Green = completed, Yellow = 1-2 days, Orange = 3-7 days, Red = above 7 days.
export function daysPending(createdAt) {
  const d = createdAt && createdAt.toDate ? createdAt.toDate() : createdAt ? new Date(createdAt) : null;
  if (!d) return 0;
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function ageingColour(line) {
  if (line.status === LOCATION_STATUS.COMPLETE) {
    return { label: 'Completed', color: 'bg-green-100 text-green-700 border-green-300' };
  }
  const days = daysPending(line.createdAt);
  if (days <= 2) return { label: `Pending ${days}d`, color: 'bg-yellow-100 text-yellow-800 border-yellow-300' };
  if (days <= 7) return { label: `Pending ${days}d`, color: 'bg-orange-100 text-orange-800 border-orange-300' };
  return { label: `Pending ${days}d`, color: 'bg-red-100 text-red-700 border-red-300' };
}

// Existing locations for an item, read from its own currently-open/complete
// putaway lines' allocations — used to show reference locations before saving
// a new receipt (per spec: display only, never auto-assign).
export async function getExistingLocationsForItem(itemId) {
  if (!itemId) return [];
  const q = query(collection(db, 'putawayLines'), where('itemId', '==', itemId));
  const snap = await getDocs(q);
  const byLocation = {};
  snap.docs.forEach((d) => {
    const data = d.data();
    (data.allocations || []).forEach((a) => {
      if (!a.locationCode) return;
      byLocation[a.locationCode] = (byLocation[a.locationCode] || 0) + Number(a.qty || 0);
    });
  });
  return Object.entries(byLocation)
    .filter(([, qty]) => qty > 0)
    .map(([locationCode, qty]) => ({ locationCode, qty }));
}

// Called immediately after a Purchase/Return ("in") movement is recorded.
// Creates the put-away line with the full received quantity pending, and
// writes a PURCHASE_ENTRY audit entry. Never touches item.rackNo or
// currentStock — those are handled by the caller's own transaction.
export async function createPutawayLine({
  itemId,
  itemName,
  itemCode,
  quantity,
  invoiceNumber,
  invoiceDate,
  supplier,
  transactionId,
  userEmail,
}) {
  const qty = Number(quantity) || 0;
  if (!itemId || qty <= 0) return null;

  const lineRef = await addDoc(collection(db, 'putawayLines'), {
    invoiceNumber: invoiceNumber || '',
    invoiceDate: invoiceDate || '',
    supplier: supplier || '',
    itemId,
    itemCode: itemCode ?? '',
    description: itemName || '',
    receivedQty: qty,
    locatedQty: 0,
    pendingQty: qty,
    status: LOCATION_STATUS.PENDING,
    allocations: [],
    transactionId: transactionId || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'locationAuditLog'), {
    action: 'PURCHASE_ENTRY',
    putawayLineId: lineRef.id,
    itemId,
    itemName: itemName || '',
    userEmail: userEmail || '',
    oldLocationCode: '',
    newLocationCode: '',
    qty,
    createdAt: serverTimestamp(),
  });

  return lineRef.id;
}

// Applies a location allocation to a put-away line (from the completed
// Put-away Location Report upload, or a manual location edit). Updates
// locatedQty/pendingQty/status on the line, bumps the location's
// currentOccupancy, and writes a LOCATION_UPLOAD / LOCATION_CHANGE audit
// entry. Software will not mark a line COMPLETE until locatedQty === receivedQty.
export async function applyLocationAllocation({
  line,
  locationCode,
  qty,
  userEmail,
  action = 'LOCATION_UPLOAD',
}) {
  const allocateQty = Number(qty) || 0;
  if (allocateQty <= 0) throw new Error('Allocation quantity must be greater than 0.');
  const pending = Number(line.pendingQty || 0);
  if (allocateQty > pending) {
    throw new Error(
      `Cannot allocate ${allocateQty} — only ${pending} still pending for this line.`
    );
  }

  const newAllocations = [...(line.allocations || [])];
  const existingIdx = newAllocations.findIndex((a) => a.locationCode === locationCode);
  if (existingIdx >= 0) {
    newAllocations[existingIdx] = {
      ...newAllocations[existingIdx],
      qty: Number(newAllocations[existingIdx].qty || 0) + allocateQty,
      allocatedAt: new Date().toISOString(),
      allocatedByEmail: userEmail || '',
    };
  } else {
    newAllocations.push({
      locationCode,
      qty: allocateQty,
      allocatedAt: new Date().toISOString(),
      allocatedByEmail: userEmail || '',
    });
  }

  const newLocatedQty = Number(line.locatedQty || 0) + allocateQty;
  const newPendingQty = Number(line.receivedQty || 0) - newLocatedQty;
  const newStatus =
    newPendingQty <= 0 ? LOCATION_STATUS.COMPLETE : newLocatedQty > 0 ? LOCATION_STATUS.PARTIAL : LOCATION_STATUS.PENDING;

  await updateDoc(doc(db, 'putawayLines', line.id), {
    allocations: newAllocations,
    locatedQty: newLocatedQty,
    pendingQty: Math.max(0, newPendingQty),
    status: newStatus,
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'locationAuditLog'), {
    action,
    putawayLineId: line.id,
    itemId: line.itemId,
    itemName: line.description || '',
    userEmail: userEmail || '',
    oldLocationCode: '',
    newLocationCode: locationCode,
    qty: allocateQty,
    createdAt: serverTimestamp(),
  });

  // Bump the location's current occupancy if it exists in the Location Master.
  try {
    const locQ = query(collection(db, 'locations'), where('locationCode', '==', locationCode));
    const locSnap = await getDocs(locQ);
    if (!locSnap.empty) {
      const locDoc = locSnap.docs[0];
      const current = Number(locDoc.data().currentOccupancy || 0);
      await updateDoc(doc(db, 'locations', locDoc.id), {
        currentOccupancy: current + allocateQty,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (e) {
    // Non-fatal — occupancy tracking is best-effort if the location code
    // doesn't exist yet in the Location Master.
  }
}

// Aggregate stats used by the Dashboard widget, the login popup, and the
// backend's daily email reminder.
export function computePutawayStats(pendingLines) {
  if (!pendingLines.length) {
    return { pendingInvoices: 0, pendingItems: 0, pendingQty: 0, oldestDays: 0, newestDays: 0 };
  }
  const invoices = new Set(pendingLines.map((l) => l.invoiceNumber || l.id));
  const days = pendingLines.map((l) => daysPending(l.createdAt));
  return {
    pendingInvoices: invoices.size,
    pendingItems: pendingLines.length,
    pendingQty: pendingLines.reduce((s, l) => s + Number(l.pendingQty || 0), 0),
    oldestDays: Math.max(...days),
    newestDays: Math.min(...days),
  };
}
