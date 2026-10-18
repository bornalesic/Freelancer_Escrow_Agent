import { describe, expect, it } from 'vitest';
import { onPageHost } from './pageHost';

describe('onPageHost: env defaults follow the laptop that served the page', () => {
  it.each([
    ['opened from another laptop → its IP', 'http://localhost:4000', '192.168.6.106', 'http://192.168.6.106:4000'],
    ['127.0.0.1 too, path kept', 'http://127.0.0.1:4101/x/', '192.168.6.106', 'http://192.168.6.106:4101/x'],
    ['page opened on this laptop → unchanged', 'http://localhost:4000', 'localhost', 'http://localhost:4000'],
    ['page opened via 127.0.0.1 → unchanged', 'http://localhost:4000', '127.0.0.1', 'http://localhost:4000'],
    ['a real address is never touched', 'http://192.168.1.20:4000', '192.168.6.106', 'http://192.168.1.20:4000'],
    ['not a URL → unchanged', 'nonsense', '192.168.6.106', 'nonsense'],
  ])('%s', (_name, url, pageHost, want) => {
    expect(onPageHost(url, pageHost)).toBe(want);
  });
});
