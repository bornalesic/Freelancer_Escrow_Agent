// A default address of "localhost" means "the laptop running the servers". When this page was opened from
// another laptop (http://192.168.6.106:5173/agent), that laptop is the one that served the page, not the
// viewer's own: in the viewer's browser "localhost" would be their own machine, where nothing is running
// (or, worse, their own agent, whose escrows would then show under someone else's address).

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * `url` with a loopback host replaced by `pageHost` when the page itself was not loaded from loopback.
 * Only for defaults from env: an address typed into the link (`?party=http://localhost:4101`) is kept,
 * because there "localhost" deliberately means the viewer's own party server.
 */
export function onPageHost(url: string, pageHost: string): string {
  if (LOOPBACK.has(pageHost)) return url;
  try {
    const u = new URL(url);
    if (!LOOPBACK.has(u.hostname)) return url;
    u.hostname = pageHost;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}
