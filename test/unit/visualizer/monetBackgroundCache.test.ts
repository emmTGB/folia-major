import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MONET_BACKGROUND_TUNING, type Theme } from '@/types';

// test/unit/visualizer/monetBackgroundCache.test.ts
// Exercise the public pipeline with controlled image completion and canvas output.
describe('Monet background cache', () => {
    const encode = vi.fn(() => 'data:image/jpeg;base64,ok');
    let decode = vi.fn(() => Promise.resolve());
    const options = (coverUrl: string) => ({
        coverUrl,
        theme: { backgroundColor: '#000000', accentColor: '#888888', primaryColor: '#ffffff' } as Theme,
        tuning: { ...DEFAULT_MONET_BACKGROUND_TUNING, backgroundGrayscale: 0, backgroundSaturation: 1, backgroundWash: 0 },
    });
    beforeEach(() => {
        vi.resetModules();
        encode.mockReset().mockReturnValue('data:image/jpeg;base64,ok');
        decode = vi.fn(() => Promise.resolve());
        vi.stubGlobal('Image', class { width = 100; height = 100; decode() { return decode(); } });
        const gradient = { addColorStop: vi.fn() };
        vi.stubGlobal('document', { createElement: () => ({
            getContext: () => ({ fillRect() {}, save() {}, restore() {}, drawImage() {},
                createLinearGradient: () => gradient, createRadialGradient: () => gradient }),
            toDataURL: encode,
        }) });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('bounds entries and refreshes LRU order on hits', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        for (let i = 0; i < 8; i++) await resolve(options(String(i)));
        await resolve(options('0'));
        await resolve(options('8'));
        await resolve(options('0'));
        expect(encode).toHaveBeenCalledTimes(9);
        await resolve(options('1'));
        expect(encode).toHaveBeenCalledTimes(10);
        expect(encode).toHaveBeenLastCalledWith('image/jpeg', 0.92);
    });

    it('bounds completed string bytes and does not retain oversized results', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        encode.mockReturnValue('x'.repeat(3 * 1024 * 1024));
        await resolve(options('a'));
        await resolve(options('b'));
        await resolve(options('a'));
        expect(encode).toHaveBeenCalledTimes(3);
        encode.mockReturnValue('x'.repeat(5 * 1024 * 1024));
        await resolve(options('oversized'));
        await resolve(options('oversized'));
        expect(encode).toHaveBeenCalledTimes(5);
        await resolve(options('a'));
        expect(encode).toHaveBeenCalledTimes(5);
    });

    it('retains only the recent window after 100 different backgrounds', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        for (let i = 0; i < 100; i++) await resolve(options(String(i)));
        for (let i = 92; i < 100; i++) await resolve(options(String(i)));
        expect(encode).toHaveBeenCalledTimes(100);
        await resolve(options('91'));
        expect(encode).toHaveBeenCalledTimes(101);
    });

    it('deduplicates pending work and never reinserts an evicted completion', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        let finish!: () => void;
        decode.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
        const old = resolve(options('old'));
        expect(resolve(options('old'))).toBe(old);
        for (let i = 0; i < 8; i++) await resolve(options(String(i)));
        const replacement = resolve(options('old'));
        await replacement;
        finish();
        await old;
        expect(resolve(options('old'))).toBe(replacement);
        expect(decode).toHaveBeenCalledTimes(10);
    });

    it('retries failed and null results', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        encode.mockImplementationOnce(() => { throw new Error('tainted'); });
        await expect(resolve(options('a'))).resolves.toBeNull();
        await expect(resolve(options('a'))).resolves.toContain('data:image');
        vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
        await expect(resolve(options('b'))).resolves.toBeNull();
        await expect(resolve(options('b'))).resolves.toBeNull();
        expect(decode).toHaveBeenCalledTimes(4);
    });

    it('retries an image load failure and retains the successful retry', async () => {
        let attempts = 0;
        vi.stubGlobal('Image', class {
            width = 100;
            height = 100;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            set src(_value: string) {
                const fail = attempts++ === 0;
                queueMicrotask(() => fail ? this.onerror?.() : this.onload?.());
            }
            decode() { return Promise.reject(new Error('decode unavailable')); }
        });
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        await expect(resolve(options('image'))).resolves.toBeNull();
        await expect(resolve(options('image'))).resolves.toContain('data:image');
        await expect(resolve(options('image'))).resolves.toContain('data:image');
        expect(attempts).toBe(2);
        expect(encode).toHaveBeenCalledTimes(1);
    });

    it('does not charge an evicted completion against the current byte budget', async () => {
        const { resolveMonetBackgroundDataUrl: resolve } = await import('@/components/visualizer/monet/monetBackgroundPipeline');
        let finish!: () => void;
        decode.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
        const old = resolve(options('old'));
        for (let i = 0; i < 8; i++) await resolve(options(String(i)));
        encode.mockReturnValue('x'.repeat(3 * 1024 * 1024));
        finish();
        await old;
        await resolve(options('recent'));
        const calls = encode.mock.calls.length;
        await resolve(options('1'));
        await resolve(options('recent'));
        expect(encode).toHaveBeenCalledTimes(calls);
    });
});
