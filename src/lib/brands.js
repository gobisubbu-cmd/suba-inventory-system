// Shared brand + stock-status helpers used across the app.
//
// New Firestore collection: brands/{id}
//   name (string, unique, e.g. "SINMAG"), createdAt, createdByEmail
//
// Brands are no longer hardcoded — Manage Items, Import Data, Spare Search,
// Reports and the Dashboard all read the live list from this collection so
// new brands (beyond SINMAG / RATIONAL / JIPA) can be added at any time from
// the Brands screen without a code change.

import { collection, addDoc, getDocs, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export const SEED_BRANDS = ['SINMAG', 'RATIONAL', 'JIPA'];

export async function ensureSeedBrands(userEmail) {
  const snap = await getDocs(collection(db, 'brands'));
  const existing = new Set(snap.docs.map((d) => (d.data().name || '').toUpperCase()));
  const missing = SEED_BRANDS.filter((b) => !existing.has(b));
  for (const name of missing) {
    await addDoc(collection(db, 'brands'), {
      name,
      createdAt: serverTimestamp(),
      createdByEmail: userEmail || 'system',
    });
  }
}

export async function fetchBrands() {
  const q = query(collection(db, 'brands'), orderBy('name', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Stock status is always derived, never stored as a free-text field a user
// can get out of sync — computed the same way everywhere (item forms,
// tables, dashboard, reports, search).
export function computeStockStatus(item) {
  const stock = Number(item.currentStock || 0);
  const reorder = Number(item.reorderLevel || 0);
  const isMaster = Boolean(item.masterOnly); // true = catalogue entry never physically stocked

  if (stock <= 0) {
    return isMaster ? 'Not Stocked' : 'Out of Stock';
  }
  if (reorder > 0 && stock <= reorder) {
    return 'Low Stock';
  }
  return 'In Stock';
}

export const STOCK_STATUS_STYLES = {
  'In Stock': 'bg-green-100 text-green-700 border-green-300',
  'Low Stock': 'bg-yellow-100 text-yellow-800 border-yellow-300',
  'Out of Stock': 'bg-red-100 text-red-700 border-red-300',
  'Not Stocked': 'bg-gray-100 text-gray-600 border-gray-300',
};

// A part is searchable/matchable by EITHER its current (new) part number or
// any of its superseded (old) part numbers — RATIONAL requirement #15.
export function allPartNumbers(item) {
  const list = [];
  if (item.partNumber) list.push(item.partNumber);
  if (Array.isArray(item.oldPartNumbers)) list.push(...item.oldPartNumbers.filter(Boolean));
  return list;
}

export function matchesSearch(item, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return true;
  const haystacks = [
    item.brand,
    item.particulars,
    item.description,
    item.category,
    item.supplier,
    item.machineModels,
    computeStockStatus(item),
    ...allPartNumbers(item),
  ];
  return haystacks.some((h) => String(h || '').toLowerCase().includes(t));
}
