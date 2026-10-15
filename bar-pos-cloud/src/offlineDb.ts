/**
 * Durable offline queue for Sherehe POS.
 * Triple-write: localStorage (sync) → IndexedDB → Electron userData file (desktop).
 * Designed so closing the app immediately after an offline sale still keeps data.
 */

export type OfflineSale = {
  id: string;
  created_at: string;
  items: {
    product_id: string;
    quantity: number;
    product_name: string;
    unit_price: number;
    cost_price: number;
  }[];
  payment_method: string;
  creditor_name: string | null;
  total: number;
  cost_total: number;
  cashier_id: string;
  cashier_name: string;
  receipt_no: string;
  synced?: boolean;
  sync_error?: string;
  conflict?: boolean;
};

export type OfflineStockReceipt = {
  id: string;
  created_at: string;
  product_id: string;
  product_name: string;
  quantity: number;
  total_cost: number;
  supplier: string | null;
  receipt_no: string | null;
  note: string;
  user_id: string;
  synced?: boolean;
  sync_error?: string;
};

const DB_NAME = "sherehe_pos_offline_v2";
const DB_VERSION = 2;
const LS_SALES = "barpos_offline_sales";
const LS_STOCK = "barpos_offline_stock";
const LS_SALES_LEGACY = "barpos_offline_sales";
const LS_STOCK_LEGACY = "barpos_offline_stock";

type StoreName = "kv" | "products" | "settings" | "profile" | "creds" | "meta";

declare global {
  interface Window {
    barposDesktop?: {
      isDesktop?: boolean;
      queueRead?: (key: string) => Promise<unknown>;
      queueWrite?: (key: string, data: unknown) => Promise<boolean>;
      [k: string]: unknown;
    };
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["kv", "products", "settings", "profile", "creds", "meta"] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      }
      // drop old per-row queues if upgrading from v1 name — new DB name avoids migration pain
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IDB open failed"));
  });
}

async function idbGetKv<T>(id: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(id);
      req.onsuccess = () => {
        const row = req.result as { id: string; data: T } | undefined;
        resolve(row?.data ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSetKv(id: string, data: unknown): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ id, data, ts: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

function lsGetArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function lsSetArray(key: string, arr: unknown[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
    // verify round-trip
    const check = localStorage.getItem(key);
    return !!check && check.length > 2;
  } catch {
    return false;
  }
}

async function desktopRead(key: string): Promise<unknown> {
  try {
    const api = typeof window !== "undefined" ? window.barposDesktop : undefined;
    if (api?.queueRead) return await api.queueRead(key);
  } catch {
    /* */
  }
  return null;
}

async function desktopWrite(key: string, data: unknown): Promise<boolean> {
  try {
    const api = typeof window !== "undefined" ? window.barposDesktop : undefined;
    if (api?.queueWrite) return !!(await api.queueWrite(key, data));
  } catch {
    /* */
  }
  return false;
}

function mergeById<T extends { id: string; synced?: boolean }>(lists: T[][]): T[] {
  const map = new Map<string, T>();
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || !item.id) continue;
      if (item.synced) continue;
      if (!map.has(item.id)) map.set(item.id, item);
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    String((a as any).created_at || "").localeCompare(String((b as any).created_at || "")),
  );
}

/** Load sales queue from all durable sources (merged). */
export async function idbLoadSalesQueue(): Promise<OfflineSale[]> {
  const fromLs = lsGetArray<OfflineSale>(LS_SALES);
  const fromIdb = (await idbGetKv<OfflineSale[]>("sales_queue")) || [];
  let fromDesktop: OfflineSale[] = [];
  const desk = await desktopRead("sales_queue");
  if (Array.isArray(desk)) fromDesktop = desk as OfflineSale[];
  return mergeById<OfflineSale>([fromLs, fromIdb, fromDesktop]);
}

/** Persist sales queue to all layers. localStorage is synchronous first. */
export async function idbSaveSalesQueue(q: OfflineSale[]): Promise<boolean> {
  const clean = (q || []).filter((s) => s && s.id && !s.synced);
  const lsOk = lsSetArray(LS_SALES, clean);
  const idbOk = await idbSetKv("sales_queue", clean);
  const deskOk = await desktopWrite("sales_queue", clean);
  // success if at least one durable layer worked
  return lsOk || idbOk || deskOk;
}

export async function idbAddSale(sale: OfflineSale): Promise<OfflineSale[]> {
  const q = await idbLoadSalesQueue();
  if (!q.some((s) => s.id === sale.id)) q.push(sale);
  await idbSaveSalesQueue(q);
  return q;
}

export async function idbLoadStockQueue(): Promise<OfflineStockReceipt[]> {
  const fromLs = lsGetArray<OfflineStockReceipt>(LS_STOCK);
  const fromIdb = (await idbGetKv<OfflineStockReceipt[]>("stock_queue")) || [];
  let fromDesktop: OfflineStockReceipt[] = [];
  const desk = await desktopRead("stock_queue");
  if (Array.isArray(desk)) fromDesktop = desk as OfflineStockReceipt[];
  return mergeById<OfflineStockReceipt>([fromLs, fromIdb, fromDesktop]);
}

export async function idbSaveStockQueue(q: OfflineStockReceipt[]): Promise<boolean> {
  const clean = (q || []).filter((s) => s && s.id && !s.synced);
  const lsOk = lsSetArray(LS_STOCK, clean);
  const idbOk = await idbSetKv("stock_queue", clean);
  const deskOk = await desktopWrite("stock_queue", clean);
  return lsOk || idbOk || deskOk;
}

export async function idbAddStockReceipt(r: OfflineStockReceipt): Promise<OfflineStockReceipt[]> {
  const q = await idbLoadStockQueue();
  if (!q.some((s) => s.id === r.id)) q.push(r);
  await idbSaveStockQueue(q);
  return q;
}

async function idbPut(store: StoreName, value: { id: string } & Record<string, unknown>) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* */
  }
}

