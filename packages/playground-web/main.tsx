import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Dithered, compose, presets, shapeFromSvg, shapes } from 'dithered/react';
import type { Brightness, Shape } from 'dithered/react';

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

// Computed once at module load: every brightness instance below is a stable
// reference, so `Dithered` never reconfigures its gallery instances.
const GALLERY_ITEMS = SHAPE_ENTRIES.flatMap(([shapeName, shape]) =>
  PRESET_ENTRIES.map(([presetName, factory]) => ({
    key: `${shapeName}-${presetName}`,
    label: `${shapeName} / ${presetName}`,
    shapeName,
    presetName,
    shape,
    brightness: factory(),
  })),
);

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
// Playground: live preview + controls + paste-your-SVG + advanced options +
// a code snippet that always matches whatever's currently configured
// ---------------------------------------------------------------------------

// A five-pointed star — deliberately not one of the built-in shapes, so
// switching to "Custom SVG" always starts from something new to look at.
const DEFAULT_CUSTOM_SVG = `<svg viewBox="0 0 100 100">
  <path d="M50 2 L61 37 L98 37 L68 59 L79 95 L50 73 L21 95 L32 59 L2 37 L39 37 Z" />
</svg>`;

function parseCustomShape(svg: string): { shape: Shape | null; error: string | null } {
  try {
    return { shape: shapeFromSvg(svg), error: null };
  } catch (err) {
    return { shape: null, error: err instanceof Error ? err.message : String(err) };
  }
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
  fg: string;
  setFg: (fg: string) => void;
  cols: number;
  setCols: (cols: number) => void;
  period: number;
  setPeriod: (period: number) => void;
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
    fg,
    setFg,
    cols,
    setCols,
    period,
    setPeriod,
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
        fg,
        cols,
        period,
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
      fg,
      cols,
      period,
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
            period={period}
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
              <span style={label}>Color</span>
              <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
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
                Needs a viewBox and at least one &lt;path&gt; — the preview updates as you type.
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
                <span style={label}>Speed: {period}ms per loop</span>
                <input
                  type="range"
                  min={200}
                  max={6000}
                  step={100}
                  value={period}
                  onChange={(e) => setPeriod(Number(e.target.value))}
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
  fg: string;
  cols: number;
  period: number;
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
    fg,
    cols,
    period,
  } = opts;

  const presetArgParts: string[] = [];
  if (presetKey === 'gem' && noiseAmt !== 0.8) presetArgParts.push(`noise: ${noiseAmt}`);
  if (presetKey === 'gameOfLife' && golSeed !== 1) presetArgParts.push(`seed: ${golSeed}`);
  const presetArgs = presetArgParts.length ? `{ ${presetArgParts.join(', ')} }` : '';
  const isBlending = blendKey !== 'none';
  const brightnessExpr = isBlending
    ? `compose.blend(presets.${presetKey}(${presetArgs}), presets.${blendKey}(), ${mix})`
    : `presets.${presetKey}(${presetArgs})`;

  const propParts = [
    `shape={${isCustomShape ? 'shape' : `shapes.${shapeKey}`}}`,
    `brightness={${brightnessExpr}}`,
    `fg="${fg}"`,
  ];
  if (cols !== 16) propParts.push(`cols={${cols}}`);
  if (period !== 2000) propParts.push(`period={${period}}`);

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
  fg: ACCENT,
  cols: 16,
  period: 2000,
  noiseAmt: 0.8,
  golSeed: 1,
};

function App() {
  const [shapeKey, setShapeKey] = useState(DEFAULTS.shapeKey);
  const [presetKey, setPresetKey] = useState(DEFAULTS.presetKey);
  const [blendKey, setBlendKey] = useState(DEFAULTS.blendKey);
  const [mix, setMix] = useState(DEFAULTS.mix);
  const [fg, setFg] = useState(DEFAULTS.fg);
  const [cols, setCols] = useState(DEFAULTS.cols);
  const [period, setPeriod] = useState(DEFAULTS.period);
  const [noiseAmt, setNoiseAmt] = useState(DEFAULTS.noiseAmt);
  const [golSeed, setGolSeed] = useState(DEFAULTS.golSeed);
  const [svgText, setSvgText] = useState(DEFAULT_CUSTOM_SVG);
  const [highlighted, setHighlighted] = useState(false);

  const playgroundRef = useRef<HTMLElement | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyExample = (nextShapeKey: string, nextPresetKey: string) => {
    setShapeKey(nextShapeKey);
    setPresetKey(nextPresetKey);
    setBlendKey(DEFAULTS.blendKey);
    setMix(DEFAULTS.mix);
    setFg(DEFAULTS.fg);
    setCols(DEFAULTS.cols);
    setPeriod(DEFAULTS.period);
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
        fg={fg}
        setFg={setFg}
        cols={cols}
        setCols={setCols}
        period={period}
        setPeriod={setPeriod}
        noiseAmt={noiseAmt}
        setNoiseAmt={setNoiseAmt}
        golSeed={golSeed}
        setGolSeed={setGolSeed}
        svgText={svgText}
        setSvgText={setSvgText}
        highlighted={highlighted}
      />
      <Footer />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');
createRoot(container).render(<App />);
