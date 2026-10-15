/* Bar POS Cloud — offline service worker v2.0.0
   - App shell + assets offline
   - Background Sync tag: barpos-sync
   - Never cache Supabase API
*/
const CACHE = "barpos-shell-v2.0.0";
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApi(url) {
  return (
    url.hostname.includes("supabase.co") ||
    url.pathname.startsWith("/rest/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/functions/") ||
    url.pathname.startsWith("/realtime/") ||
    url.pathname.startsWith("/storage/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isApi(url)) return;
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", clone));
          return res;
        })
        .catch(() =>
          caches.match("/index.html").then((r) => r || caches.match("/")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag === "barpos-sync") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: "barpos-sync" }));
      }),
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
