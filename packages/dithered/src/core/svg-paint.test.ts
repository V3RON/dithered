import { describe, expect, it } from 'vitest';
import { escapeXml, formatNumber, svgPaintContext } from './svg-paint';

describe('svgPaintContext', () => {
  it('fillRect emits a rect immediately, with the current fillStyle', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 48, 24);

    expect(ctx.toMarkup()).toBe('<rect x="0" y="0" width="48" height="24" fill="#fff"/>');
  });

  it('beginPath + rect + fill emits one rect with the current fill', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#123';
    ctx.beginPath();
    ctx.rect(1, 2, 3, 4);
    ctx.fill();

    expect(ctx.toMarkup()).toBe('<rect x="1" y="2" width="3" height="4" fill="#123"/>');
  });

  it('roundRect emits an rx attribute', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect?.(0, 0, 10, 10, 2.5);
    ctx.fill();

    expect(ctx.toMarkup()).toBe('<rect x="0" y="0" width="10" height="10" rx="2.5" fill="#000"/>');
  });

  it('does not draw a shape that beginPath cleared before fill', () => {
    const ctx = svgPaintContext();
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.beginPath();
    ctx.fill();

    expect(ctx.toMarkup()).toBe('');
  });

  it('groups consecutive same-fill shapes into one <g>, without a fill on each rect', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.fill();
    ctx.beginPath();
    ctx.rect(2, 0, 1, 1);
    ctx.fill();

    expect(ctx.toMarkup()).toBe(
      '<g fill="#111"><rect x="0" y="0" width="1" height="1"/><rect x="2" y="0" width="1" height="1"/></g>',
    );
  });

  it('starts a new group when the fill changes, closing the previous one', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.fill();
    ctx.beginPath();
    ctx.rect(1, 0, 1, 1);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.rect(2, 0, 1, 1);
    ctx.fill();

    const markup = ctx.toMarkup();
    expect(markup).toContain('<g fill="#111">');
    expect(markup.endsWith('<rect x="2" y="0" width="1" height="1" fill="#222"/>')).toBe(true);
  });

  it('a run of exactly one shape gets its fill on the rect, not wrapped in a <g>', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = '#abc';
    ctx.fillRect(0, 0, 1, 1);

    expect(ctx.toMarkup()).not.toContain('<g');
  });

  it('rounds numbers to the given precision and strips trailing zeros', () => {
    const ctx = svgPaintContext({ precision: 2 });
    ctx.fillStyle = '#000';
    ctx.fillRect(1.005, 2.1, 3, 4.999999);

    expect(ctx.toMarkup()).toBe('<rect x="1" y="2.1" width="3" height="5" fill="#000"/>');
  });

  it('escapes " and & in a fill value so a caller-supplied color cannot break the document', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = 'url(#a"b&c)';
    ctx.fillRect(0, 0, 1, 1);

    expect(ctx.toMarkup()).toContain('fill="url(#a&quot;b&amp;c)"');
    expect(ctx.toMarkup()).not.toContain('"b&c'); // raw quote/ampersand must not survive
  });

  it('ignores a non-string fillStyle (a gradient/pattern stand-in) rather than emitting "[object Object]"', () => {
    const ctx = svgPaintContext();
    ctx.fillStyle = {};
    ctx.fillRect(0, 0, 1, 1);

    expect(ctx.toMarkup()).toBe('<rect x="0" y="0" width="1" height="1" fill="#000"/>');
  });
});

describe('formatNumber', () => {
  it('strips trailing zeros', () => {
    expect(formatNumber(1.5, 3)).toBe('1.5');
    expect(formatNumber(2, 3)).toBe('2');
  });

  it('rounds to the given precision', () => {
    expect(formatNumber(1.23456, 2)).toBe('1.23');
  });

  it('never emits a negative zero', () => {
    expect(formatNumber(-0.00001, 3)).toBe('0');
    expect(formatNumber(-0, 3)).toBe('0');
  });
});

describe('escapeXml', () => {
  it('escapes &, <, >, and "', () => {
    expect(escapeXml('a & b < c > d " e')).toBe('a &amp; b &lt; c &gt; d &quot; e');
  });
});
