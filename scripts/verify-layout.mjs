/**
 * scripts/verify-layout.mjs — Headless verification of the packing algorithm.
 *
 * Run with:  node scripts/verify-layout.mjs
 *
 * It exercises the pure modules (no DOM / WebGL needed) and asserts the
 * guarantees required by Technical Specification v1.3:
 *   - 100 units with unique ids and unique names
 *   - every footprint between 2 and 8 world units
 *   - no two units intersect
 *   - the requested padding / aisle spacing is respected
 *   - every unit stays on the 0.5 world-unit lattice
 */

import { generateShopData, SHOP_HEIGHT } from '../src/data.js';
import { layoutShops, verifyLayout, placementsById } from '../src/layout.js';

let failures = 0;

function assert(condition, message, detail = '') {
  if (condition) {
    console.log(`  [32mPASS[0m ${message}${detail ? `  ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  [31mFAIL[0m ${message}${detail ? `  ${detail}` : ''}`);
  }
}

console.log('\n=== Data generation ===');
const shops = generateShopData(100);

assert(shops.length === 100, '100 units generated', `(${shops.length})`);
assert(new Set(shops.map((s) => s.id)).size === 100, 'unique ids');
assert(new Set(shops.map((s) => s.name)).size === 100, 'unique names');
assert(
  shops.every((s) => s.width >= 2 && s.width <= 8 && s.depth >= 2 && s.depth <= 8),
  'footprints within [2, 8]'
);
assert(
  shops.every((s) => Number.isInteger(s.color) && s.color >= 0 && s.color <= 0xffffff),
  'colours are valid hex integers'
);
assert(
  shops[0].id === 'shop_001' && shops[0].name === 'Apple Store',
  'first unit matches the specification example'
);

console.log('\n=== Layout ===');
const layout = layoutShops(shops, { padding: 1, aisle: 2 });
const placements = layout.placements;

assert(placements.length === 100, 'every unit placed', `(${placements.length})`);
assert(
  placements.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)),
  'all coordinates are finite'
);

const violations = verifyLayout(placements);
assert(violations.length === 0, 'no two units overlap', violations.length ? JSON.stringify(violations.slice(0, 3)) : '');

// Spacing: on the same shelf the gap must be >= padding, between shelves >= aisle.
const byShelf = new Map();
for (const p of placements) {
  if (!byShelf.has(p.shelf)) byShelf.set(p.shelf, []);
  byShelf.get(p.shelf).push(p);
}
let minInShelf = Infinity;
for (const list of byShelf.values()) {
  list.sort((a, b) => a.x - b.x);
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].x - list[i].width / 2 - (list[i - 1].x + list[i - 1].width / 2);
    minInShelf = Math.min(minInShelf, gap);
  }
}
assert(minInShelf >= 1 - 1e-9, 'in-shelf gap respects the padding', `min = ${minInShelf.toFixed(3)}`);

let minBetweenShelves = Infinity;
const shelves = [...byShelf.values()].sort((a, b) => a[0].z - b[0].z);
for (let i = 1; i < shelves.length; i++) {
  const previous = shelves[i - 1];
  const current = shelves[i];
  const previousFar = Math.max(...previous.map((p) => p.z + p.depth / 2));
  const currentNear = Math.min(...current.map((p) => p.z - p.depth / 2));
  minBetweenShelves = Math.min(minBetweenShelves, currentNear - previousFar);
}
assert(
  minBetweenShelves >= 2 - 1e-9,
  'aisle between shelves is respected',
  `min = ${minBetweenShelves.toFixed(3)}`
);

const onLattice = placements.every(
  (p) => Math.abs(p.x * 2 - Math.round(p.x * 2)) < 1e-9 && Math.abs(p.z * 2 - Math.round(p.z * 2)) < 1e-9
);
assert(onLattice, 'all units sit on the 0.5 unit lattice');

const map = placementsById(placements);
assert(map.size === 100, 'placement map is keyed by id');
assert(map.get('shop_001') !== undefined, 'shop_001 is addressable by id');

console.log('\n=== Metrics ===');
console.log(`  shelves        : ${layout.stats.shelves}`);
console.log(`  plan           : ${layout.stats.width.toFixed(2)} x ${layout.stats.depth.toFixed(2)} units`);
console.log(`  shelf limit    : ${layout.stats.shelfWidth.toFixed(2)} units`);
console.log(`  occupancy      : ${(layout.stats.occupancy * 100).toFixed(1)} %`);
console.log(`  unit height    : ${SHOP_HEIGHT} units`);
console.log(`  bounds radius  : ${layout.bounds.radius.toFixed(2)} units`);

console.log(
  failures === 0
    ? '\n[32mAll layout assertions passed.[0m\n'
    : `\n[31m${failures} assertion(s) failed.[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
