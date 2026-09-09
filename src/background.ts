/**
 * Ack-then-work helper.
 *
 * Telegram retries a webhook it considers failed, so the handler should answer
 * 200 quickly and finish the (slow) AI work afterwards. On Vercel that is what
 * `waitUntil` is for; it is read from the platform's request context so we do
 * not take a dependency on `@vercel/functions` and keep the CJS build as is.
 *
 * Off-platform (local long polling, tests) there is no context, so the caller
 * gets the promise back and simply awaits it.
 */

type WaitUntil = (promise: Promise<unknown>) => void;

interface RequestContextHolder {
  get?: () => { waitUntil?: WaitUntil } | undefined;
}

function getWaitUntil(): WaitUntil | undefined {
  const holder = (globalThis as unknown as Record<symbol, RequestContextHolder | undefined>)[
    Symbol.for('@vercel/request-context')
  ];
  return holder?.get?.()?.waitUntil;
}

/**
 * Hand `task` to the platform if it can outlive the response.
 *
 * Returns `undefined` when it was handed off (the caller may ack immediately),
 * or the promise the caller must await when there is no platform support.
 */
export function runInBackground(task: () => Promise<void>): Promise<void> | undefined {
  const promise = task();
  const waitUntil = getWaitUntil();
  if (waitUntil) {
    waitUntil(promise);
    return undefined;
  }
  return promise;
}

/** True when the platform can keep work alive past the HTTP response. */
export function hasBackgroundSupport(): boolean {
  return getWaitUntil() !== undefined;
}
