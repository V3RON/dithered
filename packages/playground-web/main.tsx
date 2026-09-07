import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Dithered, compose, presets, shapeFromSvg, shapes } from 'dithered/react';
import type { Brightness, DitherMatrix, Shape } from 'dithered/react';

const REPO_URL = 'https://github.com/V3RON/dithered';
const ACCENT = '#8232ff';

// ---------------------------------------------------------------------------
// styling helpers (inline styles only — no CSS framework)
// ---------------------------------------------------------------------------

const panel: CSSProperties = {
  background: '#141821',
  border: '1px solid #262c3a',
  borderRadius: 10,
  padding: '20px 24px',
  transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
};

const panelHighlighted: CSSProperties = {
  boxShadow: `0 0 0 2px ${ACCENT}`,
};

const sectionTitle: CSSProperties = {
  margin: '0 0 4px',
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#9aa4b8',
};

const sectionHint: CSSProperties = {
  margin: '0 0 16px',
  fontSize: 13,
  color: '#6b7385',
};

const label: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#9aa4b8',
  marginBottom: 4,
};

const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };

const controlsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 14,
};

const fieldStyle: CSSProperties = {
  width: '100%',
};

const subCard: CSSProperties = {
  background: '#0f1219',
  border: '1px solid #262c3a',
  borderRadius: 8,
  padding: 14,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 64,
  background: '#0b0d12',
  color: '#e6e8ee',
  border: '1px solid #262c3a',
  borderRadius: 6,
  padding: 8,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  resize: 'vertical',
};

const errorStyle: CSSProperties = { color: '#ff6b6b', fontSize: 12, marginTop: 6 };

const buttonStyle: CSSProperties = {
  background: ACCENT,
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const ghostButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
  border: '1px solid #262c3a',
  color: '#e6e8ee',
};

const divider: CSSProperties = {
  borderTop: '1px solid #262c3a',
  marginTop: 24,
  paddingTop: 20,
};

const codeBlockStyle: CSSProperties = {
  background: '#0b0d12',
  border: '1px solid #262c3a',
  borderRadius: 8,
  padding: '12px 14px',
  fontSize: 12.5,
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: '#e6e8ee',
  overflowX: 'auto',
  margin: 0,
};

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 32,
        flexWrap: 'wrap',
        padding: '32px 0 24px',
      }}
    >
      <div style={{ flex: '1 1 340px', minWidth: 280 }}>
        <div style={{ marginBottom: 12 }}>
          <Dithered
            shape={shapes.rozenite}
            brightness={presets.gem()}
            size={28}
            fg={ACCENT}
            label=""
          />
        </div>
        <h1 style={{ fontSize: 42, margin: '0 0 12px', lineHeight: 1.1 }}>dithered</h1>
        <p style={{ fontSize: 17, color: '#c4cad8', margin: '0 0 20px', maxWidth: 480 }}>
          Turn any SVG shape into a little animated, dithered loading spinner. Just a few lines of
          code, and nothing else to install.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <code style={codeBlockStyle}>pnpm add dithered</code>
        </div>
      </div>
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 220,
        }}
      >
        <Dithered
          shape={shapes.rozenite}
          brightness={presets.gem()}
          size={200}
          fg={ACCENT}
          label="dithered loading animation"
        />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Gallery: compact grid of every shape x every preset — click one to load it
// into the playground below
// ---------------------------------------------------------------------------

const SHAPE_ENTRIES = Object.entries(shapes) as [string, Shape][];
const PRESET_ENTRIES = Object.entries(presets) as [
  string,
  (opts?: Record<string, unknown>) => Brightness,
][];

// Three plain <circle> elements, not a hand-rolled <path> — deliberately
// not one of the built-in shapes, so switching to "Custom SVG" always
// starts from something new to look at, and doubles as a live example of
// the basic-shape support (ADR 0010): every element here is unioned into
// one Shape, same as a design tool's multi-object SVG export.
const DEFAULT_CUSTOM_SVG = `<svg viewBox="0 0 100 100">
  <circle cx="50" cy="30" r="24" />
  <circle cx="24" cy="74" r="24" />
  <circle cx="76" cy="74" r="24" />
</svg>`;

