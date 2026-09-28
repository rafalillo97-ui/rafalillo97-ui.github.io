// sw.js — Service Worker de cesta.
// Sube este archivo a la RAÍZ del dominio donde sirvas la app (mismo nivel que
// index.html), como "/sw.js". Tiene que estar en la raíz para poder controlar
// toda la app; si lo sirves desde una subcarpeta, solo funcionará ahí dentro.
//
// Hace DOS cosas: (1) recibe notificaciones push reales, (2) guarda una copia
// de la propia app para que, si alguien la abre sin conexión (o con mala
// cobertura en el gimnasio), al menos cargue en vez de dar el típico error de
// "sin conexión" del navegador. Los datos en vivo (Supabase) necesitan
// internet igualmente — esto solo cubre que la app en sí (el HTML/CSS/JS)
// aparezca de inmediato.

const CACHE_NAME = 'cesta-shell-v39';
// Los datos de cada idioma se piden aparte bajo /idiomas/ (ver ensureLangDataLoaded en
// index.html) y no se precargaban aquí — la app funcionaba bien offline en general
// porque el fetch handler de abajo va guardando en caché lo que se pide con éxito, pero
// la PRIMERA vez que alguien abre la app sin conexión (antes de haber cargado nunca nada
// online) fallaría al pedir estos ficheros. 'es' es el idioma de reserva que usan esas
// tres listas siempre, sea cual sea el idioma activo, así que es el mínimo que hace
// falta precargar para que ese primer arranque offline funcione.
const SHELL_URLS = [
  '/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/fonts/fonts.css',
  '/fonts/inter-latin-400-normal.woff2', '/fonts/inter-latin-500-normal.woff2', '/fonts/inter-latin-600-normal.woff2',
  '/fonts/inter-latin-ext-400-normal.woff2', '/fonts/inter-latin-ext-500-normal.woff2', '/fonts/inter-latin-ext-600-normal.woff2',
  '/fonts/space-grotesk-latin-500-normal.woff2', '/fonts/space-grotesk-latin-600-normal.woff2', '/fonts/space-grotesk-latin-700-normal.woff2',
  '/idiomas/PREGNANCY_EXERCISES_DATA/es.json',
  '/idiomas/BABY_ACTIVITIES_DATA/es.json',
  '/idiomas/FITNESS_SESSIONS_DATA/es.json',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Borra copias de caché de versiones antiguas del propio Service Worker.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Estrategia "red primero, caché de respaldo": siempre intenta traer la versión
// más nueva de internet; si no hay conexión, sirve la última copia guardada.
// Así el usuario ve siempre la versión al día cuando hay red, pero la app no
// se queda completamente en blanco si en ese momento no la hay.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // no interceptamos llamadas a Supabase ni a terceros

  // Tipografías y datos de idioma (traducciones de 20.000 alimentos, ~1 MB por idioma): casi
  // nunca cambian, así que se sirven al instante desde la caché y se refrescan en segundo
  // plano para la próxima vez. El HTML sigue siendo "red primero" (abajo) para que las
  // versiones nuevas de la app lleguen enseguida.
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/idiomas/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        const refresh = fetch(event.request).then((res) => {
          if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
          return res;
        }).catch(() => null);
        if (cached) { event.waitUntil(refresh); return cached; }
        const res = await refresh;
        if (res) return res;
        throw new Error('offline');
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('/index.html') || await caches.match('/');
          if (fallback) return fallback;
        }
        throw e;
      }
    })()
  );
});

// Llega un push real del servidor (aunque la app esté cerrada o en segundo plano)
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e){ data = { title: 'cesta.', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'cesta.';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined, // si dos avisos comparten "tag", el segundo sustituye al primero en vez de amontonarse
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// El usuario toca la notificación: si la app ya está abierta en una pestaña, la enfoca;
// si no, abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
