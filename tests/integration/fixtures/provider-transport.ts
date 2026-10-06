// Test-only worker bootstrap: preserve Pi's generated path and capture its original
// URL while routing the request to the loopback mock. Not bundled into dist.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  headers.set('x-test-original-url', url.href);
  const origin = process.env.PROVIDER_TEST_ORIGIN!;
  return nativeFetch(`${origin}${url.pathname}${url.search}`, { ...init, headers });
};
// Dynamic import is essential: install transport before the production worker captures fetch.
void import('../../../packages/pi-adapter/src/probe-worker');
