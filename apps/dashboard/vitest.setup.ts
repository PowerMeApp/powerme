import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom's AbortSignal is not accepted by Node's Request, which RTK Query's fetchBaseQuery builds.
// Tests never abort a request, so drop the signal (test environment only).
class TestRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
}
globalThis.Request = TestRequest;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    sessionStorage.clear();
  } catch {
    /* jsdom always has sessionStorage */
  }
});
