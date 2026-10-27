import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetMockServer } from './src/mocks/server';

afterEach(() => {
  cleanup();
  resetMockServer();
  try {
    sessionStorage.clear();
  } catch {
    /* jsdom luôn có sessionStorage; bỏ qua nếu bị chặn */
  }
});