// Computed once at module load: every brightness instance below is a stable
// reference, so `Dithered` never reconfigures its gallery instances. The
// trailing "custom" entry gives ADR 0010's basic-shape support a visible
// example right in the gallery, not just as the "Custom (paste SVG)"
// textarea's placeholder text.
const GALLERY_ITEMS = [
  ...SHAPE_ENTRIES.flatMap(([shapeName, shape]) =>
    PRESET_ENTRIES.map(([presetName, factory]) => ({
      key: `${shapeName}-${presetName}`,
      label: `${shapeName} / ${presetName}`,
      shapeName,
      presetName,
      shape,
      brightness: factory(),
    })),
  ),
  {
    key: 'custom-gem',
    label: 'custom (3 circles) / gem',
    shapeName: 'custom',
    presetName: 'gem',
    shape: shapeFromSvg(DEFAULT_CUSTOM_SVG),
    brightness: presets.gem(),
  },
];

interface GalleryProps {
  onSelect: (shapeName: string, presetName: string) => void;
}

function Gallery({ onSelect }: GalleryProps) {
  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Every shape, every animation</h2>
      <p style={sectionHint}>Click one to load it into the playground below.</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))',
          gap: 8,
        }}
      >
        {GALLERY_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="gallery-item"
            title={item.label}
            aria-label={`Load the ${item.shapeName} shape with the ${item.presetName} animation`}
            onClick={() => onSelect(item.shapeName, item.presetName)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: '1px solid transparent',
              borderRadius: 8,
              padding: 4,
              cursor: 'pointer',
            }}
          >
            <Dithered
              shape={item.shape}
              brightness={item.brightness}
              size={40}
              fg={ACCENT}
              label=""
            />
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fill the box: a resizable container demonstrating `size="fill"` — drag the
// bottom-right corner and the shape re-fits to the new box on every resize.
// ---------------------------------------------------------------------------

const fillBoxStyle: CSSProperties = {
  resize: 'both',
  overflow: 'hidden',
  minWidth: 120,
  minHeight: 120,
  width: 320,
  height: 200,
  maxWidth: '100%',
  background: '#0f1219',
  border: `1px dashed ${ACCENT}`,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 12,
};

// Stable identity across renders: `FillBox`'s own `ResizeObserver` calls
// `setBox` on every delivery (for the "measured box" readout), which
// re-renders the component on every drag frame. An inline `presets.gem()`
// in the JSX below would rebuild its identity on each of those renders,
// which the `Dithered` wrapper treats as a `brightness` change and
// reconfigures for — rebuilding the sprite strip on every pointermove and
// defeating the exact optimization this demo exists to show off.
const FILL_BOX_BRIGHTNESS = presets.gem();

