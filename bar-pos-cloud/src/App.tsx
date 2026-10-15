import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  Beer,
  LayoutDashboard,
  ShoppingCart,
  Package,
  ClipboardList,
  LogOut,
  Plus,
  Search,
  RefreshCw,
  CircleDollarSign,
  AlertTriangle,
  X,
  Printer,
  Upload,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  idbLoadSalesQueue,
  idbSaveSalesQueue,
  idbAddSale,
  idbLoadStockQueue,
  idbSaveStockQueue,
  idbAddStockReceipt,
  idbCacheProducts,
  idbLoadProducts,
  idbCacheSettings,
  idbLoadSettings,
  idbCacheProfile,
  idbLoadProfile,
  idbSetMeta,
  idbGetMeta,
  migrateLocalStorageToIdb,
  requestBackgroundSync,
  type OfflineSale as IdbOfflineSale,
  type OfflineStockReceipt,
} from "./offlineDb";

type Product = {
  id: string;
  name: string;
  category: string;
  sku: string | null;
  cost_price: number;
  sell_price: number;
  stock_qty: number;
  min_stock: number;
  active: boolean;
  image_url?: string | null;
  stock_unit?: string | null;
  units_per_pack?: number;
};
type Sale = {
  id: string;
  receipt_no: string;
  total: number;
  cost_total: number;
  payment_method: string;
  created_at: string;
  cashier_id: string;
  creditor_name?: string | null;
};
type SoldItem = {
  product_name: string;
  quantity: number;
  line_total: number;
  sale_id: string;
};
type Expense = {
  id: string;
  description: string;
  amount: number;
  created_at: string;
};
type Line = { product: Product; qty: number };
// Defaults match this bar's Supabase project so Netlify builds work without manual env setup.
// Override anytime with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (or Netlify env vars).
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  "https://hesrojwhwintwwnehpvd.supabase.co";
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhlc3Jvandod2ludHd3bmVocHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NTIzMzAsImV4cCI6MjEwNzUyODMzMH0.OVtg9e1l0O2OZbwtTMuFV906y4gwooV0hyB87wTS-0s";
const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          // Keep session on device so reopen works offline after first online login
          storage: typeof window !== "undefined" ? window.localStorage : undefined,
        },
        global: {
          // Fail fast when offline instead of long hangs
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 12000);
            const signal = init?.signal
              ? // merge abort signals simply
                init.signal
              : ctrl.signal;
            return fetch(input, { ...init, signal: init?.signal || ctrl.signal }).finally(() =>
              clearTimeout(t),
            );
          },
        },
      })
    : null;
const money = (n: number) =>
  new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    maximumFractionDigits: 2,
  }).format(Number(n || 0));
const dateLabel = (d: string) => new Date(d).toLocaleString();

/** SHA-256 hex of PIN (matches encode(digest(...),'hex') in Postgres). */
async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(String(pin).trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem("barpos_favorites") || "[]");
  } catch {
    return [];
  }
}
function saveFavorites(ids: string[]) {
  localStorage.setItem("barpos_favorites", JSON.stringify(ids.slice(0, 24)));
}

/** Offline queue + cache helpers */
const OFFLINE_QUEUE_KEY = "barpos_offline_sales";
const CACHE_PRODUCTS_KEY = "barpos_cache_products";
const CACHE_SETTINGS_KEY = "barpos_cache_settings";
const CACHE_PROFILE_KEY = "barpos_cache_profile";
const CACHE_TS_KEY = "barpos_cache_ts";

type OfflineSale = {
  id: string; // local uuid
  created_at: string;
  items: { product_id: string; quantity: number; product_name: string; unit_price: number; cost_price: number }[];
  payment_method: string;
  creditor_name: string | null;
  total: number;
  cost_total: number;
  cashier_id: string;
  cashier_name: string;
  receipt_no: string;
  synced?: boolean;
  sync_error?: string;
};

function loadOfflineQueue(): OfflineSale[] {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveOfflineQueue(q: OfflineSale[]) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
}

function cacheProducts(list: Product[]) {
  try {
    localStorage.setItem(CACHE_PRODUCTS_KEY, JSON.stringify(list));
    localStorage.setItem(CACHE_TS_KEY, new Date().toISOString());
  } catch { /* quota */ }
  void idbCacheProducts(list);
}
function loadCachedProducts(): Product[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_PRODUCTS_KEY) || "[]");
  } catch {
    return [];
  }
}
function cacheSettings(s: any) {
  try {
    localStorage.setItem(CACHE_SETTINGS_KEY, JSON.stringify(s));
  } catch { /* */ }
  void idbCacheSettings(s);
}
function loadCachedSettings(): any | null {
  try {
    const raw = localStorage.getItem(CACHE_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function cacheProfile(p: any) {
  try {
    localStorage.setItem(CACHE_PROFILE_KEY, JSON.stringify(p));
  } catch { /* */ }
  void idbCacheProfile(p);
}
function loadCachedProfile(): any | null {
  try {
    const raw = localStorage.getItem(CACHE_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Offline staff vault — hashes only, never plain passwords */
const OFFLINE_CREDS_KEY = "barpos_offline_creds";
type OfflineCred = {
  userId: string;
  email: string;
  passwordHash?: string;
  pinHash?: string;
  profile: any;
  updatedAt: string;
};

function loadOfflineCreds(): OfflineCred[] {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_CREDS_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveOfflineCreds(list: OfflineCred[]) {
  try {
    localStorage.setItem(OFFLINE_CREDS_KEY, JSON.stringify(list.slice(0, 40)));
  } catch {
    /* quota */
  }
}
function upsertOfflineCred(entry: OfflineCred) {
  const list = loadOfflineCreds().filter(
    (c) => c.userId !== entry.userId && c.email !== entry.email,
  );
  list.unshift(entry);
  saveOfflineCreds(list);
}
function makeOfflineSession(userId: string, email: string) {
  return {
    access_token: "offline-local",
    refresh_token: "offline-local",
    token_type: "bearer",
    expires_in: 60 * 60 * 24 * 365,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    user: {
      id: userId,
      email,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "offline" },
      user_metadata: { offline: true },
    },
  };
}
function isOfflineSession(s: any) {
  return (
    !!s &&
    (s.access_token === "offline-local" ||
      s.user?.app_metadata?.provider === "offline" ||
      s.user?.user_metadata?.offline === true)
  );
}
function hydrateFromCache(userId?: string) {
  const profile = loadCachedProfile();
  const products = loadCachedProducts();
  const settings = loadCachedSettings();
  return {
    profile: profile && (!userId || profile.id === userId) ? profile : null,
    products,
    settings,
  };
}


/** Finer permissions — admin always allowed; cashiers use allowed_tabs + optional flags */
const ALL_TABS = [
  "Dashboard",
  "Sell",
  "Receive Stock",
  "Inventory",
  "Products",
  "Credits",
  "Suppliers",
  "Expenses",
  "Reports",
  "Users",
  "Activity Log",
  "Backup & Settings",
] as const;

const DEFAULT_CASHIER_TABS = ["Dashboard", "Sell", "Credits", "Expenses"];
const DEFAULT_SUPERVISOR_TABS = [
  "Dashboard",
  "Sell",
  "Receive Stock",
  "Inventory",
  "Credits",
  "Expenses",
  "Reports",
];

type ActionPerm =
  | "receive_stock"
  | "adjust_stock"
  | "manage_products"
  | "manage_users"
  | "view_reports"
  | "manage_expenses"
  | "factory_reset"
  | "void_sale";

function tabsForRole(role: string, allowed: string[] | null | undefined): string[] {
  if (role === "admin") return [...ALL_TABS];
  if (allowed && allowed.length) return allowed;
  if (role === "supervisor") return [...DEFAULT_SUPERVISOR_TABS];
  return [...DEFAULT_CASHIER_TABS];
}

function canAccessTab(profile: any, tab: string): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  const tabs = tabsForRole(profile.role, profile.allowed_tabs);
  return tabs.includes(tab);
}

function canDoAction(profile: any, action: ActionPerm): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  const role = profile.role || "cashier";
  const tabs = tabsForRole(role, profile.allowed_tabs);
  switch (action) {
    case "receive_stock":
      return tabs.includes("Receive Stock") || role === "supervisor";
    case "adjust_stock":
      return tabs.includes("Inventory") || role === "supervisor";
    case "manage_products":
      return tabs.includes("Products");
    case "manage_users":
      return false;
    case "view_reports":
      return tabs.includes("Reports") || role === "supervisor";
    case "manage_expenses":
      return tabs.includes("Expenses");
    case "factory_reset":
      return false;
    case "void_sale":
      return role === "supervisor";
    default:
      return false;
  }
}

function orderedCategories(list: { category?: string }[]) {
  const preferred = ["Beer", "Spirits", "Soft Drinks"];
  const found = new Map<string, string>();
  list.forEach((p) => {
    const raw = (p.category || "").trim();
    if (!raw) return;
    const k = raw.toLowerCase();
    if (!found.has(k)) found.set(k, raw);
  });
  const result: string[] = [];
  preferred.forEach((p) => {
    const k = p.toLowerCase();
    if (found.has(k)) {
      result.push(found.get(k)!);
      found.delete(k);
    }
  });
  [...found.values()].sort((a, b) => a.localeCompare(b)).forEach((v) => result.push(v));
  return result;
}

export default function App() {
  const [session, setSession] = useState<any>(null),
    [profile, setProfile] = useState<any>(null),
    [tab, setTab] = useState("Dashboard"),
    [products, setProducts] = useState<Product[]>([]),
    [sales, setSales] = useState<Sale[]>([]),
    [soldItems, setSoldItems] = useState<SoldItem[]>([]),
    [expenses, setExpenses] = useState<Expense[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [pendingSales, setPendingSales] = useState<OfflineSale[]>(() => loadOfflineQueue());
  const [pendingStock, setPendingStock] = useState<OfflineStockReceipt[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncConflicts, setSyncConflicts] = useState(0);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [showSecret, setShowSecret] = useState(false),
    [showSecret2, setShowSecret2] = useState(false),
    [loginBusy, setLoginBusy] = useState(false),
    [loginMode, setLoginMode] = useState<"email" | "pin">("pin"),
    [needsSetup, setNeedsSetup] = useState<boolean | null>(null),
    [setupForm, setSetupForm] = useState({
      full_name: "",
      email: "",
      pin: "",
      pin2: "",
      bar_name: "Sherehe POS",
    }),
    [pinLoginCode, setPinLoginCode] = useState(""),
    [rememberMe, setRememberMe] = useState(false),
    [showAlphaKb, setShowAlphaKb] = useState(false),
    [kbTarget, setKbTarget] = useState<string | null>(null),
    [kbMode, setKbMode] = useState<"alpha" | "numeric" | "alnum">("alpha"),
    [showCreditorModal, setShowCreditorModal] = useState(false),
    [search, setSearch] = useState(""),
    [categoryFilter, setCategoryFilter] = useState("All"),
    [mobileMenuOpen, setMobileMenuOpen] = useState(false),
    [useNativeKb, setUseNativeKb] = useState(false),
    [sessionLocked, setSessionLocked] = useState(false),
    [lockPin, setLockPin] = useState(""),
    [batchMode, setBatchMode] = useState(false),
    [batchItems, setBatchItems] = useState<
      { product_id: string; name: string; qty: string; total_cost: string }[]
    >([]),
    [batchSupplier, setBatchSupplier] = useState(""),
    [batchReceiptNo, setBatchReceiptNo] = useState(""),
    [showBatchReceive, setShowBatchReceive] = useState(false),
    [batchKbIndex, setBatchKbIndex] = useState(0),
    [cart, setCart] = useState<Line[]>([]),
    [payment, setPayment] = useState("cash"),
    [creditor, setCreditor] = useState(""),
    [busy, setBusy] = useState(false),
    [heldSales, setHeldSales] = useState<Line[][]>([]),
    [receipt, setReceipt] = useState<any>(null),
    [showExpense, setShowExpense] = useState(false),
    [expenseForm, setExpenseForm] = useState({ description: "", amount: "" });
  const [showProduct, setShowProduct] = useState(false),
    [showReceive, setShowReceive] = useState(false),
    [showAudit, setShowAudit] = useState<Product | null>(null),
    [editing, setEditing] = useState<Product | null>(null);
  const [creditPayments, setCreditPayments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ bar_name: "Sherehe POS", logo_url: "", till_number: "", receipt_footer: "Thank you!", show_till_on_receipt: true, show_cashier_on_receipt: true, idle_timeout_minutes: 5, block_sale_when_out: true, receipt_paper_mm: 80 });
  const [creditPayModal, setCreditPayModal] = useState<{ name: string; outstanding: number } | null>(null);
  const [creditPayForm, setCreditPayForm] = useState({ amount: "", method: "cash", note: "" });
  const [selectedCreditor, setSelectedCreditor] = useState<string | null>(null);
  const [pinPrompt, setPinPrompt] = useState<{ action: string; onSuccess: () => void } | null>(null);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [factoryPassword, setFactoryPassword] = useState("");
  const [factoryBusy, setFactoryBusy] = useState(false);
  const autoLoginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoLoginKeyRef = useRef("");
  const syncLockRef = useRef(false);
  const processOfflineQueueRef = useRef<() => Promise<void>>(async () => {});


  const [factoryConfirmText, setFactoryConfirmText] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [settingsForm, setSettingsForm] = useState({ bar_name: "", till_number: "", receipt_footer: "", logo_url: "", admin_pin: "", idle_timeout_minutes: "5", block_sale_when_out: true, receipt_paper_mm: "80" });
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [userForm, setUserForm] = useState({
    full_name: "",
    role: "cashier",
    active: true,
    allowed_tabs: [] as string[],
    pin: "",
    staff_code: "",
  });
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [reportRange, setReportRange] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [stockReceipts, setStockReceipts] = useState<any[]>([]);
  const [stockMovements, setStockMovements] = useState<any[]>([]);
  const [varianceRange, setVarianceRange] = useState<"7" | "30" | "90" | "all">("30");
  const [adminNotifications, setAdminNotifications] = useState<any[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showSupplier, setShowSupplier] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ name: "", phone: "", note: "" });
  const [darkMode, setDarkMode] = useState(false);
  const ALL_TABS = [
    "Dashboard", "Sell", "Receive Stock", "Inventory", "Products", "Credits",
    "Suppliers", "Expenses", "Reports", "Users", "Activity Log", "Backup & Settings",
  ];
  const [form, setForm] = useState({
      name: "",
      category: "Beer",
      sku: "",
      cost_price: "",
      sell_price: "",
      stock_qty: "0",
      min_stock: "5",
      image_url: "",
      stock_unit: "unit",
      units_per_pack: "100",
      active: true,
    }),
    [receiveProduct, setReceiveProduct] = useState(""),
    [receiveQty, setReceiveQty] = useState(""),
    [receiveTotalCost, setReceiveTotalCost] = useState(""),
    [receiveSupplier, setReceiveSupplier] = useState(""),
    [receiveReceiptNo, setReceiveReceiptNo] = useState(""),
    [receiveNote, setReceiveNote] = useState("Stock delivery"),
    [auditQty, setAuditQty] = useState(""),
    [auditReason, setAuditReason] = useState("Stock count correction");
  const configured = !!supabase;
  
  
  
  
  // Keep current tab within this user's allowed tabs
  useEffect(() => {
    if (!profile?.active) return;
    const tabs = tabsForRole(profile.role, profile.allowed_tabs);
    if (!tabs.includes(tab)) {
      setTab(tabs.includes("Dashboard") ? "Dashboard" : tabs[0] || "Dashboard");
    }
  }, [profile, tab]);

// Full-system realtime: stock, sales, credits, expenses, notifications
  useEffect(() => {
    if (!supabase || !session) return;
    let debounce: any = null;
    const scheduleRefresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        refreshAll();
      }, 400);
    };
    let channel = supabase.channel("bar-pos-live");
    const tables = [
      "products",
      "sales",
      "sale_items",
      "expenses",
      "credit_payments",
      "stock_movements",
      "stock_receipts",
      "suppliers",
      "app_settings",
      "profiles",
      "activity_log",
      "admin_notifications",
    ];
    for (const table of tables) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) => {
          if (table === "admin_notifications" && payload.eventType === "INSERT") {
            if (profile?.role === "admin" && payload.new) {
              setAdminNotifications((old) => [payload.new as any, ...old].slice(0, 50));
            }
          }
          scheduleRefresh();
        },
      );
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        // connected
      }
    });
    return () => {
      clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [session, profile?.role]);

  async function markNotificationsRead() {
    if (!supabase || profile?.role !== "admin") return;
    await supabase.rpc("mark_admin_notifications_read");
    setAdminNotifications((old) =>
      old.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })),
    );
  }

// Auto log out after idle (minutes from settings; default 5). Returns to login page.
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout>;
    const mins = Math.min(60, Math.max(1, Number(settings?.idle_timeout_minutes) || 5));
    const IDLE_MS = mins * 60 * 1000;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void (async () => {
          await supabase?.auth.signOut();
          setSession(null);
          setProfile(null);
          setCart([]);
          setSessionLocked(false);
          setLockPin("");
        })();
      }, IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "touchstart", "mousemove", "click"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    bump();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [session, settings?.idle_timeout_minutes]);

