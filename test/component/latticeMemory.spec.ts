import { expect, test } from './fixtures';

// test/component/latticeMemory.spec.ts
// A destroyed card renderer must be collectible without another card ever being opened.
test('releases the last destroyed lyric runtime and its detached host', async ({ page }) => {
    await page.goto('/dev-probe.html');
    await page.evaluate(async () => {
        const runtimePath = '/src/components/app/lattice/lyrics/createLatticeLyricRuntime.ts';
        const themePath = '/src/services/baseThemes.ts';
        const pixiPath = '/src/components/visualizer/loadPixi.ts';
        const rasterPath = '/src/components/app/lattice/lyrics/latticeLyricRaster.ts';
        const { createLatticeLyricRuntime } = await import(runtimePath);
        const { DEFAULT_THEME } = await import(themePath);
        const pixi = await (await import(pixiPath)).loadPixi();
        const { createLatticeRaster } = await import(rasterPath);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const runtime = await createLatticeLyricRuntime(host, {
            songKey: 'memory-probe', currentTime: { get: () => 0, on: () => () => {} },
            currentLineIndex: 0, lines: [], theme: DEFAULT_THEME,
            keywordColoringEnabled: false, reducedMotion: true, fontsEpoch: 0,
        }, new AbortController().signal, () => {});
        if (!runtime) throw new Error('Runtime failed to initialize');
        const idleTexture = pixi.TexturePool.getOptimalTexture(256, 256);
        const liveTexture = pixi.TexturePool.getOptimalTexture(256, 256);
        pixi.TexturePool.returnTexture(idleTexture);
        const idleCanvas = pixi.CanvasPool.getOptimalCanvasAndContext(256, 256);
        pixi.CanvasPool.returnCanvasAndContext(idleCanvas);
        const glyph = createLatticeRaster(pixi).rasterize('memory', '32px sans-serif', 32, 1);
        const glyphCanvas = glyph.texture.source.resource;
        glyph.texture.destroy(true);
        const rendererCanvas = host.querySelector('canvas')!;
        (window as unknown as { retired: WeakRef<object>[] }).retired = [new WeakRef(runtime), new WeakRef(host), new WeakRef(idleCanvas)];
        runtime.destroy();
        if (!idleTexture.destroyed || liveTexture.destroyed) throw new Error('Idle/live texture ownership broken');
        if (glyphCanvas.width || glyphCanvas.height || rendererCanvas.width || rendererCanvas.height) {
            throw new Error('Retired canvas pixels retained');
        }
        pixi.TexturePool.returnTexture(liveTexture);
        pixi.TexturePool.clear();
        host.remove();
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    expect(await page.evaluate(() => (window as unknown as { retired: WeakRef<object>[] })
        .retired.map(ref => ref.deref() === undefined))).toEqual([true, true, true]);
    await cdp.detach();
});

test('leaving the queue releases the lyric canvas when its exit animation finishes', async ({ mount, page }) => {
    const wall = await mount('lattice', { withLyrics: true });
    const canvas = wall.locator('.lattice-lyrics.is-ready canvas');
    await expect(canvas).toHaveCount(1);
    await canvas.evaluate(node => {
        // Intentionally retain only this canvas to check its native backing size after teardown.
        (window as unknown as { retiredCanvas: HTMLCanvasElement }).retiredCanvas = node as HTMLCanvasElement;
    });
    await wall.getByRole('button', { name: 'Leave queue' }).click();
    await expect(wall.locator('.lattice-root')).toHaveCount(0);
    expect(await page.evaluate(() => {
        const canvas = (window as unknown as { retiredCanvas: HTMLCanvasElement }).retiredCanvas;
        return [canvas.width, canvas.height];
    })).toEqual([0, 0]);
});
