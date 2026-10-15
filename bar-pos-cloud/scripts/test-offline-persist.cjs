/**
 * Node tests for offline queue durability logic (no browser).
 * Run: node scripts/test-offline-persist.cjs
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed++;
    console.log("  PASS", name);
  } else {
    failed++;
    console.log("  FAIL", name);
  }
}

// --- Simulate localStorage-style persistence ---
function lsRoundTrip(arr) {
  const raw = JSON.stringify(arr);
  const back = JSON.parse(raw);
  return Array.isArray(back) && back.length === arr.length && back[0].id === arr[0].id;
}

// --- Simulate Electron disk write (atomic tmp+rename) ---
function diskRoundTrip(arr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sherehe-q-"));
  const f = path.join(dir, "offline-sales_queue.json");
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr), "utf8");
  fs.renameSync(tmp, f);
  const back = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return Array.isArray(back) && back.length === arr.length && back[0].receipt_no === arr[0].receipt_no;
}

// --- Merge by id ---
function mergeById(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || !item.id || item.synced) continue;
      if (!map.has(item.id)) map.set(item.id, item);
    }
  }
  return Array.from(map.values());
}

const saleA = {
  id: "a1",
  created_at: "2026-01-01T00:00:00Z",
  receipt_no: "OFF-1",
  items: [],
  payment_method: "cash",
  creditor_name: null,
  total: 100,
  cost_total: 50,
  cashier_id: "u1",
  cashier_name: "Admin",
};
const saleB = { ...saleA, id: "b2", receipt_no: "OFF-2" };

console.log("Offline persistence tests");
assert("localStorage JSON round-trip", lsRoundTrip([saleA]));
assert("disk atomic write round-trip", diskRoundTrip([saleA, saleB]));
assert(
  "merge prefers unique ids",
  mergeById([[saleA], [saleA, saleB], [saleB]]).length === 2,
);
assert(
  "merge drops synced",
  mergeById([[{ ...saleA, synced: true }], [saleB]]).length === 1,
);
{
  const raw = JSON.stringify([]);
  const back = JSON.parse(raw);
  assert("empty array round-trip", Array.isArray(back) && back.length === 0);
}

// Double-add bug simulation: save full queue then add again should not duplicate if checked
{
  let q = [saleA];
  const add = (sale) => {
    if (!q.some((s) => s.id === sale.id)) q.push(sale);
  };
  add(saleA);
  add(saleB);
  assert("no duplicate on re-add same id", q.length === 2);
}

// Close-app simulation: only sync LS write completed
{
  const ls = JSON.stringify([saleA]);
  // app "restarts"
  const restored = JSON.parse(ls);
  assert("survives restart from LS alone", restored[0].id === "a1");
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