// Phones/tablets: use the device keyboard; desktop/POS: in-app OSK
  useEffect(() => {
    const mq = window.matchMedia(
      "(max-width: 900px), (hover: none) and (pointer: coarse)",
    );
    const apply = () => setUseNativeKb(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Remember email only (never store password on device)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("barpos_remember_login");
      if (!raw) return;
      const saved = JSON.parse(raw) as { email?: string; password?: string; remember?: boolean };
      if (saved.email) {
        setEmail(String(saved.email));
        setRememberMe(true);
        // Migrate: drop any previously stored password
        localStorage.setItem(
          "barpos_remember_login",
          JSON.stringify({ email: String(saved.email), remember: true }),
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

useEffect(() => {
    let cancelled = false;
    (async () => {
      // Prefer real Supabase session when present
      if (supabase) {
        try {
          const { data } = await supabase.auth.getSession();
          if (!cancelled && data.session) {
            setSession(data.session);
            return;
          }
        } catch {
          /* offline / storage */
        }
      }
      // No live session: if we have cached profile + offline creds, stay on login
      // (user must enter PIN/password — we do not auto-login offline for security)
    })();
    if (!supabase) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      // Don't wipe a working offline session when online token refresh fails
      if (event === "TOKEN_REFRESHED" && !s) return;
      if (event === "SIGNED_OUT") {
        setSession(null);
        setProfile(null);
        return;
      }
      if (s) setSession(s);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Online / offline detection + auto-sync pending sales (no reload required)
  useEffect(() => {
    const runSyncSoon = (reason: string) => {
      // Retry a few times — "online" often fires before the network is fully usable
      const delays = [300, 1200, 3000, 8000];
      delays.forEach((ms) => {
        window.setTimeout(() => {
          if (!navigator.onLine) return;
          void processOfflineQueueRef.current();
        }, ms);
      });
      try {
        console.debug("[barpos] schedule sync:", reason);
      } catch {
        /* ignore */
      }
    };

    const goOnline = () => {
      setIsOnline(true);
      flash("Back online — syncing queued sales…");
      runSyncSoon("window.online");
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    setIsOnline(navigator.onLine);

    void (async () => {
      await migrateLocalStorageToIdb();
      const sales = await idbLoadSalesQueue();
      const stock = await idbLoadStockQueue();
      if (sales.length) setPendingSales(sales);
      if (stock.length) setPendingStock(stock);
      const ls = await idbGetMeta<string>("last_sync_at");
      if (ls) setLastSyncAt(ls);
      if (navigator.onLine && (sales.length || stock.length)) {
        runSyncSoon("startup-pending");
      }
    })();

    const onMsg = (ev: MessageEvent) => {
      if (ev?.data?.type === "barpos-sync") runSyncSoon("sw-message");
    };
    navigator.serviceWorker?.addEventListener?.("message", onMsg);

    // Visibility / focus: user returns to the till with internet restored
    const onVis = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        runSyncSoon("visibility");
      }
    };
    const onFocus = () => {
      if (navigator.onLine) runSyncSoon("focus");
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);

    // Periodic catch-up while the app stays open
    const interval = window.setInterval(() => {
      if (!navigator.onLine) return;
      void processOfflineQueueRef.current();
    }, 20000);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      navigator.serviceWorker?.removeEventListener?.("message", onMsg);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, []);

  // Keep processOfflineQueueRef pointing at the latest function (avoids stale session/supabase)
  useEffect(() => {
    processOfflineQueueRef.current = () => processOfflineQueue();
  });

  useEffect(() => {
    if (session && supabase) {
      loadProfile();
    }
  }, [session]);
  async function loadProfile() {
    if (!supabase || !session) return;
    // Offline: use cached profile + products so POS stays usable
    if (!navigator.onLine) {
      const cached = loadCachedProfile();
      if (cached && cached.id === session.user.id) {
        setProfile(cached);
        const cachedProds = loadCachedProducts();
        if (cachedProds.length) setProducts(cachedProds);
        const cachedSet = loadCachedSettings();
        if (cachedSet) setSettings(cachedSet);
        setError("");
        flash("Offline mode — using cached data. Sales will sync when online.");
        return;
      }
      setError("Offline and no cached profile. Connect once to cache data for offline use.");
      return;
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("id,full_name,role,active,allowed_tabs,staff_code,pin_hash")
      .eq("id", session.user.id)
      .maybeSingle();
    if (error) {
      // Network error while "online" detection is flaky — try cache
      const cached = loadCachedProfile();
      if (cached && cached.id === session.user.id) {
        setProfile(cached);
        const cachedProds = loadCachedProducts();
        if (cachedProds.length) setProducts(cachedProds);
        const cachedSet = loadCachedSettings();
        if (cachedSet) setSettings(cachedSet);
        setError("");
        flash("Could not reach server — using cached data.");
        return;
      }
      setError("Profile error: " + error.message);
      return;
    }
    if (!data) {
      setProfile(null);
      setError(
        "No profile for this account. In Supabase SQL Editor, run the admin profile SQL for your email.",
      );
      return;
    }
    setProfile(data);
    cacheProfile(data);
    if (data.active) {
      const tabs: string[] = data.allowed_tabs || [];
      if (tabs.length && !tabs.includes(tab)) {
        setTab(tabs.includes("Dashboard") ? "Dashboard" : tabs[0]);
      } else if (data.role === "admin") {
        setTab("Dashboard");
      }
      refreshAll();
    }
  }
  /** Fast path: only products (used after sale / receive stock so till stays snappy) */
  async function refreshProductsOnly() {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .order("sku", { ascending: true });
      if (!error && data) {
        const list = data as Product[];
        setProducts(list);
        cacheProducts(list);
      }
    } catch {
      /* keep current list */
    }
  }

  /** Light refresh for post-sale: products + recent sales only (no full 11-table load) */
  async function refreshAfterSale() {
    if (!supabase) return;
    try {
      const [p, s] = await Promise.all([
        supabase.from("products").select("*").order("sku", { ascending: true }),
        supabase
          .from("sales")
          .select(
            "id,receipt_no,total,cost_total,payment_method,created_at,cashier_id,creditor_name",
          )
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      if (!p.error && p.data) {
        const list = p.data as Product[];
        setProducts(list);
        cacheProducts(list);
      }
      if (!s.error && s.data) setSales((s.data || []) as Sale[]);
    } catch {
      /* non-blocking */
    }
  }

  async function refreshAll() {
    if (!supabase) return;
    setLoading(true);
    setError("");
    const [p, s, si, ex, cp, act, st, pr, sup, sr, sm] = await Promise.all([
      supabase.from("products").select("*").order("sku", { ascending: true }),
      supabase
        .from("sales")
        .select(
          "id,receipt_no,total,cost_total,payment_method,created_at,cashier_id,creditor_name",
        )
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("sale_items")
        .select("sale_id,product_name,quantity,line_total,created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("expenses")
        .select("id,description,amount,created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("credit_payments")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("activity_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase.from("app_settings").select("*").eq("id", 1).maybeSingle(),
      supabase.from("profiles").select("id,full_name,role,active,allowed_tabs,staff_code,login_email,created_at").order("full_name"),
      supabase.from("suppliers").select("*").order("name"),
      supabase.from("stock_receipts").select("*").order("created_at", { ascending: false }).limit(500),
      supabase
        .from("stock_movements")
        .select("id,product_id,user_id,movement_type,quantity_change,quantity_after,note,created_at")
        .eq("movement_type", "adjustment")
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);
    if (p.error) {
      // Fall back to cache on network failure
      const cached = loadCachedProducts();
      if (cached.length) {
        setProducts(cached);
        setError("Could not refresh products — using cached data.");
      } else {
        setError(p.error.message);
      }
    } else {
      const list = (p.data || []) as Product[];
      setProducts(list);
      cacheProducts(list);
    }
    if (s.error) setError(s.error.message);
    else setSales((s.data || []) as Sale[]);
    if (!si.error) setSoldItems((si.data || []) as SoldItem[]);
    if (!ex.error) setExpenses((ex.data || []) as Expense[]);
    if (!cp.error) setCreditPayments(cp.data || []);
    if (!act.error) setActivity(act.data || []);
    if (!pr.error) setProfiles(pr.data || []);
    if (!sup.error) setSuppliers(sup.data || []);
    if (!sr.error) setStockReceipts(sr.data || []);
    if (!sm.error) setStockMovements(sm.data || []);
    // stock_movements / notifications may be restricted — don't block the UI
    const notif = await supabase
      .from("admin_notifications")
      .select("id,type,title,body,created_by,created_at,read_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (!notif.error) setAdminNotifications(notif.data || []);
    if (st.data) {
      const nextSettings = {
        ...st.data,
        idle_timeout_minutes: st.data.idle_timeout_minutes ?? 5,
        block_sale_when_out: st.data.block_sale_when_out !== false,
        receipt_paper_mm: Number(st.data.receipt_paper_mm) === 58 ? 58 : 80,
      };
      setSettings(nextSettings);
      cacheSettings(nextSettings);
      setDarkMode(!!st.data.dark_mode);
      setSettingsForm({
        bar_name: st.data.bar_name || "Sherehe POS",
        till_number: st.data.till_number || "",
        receipt_footer: st.data.receipt_footer || "Thank you!",
        logo_url: st.data.logo_url || "",
        admin_pin: "",
        idle_timeout_minutes: String(st.data.idle_timeout_minutes ?? 5),
        block_sale_when_out: st.data.block_sale_when_out !== false,
        receipt_paper_mm: Number(st.data.receipt_paper_mm) === 58 ? "58" : "80",
      });
    } else {
      const cachedSet = loadCachedSettings();
      if (cachedSet) setSettings(cachedSet);
    }
    setLoading(false);
  }
  async function finishLogin(session: any, opts?: { password?: string; pin?: string }) {
    if (!session) return;
    setSession(session);

    // Offline session or no network: hydrate from cache only
    if (isOfflineSession(session) || !navigator.onLine) {
      const cached = hydrateFromCache(session.user?.id);
      if (cached.profile) {
        setProfile(cached.profile);
        if (cached.products?.length) setProducts(cached.products);
        if (cached.settings) setSettings(cached.settings);
        setError("");
        flash("Offline mode — cached data. Sales sync when internet returns.");
        return;
      }
      setError(
        "No offline data on this device yet. Connect to the internet once, sign in, then offline login will work.",
      );
      return;
    }

    if (!supabase) return;
    try {
      const { data: prof, error: pErr } = await supabase
        .from("profiles")
        .select("id,full_name,role,active,allowed_tabs,staff_code,pin_hash,login_email")
        .eq("id", session.user.id)
        .maybeSingle();
      if (pErr) {
        const cached = hydrateFromCache(session.user?.id);
        if (cached.profile) {
          setProfile(cached.profile);
          if (cached.products?.length) setProducts(cached.products);
          if (cached.settings) setSettings(cached.settings);
          setError("");
          flash("Could not reach server — using cached data.");
          return;
        }
        setError("Logged in, but profile failed to load: " + pErr.message);
        return;
      }
      if (!prof) {
        setError(
          "Logged in, but no profile row exists. Run the admin profile SQL in Supabase for this user.",
        );
        setProfile(null);
        return;
      }
      if (!prof.active) {
        setError("Account is disabled. Ask another admin to activate it.");
        await supabase.auth.signOut();
        setSession(null);
        setProfile(null);
        return;
      }
      setProfile(prof);
      cacheProfile(prof);
      setError("");

      // Save offline credentials (hashes only) so this staff can sign in without internet
      try {
        const email =
          (prof.login_email && String(prof.login_email).trim().toLowerCase()) ||
          String(session.user?.email || "").toLowerCase();
        const entry: OfflineCred = {
          userId: prof.id,
          email,
          profile: prof,
          updatedAt: new Date().toISOString(),
        };
        if (opts?.password) {
          entry.passwordHash = await hashPin(opts.password);
        }
        if (opts?.pin) {
          entry.pinHash = await hashPin(opts.pin);
        } else if (opts?.password && opts.password.length >= 4 && opts.password.length <= 12) {
          // Staff often use PIN as auth password
          entry.pinHash = await hashPin(opts.password);
        }
        upsertOfflineCred(entry);
      } catch {
        /* ignore vault errors */
      }

      void refreshProductsOnly().then(() => refreshAll());
    } catch (err: any) {
      const cached = hydrateFromCache(session.user?.id);
      if (cached.profile) {
        setProfile(cached.profile);
        if (cached.products?.length) setProducts(cached.products);
        if (cached.settings) setSettings(cached.settings);
        setError("");
        flash("Offline / network error — using cached data.");
        return;
      }
      setError(err?.message || "Login finished but data could not load.");
    }
  }

  function scheduleAutoLogin(nextEmail: string, nextPassword: string) {
    const em = nextEmail.trim().toLowerCase();
    const pw = nextPassword.trim();
    if (autoLoginTimerRef.current) {
      clearTimeout(autoLoginTimerRef.current);
      autoLoginTimerRef.current = null;
    }
    // Need a real-looking email and a password of at least 4 chars
    if (!em.includes("@") || pw.length < 4) return;
    const key = em + "\0" + pw;
    if (key === lastAutoLoginKeyRef.current) return;
    autoLoginTimerRef.current = setTimeout(() => {
      lastAutoLoginKeyRef.current = key;
      void signIn();
    }, 700);
  }

  async function signIn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setLoginBusy(true);
    setError("");
    try {
      const em = email.trim().toLowerCase();
      const pw = password.trim();
      if (!em || !pw) {
        setError("Enter email and password");
        setLoginBusy(false);
        return;
      }

      // --- OFFLINE EMAIL LOGIN ---
      if (!navigator.onLine || !supabase) {
        const h = await hashPin(pw);
        const match = loadOfflineCreds().find(
          (c) => c.email === em && c.passwordHash && c.passwordHash === h,
        );
        if (!match) {
          setError(
            !navigator.onLine
              ? "Offline login failed. Sign in once while online on this device to enable offline access."
              : "App not configured (missing Supabase keys).",
          );
          setLoginBusy(false);
          return;
        }
        cacheProfile(match.profile);
        setShowAlphaKb(false);
        await finishLogin(makeOfflineSession(match.userId, match.email));
        setLoginBusy(false);
        return;
      }

      // --- ONLINE ---
      const { data, error } = await supabase.auth.signInWithPassword({
        email: em,
        password: pw,
      });
      if (error) {
        // Network-ish failure → try offline vault
        const msg = error.message || "Login failed";
        if (/fetch|network|Failed to fetch|abort|timeout|offline/i.test(msg)) {
          const h = await hashPin(pw);
          const match = loadOfflineCreds().find(
            (c) => c.email === em && c.passwordHash && c.passwordHash === h,
          );
          if (match) {
            cacheProfile(match.profile);
            setShowAlphaKb(false);
            await finishLogin(makeOfflineSession(match.userId, match.email));
            setLoginBusy(false);
            return;
          }
        }
        if (/invalid login credentials/i.test(msg)) {
          setError("Invalid email or password. Check your credentials and try again.");
        } else if (/email not confirmed/i.test(msg)) {
          setError(
            "Email not confirmed. In Supabase → Authentication → Users, confirm the user (or turn off Confirm email).",
          );
        } else {
          setError(msg);
        }
        setLoginBusy(false);
        return;
      }
      if (data.session) {
        try {
          if (rememberMe) {
            localStorage.setItem(
              "barpos_remember_login",
              JSON.stringify({ email: em, remember: true }),
            );
          } else {
            localStorage.removeItem("barpos_remember_login");
          }
        } catch {
          /* ignore */
        }
        setShowAlphaKb(false);
        await finishLogin(data.session, { password: pw });
      }
    } finally {
      setLoginBusy(false);
    }
  }

  /** Staff PIN login — works online (Edge Function) and offline (local vault) */
  async function signInWithPin(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const pin = (password || pinLoginCode || "").trim();
    if (pin.length < 4) {
      setError("Enter your PIN (min 4 characters)");
      return;
    }
    setLoginBusy(true);
    setError("");
    try {
      const pinHash = await hashPin(pin);

      // --- OFFLINE PIN ---
      if (!navigator.onLine || !supabase) {
        const match = loadOfflineCreds().find((c) => c.pinHash && c.pinHash === pinHash);
        if (!match) {
          setError(
            "Offline PIN not recognised. Sign in once while online on this device to enable offline PIN login.",
          );
          setLoginBusy(false);
          return;
        }
        cacheProfile(match.profile);
        setPassword("");
        setPinLoginCode("");
        setShowAlphaKb(false);
        await finishLogin(makeOfflineSession(match.userId, match.email));
        setLoginBusy(false);
        return;
      }

      // --- ONLINE: Edge Function → email/password ---
      const base =
        (import.meta as any).env?.VITE_SUPABASE_URL ||
        url ||
        "";
      let em = "";
      try {
        const res = await fetch(`${base}/functions/v1/pin-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          // Fall back to offline vault if edge function fails
          const match = loadOfflineCreds().find((c) => c.pinHash && c.pinHash === pinHash);
          if (match) {
            cacheProfile(match.profile);
            setPassword("");
            setPinLoginCode("");
            setShowAlphaKb(false);
            await finishLogin(makeOfflineSession(match.userId, match.email));
            setLoginBusy(false);
            return;
          }
          setError(body.error || "Invalid PIN");
          setLoginBusy(false);
          return;
        }
        em = String(body.email || "").trim().toLowerCase();
      } catch {
        const match = loadOfflineCreds().find((c) => c.pinHash && c.pinHash === pinHash);
        if (match) {
          cacheProfile(match.profile);
          setPassword("");
          setPinLoginCode("");
          setShowAlphaKb(false);
          await finishLogin(makeOfflineSession(match.userId, match.email));
          setLoginBusy(false);
          return;
        }
        setError("Network error. Offline PIN not set up on this device yet.");
        setLoginBusy(false);
        return;
      }

      if (!em) {
        setError("PIN resolved but no email on account. Ask admin to recreate the user.");
        setLoginBusy(false);
        return;
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email: em,
        password: pin,
      });
      if (error) {
        const match = loadOfflineCreds().find((c) => c.pinHash && c.pinHash === pinHash);
        if (match) {
          cacheProfile(match.profile);
          setPassword("");
          setPinLoginCode("");
          setShowAlphaKb(false);
          await finishLogin(makeOfflineSession(match.userId, match.email));
          setLoginBusy(false);
          return;
        }
        setError(
          error.message?.includes("Invalid")
            ? "Invalid PIN. Ask admin to re-save your PIN in Users."
            : error.message || "Login failed",
        );
        setLoginBusy(false);
        return;
      }
      if (data.session) {
        setShowAlphaKb(false);
        setPassword("");
        setPinLoginCode("");
        await finishLogin(data.session, { pin, password: pin });
      }
    } catch (err: any) {
      setError(err?.message || "PIN login failed.");
    } finally {
      setLoginBusy(false);
    }
  }

  function openKb(target: string, mode: "alpha" | "numeric" | "alnum" = "alpha") {
    // On mobile/touch phones use the native keyboard — do not open virtual OSK
    setKbTarget(target);
    setKbMode(mode);
    setShowAlphaKb(true);
    setTimeout(() => {
      document
        .getElementById("osk-preview")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
  }

  function kbType(ch: string) {
    const add = (prev: string) => prev + ch;
    const numOk = ch === "." || (ch >= "0" && ch <= "9");
    switch (kbTarget) {
      case "creditor":
        setCreditor(add);
        break;
      case "pin":
        setPassword(add);
        break;
      case "staff":
        setPinLoginCode(add);
        break;
      case "loginEmail":
        setEmail(add);
        break;
      case "loginPassword":
        setPassword(add);
        break;
      case "createPin":
        setUserForm((f) => ({ ...f, pin: f.pin + ch }));
        break;
      case "expenseDesc":
        setExpenseForm((f) => ({ ...f, description: f.description + ch }));
        break;
      case "expenseAmt":
        if (numOk) setExpenseForm((f) => ({ ...f, amount: f.amount + ch }));
        break;
      case "receiveQty":
        if (numOk) setReceiveQty((v) => v + ch);
        break;
      case "receiveTotalCost":
        if (numOk) setReceiveTotalCost((v) => v + ch);
        break;
      case "receiveSupplier":
        setReceiveSupplier((v) => v + ch);
        break;
      case "receiveReceiptNo":
        setReceiveReceiptNo((v) => v + ch);
        break;
      case "receiveNote":
        setReceiveNote((v) => v + ch);
        break;
      case "batchSupplier":
        setBatchSupplier(add);
        break;
      case "batchReceiptNo":
        setBatchReceiptNo(add);
        break;
      case "batchQty": {
        if (!(ch === "." || (ch >= "0" && ch <= "9"))) break;
        setBatchItems((old) =>
          old.map((x, j) =>
            j === batchKbIndex ? { ...x, qty: (x.qty || "") + ch } : x,
          ),
        );
        break;
      }
      case "batchCost": {
        if (!(ch === "." || (ch >= "0" && ch <= "9"))) break;
        setBatchItems((old) =>
          old.map((x, j) =>
            j === batchKbIndex ? { ...x, total_cost: (x.total_cost || "") + ch } : x,
          ),
        );
        break;
      }
      case "auditQty":
        if (numOk) setAuditQty((v) => v + ch);
        break;
      case "auditReason":
        setAuditReason((v) => v + ch);
        break;
      case "prodName":
        setForm((f) => ({ ...f, name: f.name + ch }));
        break;
      case "prodSku":
        setForm((f) => ({ ...f, sku: f.sku + ch }));
        break;
      case "prodCost":
        if (numOk) setForm((f) => ({ ...f, cost_price: f.cost_price + ch }));
        break;
      case "prodSell":
        if (numOk) setForm((f) => ({ ...f, sell_price: f.sell_price + ch }));
        break;
      case "prodStock":
        if (numOk) setForm((f) => ({ ...f, stock_qty: f.stock_qty + ch }));
        break;
      case "prodMin":
        if (numOk) setForm((f) => ({ ...f, min_stock: f.min_stock + ch }));
        break;
      case "prodUnits":
        if (numOk) setForm((f) => ({ ...f, units_per_pack: f.units_per_pack + ch }));
        break;
      case "supName":
        setSupplierForm((f) => ({ ...f, name: f.name + ch }));
        break;
      case "supPhone":
        if (numOk) setSupplierForm((f) => ({ ...f, phone: f.phone + ch }));
        break;
      case "supNote":
        setSupplierForm((f) => ({ ...f, note: f.note + ch }));
        break;
      default:
        break;
    }
    requestAnimationFrame(() => {
      document
        .getElementById("osk-preview")
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
  function kbBack() {
    const cut = (s: string) => s.slice(0, -1);
    switch (kbTarget) {
      case "creditor":
        setCreditor(cut);
        break;
      case "pin":
        setPassword(cut);
        break;
      case "staff":
        setPinLoginCode(cut);
        break;
      case "loginEmail":
        setEmail(cut);
        break;
      case "loginPassword":
        setPassword(cut);
        break;
      case "createPin":
        setUserForm((f) => ({ ...f, pin: cut(f.pin) }));
        break;
      case "expenseDesc":
        setExpenseForm((f) => ({ ...f, description: cut(f.description) }));
        break;
      case "expenseAmt":
        setExpenseForm((f) => ({ ...f, amount: cut(f.amount) }));
        break;
      case "receiveQty":
        setReceiveQty(cut);
        break;
      case "receiveTotalCost":
        setReceiveTotalCost(cut);
        break;
      case "receiveSupplier":
        setReceiveSupplier(cut);
        break;
      case "receiveReceiptNo":
        setReceiveReceiptNo(cut);
        break;
      case "receiveNote":
        setReceiveNote(cut);
        break;
      case "batchSupplier":
        setBatchSupplier(cut);
        break;
      case "batchReceiptNo":
        setBatchReceiptNo(cut);
        break;
      case "batchQty":
        setBatchItems((old) =>
          old.map((x, j) =>
            j === batchKbIndex ? { ...x, qty: cut(x.qty || "") } : x,
          ),
        );
        break;
      case "batchCost":
        setBatchItems((old) =>
          old.map((x, j) =>
            j === batchKbIndex ? { ...x, total_cost: cut(x.total_cost || "") } : x,
          ),
        );
        break;
      case "auditQty":
        setAuditQty(cut);
        break;
      case "auditReason":
        setAuditReason(cut);
        break;
      case "prodName":
        setForm((f) => ({ ...f, name: cut(f.name) }));
        break;
      case "prodSku":
        setForm((f) => ({ ...f, sku: cut(f.sku) }));
        break;
      case "prodCost":
        setForm((f) => ({ ...f, cost_price: cut(f.cost_price) }));
        break;
      case "prodSell":
        setForm((f) => ({ ...f, sell_price: cut(f.sell_price) }));
        break;
      case "prodStock":
        setForm((f) => ({ ...f, stock_qty: cut(f.stock_qty) }));
        break;
      case "prodMin":
        setForm((f) => ({ ...f, min_stock: cut(f.min_stock) }));
        break;
      case "prodUnits":
        setForm((f) => ({ ...f, units_per_pack: cut(f.units_per_pack) }));
        break;
      case "supName":
        setSupplierForm((f) => ({ ...f, name: cut(f.name) }));
        break;
      case "supPhone":
        setSupplierForm((f) => ({ ...f, phone: cut(f.phone) }));
        break;
      case "supNote":
        setSupplierForm((f) => ({ ...f, note: cut(f.note) }));
        break;
      default:
        break;
    }
  }
  function kbSpace() {
    kbType(" ");
  }
  function kbValue(): string {
    switch (kbTarget) {
      case "creditor":
        return creditor;
      case "pin":
      case "createPin":
        return kbTarget === "pin" ? password : userForm.pin;
      case "staff":
        return pinLoginCode;
      case "loginEmail":
        return email;
      case "loginPassword":
        return password;
      case "expenseDesc":
        return expenseForm.description;
      case "expenseAmt":
        return expenseForm.amount;
      case "receiveQty":
        return receiveQty;
      case "receiveTotalCost":
        return receiveTotalCost;
      case "receiveSupplier":
        return receiveSupplier;
      case "receiveReceiptNo":
        return receiveReceiptNo;
      case "receiveNote":
        return receiveNote;
      case "batchSupplier":
        return batchSupplier;
      case "batchReceiptNo":
        return batchReceiptNo;
      case "batchQty":
        return batchItems[batchKbIndex]?.qty || "";
      case "batchCost":
        return batchItems[batchKbIndex]?.total_cost || "";
      case "auditQty":
        return auditQty;
      case "auditReason":
        return auditReason;
      case "prodName":
        return form.name;
      case "prodSku":
        return form.sku;
      case "prodCost":
        return form.cost_price;
      case "prodSell":
        return form.sell_price;
      case "prodStock":
        return form.stock_qty;
      case "prodMin":
        return form.min_stock;
      case "prodUnits":
        return form.units_per_pack;
      case "supName":
        return supplierForm.name;
      case "supPhone":
        return supplierForm.phone;
      case "supNote":
        return supplierForm.note;
      default:
        return "";
    }
  }

  async function createStaffUser(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || profile?.role !== "admin") return;
    const code = (userForm.staff_code || userForm.full_name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20);
    const pin = userForm.pin.trim();
    if (!userForm.full_name.trim() || !code || pin.length < 4) {
      setError("Name, staff code, and PIN (min 4) are required");
      return;
    }
    setBusy(true);
    setError("");
    // Prefer Edge Function (service role) when deployed
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke("admin-user", {
        body: {
          action: "create",
          full_name: userForm.full_name.trim(),
          pin,
          staff_code: code,
          role: userForm.role,
          allowed_tabs: userForm.allowed_tabs,
        },
      });
      if (!fnErr && fnData && !(fnData as any).error) {
        await supabase.rpc("log_activity", {
          p_action: "user_created",
          p_details: `${userForm.full_name} (${code})`,
        });
        flash(`Staff created — sign in with PIN only`);
        setShowCreateUser(false);
        setUserForm({
          full_name: "",
          role: "cashier",
          active: true,
          allowed_tabs: ["Dashboard", "Sell", "Credits", "Expenses"],
          pin: "",
          staff_code: "",
        });
        await refreshAll();
        setBusy(false);
        return;
      }
    } catch {
      /* fall through to client signUp */
    }
    const loginEmail = `${code}@bar.local`;
    const { data, error } = await supabase.auth.signUp({
      email: loginEmail,
      password: pin,
      options: { data: { full_name: userForm.full_name.trim() } },
    });
    if (error) {
      setError(error.message + " (Enable Email signups in Supabase Auth, or deploy the admin-user Edge Function.)");
      setBusy(false);
      return;
    }
    if (data.user) {
      const pinHash = await hashPin(pin);
      const { error: profErr } = await supabase
        .from("profiles")
        .update({
          full_name: userForm.full_name.trim(),
          role: userForm.role,
          active: true,
          staff_code: code,
          login_email: loginEmail,
          pin_hash: pinHash,
          allowed_tabs:
            userForm.role === "admin"
              ? ALL_TABS
              : userForm.allowed_tabs.length
                ? userForm.allowed_tabs
                : ["Dashboard", "Sell", "Credits", "Expenses"],
        })
        .eq("id", data.user.id);
      if (profErr) {
        setError(
          "Auth user created but profile PIN failed: " +
            profErr.message +
            " — open Users → Edit and set the PIN again.",
        );
        setBusy(false);
        await refreshAll();
        return;
      }
      // Best-effort: confirm email + ensure password via edge function if available
      try {
        await supabase.functions.invoke("admin-user", {
          body: { action: "reset_pin", user_id: data.user.id, pin },
        });
      } catch {
        /* optional */
      }
      await supabase.rpc("log_activity", {
        p_action: "user_created",
        p_details: `${userForm.full_name} (${code})`,
      });
      flash(`Staff created — they sign in with PIN only`);
      setShowCreateUser(false);
      setUserForm({
        full_name: "",
        role: "cashier",
        active: true,
        allowed_tabs: ["Dashboard", "Sell", "Credits", "Expenses"],
        pin: "",
        staff_code: "",
      });
      await refreshAll();
    }
    setBusy(false);
  }
  async function signOut() {
    await supabase?.auth.signOut();
    setSession(null);
    setProfile(null);
    setCart([]);
  }
  function flash(s: string) {
    setNotice(s);
    window.setTimeout(() => setNotice(""), 3500);
  }
  function openNewProduct() {
    setEditing(null);
    setForm({
      name: "",
      category: "Beer",
      sku: "",
      cost_price: "",
      sell_price: "",
      stock_qty: "0",
      min_stock: "5",
      image_url: "",
      stock_unit: "unit",
      units_per_pack: "100",
      active: true,
    });
    setShowProduct(true);
  }
  function openEditProduct(p: Product) {
    setEditing(p);
    setForm({
      name: p.name,
      category: p.category,
      sku: p.sku || "",
      cost_price: String(p.cost_price),
      sell_price: String(p.sell_price),
      stock_qty: String(p.stock_qty),
      min_stock: String(p.min_stock),
      image_url: p.image_url || "",
      stock_unit: p.stock_unit || "unit",
      units_per_pack: String(p.units_per_pack || 100),
      active: p.active !== false,
    });
    setShowProduct(true);
  }
  async function saveProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError("");
    const payload = {
      name: form.name.trim(),
      category: form.category,
      sku: form.sku.trim() || null,
      cost_price: Number(form.cost_price),
      sell_price: Number(form.sell_price),
      min_stock: Number(form.min_stock),
      image_url: form.image_url || null,
      stock_unit: form.stock_unit,
      units_per_pack: Number(form.units_per_pack) || 100,
      active: form.active !== false,
      ...(editing
        ? {}
        : {
            stock_qty:
              Number(form.stock_qty) *
              (form.stock_unit === "barrel"
                ? Number(form.units_per_pack || 100)
                : 1),
          }),
    };
    const result = editing
      ? await supabase.from("products").update(payload).eq("id", editing.id)
      : await supabase.from("products").insert(payload);
    if (result.error) setError(result.error.message);
    else {
      setShowProduct(false);
      await supabase.rpc("log_activity", {
        p_action: editing ? "product_updated" : "product_created",
        p_details: `${form.name} · sell ${form.sell_price} · cost ${form.cost_price}`,
      });
      flash(editing ? "Product updated" : "Product created");
      await refreshAll();
    }
    setBusy(false);
  }

  async function toggleProductActive(p: Product) {
    if (!supabase || profile?.role !== "admin") return;
    const next = !p.active;
    setBusy(true);
    setError("");
    const { error } = await supabase
      .from("products")
      .update({ active: next })
      .eq("id", p.id);
    if (error) setError(error.message);
    else {
      setProducts((prev) => {
        const list = prev.map((x) => (x.id === p.id ? { ...x, active: next } : x));
        cacheProducts(list);
        void idbCacheProducts(list);
        return list;
      });
      flash(next ? `${p.name} is now active` : `${p.name} is now inactive (hidden from Sell, Inventory, Receive)`);
      try {
        await supabase.rpc("log_activity", {
          p_action: next ? "product_activated" : "product_deactivated",
          p_details: p.name,
        });
      } catch {
        /* ignore */
      }
    }
    setBusy(false);
  }

  async function receiveStock(e: React.FormEvent) {
    e.preventDefault();
    if (!canDoAction(profile, "receive_stock") && profile?.role !== "admin") {
      setError("You do not have permission to receive stock.");
      return;
    }
    const product = products.find((p) => p.id === receiveProduct);
    if (!product) return;
    const qty =
      Number(receiveQty) *
      (product.stock_unit === "barrel"
        ? Number(product.units_per_pack || 100)
        : 1);
    const totalCost = Number(receiveTotalCost);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Enter a valid quantity.");
      return;
    }
    if (!Number.isFinite(totalCost) || totalCost < 0) {
      setError("Enter a valid total cost (0 is allowed).");
      return;
    }
    const addQty = Math.max(1, Math.round(qty));
    const supplier = (receiveSupplier || "").trim() || null;
    const receiptNo = (receiveReceiptNo || "").trim() || null;
    const note = (receiveNote || "Stock received").trim() || "Stock received";
    setBusy(true);
    setError("");
    // Optimistic stock
    setProducts((prev) => {
      const next = prev.map((p) =>
        p.id === receiveProduct
          ? { ...p, stock_qty: Number(p.stock_qty) + addQty }
          : p,
      );
      cacheProducts(next);
      void idbCacheProducts(next);
      return next;
    });
    setShowReceive(false);
    setReceiveQty("");
    setReceiveTotalCost("");
    setReceiveSupplier("");
    setReceiveReceiptNo("");

    // Offline or no client → queue
    if (!navigator.onLine || !supabase) {
      const localId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `stk-${Date.now()}`;
      const row: OfflineStockReceipt = {
        id: localId,
        created_at: new Date().toISOString(),
        product_id: receiveProduct,
        product_name: product.name,
        quantity: addQty,
        total_cost: totalCost,
        supplier,
        receipt_no: receiptNo,
        note,
        user_id: profile?.id || session?.user?.id || "",
      };
      const q = await idbAddStockReceipt(row);
      setPendingStock(q);
      flash("Stock received offline — will sync when online");
      requestBackgroundSync("barpos-sync");
      setBusy(false);
      return;
    }

    flash("Stock received");
    setBusy(false);
    const { error } = await supabase.rpc("receive_stock_details", {
      p_product_id: receiveProduct,
      p_quantity: addQty,
      p_total_cost: totalCost,
      p_supplier: supplier,
      p_receipt_no: receiptNo,
      p_note: note,
    });
    if (error) {
      // Network fail → queue offline
      if (/fetch|network|Failed to fetch|abort|timeout|offline/i.test(error.message || "")) {
        const localId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `stk-${Date.now()}`;
        const row: OfflineStockReceipt = {
          id: localId,
          created_at: new Date().toISOString(),
          product_id: receiveProduct,
          product_name: product.name,
          quantity: addQty,
          total_cost: totalCost,
          supplier,
          receipt_no: receiptNo,
          note,
          user_id: profile?.id || session?.user?.id || "",
        };
        const q = await idbAddStockReceipt(row);
        setPendingStock(q);
        flash("Saved offline — stock will sync when connection returns");
        requestBackgroundSync("barpos-sync");
      } else {
        setError(error.message);
        void refreshProductsOnly();
      }
    } else {
      void refreshProductsOnly();
    }
  }
  async function auditStock(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !showAudit) return;
    setBusy(true);
    const { error } = await supabase.rpc("adjust_stock", {
      p_product_id: showAudit.id,
      p_new_quantity: Math.max(0, Math.round(Number(auditQty))),
      p_note: auditReason,
    });
    if (error) setError(error.message);
    else {
      const expected = showAudit.stock_qty;
      const counted = Math.max(0, Math.round(Number(auditQty)));
      const variance = counted - expected;
      const auditName = showAudit.name;
      const reason = auditReason;
      setShowAudit(null);
      try {
        await supabase.rpc("log_activity", {
          p_action: "inventory_audit",
          p_details: `${auditName}: expected ${expected} → counted ${counted} (var ${variance >= 0 ? "+" : ""}${variance}) · ${reason}`,
        });
      } catch {
        /* ignore log failures */
      }
      flash("Inventory audit saved");
      await refreshAll();
    }
    setBusy(false);
  }
  async function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2500000) {
      setError("Image must be under 2.5 MB.");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read image"));
        reader.readAsDataURL(file);
      });
      // Auto-frame to a uniform square so all product cards look consistent
      const framed = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const size = 512;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(dataUrl);
            return;
          }
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, size, size);
          const scale = Math.min(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          const x = (size - w) / 2;
          const y = (size - h) / 2;
          ctx.drawImage(img, x, y, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.88));
        };
        img.onerror = () => reject(new Error("Invalid image"));
        img.src = dataUrl;
      });
      setForm((f) => ({ ...f, image_url: framed }));
      setError("");
    } catch (err: any) {
      setError(err?.message || "Image processing failed");
    }
  }
  async function exportProducts() {
    const rows = products.map((p) => ({
      name: p.name,
      category: p.category,
      sku: p.sku || "",
      cost_price: p.cost_price,
      sell_price: p.sell_price,
      stock_qty: p.stock_qty,
      min_stock: p.min_stock,
      stock_unit: p.stock_unit || "unit",
      units_per_pack: p.units_per_pack || 100,
      active: p.active,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(rows),
      "Products",
    );
    XLSX.writeFile(wb, "bar-pos-products.xlsx");
  }
  async function importProducts(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !supabase) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
      if (!rows.length)
        throw new Error("The first worksheet has no product rows.");
      const payload = rows
        .map((r) => ({
          name: String(r.name || "").trim(),
          category: String(r.category || "Other"),
          sku: r.sku ? String(r.sku).trim() : null,
          cost_price: Number(r.cost_price || 0),
          sell_price: Number(r.sell_price || 0),
          stock_qty: Number(r.stock_qty || 0),
          min_stock: Number(r.min_stock || 5),
          stock_unit:
            String(r.stock_unit || "unit") === "barrel" ? "barrel" : "unit",
          units_per_pack: Number(r.units_per_pack || 100),
          active: r.active === false ? false : true,
        }))
        .filter((r) => r.name);
      if (!payload.length)
        throw new Error("No rows with a product name were found.");
      const { error } = await supabase
        .from("products")
        .upsert(payload, { onConflict: "sku" });
      if (error) throw error;
      flash(`Imported ${payload.length} products`);
      await refreshAll();
    } catch (err: any) {
      setError(err?.message || "Could not import workbook.");
    } finally {
      e.target.value = "";
    }
  }
  function addCart(p: Product) {
    const blockOut = settings?.block_sale_when_out !== false;
    setCart((old) => {
      const found = old.find((x) => x.product.id === p.id);
      if (found) {
        if (blockOut && found.qty + 1 > p.stock_qty) {
          setError(`Only ${p.stock_qty} in stock for ${p.name}`);
          try {
            navigator.vibrate?.(80);
          } catch {
            /* ignore */
          }
          return old;
        }
        return old.map((x) =>
          x.product.id === p.id ? { ...x, qty: x.qty + 1 } : x,
        );
      }
      if (blockOut && p.stock_qty < 1) {
        setError(`${p.name} is out of stock`);
        try {
          navigator.vibrate?.(120);
        } catch {
          /* ignore */
        }
        return old;
      }
      if (p.stock_qty > 0 && p.stock_qty <= p.min_stock) {
        try {
          navigator.vibrate?.([40, 30, 40]);
        } catch {
          /* ignore */
        }
      }
      return [...old, { product: p, qty: 1 }];
    });
  }

  function toggleFavorite(id: string) {
    setFavorites((old) => {
      const next = old.includes(id) ? old.filter((x) => x !== id) : [id, ...old].slice(0, 24);
      saveFavorites(next);
      return next;
    });
  }
  function changeQty(id: string, delta: number) {
    setCart((old) =>
      old
        .map((x) =>
          x.product.id === id
            ? {
                ...x,
                qty: Math.max(0, Math.min(x.product.stock_qty, x.qty + delta)),
              }
            : x,
        )
        .filter((x) => x.qty > 0),
    );
  }
  const total = cart.reduce(
      (n, x) => n + x.qty * Number(x.product.sell_price),
      0,
    ),
    cost = cart.reduce((n, x) => n + x.qty * Number(x.product.cost_price), 0);
  /** Replay offline sales + stock receipts when connection returns (conflict-aware) */
  async function processOfflineQueue() {
    if (!supabase || !navigator.onLine) return;
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    setSyncingQueue(true);
    try {
    let salesSynced = 0;
    let stockSynced = 0;
    let conflicts = 0;

    // Ensure we have a real cloud session (offline login only updates React state)
    try {
      if (session && isOfflineSession(session)) {
        const { data } = await supabase.auth.getSession();
        if (data.session && !isOfflineSession(data.session as any)) {
          setSession(data.session);
        }
      } else if (!session) {
        const { data } = await supabase.auth.getSession();
        if (data.session) setSession(data.session);
      }
    } catch {
      /* continue — RPC may still work if client has stored JWT */
    }

    // --- Sales ---
    let salesQ = await idbLoadSalesQueue();
    if (!salesQ.length) {
      try {
        salesQ = loadOfflineQueue().filter((s) => !s.synced);
      } catch {
        salesQ = [];
      }
    }
    let salesRemaining = [...salesQ];
    for (const sale of salesQ) {
      try {
        const { data, error } = await supabase.rpc("checkout_sale", {
          p_items: sale.items.map((x) => ({
            product_id: x.product_id,
            quantity: x.quantity,
          })),
          p_payment_method: sale.payment_method,
          p_creditor_name: sale.creditor_name,
        });
        if (error) {
          const msg = error.message || "Sync failed";
          const isConflict = /stock|insufficient|changed on another|not enough/i.test(msg);
          if (isConflict) conflicts++;
          salesRemaining = salesRemaining.map((s) =>
            s.id === sale.id
              ? { ...s, sync_error: msg, conflict: isConflict }
              : s,
          );
          continue;
        }
        salesSynced++;
        salesRemaining = salesRemaining.filter((s) => s.id !== sale.id);
        try {
          await supabase.rpc("log_activity", {
            p_action: "offline_sale_synced",
            p_details: `Offline ${sale.receipt_no} → ${data?.receipt_no || "ok"} · ${money(sale.total)}`,
          });
        } catch {
          /* ignore */
        }
      } catch (e: any) {
        salesRemaining = salesRemaining.map((s) =>
          s.id === sale.id
            ? { ...s, sync_error: e?.message || "Network error" }
            : s,
        );
      }
    }
    await idbSaveSalesQueue(salesRemaining);
    saveOfflineQueue(salesRemaining);
    setPendingSales(salesRemaining);

    // --- Stock receipts ---
    let stockQ = await idbLoadStockQueue();
    let stockRemaining = [...stockQ];
    for (const rec of stockQ) {
      try {
        const { error } = await supabase.rpc("receive_stock_details", {
          p_product_id: rec.product_id,
          p_quantity: rec.quantity,
          p_total_cost: rec.total_cost,
          p_supplier: rec.supplier,
          p_receipt_no: rec.receipt_no,
          p_note: (rec.note || "Stock received") + " (offline sync)",
        });
        if (error) {
          stockRemaining = stockRemaining.map((s) =>
            s.id === rec.id ? { ...s, sync_error: error.message || "Sync failed" } : s,
          );
          continue;
        }
        stockSynced++;
        stockRemaining = stockRemaining.filter((s) => s.id !== rec.id);
      } catch (e: any) {
        stockRemaining = stockRemaining.map((s) =>
          s.id === rec.id ? { ...s, sync_error: e?.message || "Network error" } : s,
        );
      }
    }
    await idbSaveStockQueue(stockRemaining);
    setPendingStock(stockRemaining);

    const now = new Date().toISOString();
    setLastSyncAt(now);
    void idbSetMeta("last_sync_at", now);
    setSyncConflicts(conflicts);

    const parts: string[] = [];
    if (salesSynced) parts.push(`${salesSynced} sale${salesSynced > 1 ? "s" : ""}`);
    if (stockSynced) parts.push(`${stockSynced} stock receipt${stockSynced > 1 ? "s" : ""}`);
    if (parts.length) {
      flash(`Synced ${parts.join(" + ")} to cloud`);
      await refreshAll();
    }
    if (conflicts > 0) {
      setError(
        `${conflicts} offline sale(s) blocked by stock conflict. Resolve on Inventory or reduce qty, then retry sync.`,
      );
    } else if (
      salesRemaining.some((s) => s.sync_error) ||
      stockRemaining.some((s) => s.sync_error)
    ) {
      const authFail = [...salesRemaining, ...stockRemaining].some((s) =>
        /jwt|auth|session|not authenticated|JWT/i.test(String((s as any).sync_error || "")),
      );
      if (authFail) {
        setError(
          "Queued items need a live cloud login. Sign out and sign in once while online, then sync runs automatically.",
        );
      } else {
        setError("Some offline items could not sync. Use Retry sync on the status bar.");
      }
    }
    } catch (e: any) {
      setError(e?.message || "Sync failed. Will retry automatically when online.");
    } finally {
      setSyncingQueue(false);
      syncLockRef.current = false;
    }
  }

  async function checkout(methodOverride?: string) {
    if (!cart.length) return;
    const method = methodOverride || payment;
    if (method === "credit" && !creditor.trim()) {
      setError("Enter the creditor name before completing a credit sale.");
      setShowCreditorModal(true);
      openKb("creditor", "alpha");
      return;
    }
    setBusy(true);
    setError("");
    const snapshot = cart.map((x) => ({ ...x }));
    const payTotal = snapshot.reduce(
      (n, x) => n + x.qty * Number(x.product.sell_price),
      0,
    );
    const payCost = snapshot.reduce(
      (n, x) => n + x.qty * Number(x.product.cost_price),
      0,
    );

    // --- OFFLINE PATH ---
    if (!navigator.onLine || !supabase) {
      // Validate stock against local cache
      for (const line of snapshot) {
        const p = products.find((x) => x.id === line.product.id);
        const need = Math.max(1, Math.round(Number(line.qty) || 0));
        if (settings.block_sale_when_out !== false && p && Number(p.stock_qty) < need) {
          setError(`Insufficient stock for ${line.product.name} (have ${p.stock_qty})`);
          setBusy(false);
          return;
        }
      }
      const localId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `off-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const receiptNo = `OFF-${Date.now().toString(36).toUpperCase()}`;
      const offlineSale: OfflineSale = {
        id: localId,
        created_at: new Date().toISOString(),
        items: snapshot.map((x) => ({
          product_id: x.product.id,
          quantity: Math.max(1, Math.round(Number(x.qty) || 0)),
          product_name: x.product.name,
          unit_price: Number(x.product.sell_price),
          cost_price: Number(x.product.cost_price),
        })),
        payment_method: method,
        creditor_name: method === "credit" ? creditor.trim() : null,
        total: payTotal,
        cost_total: payCost,
        cashier_id: profile?.id || session?.user?.id || "",
        cashier_name: profile?.full_name || profile?.staff_code || "Staff",
        receipt_no: receiptNo,
      };
      // Optimistic local stock update
      setProducts((prev) =>
        prev.map((p) => {
          const line = snapshot.find((x) => x.product.id === p.id);
          if (!line) return p;
          const qty = Math.max(1, Math.round(Number(line.qty) || 0));
          return { ...p, stock_qty: Math.max(0, Number(p.stock_qty) - qty) };
        }),
      );
      const nextQueue = [...loadOfflineQueue(), offlineSale];
      saveOfflineQueue(nextQueue);
      setPendingSales(nextQueue);
      // Keep products cache in sync
      cacheProducts(
        products.map((p) => {
          const line = snapshot.find((x) => x.product.id === p.id);
          if (!line) return p;
          const qty = Math.max(1, Math.round(Number(line.qty) || 0));
          return { ...p, stock_qty: Math.max(0, Number(p.stock_qty) - qty) };
        }),
      );
      const receiptData = {
        receipt_no: receiptNo,
        cashier_name: offlineSale.cashier_name,
        total: payTotal,
        cost: payCost,
        items: snapshot,
        payment: method,
        creditor: method === "credit" ? creditor.trim() : "",
        created_at: offlineSale.created_at,
        offline: true,
      };
      setReceipt(receiptData);
      setCart([]);
      setCreditor("");
      setPayment("cash");
      flash("Sale saved offline — will sync when internet returns");
      void idbSaveSalesQueue(nextQueue);
      requestBackgroundSync("barpos-sync");
      setBusy(false);
      return;
    }

    // --- ONLINE PATH ---
    const { data, error } = await supabase.rpc("checkout_sale", {
      p_items: snapshot.map((x) => ({
        product_id: x.product.id,
        quantity: Math.max(1, Math.round(Number(x.qty) || 0)),
      })),
      p_payment_method: method,
      p_creditor_name: method === "credit" ? creditor.trim() : null,
    });
    if (error) {
      const msg = error.message || "Checkout failed";
      // If network-ish failure, fall through to offline path
      if (/failed to fetch|network|timeout|offline|ERR_/i.test(msg) || !navigator.onLine) {
        setBusy(false);
        // Re-enter offline path by temporarily forcing offline check — recurse once
        // Simpler: just show error and let user retry (or we could call offline logic)
        setError(msg + " — if internet is down, the sale will be queued on retry.");
        return;
      }
      if (/stock changed on another till|insufficient stock/i.test(msg)) {
        setError(msg + " — stock was refreshed.");
        await refreshAll();
      } else {
        setError(msg);
      }
    } else {
      // Optimistic stock so UI is instant (no full refreshAll wait)
      setProducts((prev) => {
        const next = prev.map((p) => {
          const line = snapshot.find((x) => x.product.id === p.id);
          if (!line) return p;
          const qty = Math.max(1, Math.round(Number(line.qty) || 0));
          return { ...p, stock_qty: Math.max(0, Number(p.stock_qty) - qty) };
        });
        cacheProducts(next);
        return next;
      });
      const receiptData = {
        receipt_no: data?.receipt_no || "",
        cashier_name: profile?.full_name || profile?.staff_code || "Staff",
        total: payTotal,
        cost: payCost,
        items: snapshot,
        payment: method,
        creditor: method === "credit" ? creditor.trim() : "",
        created_at: new Date().toISOString(),
      };
      setReceipt(receiptData);
      setCart([]);
      setCreditor("");
      setPayment("cash");
      flash("Sale completed");
      setBusy(false);
      // Background light sync — does not block the till
      void (async () => {
        try {
          await supabase.rpc("log_activity", {
            p_action: "sale_completed",
            p_details: `${method} · ${money(payTotal)} · ${snapshot.length} lines`,
          });
        } catch {
          /* ignore */
        }
        await refreshAfterSale();
        void processOfflineQueue();
      })();
      return;
    }
    setBusy(false);
  }

  function shareReceiptWhatsApp(r: any) {
    const bar = settings.bar_name || "Sherehe POS";
    const lines = (r.items || [])
      .map((x: any) => {
        const name = x.product?.name || x.product_name || "Item";
        const qty = x.qty || x.quantity || 1;
        const unit = Number(x.product?.sell_price ?? x.unit_price ?? 0);
        return `• ${name} × ${qty} = ${money(qty * unit)}`;
      })
      .join("%0A");
    const text =
      `*${bar}*%0A` +
      `Receipt ${r.receipt_no || ""}%0A` +
      `${dateLabel(r.created_at || new Date().toISOString())}%0A` +
      `${lines}%0A` +
      `*TOTAL ${money(r.total)}*%0A` +
      `Pay: ${(r.payment || "cash").toUpperCase()}` +
      (r.creditor ? `%0ACreditor: ${r.creditor}` : "");
    window.open(`https://wa.me/?text=${text}`, "_blank");
  }
  async function saveExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !session?.user?.id) return;
    const desc = expenseForm.description.trim();
    const amt = Number(expenseForm.amount);
    if (!desc || !Number.isFinite(amt) || amt <= 0) {
      setError("Enter a description and a valid amount");
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("expenses")
      .insert({
        description: desc,
        amount: amt,
        created_by: session.user.id,
      });
    if (error) setError(error.message);
    else {
      setShowExpense(false);
      setExpenseForm({ description: "", amount: "" });
      flash("Expense saved");
      await supabase.rpc("log_activity", { p_action: "expense_added", p_details: desc });
      await refreshAll();
    }
    setBusy(false);
  }


  function getStocktakeVarianceRows() {
    const days = varianceRange === "all" ? null : Number(varianceRange);
    const cutoff = days
      ? Date.now() - days * 24 * 60 * 60 * 1000
      : 0;
    return stockMovements
      .filter((m) => {
        if (m.movement_type !== "adjustment") return false;
        if (!cutoff) return true;
        return new Date(m.created_at).getTime() >= cutoff;
      })
      .map((m) => {
        const prod = products.find((p) => p.id === m.product_id);
        const counted = Number(m.quantity_after);
        const diff = Number(m.quantity_change);
        const expected = counted - diff;
        return {
          id: m.id,
          product_id: m.product_id,
          name: prod?.name || "Unknown product",
          category: prod?.category || "Other",
          sku: prod?.sku || "",
          expected,
          counted,
          variance: diff,
          note: m.note || "",
          created_at: m.created_at,
          user_id: m.user_id,
        };
      });
  }

  function getVarianceByCategory() {
    const rows = getStocktakeVarianceRows();
    const map: Record<
      string,
      { category: string; lines: number; over: number; under: number; net: number }
    > = {};
    rows.forEach((r) => {
      const c = r.category || "Other";
      if (!map[c]) map[c] = { category: c, lines: 0, over: 0, under: 0, net: 0 };
      map[c].lines += 1;
      map[c].net += r.variance;
      if (r.variance > 0) map[c].over += r.variance;
      if (r.variance < 0) map[c].under += Math.abs(r.variance);
    });
    return Object.values(map).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  }

  function exportVarianceReport() {
    const rows = getStocktakeVarianceRows();
    const byCat = getVarianceByCategory();
    const detail = rows.map((r) => ({
      Date: dateLabel(r.created_at),
      Category: r.category,
      Product: r.name,
      SKU: r.sku,
      "System (expected)": r.expected,
      "Physical (counted)": r.counted,
      Variance: r.variance,
      Note: r.note,
    }));
    const summary = byCat.map((c) => ({
      Category: c.category,
      Adjustments: c.lines,
      "Over (units)": c.over,
      "Under (units)": c.under,
      "Net variance": c.net,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "Variance detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "By category");
    XLSX.writeFile(wb, `stocktake-variance-${new Date().toISOString().slice(0, 10)}.xlsx`);
    flash("Variance report downloaded");
  }

  function getCreditorSummary() {
    const map: Record<string, { salesTotal: number; paidTotal: number; sales: Sale[]; payments: any[] }> = {};
    sales
      .filter((s) => s.payment_method === "credit" && s.creditor_name)
      .forEach((s) => {
        const n = (s.creditor_name || "").trim();
        if (!map[n]) map[n] = { salesTotal: 0, paidTotal: 0, sales: [], payments: [] };
        map[n].salesTotal += Number(s.total);
        map[n].sales.push(s);
      });
    creditPayments.forEach((p) => {
      const n = (p.creditor_name || "").trim();
      if (!map[n]) map[n] = { salesTotal: 0, paidTotal: 0, sales: [], payments: [] };
      map[n].paidTotal += Number(p.amount);
      map[n].payments.push(p);
    });
    return Object.entries(map)
      .map(([name, v]) => {
        const outstanding = Math.max(0, v.salesTotal - v.paidTotal);
        const salesSorted = v.sales.sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        // Approximate age from oldest credit sale while still outstanding
        let oldest = salesSorted[0]?.created_at || null;
        let ageDays = 0;
        if (outstanding > 0 && oldest) {
          ageDays = Math.floor(
            (Date.now() - new Date(oldest).getTime()) / (1000 * 60 * 60 * 24),
          );
        }
        const bucket =
          outstanding <= 0
            ? "settled"
            : ageDays <= 7
              ? "0-7"
              : ageDays <= 14
                ? "8-14"
                : "15+";
        return {
          name,
          salesTotal: v.salesTotal,
          paidTotal: v.paidTotal,
          outstanding,
          ageDays,
          bucket,
          oldest,
          sales: [...v.sales].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          ),
          payments: v.payments.sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          ),
        };
      })
      .sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  }

  function getCreditAging() {
    const list = getCreditorSummary().filter((c) => c.outstanding > 0);
    const sum = (bucket: string) =>
      list.filter((c) => c.bucket === bucket).reduce((n, c) => n + c.outstanding, 0);
    return {
      d07: sum("0-7"),
      d814: sum("8-14"),
      d15: sum("15+"),
      list,
    };
  }

  function getPaymentMix() {
    const methods = ["cash", "mpesa", "card", "credit"] as const;
    const mix = methods.map((m) => ({
      method: m,
      total: todaySales
        .filter((s) => (s.payment_method || "").toLowerCase() === m)
        .reduce((n, s) => n + Number(s.total), 0),
      count: todaySales.filter((s) => (s.payment_method || "").toLowerCase() === m).length,
    }));
    return mix;
  }

  async function submitBatchReceive() {
    if (!supabase || !batchItems.length) return;
    setBusy(true);
    setError("");
    try {
      for (const row of batchItems) {
        const qty = Number(row.qty);
        const totalCost = Number(row.total_cost);
        if (!row.product_id || !Number.isFinite(qty) || qty <= 0) continue;
        const prod = products.find((p) => p.id === row.product_id);
        const units =
          prod?.stock_unit === "barrel"
            ? qty * Number(prod.units_per_pack || 100)
            : qty;
        const unitCost = totalCost > 0 ? totalCost / units : Number(prod?.cost_price || 0);
        const { error } = await supabase.rpc("receive_stock_details", {
          p_product_id: row.product_id,
          p_quantity: Math.round(units),
          p_total_cost: Number.isFinite(totalCost) && totalCost > 0 ? totalCost : 0,
          p_supplier: batchSupplier.trim() || null,
          p_receipt_no: batchReceiptNo.trim() || null,
          p_note: "Batch receive",
        });
        if (error) throw error;
      }
      await supabase.rpc("log_activity", {
        p_action: "batch_receive",
        p_details: `${batchItems.length} lines · ${batchSupplier || "no supplier"} · ${batchReceiptNo || ""}`,
      });
      flash("Batch stock received");
      setShowBatchReceive(false);
      setBatchItems([]);
      setBatchSupplier("");
      setBatchReceiptNo("");
      setBatchMode(false);
      await refreshAll();
    } catch (err: any) {
      setError(err.message || "Batch receive failed");
    }
    setBusy(false);
  }


  async function submitCreditPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !creditPayModal) return;
    const amt = Number(creditPayForm.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid payment amount");
      return;
    }
    if (amt > creditPayModal.outstanding + 0.01) {
      setError("Amount exceeds outstanding balance");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("record_credit_payment", {
      p_creditor_name: creditPayModal.name,
      p_amount: amt,
      p_payment_method: creditPayForm.method,
      p_note: creditPayForm.note || null,
    });
    if (error) setError(error.message);
    else {
      flash(`Payment of ${money(amt)} recorded • ${data?.receipt_no || ""}`);
      // Print payment receipt
      printReceipt({
        receipt_no: data?.receipt_no || "",
        total: amt,
        payment: creditPayForm.method,
        creditor: creditPayModal.name,
        created_at: new Date().toISOString(),
        items: [{ product_name: "Credit payment", quantity: 1, unit_price: amt }],
        isPayment: true,
      });
      setCreditPayModal(null);
      setCreditPayForm({ amount: "", method: "cash", note: "" });
      await refreshAll();
    }
    setBusy(false);
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || profile?.role !== "admin") return;
    setBusy(true);
    const idleMins = Math.min(60, Math.max(1, Number(settingsForm.idle_timeout_minutes) || 5));
    const payload: any = {
      bar_name: settingsForm.bar_name.trim() || "Sherehe POS",
      till_number: settingsForm.till_number.trim(),
      receipt_footer: settingsForm.receipt_footer.trim(),
      logo_url: settingsForm.logo_url || null,
      idle_timeout_minutes: idleMins,
      block_sale_when_out: !!settingsForm.block_sale_when_out,
      receipt_paper_mm: Number(settingsForm.receipt_paper_mm) === 58 ? 58 : 80,
      updated_at: new Date().toISOString(),
    };
    if (settingsForm.admin_pin.trim()) {
      payload.admin_pin_hash = await hashPin(settingsForm.admin_pin.trim());
    }
    const { error } = await supabase.from("app_settings").update(payload).eq("id", 1);
    if (error) setError(error.message);
    else {
      flash("Settings saved");
      await supabase.rpc("log_activity", { p_action: "settings_updated", p_details: "Bar settings changed" });
      await refreshAll();
    }
    setBusy(false);
  }

  function requestPin(action: string, onSuccess: () => void) {
    setPinPrompt({ action, onSuccess });
    setPinInput("");
  }

  async function verifyPin() {
    if (!pinPrompt) return;
    const entered = pinInput.trim();
    const hashSha = await hashPin(entered);
    const hashLegacy = btoa(entered);
    const stored = settings.admin_pin_hash;
    const profilePin = profile?.pin_hash;
    if (!stored && !profilePin) {
      if (entered.length >= 4) {
        pinPrompt.onSuccess();
        setPinPrompt(null);
        flash("Action completed (set an admin PIN in Settings for protection)");
      } else {
        setError("Enter a PIN of at least 4 characters (or set one in Settings first)");
      }
      return;
    }
    const ok =
      (stored && (hashSha === stored || hashLegacy === stored)) ||
      (profilePin && (hashSha === profilePin || hashLegacy === profilePin));
    if (ok) {
      pinPrompt.onSuccess();
      setPinPrompt(null);
      setPinInput("");
    } else {
      setError("Incorrect admin PIN");
    }
  }


  async function runFactoryReset() {
    if (!supabase || !session?.user?.email) {
      setError("Not signed in");
      return;
    }
    if (profile?.role !== "admin") {
      setError("Only admin can factory reset");
      return;
    }
    const pw = factoryPassword.trim();
    if (!pw) {
      setError("Enter your admin account password (the one you use to sign in)");
      return;
    }
    setFactoryBusy(true);
    setError("");
    try {
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: session.user.email,
        password: pw,
      });
      if (authErr) {
        setError("Incorrect password. Use the same password you use to sign in.");
        setFactoryBusy(false);
        return;
      }

      const { data, error } = await supabase.rpc("factory_reset");
      if (error) {
        const msg = String(error.message || error);
        if (/could not find|function public\.factory_reset|does not exist|42883/i.test(msg)) {
          throw new Error(
            "Reset function missing or outdated. Open Supabase → SQL Editor, paste and run supabase/factory-reset.sql, then try again.",
          );
        }
        if (/DELETE requires a WHERE clause/i.test(msg)) {
          throw new Error(
            "Database still has the old reset function. Open Supabase → SQL Editor, run supabase/factory-reset.sql (full file), then try Factory reset again.",
          );
        }
        if (/Only admin/i.test(msg)) {
          throw new Error("Only an admin account can factory reset.");
        }
        throw error;
      }

      const stats = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const productsWiped = Number(stats.products ?? 0);
      const salesWiped = Number(stats.sales ?? 0);

      try {
        localStorage.removeItem(CACHE_PRODUCTS_KEY);
        localStorage.removeItem(CACHE_SETTINGS_KEY);
        localStorage.removeItem(CACHE_TS_KEY);
        localStorage.removeItem(OFFLINE_QUEUE_KEY);
        localStorage.removeItem("barpos_favorites");
      } catch {
        /* ignore */
      }
      setProducts([]);
      setSales([]);
      setSoldItems([]);
      setExpenses([]);
      setCreditPayments([]);
      setActivity([]);
      setSuppliers([]);
      setStockReceipts([]);
      setStockMovements([]);
      setAdminNotifications([]);
      setPendingSales([]);
      setCart([]);
      setHeldSales([]);
      setReceipt(null);

      setFactoryResetOpen(false);
      setFactoryPassword("");
      setFactoryConfirmText("");
      setShowAlphaKb(false);

      let stillThere = 0;
      try {
        const { count } = await supabase
          .from("products")
          .select("id", { count: "exact", head: true });
        stillThere = count ?? 0;
      } catch {
        /* ignore */
      }

      if (stillThere > 0) {
        setError(
          `Reset reported success but ${stillThere} product(s) still exist. Your database still has the old soft-reset function. Run supabase/factory-reset.sql in Supabase SQL Editor, then try again.`,
        );
      } else {
        flash(
          `Factory reset complete — wiped ${productsWiped} product(s), ${salesWiped} sale(s). Login accounts kept.`,
        );
      }
      await refreshAll();
    } catch (err: any) {
      setError(
        err?.message ||
          "Factory reset failed. In Supabase SQL Editor run supabase/factory-reset.sql, then try again.",
      );
    }
    setFactoryBusy(false);
  }

  async function deleteAllProducts() {
    if (!supabase || profile?.role !== "admin") return;
    setBusy(true);
    const { error } = await supabase.from("products").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) setError(error.message);
    else {
      flash("All products deleted");
      await supabase.rpc("log_activity", { p_action: "products_cleared", p_details: "All products removed" });
      await refreshAll();
    }
    setBusy(false);
  }

  function openEditUser(u: any) {
    setEditingUser(u);
    setUserForm({
      full_name: u.full_name || "",
      role: u.role || "cashier",
      active: u.active !== false,
      allowed_tabs: Array.isArray(u.allowed_tabs) && u.allowed_tabs.length
        ? [...u.allowed_tabs]
        : u.role === "admin"
          ? [...ALL_TABS]
          : ["Dashboard", "Sell", "Credits", "Expenses"],
      pin: "",
      staff_code: u.staff_code || "",
    });
  }

  async function saveUser(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !editingUser || profile?.role !== "admin") return;
    setBusy(true);
    const updates: Record<string, unknown> = {
      full_name: userForm.full_name.trim(),
      role: userForm.role,
      active: userForm.active,
      allowed_tabs: userForm.role === "admin" ? ALL_TABS : userForm.allowed_tabs,
    };
    const newPin = userForm.pin.trim();
    let authPinSynced = false;
    if (newPin.length >= 4) {
      updates.pin_hash = await hashPin(newPin);
      // Ensure login_email exists for PIN resolve
      const code =
        (userForm.staff_code || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) ||
        (editingUser.staff_code || "").trim();
      if (code && !editingUser.login_email) {
        updates.login_email = `${code}@bar.local`;
      }
      try {
        const { data: fnData, error: fnErr } = await supabase.functions.invoke("admin-user", {
          body: { action: "reset_pin", user_id: editingUser.id, pin: newPin },
        });
        authPinSynced = !fnErr && fnData && !(fnData as any).error;
      } catch {
        authPinSynced = false;
      }
    }
    if (userForm.staff_code?.trim()) {
      updates.staff_code = userForm.staff_code.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
      if (!updates.login_email && !editingUser.login_email) {
        updates.login_email = `${updates.staff_code}@bar.local`;
      }
    }
    const { error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", editingUser.id);
    if (error) setError(error.message);
    else {
      if (newPin.length >= 4) {
        flash(
          authPinSynced
            ? "User updated — PIN ready for PIN login"
            : "PIN saved on profile. If PIN login fails, deploy Edge Functions pin-login + admin-user, then save PIN again. Or recreate the user with that PIN.",
        );
      } else {
        flash("User updated");
      }
      setEditingUser(null);
      await supabase.rpc("log_activity", {
        p_action: "user_updated",
        p_details: `${userForm.full_name || editingUser.id} → ${userForm.role}`,
      });
      await refreshAll();
    }
    setBusy(false);
  }

  async function deleteUser(u: { id: string; full_name?: string; role?: string }) {
    if (!supabase || profile?.role !== "admin") return;
    if (u.id === profile.id) {
      setError("You cannot delete your own account");
      return;
    }
    if (
      !confirm(
        `Disable and remove access for "${u.full_name || u.id}"? They will no longer be able to sign in. Sales history is kept.`,
      )
    )
      return;
    setBusy(true);
    const { error } = await supabase.rpc("admin_delete_user", { p_user_id: u.id });
    if (error) {
      // Fallback: soft-delete via profile update if RPC not yet applied
      const { error: e2 } = await supabase
        .from("profiles")
        .update({ active: false, pin_hash: null, staff_code: null })
        .eq("id", u.id);
      if (e2) setError(error.message + " / " + e2.message);
      else {
        flash("User disabled");
        await supabase.rpc("log_activity", {
          p_action: "user_deleted",
          p_details: u.full_name || u.id,
        });
        await refreshAll();
      }
    } else {
      flash("User deleted (account disabled)");
      await refreshAll();
    }
    setBusy(false);
  }

  function getWeeklyProfitBars() {
    const days: { label: string; profit: number; sales: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toDateString();
      const daySales = sales.filter((s) => new Date(s.created_at).toDateString() === key);
      const dayExp = expenses
        .filter((e) => new Date(e.created_at).toDateString() === key)
        .reduce((n, e) => n + Number(e.amount), 0);
      const gross = daySales.reduce((n, s) => n + Number(s.total) - Number(s.cost_total || 0), 0);
      days.push({
        label: d.toLocaleDateString("en-KE", { weekday: "short", day: "numeric" }),
        profit: gross - dayExp,
        sales: daySales.reduce((n, s) => n + Number(s.total), 0),
      });
    }
    return days;
  }

  function getBestSellers(limit = 8) {
    const map: Record<string, { name: string; qty: number; revenue: number; category: string }> = {};
    soldItems.forEach((si) => {
      const sale = sales.find((s) => s.id === si.sale_id);
      if (!sale) return;
      const key = si.product_name;
      if (!map[key]) {
        const prod = products.find((p) => p.name === si.product_name);
        map[key] = { name: si.product_name, qty: 0, revenue: 0, category: prod?.category || "Other" };
      }
      map[key].qty += Number(si.quantity);
      map[key].revenue += Number(si.line_total);
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, limit);
  }

  function getWorstSellers(limit = 5) {
    const map: Record<string, { name: string; qty: number; category: string }> = {};
    products.filter((p) => p.active).forEach((p) => {
      map[p.name] = { name: p.name, qty: 0, category: p.category };
    });
    soldItems.forEach((si) => {
      if (map[si.product_name]) map[si.product_name].qty += Number(si.quantity);
    });
    return Object.values(map).sort((a, b) => a.qty - b.qty).slice(0, limit);
  }

  function getBestByCategory() {
    const best = getBestSellers(50);
    const cats: Record<string, typeof best> = {};
    best.forEach((b) => {
      cats[b.category] = cats[b.category] || [];
      cats[b.category].push(b);
    });
    return Object.entries(cats).map(([cat, items]) => ({
      category: cat,
      top: items.slice(0, 3),
    }));
  }

  function getDayOfWeekStats() {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const buckets = names.map((label) => ({ label, sales: 0, count: 0 }));
    sales.forEach((s) => {
      const d = new Date(s.created_at).getDay();
      buckets[d].sales += Number(s.total);
      buckets[d].count += 1;
    });
    return buckets;
  }

  function getHourlyStats() {
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, count: 0 }));
    sales.forEach((s) => {
      const h = new Date(s.created_at).getHours();
      hours[h].sales += Number(s.total);
      hours[h].count += 1;
    });
    return hours;
  }

  function getCashierPerformance() {
    const map: Record<string, { name: string; sales: number; count: number }> = {};
    sales.forEach((s) => {
      const id = s.cashier_id;
      if (!map[id]) {
        const p = profiles.find((x) => x.id === id);
        map[id] = { name: p?.full_name || id.slice(0, 8), sales: 0, count: 0 };
      }
      map[id].sales += Number(s.total);
      map[id].count += 1;
    });
    return Object.values(map).sort((a, b) => b.sales - a.sales);
  }

  function printLowStockOrder() {
    const items = products
      .filter((p) => p.active && p.stock_qty <= p.min_stock)
      .sort((a, b) => a.stock_qty - b.stock_qty);
    if (!items.length) {
      flash("No low-stock items");
      return;
    }
    const w = window.open("", "_blank", "width=480,height=700");
    if (!w) {
      setError("Allow pop-ups to print order list");
      return;
    }
    const bar = settings.bar_name || "Sherehe POS";
    const rows = items
      .map(
        (p) =>
          `<tr>
            <td>${p.name}</td>
            <td>${p.category}</td>
            <td style="text-align:center">${p.stock_qty}</td>
            <td style="text-align:center">${p.min_stock}</td>
            <td style="text-align:center">${Math.max(p.min_stock * 2 - p.stock_qty, p.min_stock)}</td>
          </tr>`,
      )
      .join("");
    w.document.write(`<!DOCTYPE html><html><head><title>Low stock order</title>
<style>body{font-family:system-ui,sans-serif;padding:20px;max-width:640px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #ddd;padding:8px;text-align:left}
th{background:#f8fafc} @media print{button{display:none}}</style></head><body>
<h1>${bar} — Low stock order list</h1>
<p>Generated ${new Date().toLocaleString()} · ${items.length} items below minimum</p>
<table><thead><tr><th>Product</th><th>Category</th><th>In stock</th><th>Min</th><th>Suggested order</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="margin-top:16px;font-size:12px;color:#666">Suggested order = enough to reach 2× minimum threshold.</p>
<button onclick="window.print()" style="margin-top:12px;padding:10px 18px;font-size:14px">Print / Save PDF</button>
</body></html>`);
    w.document.close();
  }

  function copyLowStockWhatsApp() {
    const items = products.filter((p) => p.active && p.stock_qty <= p.min_stock);
    if (!items.length) {
      flash("No low-stock items");
      return;
    }
    const lines = [
      `*${settings.bar_name || "Sherehe POS"} — Stock order*`,
      new Date().toLocaleDateString(),
      "",
      ...items.map(
        (p) =>
          `• ${p.name} (${p.category}): ${p.stock_qty} left → order ~${Math.max(p.min_stock * 2 - p.stock_qty, p.min_stock)}`,
      ),
    ];
    const text = lines.join("\n");
    navigator.clipboard?.writeText(text).then(
      () => flash("Order list copied — paste into WhatsApp"),
      () => setError("Could not copy to clipboard"),
    );
  }

  async function saveSupplier(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || profile?.role !== "admin") return;
    setBusy(true);
    const { error } = await supabase.from("suppliers").insert({
      name: supplierForm.name.trim(),
      phone: supplierForm.phone.trim(),
      note: supplierForm.note.trim(),
    });
    if (error) setError(error.message);
    else {
      flash("Supplier added");
      setShowSupplier(false);
      setSupplierForm({ name: "", phone: "", note: "" });
      await refreshAll();
    }
    setBusy(false);
  }

  async function toggleDarkMode() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle("dark", next);
    if (supabase && profile?.role === "admin") {
      await supabase.from("app_settings").update({ dark_mode: next }).eq("id", 1);
    }
  }

  function getSupplierLedger() {
    // Group receipts by supplier name (from free-text or linked)
    const map: Record<string, { name: string; total: number; count: number; last: string }> = {};
    stockReceipts.forEach((r) => {
      const name = (r.supplier || "").trim() || "Unknown supplier";
      if (!map[name]) map[name] = { name, total: 0, count: 0, last: r.created_at };
      map[name].total += Number(r.total_cost || 0);
      map[name].count += 1;
      if (new Date(r.created_at) > new Date(map[name].last)) map[name].last = r.created_at;
    });
    suppliers.forEach((s) => {
      if (!map[s.name]) map[s.name] = { name: s.name, total: 0, count: 0, last: "" };
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }
  function buildReceiptHtml(r: any): string {
    // Thermal paper: 80mm (default) or 58mm — content flush to edges
    const paperMm = Number(settings.receipt_paper_mm) === 58 ? 58 : 80;
    const contentMm = paperMm === 58 ? 48 : 72;
    const chars = paperMm === 58 ? 32 : 42;
    const bar = String(settings.bar_name || "BAR POS").trim();
    const till = String(settings.till_number || "").trim();
    const footer = String(settings.receipt_footer || "Thank you!").trim();
    const title = r.isPayment ? "CREDIT PAYMENT" : "SALES RECEIPT";
    const cashierName =
      (r.cashier_name && String(r.cashier_name).trim()) ||
      (profile?.full_name && String(profile.full_name).trim()) ||
      (profile?.staff_code && String(profile.staff_code).trim()) ||
      "Staff";
    const showCashier = settings.show_cashier_on_receipt !== false;
    const showTill = settings.show_till_on_receipt !== false && !!till;

    const esc = (s: string) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const kes = (n: number) => {
      const v = Number(n || 0);
      return (
        "KES " +
        v.toLocaleString("en-KE", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      );
    };

    const padLine = (left: string, right: string) => {
      const L = String(left);
      const R = String(right);
      const space = Math.max(1, chars - L.length - R.length);
      return esc(L) + "&nbsp;".repeat(space) + esc(R);
    };

    const dash = "-".repeat(chars);
    const ddot = "=".repeat(chars);

    const itemBlocks = (r.items || [])
      .map((x: any) => {
        const name = String(x.product?.name || x.product_name || "Item").trim();
        const qty = Number(x.qty || x.quantity || 1);
        const unit = Number(x.product?.sell_price ?? x.unit_price ?? 0);
        const line = Number(x.line_total ?? qty * unit);
        const nameLine =
          name.length > chars ? esc(name.slice(0, chars - 1)) + "…" : esc(name);
        const detail = padLine(`${qty} x ${kes(unit)}`, kes(line));
        return `<div class="item-name">${nameLine}</div><div class="item-row">${detail}</div>`;
      })
      .join("");

    const when = (() => {
      try {
        return new Date(r.created_at || Date.now()).toLocaleString("en-KE", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
      } catch {
        return String(r.created_at || "");
      }
    })();

    const pay = String(r.payment || r.payment_method || "cash").toUpperCase();
    const receiptNo = String(r.receipt_no || "").trim();

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Receipt ${esc(receiptNo)}</title>
<style>
  @page { size: ${paperMm}mm auto; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${paperMm}mm; max-width: ${paperMm}mm; margin: 0; padding: 0;
    background: #fff; color: #000;
    font-family: "Courier New", Courier, "Noto Sans Mono", monospace;
    font-size: 15px; line-height: 1.3;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .ticket { width: ${contentMm}mm; max-width: 100%; margin: 0 auto; padding: 1mm 1.5mm 8mm 1.5mm; }
  .center { text-align: center; }
  .left { text-align: left; }
  .bar-name { font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; margin-bottom: 3px; word-break: break-word; }
  .meta { font-size: 13px; margin: 2px 0; word-break: break-word; }
  .rule { border: none; border-top: 1px dashed #000; margin: 4px 0; height: 0; }
  .rule-hard { border: none; border-top: 1px solid #000; margin: 4px 0; height: 0; }
  .mono { font-family: "Courier New", Courier, monospace; white-space: pre-wrap; word-break: break-word; }
  .item-name { font-weight: 700; font-size: 15px; margin-top: 4px; word-break: break-word; }
  .item-row { font-size: 14px; white-space: nowrap; overflow: hidden; }
  .totals .row { display: flex; justify-content: space-between; gap: 4px; margin: 3px 0; font-size: 15px; }
  .totals .grand { font-size: 18px; font-weight: 700; margin-top: 6px; }
  .footer { text-align: center; margin-top: 8px; font-size: 13px; word-break: break-word; }
  .feed { height: 10mm; }
  @media print {
    html, body { width: ${paperMm}mm; margin: 0 !important; padding: 0 !important; }
    .ticket { padding: 0 1mm 6mm 1mm; }
    .no-print { display: none !important; }
  }
  @media screen {
    body { background: #333; padding: 12px; }
    .ticket { background: #fff; box-shadow: 0 0 0 1px #000; }
  }
</style>
</head>
<body>
  <div class="ticket">
    <div class="center">
      <div class="bar-name">${esc(bar)}</div>
      <div class="meta">${esc(title)}</div>
      ${showTill ? `<div class="meta"><b>Till: ${esc(till)}</b></div>` : ""}
      <div class="meta">${esc(when)}</div>
      ${receiptNo ? `<div class="meta">No: ${esc(receiptNo)}</div>` : ""}
      ${showCashier ? `<div class="meta">Cashier: ${esc(cashierName)}</div>` : ""}
    </div>
    <hr class="rule"/>
    <div class="left mono">${itemBlocks || "<div class='meta'>No items</div>"}</div>
    <hr class="rule-hard"/>
    <div class="totals">
      <div class="row grand"><span>TOTAL</span><span>${esc(kes(Number(r.total || 0)))}</span></div>
      <div class="row"><span>Payment</span><span>${esc(pay)}</span></div>
      ${
        r.creditor
          ? `<div class="row"><span>Creditor</span><span>${esc(String(r.creditor))}</span></div>`
          : ""
      }
    </div>
    <hr class="rule"/>
    <div class="footer">
      <div>${esc(ddot)}</div>
      <div>${esc(footer)}</div>
      <div>${esc(dash)}</div>
    </div>
    <div class="feed"></div>
  </div>
  <script>
    window.onload = function () {
      try { window.focus(); } catch (e) {}
      setTimeout(function () { window.print(); }, 200);
      window.onafterprint = function () {
        setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
      };
      setTimeout(function () { try { window.close(); } catch (e) {} }, 60000);
    };
  </script>
</body>
</html>`;
  }

  function printReceipt(r: any) {
    const html = buildReceiptHtml(r);
    // Desktop (Electron): use dedicated print window — works on every installed PC
    const desktop = (window as any).barposDesktop;
    if (desktop?.isDesktop && typeof desktop.printHtml === "function") {
      void desktop.printHtml(html, { silent: false }).then((res: any) => {
        if (res && res.ok === false) {
          setError(
            "Print failed" +
              (res.reason ? ": " + res.reason : "") +
              ". Install the thermal printer in Windows, set it as default, then try again.",
          );
        }
      });
      return;
    }
    // Browser / PWA fallback
    const w = window.open("", "_blank", "width=320,height=640");
    if (!w) {
      setError(
        "Allow pop-ups to print receipts. On desktop app, rebuild with the latest installer for built-in printing.",
      );
      return;
    }
    w.document.write(html);
    w.document.close();
  }
  async function reprintSale(s: Sale) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("sale_items")
      .select("product_name,quantity,unit_price,line_total")
      .eq("sale_id", s.id);
    if (error) {
      setError(error.message);
      return;
    }
    const cashierProfile = profiles.find((p: any) => p.id === s.cashier_id);
    printReceipt({
      receipt_no: s.receipt_no,
      total: s.total,
      payment: s.payment_method,
      creditor: s.creditor_name,
      created_at: s.created_at,
      cashier_name:
        cashierProfile?.full_name ||
        cashierProfile?.staff_code ||
        profile?.full_name ||
        "Staff",
      items: (data || []).map((x: any) => ({
        product_name: x.product_name,
        quantity: x.quantity,
        unit_price: x.unit_price,
      })),
    });
  }
  const isAdminNow = profile?.role === "admin";
  // Business day resets at 09:00 every morning for cashier "today" stats
  function getBusinessDayBounds(now = new Date()) {
    const start = new Date(now);
    if (now.getHours() < 9) start.setDate(start.getDate() - 1);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  const { start: bizStart, end: bizEnd } = getBusinessDayBounds();
  const todaySales = sales.filter((s) => {
    const t = new Date(s.created_at).getTime();
    const inBizDay = t >= bizStart.getTime() && t < bizEnd.getTime();
    if (!inBizDay) return false;
    // Cashiers only see their own sales for the current business day
    if (!isAdminNow) return s.cashier_id === session?.user?.id;
    return true;
  });
  const todayTotal = todaySales.reduce((n, s) => n + Number(s.total), 0);
  const todayExpenses = expenses
    .filter(
      (e) =>
        new Date(e.created_at).toDateString() === new Date().toDateString(),
    )
    .reduce((n, e) => n + Number(e.amount), 0);
  const todayCredit = todaySales
    .filter((s) => s.payment_method === "credit")
    .reduce((n, s) => n + Number(s.total), 0);
  const todayGross = todaySales.reduce(
    (n, s) => n + Number(s.total) - Number(s.cost_total || 0),
    0,
  );
  const todayNet = todayGross - (isAdminNow ? todayExpenses : 0);
  const todayItems = soldItems.filter((i) =>
    todaySales.some((s) => s.id === i.sale_id),
  );
  const lowStock = products.filter(
    (p) => p.active && p.stock_qty <= p.min_stock,
  );
  const filtered = products
    .filter(
      (p) =>
        p.active &&
        (p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.sku || "").toLowerCase().includes(search.toLowerCase()) ||
          p.category.toLowerCase().includes(search.toLowerCase())),
    )
    .sort((a, b) =>
      (a.sku || "").localeCompare(b.sku || "", undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  if (!configured) return <SetupScreen />;
  if (!session)
    return (
      <div className={"login-wrap" + (showAlphaKb ? " login-with-kb" : "")}>
        <div className="login-card login-card-pin">
          <div className="brand-mark login-brand">
            {settings.logo_url ? (
              <img src={settings.logo_url} alt="" className="login-logo-img" />
            ) : (
              <Beer size={28} />
            )}
          </div>
          <h1>{settings.bar_name || "Sherehe POS"}</h1>
          {!isOnline && (
            <p className="tiny center-text" style={{ marginTop: -4, marginBottom: 8, color: "#f59e0b" }}>
              Offline — use an email and password already used on this device
            </p>
          )}
          {isOnline && loadOfflineCreds().length > 0 && (
            <p className="tiny muted center-text" style={{ marginTop: -4, marginBottom: 8 }}>
              Offline login ready on this device
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void signIn();
            }}
            className="stack"
          >
            <label>
              Email
              <input
                id="login-email-input"
                type="email"
                required
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  scheduleAutoLogin(e.target.value, password);
                }}
                onFocus={() => {
                  setKbTarget("loginEmail");
                  setKbMode("alnum");
                  setShowAlphaKb(true);
                }}
                onClick={() => {
                  setKbTarget("loginEmail");
                  setKbMode("alnum");
                  setShowAlphaKb(true);
                }}
                placeholder="you@email.com"
                className="login-pin-input"
                style={{ letterSpacing: "normal", textAlign: "left", fontSize: 16 }}
              />
            </label>
            <label>
              Password
              <div className="secret-field login-pin-field">
                <input
                  id="login-password-input"
                  type={showSecret ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    scheduleAutoLogin(email, e.target.value);
                  }}
                  onFocus={() => {
                    setKbTarget("loginPassword");
                    setKbMode("alnum");
                    setShowAlphaKb(true);
                  }}
                  onClick={() => {
                    setKbTarget("loginPassword");
                    setKbMode("alnum");
                    setShowAlphaKb(true);
                  }}
                  placeholder="Password"
                  className="login-pin-input"
                  style={{ letterSpacing: "normal", textAlign: "left", fontSize: 16 }}
                />
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <label
              className="remember-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexDirection: "row",
              }}
            >
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                style={{ width: 20, height: 20 }}
              />
              <span>Remember my email on this device</span>
            </label>
            {error && <p className="error">{error}</p>}
          </form>
        </div>
        {/* Sign in stays visible above the keyboard — not part of the OSK */}
        <div className="login-sign-bar">
          <button
            className="primary full login-sign-btn"
            disabled={loginBusy || !email.trim() || !password.trim()}
            type="button"
            onClick={() => void signIn()}
          >
            {loginBusy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {showAlphaKb && (kbTarget === "loginEmail" || kbTarget === "loginPassword") && (
          <div className="login-osk-dock login-osk-touch">
            <OnScreenKeyboard
              mode="alnum"
              value={
                kbTarget === "loginEmail"
                  ? email
                  : showSecret
                    ? password
                    : "•".repeat(password.length)
              }
              onKey={(ch) => {
                const c = String(ch || "");
                if (kbTarget === "loginEmail") {
                  setEmail((v) => {
                    const next = v + c;
                    scheduleAutoLogin(next, password);
                    return next;
                  });
                } else {
                  setPassword((v) => {
                    const next = v + c;
                    scheduleAutoLogin(email, next);
                    return next;
                  });
                }
              }}
              onBack={() => {
                if (kbTarget === "loginEmail") {
                  setEmail((v) => {
                    const next = v.slice(0, -1);
                    lastAutoLoginKeyRef.current = "";
                    return next;
                  });
                } else {
                  setPassword((v) => {
                    const next = v.slice(0, -1);
                    lastAutoLoginKeyRef.current = "";
                    return next;
                  });
                }
              }}
              onSpace={() => {
                if (kbTarget === "loginEmail") {
                  setEmail((v) => {
                    const next = v + " ";
                    scheduleAutoLogin(next, password);
                    return next;
                  });
                } else {
                  setPassword((v) => {
                    const next = v + " ";
                    scheduleAutoLogin(email, next);
                    return next;
                  });
                }
              }}
              onClose={() => {
                setShowAlphaKb(false);
                // Done on password field → try sign in immediately
                if (kbTarget === "loginPassword" && email.trim() && password.trim()) {
                  void signIn();
                }
              }}
            />
          </div>
        )}
      </div>
    );

  if (!profile)
    return (
      <div className="center">
        <RefreshCw className="spin" />
        <p>Loading your account…</p>
        {error && <p className="error">{error}</p>}
        <button className="secondary" onClick={loadProfile}>
          Retry
        </button>
      </div>
    );
  if (!profile.active)
    return (
      <div className="center">
        <h2>Account disabled</h2>
        <p>Ask your administrator to activate your account.</p>
        <button className="secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  const isAdmin = profile.role === "admin";
  const allNav = [
    { name: "Dashboard", icon: LayoutDashboard },
    { name: "Sell", icon: ShoppingCart },
    { name: "Receive Stock", icon: Plus },
    { name: "Inventory", icon: ClipboardList },
    { name: "Products", icon: Package },
    { name: "Credits", icon: CircleDollarSign },
    { name: "Suppliers", icon: Package },
    { name: "Expenses", icon: CircleDollarSign },
    { name: "Reports", icon: LayoutDashboard },
    { name: "Users", icon: Package },
    { name: "Activity Log", icon: ClipboardList },
    { name: "Backup & Settings", icon: RefreshCw },
  ];
  // Finer permissions: admin all tabs; others via allowed_tabs / role defaults
  const nav = allNav.filter((n) => canAccessTab(profile, n.name));
  return (
    <>
    <div className={"app-shell" + (mobileMenuOpen ? " menu-open" : "")}>
      {mobileMenuOpen && (
        <div
          className="mobile-backdrop"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      <aside className={"sidebar" + (mobileMenuOpen ? " open" : "")}>
        <div className="logo">
          {settings.logo_url ? (
            <img src={settings.logo_url} alt="" className="logo-img" />
          ) : (
            <span className="logo-icon">
              <Beer />
            </span>
          )}
          <span>
            <b>{settings.bar_name || "Sherehe POS"}</b>
            <small>Cloud workspace</small>
          </span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <div className="sidebar-nav-scroll">
          {nav.map((n) => (
            <button
              key={n.name}
              className={"nav-item " + (tab === n.name ? "active" : "")}
              onClick={() => {
                setTab(n.name);
                setMobileMenuOpen(false);
              }}
            >
              <n.icon size={18} />
              {n.name}
            </button>
          ))}
        </div>
        <div className="side-bottom">
          <div className="user-chip">
            <div className="avatar">
              {(profile.full_name || session.user.email || "U")
                .slice(0, 1)
                .toUpperCase()}
            </div>
            <div className="user-info">
              <b>{profile.full_name || session.user.email}</b>
              <small>{profile.role}</small>
            </div>
          </div>
          <button className="nav-item" onClick={signOut}>
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="menu-toggle"
              aria-label="Open menu"
              onClick={() => setMobileMenuOpen((v) => !v)}
            >
              ☰
            </button>
            <div>
              <div className="eyebrow">BAR MANAGEMENT</div>
              <h2>{tab}</h2>
            </div>
          </div>
          <div className="top-actions">
            {isAdmin && (
              <div className="notif-wrap">
                <button
                  type="button"
                  className="icon-btn notif-btn"
                  title="Notifications"
                  onClick={() => {
                    setShowNotifs((v) => !v);
                    if (!showNotifs) markNotificationsRead();
                  }}
                >
                  🔔
                  {adminNotifications.filter((n) => !n.read_at).length > 0 && (
                    <span className="notif-badge">
                      {adminNotifications.filter((n) => !n.read_at).length}
                    </span>
                  )}
                </button>
                {showNotifs && (
                  <div className="notif-panel">
                    <div className="notif-panel-head">
                      <b>Stock alerts</b>
                      <button type="button" className="text-btn" onClick={() => setShowNotifs(false)}>
                        Close
                      </button>
                    </div>
                    <div className="notif-list">
                      {adminNotifications.length === 0 && (
                        <p className="muted tiny" style={{ padding: 12 }}>No notifications yet</p>
                      )}
                      {adminNotifications.slice(0, 20).map((n) => (
                        <div
                          key={n.id}
                          className={"notif-item" + (n.read_at ? "" : " unread")}
                        >
                          <b>{n.title}</b>
                          <small>{n.body}</small>
                          <small className="muted">{dateLabel(n.created_at)}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div
              className="health-strip"
              title="Connection & sync health"
            >
              <span
                className={
                  "health-chip " +
                  (!isOnline
                    ? "health-off"
                    : syncConflicts
                      ? "health-warn"
                      : pendingSales.length + pendingStock.length
                        ? "health-pending"
                        : "health-ok")
                }
              >
                <span
                  className={
                    "dot " +
                    (!isOnline
                      ? "offline-dot"
                      : pendingSales.length + pendingStock.length
                        ? "pending-dot"
                        : "live-dot")
                  }
                />
                {!isOnline
                  ? "Offline"
                  : syncingQueue
                    ? "Syncing…"
                    : pendingSales.length + pendingStock.length
                      ? `Pending ${pendingSales.length + pendingStock.length}`
                      : "Live"}
              </span>
              {(pendingSales.length > 0 || pendingStock.length > 0) && (
                <span className="health-chip health-detail">
                  {pendingSales.length ? `${pendingSales.length} sales` : ""}
                  {pendingSales.length && pendingStock.length ? " · " : ""}
                  {pendingStock.length ? `${pendingStock.length} stock` : ""}
                </span>
              )}
              {syncConflicts > 0 && (
                <span className="health-chip health-warn">
                  {syncConflicts} conflict{syncConflicts > 1 ? "s" : ""}
                </span>
              )}
              {lastSyncAt && isOnline && (
                <span className="health-chip health-muted" title={lastSyncAt}>
                  Synced {new Date(lastSyncAt).toLocaleTimeString()}
                </span>
              )}
              {(pendingSales.length > 0 || pendingStock.length > 0) && isOnline && (
                <button
                  type="button"
                  className="health-sync-btn"
                  disabled={syncingQueue}
                  onClick={() => void processOfflineQueue()}
                >
                  Sync now
                </button>
              )}
            </div>
            <button
              className="icon-btn"
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              onClick={toggleDarkMode}
            >
              {darkMode ? "☀️" : "🌙"}
            </button>
            <button
              className="icon-btn"
              title="Refresh data"
              onClick={refreshAll}
            >
              <RefreshCw size={17} />
            </button>
            <span className="date-text">
              {new Date().toLocaleDateString("en-KE", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          </div>
        </header>
        {error && (
          <div className="alert error-alert">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && <div className="alert success-alert">✓ {notice}</div>}
        {tab === "Dashboard" && (
          <>

            {isAdmin && adminNotifications.filter((n) => !n.read_at).length > 0 && (
              <div className="alert info-alert" style={{ marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <b>
                    {adminNotifications.filter((n) => !n.read_at).length} new stock notification
                    {adminNotifications.filter((n) => !n.read_at).length > 1 ? "s" : ""}
                  </b>
                  <div className="tiny">
                    {adminNotifications
                      .filter((n) => !n.read_at)
                      .slice(0, 3)
                      .map((n) => n.title)
                      .join(" · ")}
                  </div>
                </div>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setShowNotifs(true);
                    markNotificationsRead();
                  }}
                >
                  View
                </button>
              </div>
            )}
            <div className="welcome-row">
              <div>
                <h3>
                  Good{" "}
                  {new Date().getHours() < 12
                    ? "morning"
                    : new Date().getHours() < 17
                      ? "afternoon"
                      : "evening"}
                  , {profile.full_name?.split(" ")[0] || "there"} 👋
                </h3>
                <p className="muted">
                  {isAdmin
                    ? "Full bar performance for today."
                    : "Your daily cashier summary."}
                </p>
              </div>
              <div className="row-actions">
                <button className="secondary" onClick={refreshAll}>
                  <RefreshCw size={16} /> Refresh
                </button>
                {isAdmin && (
                  <button
                    className="primary"
                    onClick={() => setShowExpense(true)}
                  >
                    <Plus size={16} /> Add expense
                  </button>
                )}
              </div>
            </div>
            <div className="stats-grid">
              <Stat
                title="Today's sales"
                value={money(todayTotal)}
                sub={`${todaySales.length} transactions`}
                icon={<CircleDollarSign />}
              />
              <Stat
                title="Credit sales today"
                value={money(todayCredit)}
                sub="Sold on credit"
                icon={<CircleDollarSign />}
              />
              {isAdmin && (
                <>
                  <Stat
                    title="Gross profit"
                    value={money(todayGross)}
                    sub="Sales less product costs"
                    icon={<LayoutDashboard />}
                  />
                  <Stat
                    title="Expenses"
                    value={money(todayExpenses)}
                    sub="Recorded today"
                    icon={<CircleDollarSign />}
                  />
                  <Stat
                    title="Net profit"
                    value={money(todayNet)}
                    sub="Gross profit less expenses"
                    icon={<CircleDollarSign />}
                  />
                  <Stat
                    title="Credit"
                    value={money(todayCredit)}
                    sub="Credit sales today"
                    icon={<CircleDollarSign />}
                  />
                  <Stat
                    title="Active products"
                    value={String(products.filter((p) => p.active).length)}
                    sub="Product catalogue"
                    icon={<Package />}
                  />
                </>
              )}
              <Stat
                title="Low stock alerts"
                value={String(lowStock.length)}
                sub="At or below minimum"
                icon={<AlertTriangle />}
                warning={lowStock.length > 0}
              />
            </div>

            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head">
                <div>
                  <h3>Payment mix today</h3>
                </div>
              </div>
              <div className="pay-mix-grid">
                {getPaymentMix().map((m) => {
                  const pct = todayTotal > 0 ? Math.round((m.total / todayTotal) * 100) : 0;
                  return (
                    <div className="pay-mix-card" key={m.method}>
                      <b>{m.method === "mpesa" ? "M-Pesa" : m.method.charAt(0).toUpperCase() + m.method.slice(1)}</b>
                      <div className="pay-mix-amt">{money(m.total)}</div>
                      <small className="muted">{m.count} sales · {pct}%</small>
                      <div className="pay-mix-bar">
                        <span style={{ width: pct + "%" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="content-grid">
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Items sold today</h3>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Qty sold</th>
                        <th>Sales value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.values(
                        todayItems.reduce((a: any, i) => {
                          a[i.product_name] ??= {
                            name: i.product_name,
                            qty: 0,
                            value: 0,
                          };
                          a[i.product_name].qty += Number(i.quantity);
                          a[i.product_name].value += Number(i.line_total);
                          return a;
                        }, {}),
                      ).map((i: any) => (
                        <tr key={i.name}>
                          <td>{i.name}</td>
                          <td>{i.qty}</td>
                          <td>{money(i.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {todayItems.length === 0 && (
                    <p className="muted empty">No items sold today.</p>
                  )}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Low-stock alerts</h3>
                  </div>
                  <button
                    className="text-btn"
                    onClick={() => setTab("Inventory")}
                  >
                    Manage →
                  </button>
                </div>
                {lowStock.length === 0 ? (
                  <div className="empty small-empty">
                    <Package size={28} />
                    <b>Stock looks good</b>
                    <span>No low-stock products right now.</span>
                  </div>
                ) : (
                  lowStock.map((p) => (
                    <div className="stock-row" key={p.id}>
                      <div className="product-symbol">
                        <Beer size={17} />
                      </div>
                      <div className="grow">
                        <b>{p.name}</b>
                        <small>{p.category}</small>
                      </div>
                      <span className="stock-badge">{p.stock_qty} left</span>
                    </div>
                  ))
                )}
              </section>
            </div>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>
                    {isAdmin ? "Today's sales (reprint)" : "My sales today"}
                  </h3>
                  <p className="muted tiny">
                    {todaySales.length} sales · {money(todayTotal)}
                    {!isAdmin ? " (your till only)" : ""}
                  </p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Time</th>
                      <th>Payment</th>
                      <th>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {todaySales.slice(0, 30).map((s) => (
                      <tr key={s.id}>
                        <td>{s.receipt_no}</td>
                        <td>{dateLabel(s.created_at)}</td>
                        <td>{s.payment_method}</td>
                        <td>{money(s.total)}</td>
                        <td>
                          <button
                            className="small-action"
                            onClick={() => reprintSale(s)}
                          >
                            <Printer size={14} /> Print
                          </button>
                          <button
                            className="small-action"
                            type="button"
                            onClick={async () => {
                              if (!supabase) return;
                              const { data } = await supabase
                                .from("sale_items")
                                .select("product_name,quantity,unit_price,line_total")
                                .eq("sale_id", s.id);
                              shareReceiptWhatsApp({
                                receipt_no: s.receipt_no,
                                total: s.total,
                                payment: s.payment_method,
                                creditor: s.creditor_name,
                                created_at: s.created_at,
                                items: (data || []).map((i: any) => ({
                                  product_name: i.product_name,
                                  quantity: i.quantity,
                                  unit_price: i.unit_price,
                                })),
                              });
                            }}
                          >
                            WhatsApp
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Credit collection reminders */}
            {isAdmin && (
              <section className="panel" style={{ marginTop: 16 }}>
                <div className="panel-head">
                  <div>
                    <h3>Credit collection</h3>
                  </div>
                  <button className="text-btn" onClick={() => setTab("Credits")}>
                    All credits →
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Creditor</th>
                        <th>Outstanding</th>
                        <th>Sales</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {getCreditorSummary()
                        .filter((c) => c.outstanding > 0)
                        .slice(0, 10)
                        .map((c) => (
                          <tr key={c.name}>
                            <td><b>{c.name}</b></td>
                            <td className="amount-cell">
                              <b className="status-warn">{money(c.outstanding)}</b>
                            </td>
                            <td>{c.sales.length}</td>
                            <td>
                              <button
                                className="small-action"
                                onClick={() => {
                                  setCreditPayModal({ name: c.name, outstanding: c.outstanding });
                                  setCreditPayForm({ amount: String(c.outstanding), method: "cash", note: "" });
                                }}
                              >
                                Pay
                              </button>
                            </td>
                          </tr>
                        ))}
                      {getCreditorSummary().filter((c) => c.outstanding > 0).length === 0 && (
                        <tr>
                          <td colSpan={4} className="muted center-text">No outstanding credit</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Low-stock auto-order */}
            {isAdmin && lowStock.length > 0 && (
              <section className="panel" style={{ marginTop: 16 }}>
                <div className="panel-head">
                  <div>
                    <h3>Low-stock order list</h3>
                  </div>
                  <div className="row-actions">
                    <button className="secondary" onClick={copyLowStockWhatsApp}>
                      Copy for WhatsApp
                    </button>
                    <button className="primary" onClick={printLowStockOrder}>
                      <Printer size={16} /> Print order list
                    </button>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
        {tab === "Sell" && (
          <div className="sell-layout">
            <section className="sell-products">
              <div className="section-title">
                <div>
                  <h3>Sell</h3>
                </div>
                <span className="count-pill">{filtered.length}</span>
              </div>
              {lowStock.length > 0 && (
                <div className="alert" style={{ marginBottom: 10, borderColor: "#f59e0b" }}>
                  <AlertTriangle size={16} />{" "}
                  <b>{lowStock.length} low / out of stock</b>
                  <span className="tiny" style={{ marginLeft: 8 }}>
                    {lowStock
                      .slice(0, 4)
                      .map((p) => `${p.name} (${p.stock_qty})`)
                      .join(" · ")}
                    {lowStock.length > 4 ? "…" : ""}
                  </span>
                </div>
              )}
              <div className="searchbox">
                <Search size={18} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search drinks…"
                />
              </div>
              {favorites.length > 0 && (
                <div className="sell-category" style={{ marginBottom: 8 }}>
                  <h4>Favorites</h4>
                  <div className="product-grid sell-grid">
                    {favorites
                      .map((id) => products.find((p) => p.id === id && p.active))
                      .filter(Boolean)
                      .map((p: any) => (
                        <button
                          key={"fav-" + p.id}
                          type="button"
                          className={
                            "product-card sell-card" +
                            (p.stock_qty <= 0
                              ? " out-of-stock"
                              : p.stock_qty <= p.min_stock
                                ? " low-stock-card"
                                : "")
                          }
                          onClick={() => addCart(p)}
                          disabled={settings?.block_sale_when_out !== false && p.stock_qty <= 0}
                        >
                          <span className="stock-badge-corner">{p.stock_qty}</span>
                          <div className="card-meta">
                            <b className="card-name">{p.name}</b>
                            <strong className="card-price">{money(p.sell_price)}</strong>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              )}
              <div className="category-strip">
                <button
                  type="button"
                  className={"category-pill big-pill" + (categoryFilter === "All" ? " selected" : "")}
                  onClick={() => setCategoryFilter("All")}
                >
                  All
                </button>
                {orderedCategories(products.filter((p) => p.active)).map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={
                      "category-pill big-pill" +
                      (categoryFilter.toLowerCase() === c.toLowerCase() ? " selected" : "")
                    }
                    onClick={() => setCategoryFilter(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
              {(() => {
                const cats =
                  categoryFilter === "All"
                    ? orderedCategories(filtered)
                    : orderedCategories(filtered).filter(
                        (c) => c.toLowerCase() === categoryFilter.toLowerCase(),
                      );
                const seen = new Set<string>();
                return cats.map((category) => {
                  const items = filtered
                    .filter(
                      (p) =>
                        p.category.toLowerCase() === category.toLowerCase() &&
                        !seen.has(p.id),
                    )
                    .sort((a, b) =>
                      (a.sku || "").localeCompare(b.sku || "", undefined, {
                        numeric: true,
                        sensitivity: "base",
                      }),
                    );
                  items.forEach((p) => seen.add(p.id));
                  if (!items.length) return null;
                  return (
                    <div className="sell-category" key={category}>
                      <h4>{category}</h4>
                      <div className="product-grid sell-grid">
                        {items.map((p) => (
                          <div key={p.id} className="product-card-wrap" style={{ position: "relative" }}>
                            <button
                              type="button"
                              className="small-action"
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                zIndex: 2,
                                padding: "2px 6px",
                                fontSize: 12,
                              }}
                              title={favorites.includes(p.id) ? "Unpin favorite" : "Pin favorite"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFavorite(p.id);
                              }}
                            >
                              {favorites.includes(p.id) ? "★" : "☆"}
                            </button>
                            <button
                              className={
                                "product-card sell-card" +
                                (p.stock_qty <= 0
                                  ? " out-of-stock"
                                  : p.stock_qty <= p.min_stock
                                    ? " low-stock-card"
                                    : "")
                              }
                              onClick={() => addCart(p)}
                              disabled={
                                settings?.block_sale_when_out !== false && p.stock_qty <= 0
                              }
                            >
                              <span
                                className={
                                  "stock-badge-corner" +
                                  (p.stock_qty <= 0
                                    ? " stock-out"
                                    : p.stock_qty <= p.min_stock
                                      ? " stock-low"
                                      : " stock-ok")
                                }
                              >
                                {p.stock_qty}
                              </span>
                              <div className="card-image-wrap">
                                {p.image_url ? (
                                  <img src={p.image_url} alt={p.name} />
                                ) : (
                                  <span className="drink-icon">
                                    <Beer size={28} />
                                  </span>
                                )}
                              </div>
                              <div className="card-meta">
                                <b className="card-name">{p.name}</b>
                                <strong className="card-price">{money(p.sell_price)}</strong>
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
              {filtered.length === 0 && (
                <div className="empty">
                  <Package size={35} />
                  <b>No products found</b>
                </div>
              )}
            </section>
            <section className="cart-panel cart-panel-v2">
              <div className="cart-head">
                <div className="cart-head-title">
                  <h3>Order</h3>
                  <span className="cart-count-badge">
                    {cart.reduce((n, x) => n + x.qty, 0)}
                  </span>
                </div>
                {cart.length > 0 && (
                  <button
                    className="cart-clear-btn"
                    onClick={() => setCart([])}
                    title="Clear order"
                    type="button"
                  >
                    Clear
                  </button>
                )}
              </div>
              {heldSales.length > 0 && (
                <div className="held-sales-bar">
                  <span className="held-label">Held</span>
                  {heldSales.map((h, i) => (
                    <button
                      className="held-chip"
                      key={i}
                      type="button"
                      onClick={() => {
                        setCart(h);
                        setHeldSales((old) => old.filter((_, j) => j !== i));
                      }}
                    >
                      #{i + 1}{" "}
                      {money(
                        h.reduce((n, x) => n + x.qty * x.product.sell_price, 0),
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="cart-lines">
                {cart.map((x) => (
                  <div className="cart-line cart-line-v2" key={x.product.id}>
                    <div className="cart-line-main">
                      <div className="cart-line-info">
                        <b className="cart-item-name">{x.product.name}</b>
                        <span className="cart-item-unit">
                          {money(x.product.sell_price)} each
                        </span>
                      </div>
                      <b className="line-total">
                        {money(x.qty * x.product.sell_price)}
                      </b>
                    </div>
                    <div className="cart-line-actions">
                      <div className="qty-control qty-control-lg">
                        <button
                          type="button"
                          className="qty-btn"
                          aria-label="Decrease"
                          onClick={() => changeQty(x.product.id, -1)}
                        >
                          −
                        </button>
                        <span className="qty-val">{x.qty}</span>
                        <button
                          type="button"
                          className="qty-btn"
                          aria-label="Increase"
                          onClick={() => changeQty(x.product.id, 1)}
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        className="cart-remove-btn"
                        title="Remove item"
                        aria-label="Remove"
                        onClick={() =>
                          setCart((old) =>
                            old.filter((l) => l.product.id !== x.product.id),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {!cart.length && (
                  <div className="empty cart-empty">
                    <div className="cart-empty-icon">
                      <ShoppingCart size={32} />
                    </div>
                    <b>No items yet</b>
                    <span>Tap a drink to add it to this order</span>
                  </div>
                )}
              </div>
              <div className="cart-footer cart-footer-v2">
                <div className="cart-total-block">
                  <span className="cart-total-label">Total due</span>
                  <b className="cart-total-amount">{money(total)}</b>
                </div>
                <div className="field-label cart-pay-label">Pay with</div>
                <div className="pay-methods pay-methods-v2">
                  {(["cash", "mpesa", "card", "credit"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={
                        "pay-btn pay-btn-v2" + (payment === m ? " active" : "")
                      }
                      disabled={!cart.length || busy}
                      onClick={() => {
                        setPayment(m);
                        if (m === "credit") {
                          setShowCreditorModal(true);
                          openKb("creditor", "alpha");
                        } else {
                          checkout(m);
                        }
                      }}
                    >
                      {m === "mpesa"
                        ? "M-Pesa"
                        : m.charAt(0).toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="sell-actions-row">
                  <button
                    className="secondary hold-btn"
                    type="button"
                    disabled={!cart.length}
                    onClick={() => {
                      setHeldSales((old) => [...old, cart]);
                      setCart([]);
                      flash("Sale held — tap Held chip above to resume");
                    }}
                  >
                    Hold sale
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
        {tab === "Receive Stock" && (
          <>
            <div className="page-tools">
              <div>
                <h3>Receive stock</h3>
              </div>
              <div className="row-actions">
                <button
                  className={batchMode ? "primary" : "secondary"}
                  onClick={() => {
                    setBatchMode((v) => !v);
                    if (batchMode) setBatchItems([]);
                  }}
                >
                  {batchMode ? "Batch mode ON" : "Batch receive"}
                </button>
                {batchMode && batchItems.length > 0 && (
                  <button className="primary" onClick={() => setShowBatchReceive(true)}>
                    Review batch ({batchItems.length})
                  </button>
                )}
              </div>
            </div>
            {batchMode && (
              <div className="alert info-alert" style={{ marginBottom: 12 }}>
                Batch mode: tap products to add them to one supplier invoice, then Review batch.
              </div>
            )}
            {(() => {
              const seen = new Set<string>();
              return orderedCategories(products.filter((p) => p.active)).map((category) => {
                const rows = products
                  .filter(
                    (p) =>
                      p.active &&
                      p.category.toLowerCase() === category.toLowerCase() &&
                      !seen.has(p.id),
                  )
                  .sort((a, b) =>
                    (a.sku || "").localeCompare(b.sku || "", undefined, {
                      numeric: true,
                      sensitivity: "base",
                    }),
                  );
                rows.forEach((p) => seen.add(p.id));
                return rows.length ? (
                  <section className="sell-category" key={category}>
                    <h4>{category}</h4>
                    <div className="product-grid receive-grid">
                      {rows.map((p) => (
                        <button
                          className="product-card stock-card"
                          key={p.id}
                          onClick={() => {
                            if (batchMode) {
                              setBatchItems((old) => {
                                if (old.some((x) => x.product_id === p.id)) return old;
                                return [
                                  ...old,
                                  {
                                    product_id: p.id,
                                    name: p.name,
                                    qty: "1",
                                    total_cost: "",
                                  },
                                ];
                              });
                              flash(`${p.name} added to batch`);
                              return;
                            }
                            setReceiveProduct(p.id);
                            setReceiveQty("");
                            setReceiveTotalCost("");
                            setReceiveSupplier("");
                            setReceiveReceiptNo("");
                            setShowReceive(true);
                          }}
                        >
                          <div className="card-image-wrap">
                            {p.image_url ? (
                              <img src={p.image_url} alt={p.name} />
                            ) : (
                              <span className="drink-icon">
                                <Beer size={28} />
                              </span>
                            )}
                          </div>
                          <div className="card-meta">
                            <b className="card-name">{p.name}</b>
                            <span
                              className={
                                "stock-num" +
                                (p.stock_qty <= p.min_stock ? " stock-low" : " stock-ok")
                              }
                            >
                              {p.stock_qty}
                            </span>
                          </div>
                          <strong className="card-action">Receive</strong>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null;
              });
            })()}
          </>
        )}
        {tab === "Inventory" && (
          <>
            <div className="page-tools">
              <div>
                <h3>Inventory audit</h3>
              </div>
              <div className="row-actions">
                <select
                  value={varianceRange}
                  onChange={(e) =>
                    setVarianceRange(e.target.value as "7" | "30" | "90" | "all")
                  }
                >
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="all">All time</option>
                </select>
                <button className="secondary" onClick={exportVarianceReport}>
                  <Download size={16} /> Export variance
                </button>
              </div>
            </div>
            {(() => {
              const rows = getStocktakeVarianceRows();
              const byCat = getVarianceByCategory();
              const net = rows.reduce((n, r) => n + r.variance, 0);
              const over = rows.filter((r) => r.variance > 0).reduce((n, r) => n + r.variance, 0);
              const under = rows.filter((r) => r.variance < 0).reduce((n, r) => n + Math.abs(r.variance), 0);
              return (
                <section className="panel" style={{ marginBottom: 16 }}>
                  <div className="panel-head">
                    <div>
                      <h3>Stocktake variance report</h3>
                    </div>
                  </div>
                  <div className="stats-grid" style={{ marginBottom: 12 }}>
                    <Stat title="Audits" value={String(rows.length)} sub="Adjustments in range" icon={<ClipboardList />} />
                    <Stat title="Over" value={`+${over}`} sub="Units above system" icon={<Plus />} />
                    <Stat title="Under" value={`-${under}`} sub="Units below system" icon={<AlertTriangle />} warning />
                    <Stat title="Net variance" value={`${net >= 0 ? "+" : ""}${net}`} sub="Counted − expected" icon={<Package />} />
                  </div>
                  <h4 style={{ margin: "8px 0" }}>By category</h4>
                  <div className="table-scroll" style={{ marginBottom: 16 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Category</th>
                          <th>Lines</th>
                          <th>Over</th>
                          <th>Under</th>
                          <th>Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byCat.map((c) => (
                          <tr key={c.category}>
                            <td><b>{c.category}</b></td>
                            <td>{c.lines}</td>
                            <td className="status-ok">+{c.over}</td>
                            <td className="status-warn">-{c.under}</td>
                            <td><b>{c.net >= 0 ? `+${c.net}` : c.net}</b></td>
                          </tr>
                        ))}
                        {byCat.length === 0 && (
                          <tr>
                            <td colSpan={5} className="muted center-text">
                              No stocktake adjustments in this period. Complete audits below to build the report.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <h4 style={{ margin: "8px 0" }}>Adjustment detail</h4>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Category</th>
                          <th>Product</th>
                          <th>Expected</th>
                          <th>Counted</th>
                          <th>Variance</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 100).map((r) => (
                          <tr key={r.id}>
                            <td>{dateLabel(r.created_at)}</td>
                            <td>{r.category}</td>
                            <td><b>{r.name}</b></td>
                            <td>{r.expected}</td>
                            <td>{r.counted}</td>
                            <td className={r.variance < 0 ? "status-warn" : r.variance > 0 ? "status-ok" : ""}>
                              <b>{r.variance >= 0 ? `+${r.variance}` : r.variance}</b>
                            </td>
                            <td><small>{r.note}</small></td>
                          </tr>
                        ))}
                        {rows.length === 0 && (
                          <tr>
                            <td colSpan={7} className="muted center-text">No adjustments yet</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })()}
            {(() => {
              const seen = new Set<string>();
              return orderedCategories(products.filter((p) => p.active)).map((category) => {
                const rows = products
                  .filter(
                    (p) =>
                      p.active &&
                      p.category.toLowerCase() === category.toLowerCase() &&
                      !seen.has(p.id),
                  )
                  .sort((a, b) =>
                    (a.sku || "").localeCompare(b.sku || "", undefined, {
                      numeric: true,
                      sensitivity: "base",
                    }),
                  );
                rows.forEach((p) => seen.add(p.id));
                return rows.length ? (
                  <section className="sell-category" key={category}>
                    <h4>{category}</h4>
                    <div className="product-grid receive-grid">
                      {rows.map((p) => (
                        <button
                          className="product-card stock-card"
                          key={p.id}
                          onClick={() => {
                            setShowAudit(p);
                            setAuditQty(String(p.stock_qty));
                            setAuditReason("Stock count correction");
                          }}
                        >
                          <div className="card-image-wrap">
                            {p.image_url ? (
                              <img src={p.image_url} alt={p.name} />
                            ) : (
                              <span className="drink-icon">
                                <ClipboardList size={28} />
                              </span>
                            )}
                          </div>
                          <div className="card-meta">
                            <b className="card-name">{p.name}</b>
                            <span
                              className={
                                "stock-num" +
                                (p.stock_qty <= p.min_stock ? " stock-low" : " stock-ok")
                              }
                            >
                              {p.stock_qty}
                            </span>
                          </div>
                          <strong className="card-action">Audit</strong>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null;
              });
            })()}
          </>
        )}
        {tab === "Products" && (
          <>
            <div className="page-tools">
              <div>
                <h3>Product catalogue</h3>
              </div>
              {isAdmin && (
                <div className="row-actions">
                  <button className="secondary" onClick={exportProducts}>
                    <Download size={16} /> Export XLSX
                  </button>
                  <label
                    className="secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                    }}
                  >
                    <Upload size={16} /> Import XLSX
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      style={{ display: "none" }}
                      onChange={importProducts}
                    />
                  </label>
                  <button className="primary" onClick={openNewProduct}>
                    <Plus size={17} /> Add product
                  </button>
                  <button
                    className="secondary"
                    style={{ color: "#b91c1c" }}
                    onClick={() =>
                      requestPin("delete all products", () => {
                        if (confirm("Permanently delete ALL products?")) deleteAllProducts();
                      })
                    }
                  >
                    Delete all
                  </button>
                </div>
              )}
            </div>
            <div className="panel table-panel">
              <ProductsTable
                products={products}
                admin={isAdmin}
                onEdit={openEditProduct}
                onToggleActive={toggleProductActive}
              />
            </div>
          </>
        )}
        {tab === "Stock" && (
          <>
            <div className="page-tools">
              <div>
                <h3>Stock control</h3>
                <p className="muted">
                  Receive deliveries and monitor quantities.
                </p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setReceiveProduct(products.find((p) => p.active)?.id || "");
                  setShowReceive(true);
                }}
              >
                <Plus size={17} /> Receive stock
              </button>
            </div>
            <div className="stats-grid compact-stats">
              <Stat
                title="Active SKUs"
                value={String(products.filter((p) => p.active).length)}
                icon={<Package />}
              />
              <Stat
                title="Low stock"
                value={String(lowStock.length)}
                icon={<AlertTriangle />}
                warning={lowStock.length > 0}
              />
              <Stat
                title="Out of stock"
                value={String(
                  products.filter((p) => p.active && p.stock_qty === 0).length,
                )}
                icon={<X />}
              />
            </div>
            <div className="panel table-panel">
              <ProductsTable
                products={products}
                admin={isAdmin}
                onEdit={openEditProduct}
                onToggleActive={toggleProductActive}
              />
            </div>
          </>
        )}
        {tab === "Credits" && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Creditors</h3>
              </div>
              <button className="secondary" onClick={refreshAll}>
                Refresh
              </button>
            </div>
            {(() => {
              const aging = getCreditAging();
              return (
                <div className="stats-grid" style={{ marginBottom: 16 }}>
                  <Stat title="0–7 days" value={money(aging.d07)} sub="Recent credit" icon={<CircleDollarSign />} />
                  <Stat title="8–14 days" value={money(aging.d814)} sub="Follow up" icon={<AlertTriangle />} />
                  <Stat title="15+ days" value={money(aging.d15)} sub="Overdue" icon={<AlertTriangle />} warning />
                </div>
              );
            })()}
            {selectedCreditor ? (
              <div>
                <button className="secondary" style={{ marginBottom: 12 }} onClick={() => setSelectedCreditor(null)}>
                  ← Back to list
                </button>
                <h3 style={{ marginBottom: 8 }}>{selectedCreditor}</h3>
                {(() => {
                  const c = getCreditorSummary().find((x) => x.name === selectedCreditor);
                  if (!c) return <p>No data</p>;
                  return (
                    <>
                      <div className="stats-grid" style={{ marginBottom: 16 }}>
                        <Stat title="Total credit given" value={money(c.salesTotal)} sub={`${c.sales.length} sales`} icon={<CircleDollarSign />} />
                        <Stat title="Total paid" value={money(c.paidTotal)} sub={`${c.payments.length} payments`} icon={<CircleDollarSign />} />
                        <Stat title="Outstanding" value={money(c.outstanding)} sub={c.outstanding <= 0 ? "Fully settled" : "Balance due"} icon={<AlertTriangle />} />
                      </div>
                      {c.outstanding > 0 && (
                        <button
                          className="primary"
                          style={{ marginBottom: 16 }}
                          onClick={() => {
                            setCreditPayModal({ name: c.name, outstanding: c.outstanding });
                            setCreditPayForm({ amount: String(c.outstanding), method: "cash", note: "" });
                          }}
                        >
                          Record payment
                        </button>
                      )}
                      <h4>Credit sales</h4>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Receipt</th>
                              <th>Date</th>
                              <th>Amount</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {c.sales.map((s) => (
                              <tr key={s.id}>
                                <td>{s.receipt_no}</td>
                                <td>{dateLabel(s.created_at)}</td>
                                <td className="amount-cell">{money(s.total)}</td>
                                <td>
                                  <button className="small-action" onClick={() => reprintSale(s)}>
                                    <Printer size={14} /> Reprint
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <h4 style={{ marginTop: 20 }}>Payments</h4>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Receipt</th>
                              <th>Date</th>
                              <th>Method</th>
                              <th>Amount</th>
                              <th>Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {c.payments.length === 0 && (
                              <tr>
                                <td colSpan={5} className="muted">No payments yet</td>
                              </tr>
                            )}
                            {c.payments.map((p) => (
                              <tr key={p.id}>
                                <td>{p.receipt_no}</td>
                                <td>{dateLabel(p.created_at)}</td>
                                <td>{(p.payment_method || "").toUpperCase()}</td>
                                <td className="amount-cell">{money(p.amount)}</td>
                                <td>{p.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Creditor</th>
                      <th>Sales</th>
                      <th>Total credit</th>
                      <th>Paid</th>
                      <th>Outstanding</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {getCreditorSummary()
                      .filter((c) => isAdmin || c.outstanding > 0)
                      .map((c) => (
                        <tr key={c.name}>
                          <td>
                            <b>{c.name}</b>
                          </td>
                          <td>{c.sales.length}</td>
                          <td>{money(c.salesTotal)}</td>
                          <td>{money(c.paidTotal)}</td>
                          <td>
                            <b className={c.outstanding > 0 ? "status-warn" : "status-ok"}>
                              {money(c.outstanding)}
                            </b>
                            {c.outstanding > 0 && (
                              <small className="muted">
                                {c.bucket === "15+"
                                  ? `${c.ageDays}d overdue`
                                  : `${c.ageDays}d · ${c.bucket}`}
                              </small>
                            )}
                          </td>
                          <td className="row-actions">
                            <button
                              className="touch-action"
                              onClick={() => setSelectedCreditor(c.name)}
                            >
                              View history
                            </button>
                            {c.outstanding > 0 && (
                              <button
                                className="touch-action primary-touch"
                                onClick={() => {
                                  setCreditPayModal({ name: c.name, outstanding: c.outstanding });
                                  setCreditPayForm({ amount: String(c.outstanding), method: "cash", note: "" });
                                }}
                              >
                                Pay
                              </button>
                            )}
                            {isAdmin && c.outstanding <= 0 && (
                              <button
                                className="small-action"
                                onClick={async () => {
                                  if (!confirm(`Remove fully settled creditor "${c.name}" from view?`)) return;
                                  // Soft: just leave in history; for hard delete of payments we could, but keep for audit
                                  flash("Fully settled creditors stay in admin history for audit");
                                }}
                              >
                                Archive
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    {getCreditorSummary().filter((c) => isAdmin || c.outstanding > 0).length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted center-text">
                          No credit records yet. Credit sales appear here after checkout.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {tab === "Suppliers" && isAdmin && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Suppliers ledger</h3>
                <p className="muted">
                  Suppliers from stock receipts. Add named suppliers and track purchase totals.
                </p>
              </div>
              <button className="primary" onClick={() => setShowSupplier(true)}>
                <Plus size={16} /> Add supplier
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Deliveries</th>
                    <th>Total purchased</th>
                    <th>Last delivery</th>
                    <th>Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {getSupplierLedger().map((s) => {
                    const meta = suppliers.find((x) => x.name === s.name);
                    return (
                      <tr key={s.name}>
                        <td><b>{s.name}</b></td>
                        <td>{s.count}</td>
                        <td className="amount-cell">{money(s.total)}</td>
                        <td>{s.last ? dateLabel(s.last) : "—"}</td>
                        <td>{meta?.phone || "—"}</td>
                      </tr>
                    );
                  })}
                  {getSupplierLedger().length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted center-text">
                        No supplier data yet. Receive stock with a supplier name, or add one here.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="tiny muted" style={{ marginTop: 12 }}>
              When receiving stock, enter the supplier name — it appears in this ledger with total purchase value.
            </p>
          </section>
        )}
        {tab === "Suppliers" && !isAdmin && (
          <section className="panel">
            <h3>Suppliers</h3>
          </section>
        )}
        {tab === "Expenses" && (
          <>
            <div className="page-tools">
              <div>
                <h3>Expenses</h3>
              </div>
              <button
                className="primary"
                onClick={() => setShowExpense(true)}
              >
                <Plus size={16} /> Add expense
              </button>
            </div>
            <div className="panel table-panel">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((x) => (
                      <tr key={x.id}>
                        <td>{dateLabel(x.created_at)}</td>
                        <td>{x.description}</td>
                        <td>{money(Number(x.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
        {tab === "Reports" && isAdmin && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Reports & insights</h3>
              </div>
              <div className="row-actions">
                <div className="pay-methods" style={{ margin: 0 }}>
                  {(["daily", "weekly", "monthly"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={"pay-btn" + (reportRange === r ? " active" : "")}
                      onClick={() => setReportRange(r)}
                    >
                      {r.charAt(0).toUpperCase() + r.slice(1)}
                    </button>
                  ))}
                </div>
                <button
                  className="secondary"
                  onClick={() => {
                    const rows = [
                      ["Receipt", "Date", "Payment", "Creditor", "Sales", "Cost", "Gross profit"],
                      ...sales.map((s) => [
                        s.receipt_no,
                        s.created_at,
                        s.payment_method,
                        s.creditor_name || "",
                        s.total,
                        s.cost_total,
                        Number(s.total) - Number(s.cost_total),
                      ]),
                    ];
                    const csv = rows
                      .map((r) =>
                        r.map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"').join(","),
                      )
                      .join("\n");
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                    a.download = `bar-pos-report-${reportRange}.csv`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  Export CSV
                </button>
              </div>
            </div>
            <div className="stats-grid">
              <Stat title="Sales" value={money(sales.reduce((n, x) => n + Number(x.total), 0))} icon={<CircleDollarSign />} />
              <Stat title="Gross profit" value={money(sales.reduce((n, x) => n + Number(x.total) - Number(x.cost_total), 0))} icon={<CircleDollarSign />} />
              <Stat title="Expenses" value={money(expenses.reduce((n, x) => n + Number(x.amount), 0))} icon={<CircleDollarSign />} />
              <Stat title="Net profit" value={money(sales.reduce((n, x) => n + Number(x.total) - Number(x.cost_total), 0) - expenses.reduce((n, x) => n + Number(x.amount), 0))} icon={<LayoutDashboard />} />
            </div>

            <div className="panel table-panel" style={{ marginTop: 16 }}>
              <h4>Gross profit by category</h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Qty sold</th>
                      <th>Revenue</th>
                      <th>Cost</th>
                      <th>Gross profit</th>
                      <th>Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const map: Record<
                        string,
                        { qty: number; revenue: number; cost: number }
                      > = {};
                      soldItems.forEach((si) => {
                        const sale = sales.find((s) => s.id === si.sale_id);
                        if (!sale) return;
                        const prod = products.find((p) => p.name === si.product_name);
                        const cat = prod?.category || "Other";
                        if (!map[cat]) map[cat] = { qty: 0, revenue: 0, cost: 0 };
                        map[cat].qty += Number(si.quantity);
                        map[cat].revenue += Number(si.line_total);
                        const unitCost = prod ? Number(prod.cost_price) : 0;
                        map[cat].cost += unitCost * Number(si.quantity);
                      });
                      return Object.entries(map)
                        .sort((a, b) => b[1].revenue - a[1].revenue)
                        .map(([cat, v]) => {
                          const gp = v.revenue - v.cost;
                          const margin = v.revenue > 0 ? (gp / v.revenue) * 100 : 0;
                          return (
                            <tr key={cat}>
                              <td><b>{cat}</b></td>
                              <td>{v.qty}</td>
                              <td>{money(v.revenue)}</td>
                              <td>{money(v.cost)}</td>
                              <td>{money(gp)}</td>
                              <td>{margin.toFixed(1)}%</td>
                            </tr>
                          );
                        });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel table-panel" style={{ marginTop: 16 }}>
              <h4>Gross profit by product (top 20)</h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Qty</th>
                      <th>Revenue</th>
                      <th>Est. cost</th>
                      <th>Gross profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const map: Record<
                        string,
                        { qty: number; revenue: number; cost: number }
                      > = {};
                      soldItems.forEach((si) => {
                        if (!sales.find((s) => s.id === si.sale_id)) return;
                        const name = si.product_name;
                        const prod = products.find((p) => p.name === name);
                        if (!map[name]) map[name] = { qty: 0, revenue: 0, cost: 0 };
                        map[name].qty += Number(si.quantity);
                        map[name].revenue += Number(si.line_total);
                        map[name].cost += Number(prod?.cost_price || 0) * Number(si.quantity);
                      });
                      return Object.entries(map)
                        .sort((a, b) => b[1].revenue - a[1].revenue)
                        .slice(0, 20)
                        .map(([name, v]) => (
                          <tr key={name}>
                            <td><b>{name}</b></td>
                            <td>{v.qty}</td>
                            <td>{money(v.revenue)}</td>
                            <td>{money(v.cost)}</td>
                            <td>{money(v.revenue - v.cost)}</td>
                          </tr>
                        ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="charts-row">
              <div className="chart-card">
                <h4>Profit — last 7 days</h4>
                {(() => {
                  const bars = getWeeklyProfitBars();
                  const max = Math.max(...bars.map((b) => Math.abs(b.profit)), 1);
                  const h = 140;
                  const w = 320;
                  const gap = 8;
                  const bw = (w - gap * (bars.length + 1)) / bars.length;
                  return (
                    <svg viewBox={`0 0 ${w} ${h + 30}`} width="100%" height="180" className="bar-chart">
                      {bars.map((b, i) => {
                        const bh = (Math.abs(b.profit) / max) * (h - 20);
                        const x = gap + i * (bw + gap);
                        const y = b.profit >= 0 ? h - bh : h;
                        return (
                          <g key={i}>
                            <rect
                              x={x}
                              y={Math.min(y, h - 2)}
                              width={bw}
                              height={Math.max(bh, 2)}
                              rx="4"
                              fill={b.profit >= 0 ? "#f59e0b" : "#ef4444"}
                            />
                            <text x={x + bw / 2} y={h + 14} textAnchor="middle" fontSize="9" fill="currentColor">
                              {b.label}
                            </text>
                            <title>{`${b.label}: ${money(b.profit)} profit · ${money(b.sales)} sales`}</title>
                          </g>
                        );
                      })}
                      <line x1="0" y1={h} x2={w} y2={h} stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" />
                    </svg>
                  );
                })()}
              </div>

              <div className="chart-card">
                <h4>Best selling items</h4>
                {(() => {
                  const best = getBestSellers(8);
                  const max = Math.max(...best.map((b) => b.qty), 1);
                  if (!best.length) return <p className="muted">No sales data yet</p>;
                  return (
                    <div className="hbar-list">
                      {best.map((b) => (
                        <div className="hbar-row" key={b.name}>
                          <div className="hbar-label">
                            <b>{b.name}</b>
                            <small>{b.category} · {money(b.revenue)}</small>
                          </div>
                          <div className="hbar-track">
                            <div className="hbar-fill" style={{ width: `${(b.qty / max) * 100}%` }} />
                          </div>
                          <span className="hbar-val">{b.qty}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="charts-row" style={{ marginTop: 16 }}>
              <div className="chart-card">
                <h4>Worst selling (lowest qty)</h4>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Product</th><th>Category</th><th>Qty sold</th></tr></thead>
                    <tbody>
                      {getWorstSellers(6).map((w) => (
                        <tr key={w.name}>
                          <td>{w.name}</td>
                          <td>{w.category}</td>
                          <td>{w.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="chart-card">
                <h4>Top by category</h4>
                {getBestByCategory().map((c) => (
                  <div key={c.category} style={{ marginBottom: 12 }}>
                    <b style={{ fontSize: 13 }}>{c.category}</b>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {c.top.map((t) => (
                        <li key={t.name}>{t.name} — {t.qty} sold ({money(t.revenue)})</li>
                      ))}
                    </ul>
                  </div>
                ))}
                {getBestByCategory().length === 0 && <p className="muted">No data yet</p>}
              </div>
            </div>

            <div className="charts-row" style={{ marginTop: 16 }}>
              <div className="chart-card">
                <h4>Sales by day of week</h4>
                {(() => {
                  const days = getDayOfWeekStats();
                  const max = Math.max(...days.map((d) => d.sales), 1);
                  return (
                    <div className="hbar-list">
                      {days.map((d) => (
                        <div className="hbar-row" key={d.label}>
                          <div className="hbar-label"><b>{d.label}</b><small>{d.count} sales</small></div>
                          <div className="hbar-track">
                            <div className="hbar-fill" style={{ width: `${(d.sales / max) * 100}%` }} />
                          </div>
                          <span className="hbar-val">{money(d.sales)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <div className="chart-card">
                <h4>Hourly sales heatmap</h4>
                <div className="heatmap">
                  {getHourlyStats().map((h) => {
                    const max = Math.max(...getHourlyStats().map((x) => x.sales), 1);
                    const intensity = h.sales / max;
                    return (
                      <div
                        key={h.hour}
                        className="heat-cell"
                        title={`${h.hour}:00 — ${money(h.sales)} (${h.count} sales)`}
                        style={{
                          background: h.sales === 0
                            ? "var(--heat-empty, #f1f5f9)"
                            : `rgba(245, 158, 11, ${0.15 + intensity * 0.85})`,
                        }}
                      >
                        <span className="heat-hour">{h.hour}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="charts-row" style={{ marginTop: 16 }}>
              <div className="chart-card">
                <h4>Cashier performance</h4>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr><th>Cashier</th><th>Transactions</th><th>Total sales</th></tr>
                    </thead>
                    <tbody>
                      {getCashierPerformance().map((c) => (
                        <tr key={c.name}>
                          <td><b>{c.name}</b></td>
                          <td>{c.count}</td>
                          <td className="amount-cell">{money(c.sales)}</td>
                        </tr>
                      ))}
                      {getCashierPerformance().length === 0 && (
                        <tr><td colSpan={3} className="muted">No sales yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="chart-card">
                <h4>Export</h4>
                <div className="row-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      const wb = XLSX.utils.book_new();
                      const salesSheet = sales.map((s) => ({
                        Receipt: s.receipt_no,
                        Date: s.created_at,
                        Payment: s.payment_method,
                        Creditor: s.creditor_name || "",
                        Total: s.total,
                        Cost: s.cost_total,
                        GrossProfit: Number(s.total) - Number(s.cost_total),
                      }));
                      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesSheet), "Sales");
                      const daySheet = getDayOfWeekStats().map((d) => ({
                        Day: d.label, Sales: d.sales, Transactions: d.count,
                      }));
                      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daySheet), "By Day");
                      const cashierSheet = getCashierPerformance().map((c) => ({
                        Cashier: c.name, Transactions: c.count, Sales: c.sales,
                      }));
                      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashierSheet), "Cashiers");
                      const bestSheet = getBestSellers(30).map((b) => ({
                        Product: b.name, Category: b.category, Qty: b.qty, Revenue: b.revenue,
                      }));
                      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bestSheet), "Best Sellers");
                      XLSX.writeFile(wb, `bar-pos-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
                      flash("Excel report downloaded");
                    }}
                  >
                    <Download size={16} /> Export Excel
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
        {tab === "Users" && isAdmin && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Users & permissions</h3>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setUserForm({
                    full_name: "",
                    role: "cashier",
                    active: true,
                    allowed_tabs: ["Dashboard", "Sell", "Credits", "Expenses"],
                    pin: "",
                    staff_code: "",
                  });
                  setShowCreateUser(true);
                }}
              >
                <Plus size={16} /> Create user
              </button>
            </div>
            <div className="alert info-alert" style={{ marginBottom: 16 }}>
              Staff login: use <b>email + password</b> (same credentials as Supabase Auth). After setting a PIN here, staff type that PIN on the login screen. Each PIN must be unique. If login fails, re-save the PIN or deploy Edge Functions <code>pin-login</code> + <code>admin-user</code>. Turn off Confirm email in Supabase Auth settings for staff accounts.
              Email signups must be enabled in Supabase Auth when creating users from this screen. To remove a user, use Delete (disables the account; sales history is kept).
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Code</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Tabs</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((u) => (
                    <tr key={u.id}>
                      <td><b>{u.full_name || "—"}</b></td>
                      <td><code>{u.staff_code || "—"}</code></td>
                      <td style={{ textTransform: "capitalize" }}>{u.role}</td>
                      <td>
                        <span className={"status " + (u.active ? "status-ok" : "status-warn")}>
                          {u.active ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td>
                        <small>
                          {u.role === "admin"
                            ? "All tabs"
                            : (u.allowed_tabs || []).length
                              ? (u.allowed_tabs as string[]).join(", ")
                              : "Default"}
                        </small>
                      </td>
                      <td className="row-actions">
                        <button className="small-action" onClick={() => openEditUser(u)}>
                          Edit
                        </button>
                        {u.id !== profile?.id && (
                          <button
                            className="small-action danger"
                            onClick={() => deleteUser(u)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {profiles.length === 0 && (
                    <tr><td colSpan={6} className="muted center-text">No profiles found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {tab === "Users" && !isAdmin && (
          <section className="panel">
            <h3>Users</h3>
          </section>
        )}
        {tab === "Activity Log" && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Activity log</h3>
              </div>
              <button className="secondary" onClick={refreshAll}>Refresh</button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.length === 0 && (
                    <tr><td colSpan={3} className="muted center-text">No activity recorded yet. Actions such as expenses, settings changes and credit payments are logged.</td></tr>
                  )}
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td>{dateLabel(a.created_at)}</td>
                      <td><b>{a.action}</b></td>
                      <td>{a.details || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {tab === "Backup & Settings" && isAdmin && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Backup & Settings</h3>
              </div>
            </div>
            <form className="stack" onSubmit={saveSettings} style={{ maxWidth: 520 }}>
              <label>
                Bar name
                <input
                  value={settingsForm.bar_name}
                  onChange={(e) => setSettingsForm({ ...settingsForm, bar_name: e.target.value })}
                  placeholder="e.g. Safari Lounge"
                />
              </label>
              <label>
                Logo (upload image)
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      setSettingsForm((f) => ({
                        ...f,
                        logo_url: String(reader.result || ""),
                      }));
                    };
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
              {settingsForm.logo_url && (
                <div style={{ marginTop: 8 }}>
                  <img
                    src={settingsForm.logo_url}
                    alt="Logo preview"
                    style={{ maxHeight: 64, borderRadius: 8, objectFit: "contain" }}
                  />
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => setSettingsForm({ ...settingsForm, logo_url: "" })}
                  >
                    Remove logo
                  </button>
                </div>
              )}
              <label>
                Till / KRA number (shown on receipt)
                <input
                  value={settingsForm.till_number}
                  onChange={(e) => setSettingsForm({ ...settingsForm, till_number: e.target.value })}
                  placeholder="e.g. A123456789B"
                />
              </label>
              <label>
                Receipt footer text
                <input
                  value={settingsForm.receipt_footer}
                  onChange={(e) => setSettingsForm({ ...settingsForm, receipt_footer: e.target.value })}
                />
              </label>
              <label>
                Set / change Admin PIN (min 4 chars, leave blank to keep current)
                <div className="secret-field">
                  <input
                    type={showSecret2 ? "text" : "password"}
                    value={settingsForm.admin_pin}
                    onChange={(e) => setSettingsForm({ ...settingsForm, admin_pin: e.target.value })}
                    placeholder="••••"
                  />
                  <button
                    type="button"
                    className="secret-toggle"
                    onClick={() => setShowSecret2((v) => !v)}
                    tabIndex={-1}
                  >
                    {showSecret2 ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
              <label>
                Idle auto-logout (minutes, 1–60)
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settingsForm.idle_timeout_minutes}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, idle_timeout_minutes: e.target.value })
                  }
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!settingsForm.block_sale_when_out}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, block_sale_when_out: e.target.checked })
                  }
                />
                Block sales when product is out of stock
              </label>
              <label>
                Thermal paper width
                <select
                  value={settingsForm.receipt_paper_mm || "80"}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, receipt_paper_mm: e.target.value })
                  }
                >
                  <option value="80">80mm (standard kitchen/POS roll)</option>
                  <option value="58">58mm (narrow roll)</option>
                </select>
              </label>
              <p className="tiny muted">
                Receipts print edge-to-edge for thermal printers. In the print dialog choose your thermal printer, paper size matching the width above, and turn off headers/footers.
              </p>
              <div className="modal-actions">
                <button className="primary" disabled={busy}>Save settings</button>
              </div>
            </form>
            <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid var(--border, #e2e8f0)" }} />
            <h4>Backup</h4>
            <p className="muted tiny">Download a full JSON snapshot of products, sales, expenses and settings (keep offline).</p>
            <div className="row-actions" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  if (!supabase) return;
                  setBusy(true);
                  try {
                    const tables = [
                      "products",
                      "sales",
                      "sale_items",
                      "expenses",
                      "profiles",
                      "stock_movements",
                      "stock_receipts",
                      "credit_payments",
                      "suppliers",
                      "app_settings",
                    ];
                    const payload: any = { exported_at: new Date().toISOString(), tables: {} };
                    for (const t of tables) {
                      const { data } = await supabase.from(t).select("*");
                      payload.tables[t] = data || [];
                    }
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(
                      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
                    );
                    a.download = `bar-pos-backup-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    flash("Backup downloaded");
                  } catch (e: any) {
                    setError(e.message || "Backup failed");
                  }
                  setBusy(false);
                }}
              >
                <Download size={16} /> Download full backup (JSON)
              </button>
            </div>
            <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid var(--border, #e2e8f0)" }} />
            <h4>Danger zone</h4>
            <div className="row-actions" style={{ marginTop: 12 }}>
              <button
                className="secondary"
                onClick={() =>
                  requestPin("delete all products", () => {
                    if (confirm("Permanently delete ALL products? This cannot be undone.")) {
                      deleteAllProducts();
                    }
                  })
                }
              >
                Delete all products
              </button>
              <button
                className="secondary"
                style={{ color: "#b91c1c", borderColor: "#b91c1c" }}
                onClick={() => {
                  setFactoryPassword("");
                  setFactoryConfirmText("");
                  setError("");
                  setFactoryResetOpen(true);
                  setKbTarget("factoryPassword");
                  setKbMode("alnum");
                  setShowAlphaKb(true);
                }}
              >
                Factory reset (wipe all data)
              </button>
            </div>
            <p className="tiny muted" style={{ marginTop: 16 }}>
              Database backups: use the Supabase Dashboard → Database → Backups. Never share your service_role key.
            </p>
          </section>
        )}
        {tab === "Backup & Settings" && !isAdmin && (
          <section className="panel">
            <h3>Settings</h3>
          </section>
        )}
        {/* Sales moved into Dashboard — tab removed from nav */}
        <footer className="footer-note">
          Sherehe POS <span>•</span>{" "}
          {loading
            ? "Syncing…"
            : !isOnline
              ? "Offline mode — sales queue on this device"
              : pendingSales.length
                ? `${pendingSales.length} offline sale(s) pending sync`
                : "Data synced from your cloud database"}{" "}
          <span>•</span> Signed in as {profile.role}
        </footer>
      
      {/* Mobile bottom quick nav */}
      <nav className="mobile-bottom-nav">
        {nav
          .filter((n) =>
            ["Dashboard", "Sell", "Credits", "Receive Stock", "Reports"].includes(
              n.name,
            ),
          )
          .slice(0, 5)
          .map((n) => (
            <button
              key={n.name}
              type="button"
              className={"mobile-nav-btn" + (tab === n.name ? " active" : "")}
              onClick={() => setTab(n.name)}
            >
              <n.icon size={20} />
              <span>{n.name === "Receive Stock" ? "Receive" : n.name}</span>
            </button>
          ))}
        <button
          type="button"
          className="mobile-nav-btn"
          onClick={() => setMobileMenuOpen(true)}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>☰</span>
          <span>More</span>
        </button>
      </nav>
</main>
      {showProduct && (
        <Modal
          title={editing ? "Edit product" : "Add a product"}
          onClose={() => {
            setShowProduct(false);
            setShowAlphaKb(false);
          }}
        >
          <form className="stack" onSubmit={saveProduct}>
            <label>
              Product name
              <input
                required
                value={form.name}
                inputMode="text"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onFocus={() => openKb("prodName", "alpha")}
                onClick={() => openKb("prodName", "alpha")}
                placeholder="Tap for keyboard"
              />
            </label>
            <label>
              Product image
              <input type="file" accept="image/*" onChange={handleImage} />
              <small className="tiny muted">Images are auto-framed to a square so every product card looks the same.</small>
            </label>
            {form.image_url && (
              <div className="product-image-preview-frame">
                <img src={form.image_url} alt="Product preview" />
              </div>
            )}
            <label className="active-toggle-row" style={{ display: "flex", alignItems: "center", gap: 12, flexDirection: "row" }}>
              <input
                type="checkbox"
                checked={form.active !== false}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                style={{ width: 22, height: 22 }}
              />
              <span>
                <b>Product active</b>
                <small className="muted" style={{ display: "block" }}>
                  Off = hidden from Sell, Inventory, and Receive Stock (still listed under Products)
                </small>
              </span>
            </label>
            <div className="form-row">
              <label>
                Category
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                >
                  {[
                    "Beer",
                    "Cider",
                    "Spirits",
                    "Wine",
                    "Soft Drinks",
                    "Water",
                    "Other",
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                SKU / barcode
                <input
                  value={form.sku}
                  inputMode="text"
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                onFocus={() => openKb("prodSku", "alnum")}
                onClick={() => openKb("prodSku", "alnum")}
                  placeholder="Tap for keyboard"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Buying cost (KES)
                <input
                  required
                  value={form.cost_price}
                  inputMode="decimal"
                onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                onFocus={() => openKb("prodCost", "numeric")}
                onClick={() => openKb("prodCost", "numeric")}
                  placeholder="Tap for number pad"
                />
              </label>
              <label>
                Selling price (KES)
                <input
                  required
                  value={form.sell_price}
                  inputMode="decimal"
                onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
                onFocus={() => openKb("prodSell", "numeric")}
                onClick={() => openKb("prodSell", "numeric")}
                  placeholder="Tap for number pad"
                />
              </label>
            </div>
            <div className="form-row">
              {!editing && (
                <label>
                  Opening stock
                  <input
                    required
                    value={form.stock_qty}
                    inputMode="decimal"
                onChange={(e) => setForm({ ...form, stock_qty: e.target.value })}
                onFocus={() => openKb("prodStock", "numeric")}
                onClick={() => openKb("prodStock", "numeric")}
                    placeholder="Tap for number pad"
                  />
                </label>
              )}
              <label>
                Low-stock threshold
                <input
                  required
                  value={form.min_stock}
                  inputMode="decimal"
                onChange={(e) => setForm({ ...form, min_stock: e.target.value })}
                onFocus={() => openKb("prodMin", "numeric")}
                onClick={() => openKb("prodMin", "numeric")}
                  placeholder="Tap for number pad"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Stock unit
                <select
                  value={form.stock_unit}
                  onChange={(e) =>
                    setForm({ ...form, stock_unit: e.target.value })
                  }
                >
                  <option value="unit">Individual unit / cup</option>
                  <option value="barrel">Barrel converted to cups</option>
                </select>
              </label>
              {form.stock_unit === "barrel" && (
                <label>
                  Cups per barrel
                  <input
                    required
                    value={form.units_per_pack}
                    inputMode="decimal"
                onChange={(e) => setForm({ ...form, units_per_pack: e.target.value })}
                onFocus={() => openKb("prodUnits", "numeric")}
                onClick={() => openKb("prodUnits", "numeric")}
                    placeholder="Tap for number pad"
                  />
                </label>
              )}
            </div>
            {showAlphaKb &&
              kbTarget &&
              [
                "prodName",
                "prodSku",
                "prodCost",
                "prodSell",
                "prodStock",
                "prodMin",
                "prodUnits",
              ].includes(kbTarget) && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowProduct(false);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save product"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      
            {showBatchReceive && (
        <Modal
          title="Batch receive stock"
          onClose={() => {
            setShowBatchReceive(false);
            setShowAlphaKb(false);
          }}
        >
          <div className="stack">
            <label>
              Supplier (optional)
              <input
                value={batchSupplier}
                onChange={(e) => setBatchSupplier(e.target.value)}
                onFocus={() => openKb("batchSupplier", "alpha")}
                onClick={() => openKb("batchSupplier", "alpha")}
                placeholder="Supplier name"
              />
            </label>
            <label>
              Invoice / receipt no (optional)
              <input
                value={batchReceiptNo}
                onChange={(e) => setBatchReceiptNo(e.target.value)}
                onFocus={() => openKb("batchReceiptNo", "alnum")}
                onClick={() => openKb("batchReceiptNo", "alnum")}
                placeholder="Invoice no"
              />
            </label>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Total cost</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batchItems.map((row, i) => (
                    <tr key={row.product_id}>
                      <td><b>{row.name}</b></td>
                      <td>
                        <input
                          inputMode="decimal"
                          value={row.qty}
                          onChange={(e) =>
                            setBatchItems((old) =>
                              old.map((x, j) =>
                                j === i ? { ...x, qty: e.target.value } : x,
                              ),
                            )
                          }
                          onFocus={() => {
                            setBatchKbIndex(i);
                            openKb("batchQty", "numeric");
                          }}
                          onClick={() => {
                            setBatchKbIndex(i);
                            openKb("batchQty", "numeric");
                          }}
                          style={{ width: 80 }}
                          placeholder="Qty"
                        />
                      </td>
                      <td>
                        <input
                          inputMode="decimal"
                          value={row.total_cost}
                          onChange={(e) =>
                            setBatchItems((old) =>
                              old.map((x, j) =>
                                j === i ? { ...x, total_cost: e.target.value } : x,
                              ),
                            )
                          }
                          onFocus={() => {
                            setBatchKbIndex(i);
                            openKb("batchCost", "numeric");
                          }}
                          onClick={() => {
                            setBatchKbIndex(i);
                            openKb("batchCost", "numeric");
                          }}
                          style={{ width: 110 }}
                          placeholder="0"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() =>
                            setBatchItems((old) => old.filter((_, j) => j !== i))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showAlphaKb &&
              kbTarget &&
              ["batchSupplier", "batchReceiptNo", "batchQty", "batchCost"].includes(
                kbTarget,
              ) && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowBatchReceive(false);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !batchItems.length}
                onClick={submitBatchReceive}
              >
                {busy ? "Saving…" : "Receive all"}
              </button>
            </div>
          </div>
        </Modal>
      )}

{showReceive && (
        <Modal
          title="Receive stock"
          onClose={() => {
            setShowReceive(false);
            setShowAlphaKb(false);
          }}
        >
          <form className="stack" onSubmit={receiveStock}>
            <p className="muted">
              {products.find((p) => p.id === receiveProduct)?.name} · Current
              stock:{" "}
              {products.find((p) => p.id === receiveProduct)?.stock_qty ?? 0}
            </p>
            <label>
              Quantity received (
              {products.find((p) => p.id === receiveProduct)?.stock_unit ===
              "barrel"
                ? "barrels"
                : "units"}
              )
              <input
                required
                value={receiveQty}
                inputMode="decimal"
                onChange={(e) => setReceiveQty(e.target.value)}
                onFocus={() => openKb("receiveQty", "numeric")}
                onClick={() => openKb("receiveQty", "numeric")}
                placeholder="Qty"
              />
            </label>
            <label>
              Total invoice cost (KES)
              <input
                required
                value={receiveTotalCost}
                inputMode="decimal"
                onChange={(e) => setReceiveTotalCost(e.target.value)}
                onFocus={() => openKb("receiveTotalCost", "numeric")}
                onClick={() => openKb("receiveTotalCost", "numeric")}
                placeholder="Total cost"
              />
            </label>
            <p className="tiny muted">
              Unit cost is calculated automatically in the background from total cost ÷ quantity and updates the product average cost.
            </p>
            <label>
              Supplier (optional)
              <input
                value={receiveSupplier}
                inputMode="text"
                onChange={(e) => setReceiveSupplier(e.target.value)}
                onFocus={() => openKb("receiveSupplier", "alpha")}
                onClick={() => openKb("receiveSupplier", "alpha")}
                placeholder="Supplier"
              />
            </label>
            <label>
              Receipt / invoice number (optional)
              <input
                value={receiveReceiptNo}
                inputMode="text"
                onChange={(e) => setReceiveReceiptNo(e.target.value)}
                onFocus={() => openKb("receiveReceiptNo", "alnum")}
                onClick={() => openKb("receiveReceiptNo", "alnum")}
                placeholder="Receipt no"
              />
            </label>
            <label>
              Note
              <input
                value={receiveNote}
                inputMode="text"
                onChange={(e) => setReceiveNote(e.target.value)}
                onFocus={() => openKb("receiveNote", "alpha")}
                onClick={() => openKb("receiveNote", "alpha")}
                placeholder="Note"
              />
            </label>
            {showAlphaKb &&
              kbTarget &&
              [
                "receiveQty",
                "receiveTotalCost",
                "receiveSupplier",
                "receiveReceiptNo",
                "receiveNote",
              ].includes(kbTarget) && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowReceive(false);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy || !receiveProduct}>
                {busy ? "Saving…" : "Receive stock"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {showAudit && (
        <Modal
          title={`Inventory audit · ${showAudit.name}`}
          onClose={() => {
            setShowAudit(null);
            setShowAlphaKb(false);
          }}
        >
          <form className="stack" onSubmit={auditStock}>
            <p className="muted">System quantity: {showAudit.stock_qty}</p>
            <label>
              Physical count
              <input
                required
                value={auditQty}
                inputMode="decimal"
                onChange={(e) => setAuditQty(e.target.value)}
                onFocus={() => openKb("auditQty", "numeric")}
                onClick={() => openKb("auditQty", "numeric")}
                placeholder="Tap for number pad"
              />
            </label>
            <label>
              Reason for adjustment
              <input
                required
                value={auditReason}
                inputMode="text"
                onChange={(e) => setAuditReason(e.target.value)}
                onFocus={() => openKb("auditReason", "alpha")}
                onClick={() => openKb("auditReason", "alpha")}
                placeholder="Tap for keyboard"
              />
            </label>
            {showAlphaKb &&
              kbTarget &&
              ["auditQty", "auditReason"].includes(kbTarget) && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowAudit(null);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save adjustment"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {showExpense && (
        <Modal
          title="Record expense"
          onClose={() => {
            setShowExpense(false);
            setShowAlphaKb(false);
            setKbTarget(null);
          }}
        >
          <form className="stack" onSubmit={saveExpense}>
            <label>
              Expense description
              <input
                required
                value={expenseForm.description}
                inputMode="text"
                onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                onFocus={() => openKb("expenseDesc", "alpha")}
                onClick={() => openKb("expenseDesc", "alpha")}
                placeholder="Tap to type description"
              />
            </label>
            <label>
              Amount (KES)
              <input
                required
                value={expenseForm.amount}
                inputMode="decimal"
                onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })}
                onFocus={() => openKb("expenseAmt", "numeric")}
                onClick={() => openKb("expenseAmt", "numeric")}
                placeholder="Tap for number pad"
              />
            </label>
            {showAlphaKb &&
              (kbTarget === "expenseDesc" || kbTarget === "expenseAmt") && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowExpense(false);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save expense
              </button>
            </div>
          </form>
        </Modal>
      )}
      {showCreditorModal && (
        <Modal
          title="Creditor name"
          onClose={() => {
            setShowCreditorModal(false);
            setShowAlphaKb(false);
          }}
        >
          <div className="stack">
            <input
              autoFocus
              value={creditor}
              onChange={(e) => setCreditor(e.target.value)}
              onFocus={() => openKb("creditor", "alpha")}
              placeholder="Creditor name"
              className="creditor-display"
            />
            {showAlphaKb && (
              <OnScreenKeyboard
                mode="alpha"
                value={creditor}
                onKey={kbType}
                onBack={kbBack}
                onSpace={kbSpace}
                onClose={() => {
                  setShowCreditorModal(false);
                  setShowAlphaKb(false);
                  setKbTarget(null);
                }}
              />
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setCreditor("");
                  setShowCreditorModal(false);
                  setPayment("cash");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!creditor.trim() || busy}
                onClick={() => {
                  setShowCreditorModal(false);
                  setShowAlphaKb(false);
                  checkout("credit");
                }}
              >
                Complete & print
              </button>
            </div>
          </div>
        </Modal>
      )}
      {creditPayModal && (
        <Modal title={`Record payment · ${creditPayModal.name}`} onClose={() => setCreditPayModal(null)}>
          <form className="stack" onSubmit={submitCreditPayment}>
            <p className="muted">Outstanding: <b>{money(creditPayModal.outstanding)}</b></p>
            <label>
              Amount (KES)
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={creditPayModal.outstanding}
                required
                value={creditPayForm.amount}
                onChange={(e) => setCreditPayForm({ ...creditPayForm, amount: e.target.value })}
              />
            </label>
            <label>
              Payment method
              <select
                value={creditPayForm.method}
                onChange={(e) => setCreditPayForm({ ...creditPayForm, method: e.target.value })}
              >
                <option value="cash">Cash</option>
                <option value="mpesa">M-Pesa</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Note (optional)
              <input
                value={creditPayForm.note}
                onChange={(e) => setCreditPayForm({ ...creditPayForm, note: e.target.value })}
                placeholder="e.g. Partial payment"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setCreditPayModal(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Record & print receipt
              </button>
            </div>
          </form>
        </Modal>
      )}
      {showCreateUser && (
        <Modal title="Create staff user" onClose={() => setShowCreateUser(false)}>
          <form className="stack" onSubmit={createStaffUser}>
            <label>
              Full name
              <input
                required
                value={userForm.full_name}
                onChange={(e) => setUserForm({ ...userForm, full_name: e.target.value })}
                placeholder="e.g. Jane"
              />
            </label>
            <label>
              Staff code (used at login)
              <input
                required
                value={userForm.staff_code}
                onChange={(e) =>
                  setUserForm({
                    ...userForm,
                    staff_code: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""),
                  })
                }
                placeholder="e.g. jane"
              />
            </label>
            <label>
              PIN (min 4 digits/letters)
              <div className="secret-field">
                <input
                  required
                  type={showSecret ? "text" : "password"}
                  value={userForm.pin}
                  
                  onChange={(e) =>
                    setUserForm((f) => ({ ...f, pin: e.target.value }))
                  }
                  onClick={() => {
                    setKbTarget("createPin");
                    setShowAlphaKb(true);
                  }}
                  placeholder="Tap for keyboard"
                />
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            {showAlphaKb && kbTarget === "createPin" && (
              <OnScreenKeyboard
                mode="numeric"
                value={userForm.pin}
                onKey={kbType}
                onBack={kbBack}
                onSpace={kbSpace}
                onClose={() => setShowAlphaKb(false)}
              />
            )}
            <label>
              Role
              <select
                value={userForm.role}
                onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
              >
                <option value="cashier">Cashier</option>
                <option value="supervisor">Supervisor</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            {userForm.role === "cashier" && (
              <div>
                <div className="field-label" style={{ marginBottom: 8 }}>Permissions (tabs)</div>
                <div className="perm-grid">
                  {ALL_TABS.map((t) => (
                    <label key={t} className="perm-check">
                      <input
                        type="checkbox"
                        checked={userForm.allowed_tabs.includes(t)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...userForm.allowed_tabs, t]
                            : userForm.allowed_tabs.filter((x) => x !== t);
                          setUserForm({ ...userForm, allowed_tabs: next });
                        }}
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShowCreateUser(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>Create user</button>
            </div>
          </form>
        </Modal>
      )}
      {showSupplier && (
        <Modal
          title="Add supplier"
          onClose={() => {
            setShowSupplier(false);
            setShowAlphaKb(false);
          }}
        >
          <form className="stack" onSubmit={saveSupplier}>
            <label>
              Supplier name
              <input
                required
                value={supplierForm.name}
                inputMode="text"
                onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}
                onFocus={() => openKb("supName", "alpha")}
                onClick={() => openKb("supName", "alpha")}
                placeholder="Tap for keyboard"
              />
            </label>
            <label>
              Phone (optional)
              <input
                value={supplierForm.phone}
                inputMode="decimal"
                onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                onFocus={() => openKb("supPhone", "numeric")}
                onClick={() => openKb("supPhone", "numeric")}
                placeholder="Tap for number pad"
              />
            </label>
            <label>
              Note (optional)
              <input
                value={supplierForm.note}
                inputMode="text"
                onChange={(e) => setSupplierForm({ ...supplierForm, note: e.target.value })}
                onFocus={() => openKb("supNote", "alpha")}
                onClick={() => openKb("supNote", "alpha")}
                placeholder="Tap for keyboard"
              />
            </label>
            {showAlphaKb &&
              kbTarget &&
              ["supName", "supPhone", "supNote"].includes(kbTarget) && (
                <OnScreenKeyboard
                  mode={kbMode}
                  value={kbValue()}
                  onKey={kbType}
                  onBack={kbBack}
                  onSpace={kbSpace}
                  onClose={() => setShowAlphaKb(false)}
                />
              )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowSupplier(false);
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save supplier
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editingUser && (
        <Modal title={`Edit user · ${editingUser.full_name || editingUser.id.slice(0, 8)}`} onClose={() => setEditingUser(null)}>
          <form className="stack" onSubmit={saveUser}>
            <label>
              Full name
              <input
                value={userForm.full_name}
                onChange={(e) => setUserForm({ ...userForm, full_name: e.target.value })}
                placeholder="e.g. Jane Cashier"
              />
            </label>
            <label>
              Role
              <select
                value={userForm.role}
                onChange={(e) =>
                  setUserForm({
                    ...userForm,
                    role: e.target.value,
                    allowed_tabs: e.target.value === "admin" ? [...ALL_TABS] : userForm.allowed_tabs,
                  })
                }
              >
                <option value="cashier">Cashier</option>
                <option value="supervisor">Supervisor</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={userForm.active}
                onChange={(e) => setUserForm({ ...userForm, active: e.target.checked })}
              />
              Account active
            </label>
            {userForm.role === "cashier" && (
              <div>
                <div className="field-label" style={{ marginBottom: 8 }}>Allowed tabs</div>
                <div className="perm-grid">
                  {ALL_TABS.map((t) => (
                    <label key={t} className="perm-check">
                      <input
                        type="checkbox"
                        checked={userForm.allowed_tabs.includes(t)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...userForm.allowed_tabs, t]
                            : userForm.allowed_tabs.filter((x) => x !== t);
                          setUserForm({ ...userForm, allowed_tabs: next });
                        }}
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {userForm.role === "admin" && (
              <p className="tiny muted">Admins automatically have access to every tab.</p>
            )}
            <label>
              Staff code
              <input
                value={userForm.staff_code}
                onChange={(e) =>
                  setUserForm({
                    ...userForm,
                    staff_code: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""),
                  })
                }
                placeholder="e.g. jane"
              />
            </label>
            <label>
              New login PIN (leave blank to keep current)
              <div className="secret-field">
                <input
                  type={showSecret ? "text" : "password"}
                  value={userForm.pin}
                  onChange={(e) => setUserForm({ ...userForm, pin: e.target.value })}
                  placeholder="Min 4 characters"
                  minLength={0}
                />
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <p className="tiny muted">
              Cashiers sign in with this PIN on the login screen (login PIN mode). Each PIN must be unique.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setEditingUser(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save user
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pinPrompt && (
        <Modal title="Admin PIN required" onClose={() => setPinPrompt(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              verifyPin();
            }}
          >
            <p className="muted">Enter admin PIN to {pinPrompt.action}</p>
            <label>
              PIN
              <div className="secret-field">
                <input
                  type={showSecret ? "text" : "password"}
                  autoFocus
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  onFocus={() => {
                    setKbTarget("pinPrompt");
                    setKbMode("alnum");
                    setShowAlphaKb(true);
                  }}
                  onClick={() => {
                    setKbTarget("pinPrompt");
                    setKbMode("alnum");
                    setShowAlphaKb(true);
                  }}
                  placeholder="••••"
                />
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            {showAlphaKb && kbTarget === "pinPrompt" && (
              <OnScreenKeyboard
                mode="alnum"
                value={showSecret ? pinInput : "•".repeat(pinInput.length)}
                onKey={(ch) => setPinInput((v) => v + ch)}
                onBack={() => setPinInput((v) => v.slice(0, -1))}
                onSpace={() => setPinInput((v) => v + " ")}
                onClose={() => setShowAlphaKb(false)}
              />
            )}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPinPrompt(null)}>
                Cancel
              </button>
              <button className="primary" type="submit">
                Confirm
              </button>
            </div>
          </form>
        </Modal>
      )}
      {factoryResetOpen && (
        <Modal
          title="Factory reset"
          onClose={() => {
            setFactoryResetOpen(false);
            setFactoryPassword("");
            setFactoryConfirmText("");
            setShowAlphaKb(false);
          }}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void runFactoryReset();
            }}
          >
            <p className="muted" style={{ color: "#b91c1c" }}>
              This permanently deletes <b>all business data</b>: products, sales, stock,
              expenses, credits, suppliers, and notifications.
            </p>
            <p className="tiny muted">
              <b>Kept:</b> your admin/staff login accounts so you can sign in and start
              again. This cannot be undone from the app.
            </p>
            <p className="tiny muted">
              If wipe fails, run <code>supabase/factory-reset.sql</code> in the Supabase SQL Editor first.
            </p>
            <label>
              Admin login password
              <div className="secret-field">
                <input
                  type={showSecret ? "text" : "password"}
                  autoFocus
                  value={factoryPassword}
                  onChange={(e) => setFactoryPassword(e.target.value)}
                  placeholder="Same password you use to sign in"
                />
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setFactoryResetOpen(false);
                  setFactoryPassword("");
                  setFactoryConfirmText("");
                  setShowAlphaKb(false);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                type="submit"
                disabled={factoryBusy || !factoryPassword.trim()}
                style={{ background: "#b91c1c", boxShadow: "none" }}
              >
                {factoryBusy ? "Wiping…" : "Wipe all data"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {receipt && (
        <Modal
          title="Sale completed — receipt"
          onClose={() => setReceipt(null)}
        >
          <div className="receipt-preview">
            <h3>{settings.bar_name || "BAR POS"}</h3>
            <p>{receipt.receipt_no}</p>
            <p>{dateLabel(receipt.created_at)}</p>
            {receipt.offline && (
              <p className="tiny" style={{ color: "#b45309", fontWeight: 700 }}>
                OFFLINE SALE — will sync when internet returns
              </p>
            )}
            {receipt.cashier_name && settings.show_cashier_on_receipt !== false && (
              <p className="tiny">Cashier: {receipt.cashier_name}</p>
            )}
            {settings.till_number && settings.show_till_on_receipt !== false && (
              <p className="tiny">Till: {settings.till_number}</p>
            )}
            <hr />
            {receipt.items.map((x: Line) => (
              <div className="summary-line" key={x.product.id}>
                <span>
                  {x.product.name} × {x.qty}
                </span>
                <b>{money(x.product.sell_price * x.qty)}</b>
              </div>
            ))}
            <hr />
            <div className="summary-line grand">
              <span>Total</span>
              <b>{money(receipt.total)}</b>
            </div>
            <p>Payment: {String(receipt.payment || "").toUpperCase()}</p>
            {receipt.creditor && <p>Creditor: {receipt.creditor}</p>}
          </div>
          <div className="modal-actions" style={{ flexWrap: "wrap" }}>
            <button className="secondary" onClick={() => setReceipt(null)}>
              Close
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => shareReceiptWhatsApp(receipt)}
            >
              Share WhatsApp
            </button>
            <button
              className="primary"
              onClick={() => {
                printReceipt(receipt);
              }}
            >
              <Printer size={16} /> Print thermal
            </button>
          </div>
        </Modal>
      )}
    </div>
    </>
  );
}
function Stat({
  title,
  value,
  sub,
  icon,
  warning,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  warning?: boolean;
}) {
  return (
    <div className="stat-card">
      <div className={"stat-icon " + (warning ? "warn" : "")}>{icon}</div>
      <div className="stat-title">{title}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub || "Updated from cloud"}</div>
    </div>
  );
}
function SalesTable({
  sales,
  full = false,
  onPrint,
}: {
  sales: Sale[];
  full?: boolean;
  onPrint?: (s: Sale) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Receipt</th>
            {full && <th>Date & time</th>}
            <th>Payment</th>
            <th>Total</th>
            {onPrint && <th></th>}
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id}>
              <td>
                <b className="receipt-id">{s.receipt_no}</b>
                {!full && (
                  <small className="sub-cell">{dateLabel(s.created_at)}</small>
                )}
              </td>
              {full && <td>{dateLabel(s.created_at)}</td>}
              <td>
                <span className="payment-tag">{s.payment_method}</span>
                {s.creditor_name && (
                  <small className="sub-cell">{s.creditor_name}</small>
                )}
              </td>
              <td className="amount-cell">{money(s.total)}</td>
              {onPrint && (
                <td>
                  <button className="small-action" onClick={() => onPrint(s)}>
                    <Printer size={14} /> Print
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {sales.length === 0 && (
        <div className="empty table-empty">
          <ClipboardList size={30} />
          <b>No sales yet</b>
          <span>Completed sales will appear here.</span>
        </div>
      )}
    </div>
  );
}
function ProductsTable({
  products,
  admin,
  onEdit,
  onToggleActive,
}: {
  products: Product[];
  admin: boolean;
  onEdit: (p: Product) => void;
  onToggleActive?: (p: Product) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Category</th>
            <th>Cost</th>
            <th>Sell price</th>
            <th>In stock</th>
            <th>Stock</th>
            <th>Active</th>
            {admin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className={p.active === false ? "row-inactive" : ""}>
              <td>
                <div className="product-cell">
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="product-thumb product-thumb-framed" />
                  ) : (
                    <span className="mini-drink">
                      <Beer size={16} />
                    </span>
                  )}
                  <span>
                    <b>{p.name}</b>
                    <small>{p.sku || "No SKU"}</small>
                  </span>
                </div>
              </td>
              <td>{p.category}</td>
              <td>{money(p.cost_price)}</td>
              <td className="amount-cell">{money(p.sell_price)}</td>
              <td>
                <b>{p.stock_qty}</b>{" "}
                <small className="muted">/ min {p.min_stock}</small>
              </td>
              <td>
                <span
                  className={
                    "status " +
                    (p.stock_qty <= p.min_stock ? "status-warn" : "status-ok")
                  }
                >
                  {p.stock_qty <= p.min_stock ? "Low stock" : "In stock"}
                </span>
              </td>
              <td>
                {admin && onToggleActive ? (
                  <button
                    type="button"
                    className={"status-toggle " + (p.active !== false ? "is-active" : "is-inactive")}
                    onClick={() => onToggleActive(p)}
                    title={p.active !== false ? "Click to deactivate" : "Click to activate"}
                  >
                    {p.active !== false ? "Active" : "Inactive"}
                  </button>
                ) : (
                  <span className={"status " + (p.active !== false ? "status-ok" : "status-warn")}>
                    {p.active !== false ? "Active" : "Inactive"}
                  </span>
                )}
              </td>
              {admin && (
                <td>
                  <button className="small-action" onClick={() => onEdit(p)}>
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {products.length === 0 && (
        <div className="empty table-empty">
          <Package size={30} />
          <b>No products yet</b>
          <span>Add your first bar product to start selling.</span>
        </div>
      )}
    </div>
  );
}
function OnScreenKeyboard({
  mode,
  value,
  onKey,
  onBack,
  onSpace,
  onClose,
}: {
  mode: "alpha" | "numeric" | "alnum";
  value: string;
  onKey: (ch: string) => void;
  onBack: () => void;
  onSpace: () => void;
  onClose: () => void;
}) {
  const [capsOn, setCapsOn] = useState(false);
  const upperRows = [
    "QWERTYUIOP".split(""),
    "ASDFGHJKL".split(""),
    "ZXCVBNM".split(""),
  ];
  const alphaRows = upperRows.map((row) =>
    row.map((k) => (capsOn ? k.toUpperCase() : k.toLowerCase())),
  );
  // 3-column phone number pad
  const padRows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["⌫", "0", "✓"],
  ];
  return (
    <div className="osk-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="osk-wrap">
        <div className="osk-preview" id="osk-preview">
          {value || <span className="muted">…</span>}
        </div>
        <div
          className={
            "osk" +
            (mode === "numeric" ? " osk-pad-mode" : " osk-alpha-mode") +
            (capsOn ? " osk-caps-on" : " osk-caps-off")
          }
        >
          {mode === "numeric" ? (
            <>
              {padRows.map((row, i) => (
                <div className="osk-row osk-pad-row" key={i}>
                  {row.map((k) =>
                    k === "⌫" ? (
                      <button
                        type="button"
                        key={k}
                        className="osk-key osk-pad-key osk-back"
                        onClick={onBack}
                      >
                        ⌫
                      </button>
                    ) : k === "✓" ? (
                      <button
                        type="button"
                        key={k}
                        className="osk-key osk-pad-key osk-done"
                        onClick={onClose}
                      >
                        Done
                      </button>
                    ) : (
                      <button
                        type="button"
                        key={k}
                        className="osk-key osk-pad-key"
                        onClick={() => onKey(k)}
                      >
                        {k}
                      </button>
                    ),
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              {mode === "alnum" && (
                <>
                  <div className="osk-row osk-num-strip">
                    {"1234567890".split("").map((k) => (
                      <button
                        type="button"
                        key={k}
                        className="osk-key"
                        onClick={() => onKey(k)}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {alphaRows.map((row, i) => (
                <div className="osk-row osk-alpha-row" key={i}>
                  {row.map((k) => (
                    <button
                      type="button"
                      key={k + i}
                      className="osk-key osk-alpha"
                      onClick={() => onKey(k)}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              ))}
              <div className="osk-row osk-alpha-row osk-bottom-row">
                <button
                  type="button"
                  className="osk-key osk-at"
                  onClick={() => onKey("@")}
                >
                  @
                </button>
                <button
                  type="button"
                  className="osk-key osk-dot"
                  onClick={() => onKey(".")}
                  title="Period"
                >
                  .
                </button>
                <button
                  type="button"
                  className={"osk-key osk-caps" + (capsOn ? " active" : "")}
                  onClick={() => setCapsOn((v) => !v)}
                  aria-pressed={capsOn}
                  title={capsOn ? "Caps On — tap for lowercase" : "Caps Off — tap for UPPERCASE"}
                >
                  {capsOn ? "CAPS ON" : "caps off"}
                </button>
                <button type="button" className="osk-key osk-wide" onClick={onSpace}>
                  Space
                </button>
                <button type="button" className="osk-key osk-wide" onClick={onBack}>
                  ⌫
                </button>
                <button type="button" className="osk-key osk-done" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function SetupScreen() {
  const onNetlify =
    typeof window !== "undefined" &&
    (window.location.hostname.includes("netlify.app") ||
      window.location.hostname.includes("netlify.com"));

  return (
    <div className="login-wrap">
      <div className="login-card setup-card">
        <div className="brand-mark">
          <Beer size={28} />
        </div>
        <h1>Connect your bar POS</h1>
        <p className="muted">
          {onNetlify
            ? "This Netlify site was built without Supabase credentials. Add the environment variables below, then redeploy."
            : "The project is ready. Add your Supabase project credentials to connect the cloud database."}
        </p>
        {onNetlify ? (
          <ol className="setup-steps">
            <li>
              Open <b>Netlify</b> → your site →{" "}
              <b>Site configuration → Environment variables</b>.
            </li>
            <li>
              Add these two variables (exact names):
              <br />
              <code>VITE_SUPABASE_URL</code> ={" "}
              <code>https://YOUR_REF.supabase.co</code>
              <br />
              <code>VITE_SUPABASE_ANON_KEY</code> = your anon / publishable key
              <br />
              <span className="tiny muted">
                Find both under Supabase → Project Settings → API.
              </span>
            </li>
            <li>
              Go to <b>Deploys → Trigger deploy → Clear cache and deploy site</b>.
              Vite only reads these keys during the build.
            </li>
            <li>
              After deploy succeeds, refresh this page — you should see the login
              screen.
            </li>
          </ol>
        ) : (
          <ol className="setup-steps">
            <li>
              Create a project at{" "}
              <a
                href="https://supabase.com/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                Supabase Dashboard
              </a>
              .
            </li>
            <li>
              Open the project's <b>SQL Editor</b> and run the{" "}
              <code>supabase/schema.sql</code> file included in this project.
            </li>
            <li>
              Copy <code>.env.example</code> to <code>.env</code> and fill in your
              project URL and publishable/anon key.
            </li>
            <li>
              Run <code>npm install</code> then <code>npm run dev</code>.
            </li>
            <li>
              Create a user in Supabase Authentication, then run the profile setup
              SQL in the README to assign the first admin.
            </li>
          </ol>
        )}
        <div className="alert info-alert">
          Never put the Supabase <b>service_role</b> key in frontend or Netlify
          env vars — only the <b>anon / publishable</b> key.
        </div>
        <p className="tiny muted">See DEPLOY.md for GitHub → Netlify steps.</p>
      </div>
    </div>
  );
}