function FillBox() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setBox({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Fill the box</h2>
      <p style={sectionHint}>
        <code>size=&quot;fill&quot;</code> tracks its parent instead of a fixed height. Drag the
        dashed box's bottom-right corner — the shape re-fits on every resize, no code involved.
      </p>
      <div ref={containerRef} style={fillBoxStyle}>
        <Dithered
          shape={shapes.rozenite}
          brightness={FILL_BOX_BRIGHTNESS}
          size="fill"
          fg={ACCENT}
          label="A resizable dithered shape filling its container"
        />
      </div>
      <p style={{ ...sectionHint, margin: '10px 0 0' }}>
        Measured box: {box ? `${box.width} × ${box.height}px` : '—'}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loading -> done: the headline `transitionTo`/`transition` use case
// (ADR 0004, issue #4) — flip `shape`/`brightness` and the indicator
// morphs between them instead of cutting, with `transition` as the only
// prop that changed. Identical on `dithered/react` and `dithered/native`.
// ---------------------------------------------------------------------------

const LOADING_DONE_SNIPPET = `<Dithered
  shape={done ? shapes.check : shapes.rozenite}
  brightness={done ? presets.fill() : presets.gem()}
  transition={{ duration: 400 }}
  fg="${ACCENT}"
/>`;

// Module-level, not `presets.fill()`/`presets.gem()` called inline in the
// JSX below — see the caveat on `Dithered`'s `brightness` prop in
// `react.tsx` and in the README's Transitions section. `dithered/react`
// diffs `brightness` (and `shape`) by identity, and with `transition` set
// (as it is here) a changed identity doesn't just trigger a resample —
// it starts a real `transitionTo()` morph. Calling `presets.fill()` fresh
// on every render meant every *unrelated* re-render of the playground
// (dragging the size slider, picking a shape elsewhere on the page — any
// `App`-level state change, since this component isn't memoized) cut a
// morph short and started a new one from the shape to itself.
const LOADING_DONE_FILL = presets.fill();
const LOADING_DONE_GEM = presets.gem();

function LoadingToDone() {
  const [done, setDone] = useState(false);

  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Loading → done</h2>
      <p style={sectionHint}>
        The one prop change a loading indicator almost always needs: flip <code>shape</code> and{' '}
        <code>brightness</code> together and, with <code>transition</code> set, dithered morphs
        smoothly between them instead of jumping.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 96,
            height: 96,
          }}
        >
          <Dithered
            shape={done ? shapes.check : shapes.rozenite}
            brightness={done ? LOADING_DONE_FILL : LOADING_DONE_GEM}
            transition={{ duration: 400 }}
            size={72}
            fg={ACCENT}
            label={done ? 'Done' : 'Loading'}
          />
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 240 }}>
          <button onClick={() => setDone((v) => !v)} style={buttonStyle}>
            {done ? 'Reset' : 'Simulate completion'}
          </button>
          <pre style={{ ...codeBlockStyle, marginTop: 14 }}>{LOADING_DONE_SNIPPET}</pre>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Playground: live preview + controls + paste-your-SVG + advanced options +
// a code snippet that always matches whatever's currently configured
// ---------------------------------------------------------------------------

// The named matrices, in the order the "Matrix" select offers them.
const MATRIX_NAMES: Extract<DitherMatrix, string>[] = ['bayer2', 'bayer4', 'bayer8', 'blueNoise'];

