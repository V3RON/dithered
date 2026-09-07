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

    const cells = sampleCells(shapes.rozenite, 16);
    expect(cells.length).toBeGreaterThan(0);

    const svg = renderToSvg({
      shape: shapes.rozenite,
      brightness: () => true,
      cols: 16,
      fg: '#8232ff',
    });
    expect(svg).toContain('<svg');
    expect(svg.length).toBeGreaterThan(0);

    const dataUrl = renderToDataURL({
      shape: shapes.rozenite,
      brightness: () => true,
      cols: 16,
      fg: '#8232ff',
    });
    expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
  });
});
