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
//
// Some items only ever had `partCode` set (never `partNumber`) — e.g. older
// bulk/reference-list imports that predate the two fields being kept in
// sync — so Dashboard's own display/search already falls back to partCode.
// This is the one shared place every matcher (Import Data, Spare Search,
// etc.) should go through, so it needs the same fallback or those items
// stay invisible to matching even though they're visible everywhere else.
export function allPartNumbers(item) {
  const list = [];
  if (item.partNumber) list.push(item.partNumber);
  if (item.partCode && item.partCode !== item.partNumber) list.push(item.partCode);
  if (Array.isArray(item.oldPartNumbers)) list.push(...item.oldPartNumbers.filter(Boolean));
  return list;
}

// Strips spaces/hyphens so "SM401" can find "SM - 401" or "SM 401" — real
// stock names are typed inconsistently (some with a hyphen before the model
// number, some without, some with extra spacing), and a person searching
// from a screenshot or supplier list won't know which style was used.
export function normalizeForLooseMatch(s) {
  return String(s || '').toLowerCase().replace(/[\s-]+/g, '');
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
  // Precise pass first (keeps exact behavior for anyone relying on it).
  if (haystacks.some((h) => String(h || '').toLowerCase().includes(t))) return true;
  // Loose fallback: ignore spacing/hyphen differences, e.g. typing "SM401"
  // (or even just "M40") should still find "SM - 401" / "SM 401".
  const looseTerm = normalizeForLooseMatch(t);
  if (!looseTerm) return false;
  return haystacks.some((h) => normalizeForLooseMatch(h).includes(looseTerm));
}