function parseCustomShape(svg: string): { shape: Shape | null; error: string | null } {
  try {
    return { shape: shapeFromSvg(svg), error: null };
  } catch (err) {
    return { shape: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// Darkest -> brightest, one default per tone count rather than a single
// 3-tone array indexed by position: the accent is always present, and every
// entry is distinct from the others *at that tone count*. Indexing a single
// default array by position would make `DEFAULT_PALETTE[1] === ACCENT`
// collide with the 1-tone default (also just `[ACCENT]`), producing a
// duplicate the moment the user grew from the untouched default — see ADR
// 0005 review round 2, finding 1.
const DEFAULT_PALETTES: Readonly<Record<1 | 2 | 3, readonly string[]>> = {
  1: [ACCENT],
  2: ['#2a1a4a', ACCENT],
  3: ['#2a1a4a', ACCENT, '#d9c2ff'],
};

/** Whether `palette` is exactly the untouched default for its own length. */
function isDefaultPalette(palette: readonly string[]): boolean {
  const def = DEFAULT_PALETTES[palette.length as 1 | 2 | 3] as readonly string[] | undefined;
  return def !== undefined && palette.every((color, i) => color === def[i]);
}

/**
 * Grows or shrinks `palette` to exactly `count` tones (1-3).
 *
 * - If `palette` is still the untouched default for its current length, the
 *   whole palette switches wholesale to the default for `count` — growing
 *   *and* shrinking. This is what makes the default 1 -> 2 -> 3 -> 2 -> 1
 *   path show a genuinely new tone at every step and land back on the plain
 *   accent at 1, instead of e.g. truncating 2 tones down to `['#2a1a4a']`
 *   (losing the accent) or filling new slots positionally from a palette
 *   anchored at a different length (the duplicate in finding 1).
 * - Otherwise the user has edited at least one swatch, so their colors are
 *   preserved: shrinking truncates (keeping the darker tones, since the
 *   palette is darkest-first), and growing fills only the new slots, each
 *   from the 3-tone default pool, skipping any candidate already present in
 *   the palette so growing never introduces a duplicate tone.
 */
function resizePalette(palette: string[], count: number): string[] {
  if (isDefaultPalette(palette)) return [...DEFAULT_PALETTES[count as 1 | 2 | 3]];

  if (count <= palette.length) return palette.slice(0, count);

  const next = palette.slice();
  const pool = DEFAULT_PALETTES[3];
  for (let i = palette.length; i < count; i++) {
    next.push(pool.find((color) => !next.includes(color)) ?? ACCENT);
  }
  return next;
}

export interface PlaygroundState {
  shapeKey: string;
  setShapeKey: (key: string) => void;
  presetKey: string;
  setPresetKey: (key: string) => void;
  blendKey: string;
  setBlendKey: (key: string) => void;
  mix: number;
  setMix: (mix: number) => void;
  /** Darkest-first; a single entry renders (and is emitted) as a plain color, not a one-tone array. */
  palette: string[];
  setPalette: (palette: string[]) => void;
  cols: number;
  setCols: (cols: number) => void;
  matrix: Extract<DitherMatrix, string>;
  setMatrix: (matrix: Extract<DitherMatrix, string>) => void;
  period: number;
  setPeriod: (period: number) => void;
  speed: number;
  setSpeed: (speed: number) => void;
  noiseAmt: number;
  setNoiseAmt: (n: number) => void;
  golSeed: number;
  setGolSeed: (n: number) => void;
  svgText: string;
  setSvgText: (svg: string) => void;
  highlighted: boolean;
}

const Playground = forwardRef<HTMLElement, PlaygroundState>(function Playground(
  {
    shapeKey,
    setShapeKey,
    presetKey,
    setPresetKey,
    blendKey,
    setBlendKey,
    mix,
    setMix,
    palette,
    setPalette,
    cols,
    setCols,
    matrix,
    setMatrix,
    period,
    setPeriod,
    speed,
    setSpeed,
    noiseAmt,
    setNoiseAmt,
    golSeed,
    setGolSeed,
    svgText,
    setSvgText,
    highlighted,
  },
  ref,
) {
  const [customShape, setCustomShape] = useState<Shape | null>(
    () => parseCustomShape(DEFAULT_CUSTOM_SVG).shape,
  );
  const [svgError, setSvgError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const isCustomShape = shapeKey === 'custom';

  const setToneCount = (count: number) => setPalette(resizePalette(palette, count));
  const setToneColor = (index: number, color: string) =>
    setPalette(palette.map((c, i) => (i === index ? color : c)));
  // `<Dithered>`'s `fg` and `buildSnippet`'s emitted prop both collapse a
  // one-tone palette back to a plain string, so `fg="..."` (not
  // `fg={['...']}`) is what a single swatch produces — matching the
  // library's own `n === 1` fast path (see ADR 0005 §2/§3).
  const fg = palette.length === 1 ? palette[0] : palette;

  // Re-parse the pasted SVG whenever it changes, but only while it's
  // actually in use — so the textarea "reacts to changes" without the user
  // having to click an Apply button. Keeps showing the last valid shape
  // while the SVG is mid-edit and invalid, rather than flashing blank.
  useEffect(() => {
    if (!isCustomShape) return;
    const id = setTimeout(() => {
      const { shape: parsed, error } = parseCustomShape(svgText);
      if (parsed) setCustomShape(parsed);
      setSvgError(error);
    }, 300);
    return () => clearTimeout(id);
  }, [svgText, isCustomShape]);

  const shape = isCustomShape
    ? (customShape ?? shapes.rozenite)
    : shapes[shapeKey as keyof typeof shapes];

  // `mix` only parameterizes the closure `compose.blend` returns — it plays
  // no part in constructing `primary`/`secondary` — so it's kept out of this
  // memo's deps. Otherwise every slider step would rebuild both presets
  // (e.g. re-running 48 generations of `gameOfLife`'s board), which this
  // split avoids. It does *not* avoid a repaint: the `brightness` memo below
  // still returns a new `compose.blend(...)` closure on every `mix` step,
  // `Dithered`'s reconfigure effect depends on `brightness` by identity, and
  // `renderer.ts`'s `update()` unconditionally calls `configure()` — which
  // re-samples cells and repaints every frame regardless. The slider still
  // works correctly; this split just keeps a mix drag from *also* re-running
  // the (possibly expensive) preset factories on top of that.
  const presetsForBlend = useMemo(() => {
    const factory = presets[presetKey as keyof typeof presets];
    const primary =
      presetKey === 'gem'
        ? factory({ noise: noiseAmt })
        : presetKey === 'gameOfLife'
          ? factory({ seed: golSeed })
          : factory();
    if (blendKey === 'none') return { primary, secondary: null };
    const secondary = presets[blendKey as keyof typeof presets]();
    return { primary, secondary };
  }, [presetKey, noiseAmt, golSeed, blendKey]);

  const brightness = useMemo(() => {
    const { primary, secondary } = presetsForBlend;
    if (!secondary) return primary;
    return compose.blend(primary, secondary, mix);
  }, [presetsForBlend, mix]);

  const snippet = useMemo(
    () =>
      buildSnippet({
        isCustomShape,
        shapeKey,
        svgText,
        presetKey,
        noiseAmt,
        golSeed,
        blendKey,
        mix,
        palette,
        cols,
        matrix,
        period,
        speed,
      }),
    [
      isCustomShape,
      shapeKey,
      svgText,
      presetKey,
      noiseAmt,
      golSeed,
      blendKey,
      mix,
      palette,
      cols,
      matrix,
      period,
      speed,
    ],
  );

  return (
    <section ref={ref} style={{ ...panel, ...(highlighted ? panelHighlighted : {}) }}>
      <h2 style={sectionTitle}>Play with it</h2>
      <p style={sectionHint}>
        Pick a shape and an animation, tweak the knobs, then grab the code at the bottom.
      </p>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 140,
          }}
        >
          <Dithered
            shape={shape}
            brightness={brightness}
            size={140}
            fg={fg}
            cols={cols}
            matrix={matrix}
            period={period}
            speed={speed}
            label="Preview"
          />
        </div>

        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={controlsGrid}>
            <label style={row}>
              <span style={label}>Shape</span>
              <select
                style={fieldStyle}
                value={shapeKey}
                onChange={(e) => setShapeKey(e.target.value)}
              >
                {SHAPE_ENTRIES.map(([name]) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value="custom">Custom (paste SVG)</option>
              </select>
            </label>

            <label style={row}>
              <span style={label}>Animation</span>
              <select
                style={fieldStyle}
                value={presetKey}
                onChange={(e) => setPresetKey(e.target.value)}
              >
                {PRESET_ENTRIES.map(([name]) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label style={row}>
              <span style={label}>Blend with</span>
              <select
                style={fieldStyle}
                value={blendKey}
                onChange={(e) => setBlendKey(e.target.value)}
              >
                <option value="none">None</option>
                {PRESET_ENTRIES.map(([name]) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label style={row}>
              <span style={label}>Tones</span>
              <select
                style={fieldStyle}
                value={palette.length}
                onChange={(e) => setToneCount(Number(e.target.value))}
              >
                <option value={1}>1 (single color)</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
          </div>

          {blendKey !== 'none' && (
            <label style={row}>
              <span style={label}>Mix: {mix.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={mix}
                onChange={(e) => setMix(Number(e.target.value))}
              />
            </label>
          )}

          <div style={row}>
            <span style={label}>
              {palette.length > 1 ? 'Palette (darkest → brightest)' : 'Color'}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {palette.map((color, i) => (
                <input
                  key={i}
                  type="color"
                  value={color}
                  onChange={(e) => setToneColor(i, e.target.value)}
                  aria-label={palette.length > 1 ? `Tone ${i + 1} of ${palette.length}` : 'Color'}
                />
              ))}
            </div>
          </div>

          {isCustomShape && (
            <div style={subCard}>
              <span style={label}>Paste your own SVG</span>
              <textarea
                style={textareaStyle}
                value={svgText}
                onChange={(e) => setSvgText(e.target.value)}
                spellCheck={false}
              />
              <p style={{ ...sectionHint, margin: '6px 0 0' }}>
                Needs a viewBox and at least one shape (&lt;path&gt;, &lt;rect&gt;, &lt;circle&gt;,
                &lt;ellipse&gt;, &lt;polygon&gt; or &lt;polyline&gt;) — the preview updates as you
                type.
              </p>
              {svgError && <div style={errorStyle}>{svgError}</div>}
            </div>
          )}

          <div>
            <button onClick={() => setAdvanced((v) => !v)} style={ghostButtonStyle}>
              {advanced ? 'Hide advanced options' : 'Advanced options'}
            </button>
          </div>

          {advanced && (
            <div style={{ ...subCard, ...controlsGrid }}>
              <label style={row}>
                <span style={label}>Columns: {cols}</span>
                <input
                  type="range"
                  min={8}
                  max={48}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                />
              </label>
              <label style={row}>
                <span style={label}>Matrix</span>
                <select
                  style={fieldStyle}
                  value={matrix}
                  onChange={(e) => setMatrix(e.target.value as Extract<DitherMatrix, string>)}
                >
                  {MATRIX_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={row}>
                <span style={label}>Loop duration: {period}ms</span>
                <input
                  type="range"
                  min={200}
                  max={6000}
                  step={100}
                  value={period}
                  onChange={(e) => setPeriod(Number(e.target.value))}
                />
              </label>
              <label style={row}>
                <span style={label}>Playback speed: {speed.toFixed(1)}x</span>
                <input
                  type="range"
                  min={-3}
                  max={3}
                  step={0.1}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                />
              </label>
              {presetKey === 'gem' && (
                <label style={row}>
                  <span style={label}>Noise: {noiseAmt.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1.4}
                    step={0.05}
                    value={noiseAmt}
                    onChange={(e) => setNoiseAmt(Number(e.target.value))}
                  />
                </label>
              )}
              {presetKey === 'gameOfLife' && (
                <label style={row}>
                  <span style={label}>Seed</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      value={golSeed}
                      onChange={(e) => setGolSeed(Number(e.target.value))}
                      style={{ width: 90 }}
                    />
                    <button
                      onClick={() => setGolSeed(Math.floor(Math.random() * 100000))}
                      style={ghostButtonStyle}
                    >
                      Random
                    </button>
                  </div>
                </label>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={divider}>
        <h3 style={sectionTitle}>Grab the code</h3>
        <p style={sectionHint}>This matches whatever you've got set up above.</p>
        <pre style={codeBlockStyle}>{snippet}</pre>
        <p style={{ ...sectionHint, margin: '12px 0 0' }}>
          On React Native / Expo? Swap the import for{' '}
          <code style={{ ...codeBlockStyle, display: 'inline', padding: '2px 6px' }}>
            dithered/react-native
          </code>{' '}
          — same API, rendered through react-native-skia.
        </p>
      </div>
    </section>
  );
});

function buildSnippet(opts: {
  isCustomShape: boolean;
  shapeKey: string;
  svgText: string;
  presetKey: string;
  noiseAmt: number;
  golSeed: number;
  blendKey: string;
  mix: number;
  palette: string[];
  cols: number;
  matrix: Extract<DitherMatrix, string>;
  period: number;
  speed: number;
}): string {
  const {
    isCustomShape,
    shapeKey,
    svgText,
    presetKey,
    noiseAmt,
    golSeed,
    blendKey,
    mix,
    palette,
    cols,
    matrix,
    period,
    speed,
  } = opts;

  const presetArgParts: string[] = [];
  if (presetKey === 'gem' && noiseAmt !== 0.8) presetArgParts.push(`noise: ${noiseAmt}`);
  if (presetKey === 'gameOfLife' && golSeed !== 1) presetArgParts.push(`seed: ${golSeed}`);
  const presetArgs = presetArgParts.length ? `{ ${presetArgParts.join(', ')} }` : '';
  const isBlending = blendKey !== 'none';
  const brightnessExpr = isBlending
    ? `compose.blend(presets.${presetKey}(${presetArgs}), presets.${blendKey}(), ${mix})`
    : `presets.${presetKey}(${presetArgs})`;

  // A single tone is a plain string prop, matching the library's own
  // `n === 1` fast path; only 2+ tones become an array literal.
  const fgProp =
    palette.length === 1
      ? `fg="${palette[0]}"`
      : `fg={[${palette.map((color) => `'${color}'`).join(', ')}]}`;

  const propParts = [
    `shape={${isCustomShape ? 'shape' : `shapes.${shapeKey}`}}`,
    `brightness={${brightnessExpr}}`,
    fgProp,
  ];
  if (cols !== 16) propParts.push(`cols={${cols}}`);
  if (matrix !== 'bayer4') propParts.push(`matrix="${matrix}"`);
  if (period !== 2000) propParts.push(`period={${period}}`);
  if (speed !== 1) propParts.push(`speed={${speed}}`);

  const jsx = `<Dithered\n  ${propParts.join('\n  ')}\n/>`;

  const namedImports = (names: (string | false)[]) => names.filter(Boolean).join(', ');

  if (isCustomShape) {
    return (
      `import { ${namedImports(['Dithered', 'presets', isBlending && 'compose', 'shapeFromSvg'])} } from 'dithered/react';\n\n` +
      `const shape = shapeFromSvg(\`${svgText}\`);\n\n` +
      jsx
    );
  }

  return (
    `import { ${namedImports(['Dithered', 'shapes', 'presets', isBlending && 'compose'])} } from 'dithered/react';\n\n` +
    jsx
  );
}

// ---------------------------------------------------------------------------
// Scrub: a range input driving `time` directly, next to a free-running
// instance of the same shape/animation — the acceptance criterion for
// external playback control (issue #6). `time` bypasses the internal
// clock entirely, so the left indicator only ever shows what the slider
// says, however fast or slow it's dragged.
// ---------------------------------------------------------------------------

// Stable references so neither `<Dithered>` below re-records/reconfigures
// on every render of the slider's own state.
const SCRUB_SHAPE = shapes.heart;
const SCRUB_BRIGHTNESS = presets.pulse();

const SCRUB_SNIPPET = `import { Dithered } from 'dithered/react';
import { shapes, presets } from 'dithered';

// \`time\` is in loop units (1 = one full loop) and pauses the internal
// clock — drive it from a slider, a scroll position, or a shared value.
<Dithered shape={shapes.heart} brightness={presets.pulse()} time={scrubPosition} />`;

function ScrubExample() {
  const [scrub, setScrub] = useState(0);

  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Scrub playback</h2>
      <p style={sectionHint}>
        Drag the slider to drive the left indicator with the <code>time</code> prop directly — no
        animation loop, no internal clock. The right one keeps looping on its own, for comparison.
      </p>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Dithered
              shape={SCRUB_SHAPE}
              brightness={SCRUB_BRIGHTNESS}
              size={90}
              fg={ACCENT}
              time={scrub}
              label="Scrubbed preview"
            />
            <span style={label}>time = {scrub.toFixed(3)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Dithered
              shape={SCRUB_SHAPE}
              brightness={SCRUB_BRIGHTNESS}
              size={90}
              fg={ACCENT}
              label="Free-running preview"
            />
            <span style={label}>free-running</span>
          </div>
        </div>

        <div style={{ flex: '1 1 260px', minWidth: 220 }}>
          <label style={row}>
            <span style={label}>Scrub position</span>
            <input
              type="range"
              min={0}
              max={0.999}
              step={0.001}
              value={scrub}
              onChange={(e) => setScrub(Number(e.target.value))}
              style={fieldStyle}
              aria-label="Scrub position"
            />
          </label>
        </div>
      </div>

      <div style={divider}>
        <h3 style={sectionTitle}>Grab the code</h3>
        <pre style={codeBlockStyle}>{SCRUB_SNIPPET}</pre>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer
      style={{
        textAlign: 'center',
        fontSize: 13,
        color: '#6b7385',
        padding: '8px 0 24px',
      }}
    >
      MIT licensed.{' '}
      <a href={REPO_URL} style={{ color: '#9aa4b8' }}>
        Poke around on GitHub ↗
      </a>
    </footer>
  );
}

// ---------------------------------------------------------------------------

const DEFAULTS = {
  shapeKey: 'rozenite',
  presetKey: 'gem',
  blendKey: 'none',
  mix: 0.5,
  palette: [...DEFAULT_PALETTES[1]],
  cols: 16,
  matrix: 'bayer4' as Extract<DitherMatrix, string>,
  period: 2000,
  speed: 1,
  noiseAmt: 0.8,
  golSeed: 1,
};

function App() {
  const [shapeKey, setShapeKey] = useState(DEFAULTS.shapeKey);
  const [presetKey, setPresetKey] = useState(DEFAULTS.presetKey);
  const [blendKey, setBlendKey] = useState(DEFAULTS.blendKey);
  const [mix, setMix] = useState(DEFAULTS.mix);
  const [palette, setPalette] = useState<string[]>(DEFAULTS.palette);
  const [cols, setCols] = useState(DEFAULTS.cols);
  const [matrix, setMatrix] = useState(DEFAULTS.matrix);
  const [period, setPeriod] = useState(DEFAULTS.period);
  const [speed, setSpeed] = useState(DEFAULTS.speed);
  const [noiseAmt, setNoiseAmt] = useState(DEFAULTS.noiseAmt);
  const [golSeed, setGolSeed] = useState(DEFAULTS.golSeed);
  const [svgText, setSvgText] = useState(DEFAULT_CUSTOM_SVG);
  const [highlighted, setHighlighted] = useState(false);

  const playgroundRef = useRef<HTMLElement | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyExample = (nextShapeKey: string, nextPresetKey: string) => {
    setShapeKey(nextShapeKey);
    setPresetKey(nextPresetKey);
    // Reset the textarea too, so the "custom" gallery tile always shows
    // its three-circle example rather than whatever a prior edit left in
    // svgText — built-in shapes ignore svgText, so this is a no-op for them.
    if (nextShapeKey === 'custom') setSvgText(DEFAULT_CUSTOM_SVG);
    setBlendKey(DEFAULTS.blendKey);
    setMix(DEFAULTS.mix);
    setPalette(DEFAULTS.palette);
    setCols(DEFAULTS.cols);
    setMatrix(DEFAULTS.matrix);
    setPeriod(DEFAULTS.period);
    setSpeed(DEFAULTS.speed);
    setNoiseAmt(DEFAULTS.noiseAmt);
    setGolSeed(DEFAULTS.golSeed);

    playgroundRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
    setHighlighted(true);
    highlightTimeout.current = setTimeout(() => setHighlighted(false), 900);
  };

  return (
    <div
      style={{
        maxWidth: 1000,
        margin: '0 auto',
        padding: '0 20px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <Hero />
      <Gallery onSelect={applyExample} />
      <LoadingToDone />
      <FillBox />
      <Playground
        ref={playgroundRef}
        shapeKey={shapeKey}
        setShapeKey={setShapeKey}
        presetKey={presetKey}
        setPresetKey={setPresetKey}
        blendKey={blendKey}
        setBlendKey={setBlendKey}
        mix={mix}
        setMix={setMix}
        palette={palette}
        setPalette={setPalette}
        cols={cols}
        setCols={setCols}
        matrix={matrix}
        setMatrix={setMatrix}
        period={period}
        setPeriod={setPeriod}
        speed={speed}
        setSpeed={setSpeed}
        noiseAmt={noiseAmt}
        setNoiseAmt={setNoiseAmt}
        golSeed={golSeed}
        setGolSeed={setGolSeed}
        svgText={svgText}
        setSvgText={setSvgText}
        highlighted={highlighted}
      />
      <ScrubExample />
      <Footer />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');
createRoot(container).render(<App />);
