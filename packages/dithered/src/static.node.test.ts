// @vitest-environment node
import { describe, expect, it } from 'vitest';

describe('plain Node, no DOM', () => {
  it('has no DOM globals in this environment', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(typeof Path2D).toBe('undefined');
    expect(typeof HTMLCanvasElement).toBe('undefined');
  });

  it('runs sampleCells, renderToSvg and renderToDataURL end to end with no DOM', async () => {
    const { sampleCells, shapes, renderToSvg, renderToDataURL } = await import('./index');

    // `rozenite`'s path is pure H/V — it exercises none of `arcToCubics`,
    // `flattenCubic` or `flattenQuadratic`, so a DOM reference introduced
    // inside any of those would go uncaught here. `circle` (built from
    // `A`) and `heart` (built from `C`) exercise both.
    for (const shape of [shapes.rozenite, shapes.circle, shapes.heart]) {
      const cells = sampleCells(shape, 16);
      expect(cells.length).toBeGreaterThan(0);

      const svg = renderToSvg({ shape, brightness: () => true, cols: 16, fg: '#8232ff' });
      expect(svg).toContain('<svg');
      // A regression that emitted a well-formed but empty `<svg>` (zero
      // drawn cells) would satisfy a bare `.toContain('<svg')`/length
      // check; require actual `<rect>` output.
      const rectCount = (svg.match(/<rect\b/g) ?? []).length;
      expect(rectCount).toBeGreaterThan(0);

      const dataUrl = renderToDataURL({ shape, brightness: () => true, cols: 16, fg: '#8232ff' });
      expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
      const payload = dataUrl.slice('data:image/svg+xml;utf8,'.length);
      expect(decodeURIComponent(payload)).toBe(svg);
    }
  });
});
