/* Automoteev service worker — handles incoming push notifications and
 * routes notification clicks to the right place in the app.
 *
 * Served at /sw.js (root scope) so it can intercept events for the entire
 * origin. Registered from main.tsx after page load.
 *
 * The push payload shape we expect (set by apps/api/src/services/push.ts):
 *   { title: string, body: string, url?: string, tag?: string }
 */

self.addEventListener("install", (event) => {
  // Take over immediately on first install — no need to wait for tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim all open clients so we start receiving fetch/push events without
  // requiring a refresh.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    // Push payload wasn't JSON — fall back to text body.
    data = { title: "Automoteev", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Automoteev";
  const options = {
    body: data.body || "",
    // Deep-link target stored on the notification so notificationclick can read it.
    data: { url: data.url || "/app" },
    tag: data.tag || undefined,
    // Replace prior notifications with the same tag (e.g. multiple updates on
    // one task). If undefined, every push stacks separately.
    renotify: !!data.tag,
    badge: "/icon.svg",
    icon: "/icon.svg"
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/app";

  event.waitUntil(
    (async () => {
      // Reuse an existing tab if one is already on automoteev.com — feels
      // less jarring than opening a brand new one for every notification.
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });
      for (const client of allClients) {
        if ("focus" in client) {
          // Two-prong navigation: client.navigate() reloads the URL, but on
          // an already-open SPA that's already at /app, React doesn't
          // re-mount and the deep-link useEffect (which only fires on mount)
          // misses the new query params. So we ALSO postMessage the URL to
          // the client, which it listens for and handles in-app via setTab
          // and setHistoryAutoExpandTaskId. Whichever path lands first wins.
          try {
            client.postMessage({ type: "automoteev:deep-link", url: targetUrl });
          } catch (err) {
            // postMessage is best-effort; ignore if the channel is dead.
          }
          if ("navigate" in client) {
            try {
              await client.navigate(targetUrl);
            } catch (err) {
              // navigate() can fail on cross-origin or detached clients; ignore.
            }
          }
          return client.focus();
        }
      }
      // No tab open — open a new one.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
