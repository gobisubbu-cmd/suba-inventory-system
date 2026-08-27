import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, Check, ChevronDown } from 'lucide-react';
import { matchesSearch } from '../lib/brands';

// Full-screen search-and-pick overlay, built for a phone: a plain <select>
// with hundreds of parts in it is unusable on a small touch keyboard, and a
// desktop-style inline dropdown is too fiddly to tap accurately. Tapping the
// field opens a full-screen list instead — big tap targets, autofocused
// search, one tap to pick.
export default function MobileItemPicker({ items, value, onChange, placeholder = 'Select a part...' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  const selected = items.find((it) => it.id === value);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const sorted = [...items].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || ''));
    if (!q) return sorted.slice(0, 60);
    // Same matcher as everywhere else in the app: exact substring first,
    // then a loose pass ignoring spaces/hyphens — so "TS 118" on a phone
    // keyboard still finds a part stored as "TS-118".
    return sorted.filter((it) => matchesSearch(it, q)).slice(0, 60);
  }, [items, query]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-between px-4 py-3 border rounded-xl text-left bg-white active:bg-gray-50"
      >
        <span className={selected ? 'text-gray-800 font-medium truncate' : 'text-gray-400'}>
          {selected
            ? `${selected.brand ? `[${selected.brand}] ` : ''}${selected.particulars}`
            : placeholder}
        </span>
        <ChevronDown size={18} className="text-gray-400 shrink-0 ml-2" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center gap-2 p-3 border-b shrink-0">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search part name, number, brand..."
                className="w-full pl-10 pr-3 py-3 border rounded-xl text-base focus:outline-none focus:border-emerald-600"
              />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-3 text-gray-500 active:text-gray-800"
              aria-label="Close"
            >
              <X size={22} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="text-center text-gray-400 py-10 px-4">No matching parts. Try a different search.</p>
            )}
            {filtered.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => {
                  onChange(it.id);
                  setOpen(false);
                }}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 border-b text-left active:bg-emerald-50"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{it.particulars}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {it.brand ? `[${it.brand}] ` : ''}
                    {it.partNumber || it.partCode || ''} · stock: {it.currentStock ?? 0}
                  </p>
                </div>
                {it.id === value && <Check size={18} className="text-emerald-600 shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
