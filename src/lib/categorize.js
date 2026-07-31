// Keyword-based category inference for spare parts whose `category` field is
// blank. Used as a fallback wherever we need to group items by category
// (Reorder Items page, Overview breakdown) without forcing a re-import.
// Rules are ordered most-specific-first; the first match wins.
//
// This taxonomy was derived by analysing ~740 real SUBA spare-part
// descriptions across SINMAG, RATIONAL, TAIYI, HOBART, HALLDE and
// Electrolux and picking keyword buckets that gave good real-world coverage.

const RULES = [
  ['Cutting Tools & Blades', /\b(knife|blade|julienne|slicer disc|cutting|dicer|grater|shredder|corer)\b/i],
  ['Mixer, Dough & Scrapper Parts', /\b(scrapper|beater|whisk|dough hook|u-form|pisciform|adjusting block|support seat|prewheel|bowl fixed hinge)\b/i],
  ['Motors & Gearboxes', /\b(motor|gear ?box|pinion|gear|shaft|drive \d|kw drive)\b/i],
  ['Belts, Conveyors & Sheeter Parts', /\b(belt|conveyor|sheeter|chain|pulley)\b/i],
  ['Fans & Ventilation', /\b(fan|blower|exhaust|vent)\b/i],
  ['Control Panels, PCBs & Displays', /\b(pcb|pc board|control panel|circuit board|display|touch ?screen|keypad|membrane)\b/i],
  ['Heating Elements & Burners', /\b(heat(er|ing)|burner|spark rod|igniter|element)\b/i],
  ['Valves & Solenoids', /\b(valve|solenoid|flowmeter)\b/i],
  ['Sensors, Probes & Floats', /\b(sensor|probe|thermostat|thermocouple|limiter|float)\b/i],
  ['Water & Steam System', /\b(nozzle|spout|shower|humidity|water|steam|pump|hose|pipe)\b/i],
  ['Switches, Buttons & Relays', /\b(switch|button|relay|timer|contactor)\b/i],
  ['Electrical & Wiring', /\b(converter|transformer|wire|cable|connector|voltage|socket|plug|fuse|capacitor|bulb|lamp|light)\b/i],
  ['Bearings, Bushings & Seals', /\b(bearing|bushing|seal|gasket|o-?ring)\b/i],
  ['Doors, Locks & Hinges', /\b(door|lock|hinge|handle)\b/i],
  ['Wheels & Casters', /\b(wheel|caster|roller)\b/i],
  ['Springs & Fasteners', /\b(spring|screw|rivet|washer|nut|bolt|clip|pin)\b/i],
  ['Trolleys, Racks, Bowls & Trays', /\b(trolley|rack|bowl|tray|basket)\b/i],
  ['Filters', /\bfilter\b/i],
  ['Covers, Panels & Plastic Parts', /\b(cover|panel|plastic|cap|knob|housing|bracket|frame)\b/i],
];

export const FALLBACK_CATEGORY = 'General Spares';

// Full ordered list of category names this module can produce, for building
// filter dropdowns / legends.
export const CATEGORY_NAMES = [...RULES.map((r) => r[0]), FALLBACK_CATEGORY];

// Returns the item's own category if set, otherwise infers one from its
// particulars/description text. Never mutates the item.
export function categoryOf(item) {
  const explicit = (item.category || '').trim();
  if (explicit) return explicit;
  const text = `${item.particulars || ''} ${item.description || ''}`;
  for (const [name, pattern] of RULES) {
    if (pattern.test(text)) return name;
  }
  return FALLBACK_CATEGORY;
}

// Groups a list of items by categoryOf(item), returning entries sorted by
// group size (largest first) then name.
export function groupByCategory(items) {
  const groups = new Map();
  for (const it of items) {
    const cat = categoryOf(it);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}