async function idbGet<T>(store: StoreName, id: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function idbCacheProducts(list: unknown[]) {
  await idbPut("products", { id: "all", list, ts: new Date().toISOString() });
  try {
    localStorage.setItem("barpos_cache_products", JSON.stringify(list));
  } catch {
    /* */
  }
}

export async function idbLoadProducts<T = unknown>(): Promise<T[]> {
  const row = await idbGet<{ id: string; list: T[] }>("products", "all");
  if (row?.list?.length) return row.list;
  try {
    const raw = localStorage.getItem("barpos_cache_products");
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export async function idbCacheSettings(s: unknown) {
  await idbPut("settings", { id: "app", data: s });
  try {
    localStorage.setItem("barpos_cache_settings", JSON.stringify(s));
  } catch {
    /* */
  }
}

export async function idbLoadSettings<T = unknown>(): Promise<T | null> {
  const row = await idbGet<{ id: string; data: T }>("settings", "app");
  if (row?.data) return row.data;
  try {
    const raw = localStorage.getItem("barpos_cache_settings");
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function idbCacheProfile(p: unknown) {
  await idbPut("profile", { id: "current", data: p });
  try {
    localStorage.setItem("barpos_cache_profile", JSON.stringify(p));
  } catch {
    /* */
  }
}

export async function idbLoadProfile<T = unknown>(): Promise<T | null> {
  const row = await idbGet<{ id: string; data: T }>("profile", "current");
  if (row?.data) return row.data;
  try {
    const raw = localStorage.getItem("barpos_cache_profile");
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function idbSetMeta(key: string, value: unknown) {
  await idbPut("meta", { id: key, value, ts: new Date().toISOString() });
}

export async function idbGetMeta<T = unknown>(key: string): Promise<T | null> {
  const row = await idbGet<{ id: string; value: T }>("meta", key);
  return row?.value ?? null;
}

export async function migrateLocalStorageToIdb() {
  // Ensure LS data is also in IDB + desktop file
  try {
    const sales = lsGetArray<OfflineSale>(LS_SALES_LEGACY);
    if (sales.length) await idbSaveSalesQueue(sales);
  } catch {
    /* */
  }
  try {
    const stock = lsGetArray<OfflineStockReceipt>(LS_STOCK_LEGACY);
    if (stock.length) await idbSaveStockQueue(stock);
  } catch {
    /* */
  }
}

export function requestBackgroundSync(tag = "barpos-sync") {
  try {
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      navigator.serviceWorker.ready
        .then((reg) => {
          // @ts-expect-error SyncManager
          return reg.sync?.register(tag);
        })
        .catch(() => {});
    }
  } catch {
    /* */
  }
}

/** Sync helpers for App.tsx localStorage readers */
export function loadSalesQueueSync(): OfflineSale[] {
  return lsGetArray<OfflineSale>(LS_SALES).filter((s) => !s.synced);
}

export function loadStockQueueSync(): OfflineStockReceipt[] {
  return lsGetArray<OfflineStockReceipt>(LS_STOCK).filter((s) => !s.synced);
}


/** Wipe all pending offline sales + stock from every layer (LS, IDB, desktop file). */
export async function clearAllOfflineQueues(): Promise<void> {
  try {
    localStorage.removeItem(LS_SALES);
    localStorage.removeItem(LS_STOCK);
    localStorage.removeItem("barpos_offline_sales");
    localStorage.removeItem("barpos_offline_stock");
  } catch {
    /* */
  }
  try {
    await idbSetKv("sales_queue", []);
    await idbSetKv("stock_queue", []);
  } catch {
    /* */
  }
  try {
    await desktopWrite("sales_queue", []);
    await desktopWrite("stock_queue", []);
  } catch {
    /* */
  }
}
