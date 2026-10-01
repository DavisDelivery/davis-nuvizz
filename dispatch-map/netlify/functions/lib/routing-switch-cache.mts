// netlify/functions/lib/routing-switch-cache.mts
//
// THE SERVER'S COPY OF THE ROUTING-SWITCHES DOCUMENT (src/lib/routing-switches.js). PURE AND
// IMPORT-FREE ON PURPOSE: the switch readers that consult it (routing-time-windows.mts above all)
// are also pulled into the browser bundle, and a reader that imported the Firestore client would
// drag a service-account module into the page. lib/routing-switches-store.mts fills this cache;
// the readers only ever read it.
//
// Empty until hydrated, and in every unit test that does not set it — so a reader with nothing
// cached resolves exactly as it did before the page existed: its environment variable, then its
// default.

let cache: Record<string, any> = {};

/** The stored on/off for `name`, or undefined when the page has not set it (or nothing loaded). */
export function storedRoutingSwitch(name: string): boolean | undefined {
  const v = cache?.[name];
  return v && typeof v === 'object' && typeof v.on === 'boolean' ? v.on : undefined;
}

export function setRoutingSwitchCache(doc: Record<string, any> | null | undefined): void {
  cache = doc && typeof doc === 'object' ? doc : {};
}

export function routingSwitchCache(): Record<string, any> {
  return cache;
}
