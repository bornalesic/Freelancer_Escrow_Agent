import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestBlobUrl } from './http';

const served = (body: string, type: string) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': type } }));

async function blobTypeOf(url: string): Promise<string> {
  return (await (await fetch(url)).blob()).type;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestBlobUrl', () => {
  it('keeps raster images displayable', async () => {
    served('png-bytes', 'image/png');
    const url = await requestBlobUrl('http://agent', '/escrows/x/deliveries/1/files/a.png');
    vi.restoreAllMocks();
    expect(await blobTypeOf(url)).toBe('image/png');
  });

  it.each(['image/svg+xml', 'text/html; charset=utf-8', 'application/xhtml+xml'])(
    'turns %s into a download, so a delivered file never runs as this app',
    async (type) => {
      served('<svg onload="fetch(`http://localhost:4101/wallet/pay`)"/>', type);
      const url = await requestBlobUrl('http://agent', '/escrows/x/deliveries/1/files/evil');
      vi.restoreAllMocks();
      expect(await blobTypeOf(url)).toBe('application/octet-stream');
    },
  );
});
