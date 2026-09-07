import { describe, expect, it } from 'vitest';
import { collectGeometry, type SvgNode } from './svg-tree';

/** A minimal hand-built `SvgNode`, for exercising the traversal directly. */
class Node implements SvgNode {
  children: Node[];
  private readonly attrs: Record<string, string>;

  constructor(
    public readonly tag: string,
    attrs: Record<string, string> = {},
    children: Node[] = [],
  ) {
    this.attrs = attrs;
    this.children = children;
  }

  attr(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
}

const root = (children: Node[], attrs: Record<string, string> = {}) =>
  new Node('svg', attrs, children);
const path = (d: string, attrs: Record<string, string> = {}) => new Node('path', { d, ...attrs });

describe('collectGeometry: basic concatenation', () => {
  it('concatenates <path> d values in document order', () => {
    const { path: d } = collectGeometry(root([path('M0 0 Z'), path('M1 1 Z')]), 'test');
    expect(d).toBe('M0 0 Z M1 1 Z');
  });

  it('descends through nested containers (<g>, <a>, unknown tags)', () => {
    const tree = root([
      new Node('g', {}, [new Node('a', {}, [new Node('weird-container', {}, [path('M0 0 Z')])])]),
    ]);
    expect(collectGeometry(tree, 'test').path).toBe('M0 0 Z');
  });

  it('converts basic shapes and concatenates them with <path> in document order', () => {
    const tree = root([
      new Node('rect', { width: '10', height: '10' }),
      path('M99 99 Z'),
      new Node('circle', { r: '5' }),
    ]);
    const { path: d } = collectGeometry(tree, 'test');
    expect(d).toBe('M 0 0 H 10 V 10 H 0 Z M99 99 Z M 5 0 A 5 5 0 0 1 -5 0 A 5 5 0 0 1 5 0 Z');
  });
});

describe('collectGeometry: skip rules', () => {
  it('skips geometry inside <defs>, <clipPath>, <mask>, <symbol>', () => {
    // SvgNode.tag is always lower-cased by the adapter that builds the tree
    // (see svg.ts/svg-lite.ts), so <clipPath> arrives here as "clippath".
    for (const tag of ['defs', 'clippath', 'mask', 'symbol']) {
      const tree = root([new Node(tag, {}, [path('M9 9 Z')]), path('M1 1 Z')]);
      expect(collectGeometry(tree, 'test').path).toBe('M1 1 Z');
    }
  });

  it('skips a whole subtree under display="none", even a nested visible descendant', () => {
    const tree = root([
      new Node('g', { display: 'none' }, [path('M9 9 Z', { display: 'inline' })]),
      path('M1 1 Z'),
    ]);
    expect(collectGeometry(tree, 'test').path).toBe('M1 1 Z');
  });

  it('drops fill="none" geometry with no stroke, but keeps fill="none" with a stroke', () => {
    const tree = root([
      path('M9 9 Z', { fill: 'none' }),
      path('M1 1 Z', { fill: 'none', stroke: 'red' }),
    ]);
    expect(collectGeometry(tree, 'test').path).toBe('M1 1 Z');
  });

  it('resolves fill/stroke down the ancestor chain, so a child can override a root fill="none"', () => {
    const tree = root([path('M1 1 Z', { fill: 'red' })], { fill: 'none' });
    expect(collectGeometry(tree, 'test').path).toBe('M1 1 Z');
  });

  it('drops every path under a root fill="none" with no per-path override', () => {
    const tree = root([path('M9 9 Z')], { fill: 'none' });
    expect(() => collectGeometry(tree, 'test')).toThrow(/no drawable geometry/i);
  });

  it('drops <line> unconditionally (zero area)', () => {
    const tree = root([
      new Node('line', { x1: '0', y1: '0', x2: '10', y2: '10', stroke: 'red' }),
      path('M1 1 Z'),
    ]);
    expect(collectGeometry(tree, 'test').path).toBe('M1 1 Z');
  });
});

describe('collectGeometry: transform', () => {
  it('bakes a transform on the geometry element itself', () => {
    const { path: d } = collectGeometry(
      root([path('M0 0 L10 0', { transform: 'translate(5 5)' })]),
      'test',
    );
    expect(d).toBe('M 5 5 L 15 5');
  });

  it('composes an ancestor <g transform> with the element, parent first', () => {
    const tree = root([
      new Node('g', { transform: 'translate(100 0)' }, [
        path('M0 0 L10 0', { transform: 'scale(2)' }),
      ]),
    ]);
    // scale(2) applies to the geometry first (10,0)*2=(20,0), then translate(100,0).
    expect(collectGeometry(tree, 'test').path).toBe('M 100 0 L 120 0');
  });

  it('composes nested <g transform>s in ancestor order', () => {
    const tree = root([
      new Node('g', { transform: 'translate(10 0)' }, [
        new Node('g', { transform: 'translate(0 10)' }, [path('M0 0 Z')]),
      ]),
    ]);
    expect(collectGeometry(tree, 'test').path).toBe('M 10 10 Z');
  });

  it('leaves an untransformed element unchanged, byte-for-byte (no re-serialize)', () => {
    const { path: d } = collectGeometry(root([path('M0 0 L10 0 A5 5 0 0 1 20 0')]), 'test');
    expect(d).toBe('M0 0 L10 0 A5 5 0 0 1 20 0');
  });

  it("ignores the root <svg>'s own transform attribute", () => {
    const tree = root([path('M0 0 L10 0')], { transform: 'translate(1000 1000)' });
    expect(collectGeometry(tree, 'test').path).toBe('M0 0 L10 0');
  });

  it('throws with the calling label on a malformed transform', () => {
    const tree = root([path('M0 0 Z', { transform: 'spin(10)' })]);
    expect(() => collectGeometry(tree, 'myLoader')).toThrow(/^myLoader:/);
  });
});

describe('collectGeometry: fill-rule', () => {
  it('omits fillRule when every contributing element is nonzero (or unset)', () => {
    const { fillRule } = collectGeometry(
      root([path('M0 0 Z'), path('M1 1 Z', { 'fill-rule': 'nonzero' })]),
      'test',
    );
    expect(fillRule).toBeUndefined();
  });

  it('sets fillRule: evenodd when every contributing element agrees on evenodd', () => {
    const { fillRule } = collectGeometry(
      root([path('M0 0 Z', { 'fill-rule': 'evenodd' })]),
      'test',
    );
    expect(fillRule).toBe('evenodd');
  });

  it('inherits fill-rule from an ancestor', () => {
    const tree = root([new Node('g', { 'fill-rule': 'evenodd' }, [path('M0 0 Z')])]);
    expect(collectGeometry(tree, 'test').fillRule).toBe('evenodd');
  });

  it('throws, naming both rules, when contributing elements disagree', () => {
    const tree = root([
      path('M0 0 Z', { 'fill-rule': 'nonzero' }),
      path('M1 1 Z', { 'fill-rule': 'evenodd' }),
    ]);
    expect(() => collectGeometry(tree, 'test')).toThrow(/nonzero.*evenodd|evenodd.*nonzero/i);
  });

  it('does not let a skipped (hidden) element vote on fill-rule', () => {
    const tree = root([
      path('M9 9 Z', { fill: 'none', 'fill-rule': 'evenodd' }),
      path('M1 1 Z', { 'fill-rule': 'nonzero' }),
    ]);
    expect(collectGeometry(tree, 'test').fillRule).toBeUndefined();
  });
});

describe('collectGeometry: errors', () => {
  it('throws a specific message when the document is all <use>/<text>', () => {
    const tree = root([new Node('use', { href: '#a' }), new Node('text', {}, [])]);
    expect(() => collectGeometry(tree, 'myLoader')).toThrow(/<use>.*<text>|<text>.*<use>/);
    expect(() => collectGeometry(tree, 'myLoader')).toThrow(/myLoader:/);
  });

  it('throws the generic message for a document with no geometry and nothing unsupported', () => {
    expect(() => collectGeometry(root([]), 'myLoader')).toThrow(/myLoader:.*no drawable geometry/i);
  });

  it('does not descend into <use>/<text>/<image> looking for nested geometry', () => {
    const tree = root([new Node('text', {}, [path('M0 0 Z')])]);
    expect(() => collectGeometry(tree, 'test')).toThrow();
  });
});
