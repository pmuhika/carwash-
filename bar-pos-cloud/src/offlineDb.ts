/**
 * IndexedDB store for Bar POS offline data (queue, products, settings, creds).
 * Falls back gracefully if IDB is unavailable.
 */

const DB_NAME = "barpos_offline_v1";
const DB_VERSION = 1;

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

type StoreName =
  | "sales_queue"
  | "stock_queue"
  | "products"
  | "settings"
  | "profile"
  | "creds"
  | "meta";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const stores: StoreName[] = [
        "sales_queue",
        "stock_queue",
        "products",
        "settings",
        "profile",
        "creds",
        "meta",
      ];
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IDB open failed"));
  });
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
    /* quota / private mode */
  }
}

async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as T[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function idbDelete(store: StoreName, id: string) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* */
  }
}

async function idbClear(store: StoreName) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* */
  }
}

// --- Sales queue ---
export async function idbLoadSalesQueue(): Promise<OfflineSale[]> {
  const rows = await idbGetAll<OfflineSale & { id: string }>("sales_queue");
  return rows.filter((r) => !r.synced);
}

export async function idbSaveSalesQueue(q: OfflineSale[]) {
  await idbClear("sales_queue");
  for (const s of q) {
    await idbPut("sales_queue", s as OfflineSale & { id: string });
  }
  // mirror small summary to localStorage for fast boot
  try {
    localStorage.setItem(
      "barpos_offline_sales",
      JSON.stringify(q.filter((s) => !s.synced)),
    );
  } catch {
    /* */
  }
}

export async function idbAddSale(sale: OfflineSale) {
  const q = await idbLoadSalesQueue();
  q.push(sale);
  await idbSaveSalesQueue(q);
  return q;
}

// --- Stock receive queue ---
export async function idbLoadStockQueue(): Promise<OfflineStockReceipt[]> {
  const rows = await idbGetAll<OfflineStockReceipt>("stock_queue");
  return rows.filter((r) => !r.synced);
}

export async function idbSaveStockQueue(q: OfflineStockReceipt[]) {
  await idbClear("stock_queue");
  for (const s of q) {
    await idbPut("stock_queue", s as OfflineStockReceipt & { id: string });
  }
  try {
    localStorage.setItem("barpos_offline_stock", JSON.stringify(q.filter((s) => !s.synced)));
  } catch {
    /* */
  }
}

export async function idbAddStockReceipt(r: OfflineStockReceipt) {
  const q = await idbLoadStockQueue();
  q.push(r);
  await idbSaveStockQueue(q);
  return q;
}

// --- Products / settings / profile ---
export async function idbCacheProducts(list: unknown[]) {
  await idbPut("products", { id: "all", list, ts: new Date().toISOString() });
  try {
    localStorage.setItem("barpos_cache_products", JSON.stringify(list));
    localStorage.setItem("barpos_cache_ts", new Date().toISOString());
  } catch {
    /* */
  }
}

export async function idbLoadProducts<T = unknown>(): Promise<T[]> {
  const row = await idbGet<{ id: string; list: T[] }>("products", "all");
  if (row?.list?.length) return row.list;
  try {
    return JSON.parse(localStorage.getItem("barpos_cache_products") || "[]");
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
    return raw ? JSON.parse(raw) : null;
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
    return raw ? JSON.parse(raw) : null;
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

/** Migrate localStorage queues into IndexedDB once */
export async function migrateLocalStorageToIdb() {
  try {
    const salesRaw = localStorage.getItem("barpos_offline_sales");
    if (salesRaw) {
      const sales = JSON.parse(salesRaw) as OfflineSale[];
      if (Array.isArray(sales) && sales.length) {
        const existing = await idbLoadSalesQueue();
        if (!existing.length) await idbSaveSalesQueue(sales);
      }
    }
    const stockRaw = localStorage.getItem("barpos_offline_stock");
    if (stockRaw) {
      const stock = JSON.parse(stockRaw) as OfflineStockReceipt[];
      if (Array.isArray(stock) && stock.length) {
        const existing = await idbLoadStockQueue();
        if (!existing.length) await idbSaveStockQueue(stock);
      }
    }
  } catch {
    /* */
  }
}

/** Ask service worker to register background sync */
export function requestBackgroundSync(tag = "barpos-sync") {
  try {
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      navigator.serviceWorker.ready.then((reg) => {
        // @ts-expect-error SyncManager typings vary
        return reg.sync?.register(tag);
      }).catch(() => {});
    }
  } catch {
    /* unsupported */
  }
}
