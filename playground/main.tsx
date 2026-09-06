import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { Brightness, Shape } from 'dithered';
import { presets, shapeFromSvg, shapes } from 'dithered';
import { Dithered } from 'dithered/react';

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
};

const sectionTitle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#9aa4b8',
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
  gap: 12,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Dithered
            shape={shapes.rozenite}
            brightness={presets.gem()}
            size={28}
            fg={ACCENT}
            label=""
          />
          <a href={REPO_URL} style={{ fontSize: 13, color: '#9aa4b8', textDecoration: 'none' }}>
            View on GitHub ↗
          </a>
        </div>
        <h1 style={{ fontSize: 42, margin: '0 0 12px', lineHeight: 1.1 }}>dithered</h1>
        <p style={{ fontSize: 17, color: '#c4cad8', margin: '0 0 20px', maxWidth: 480 }}>
          Turn any SVG silhouette into an animated, dithered loading spinner — a few lines of code,
          zero dependencies.
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
// Gallery: compact grid of every shape x every preset
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
    shape,
    brightness: factory(),
  })),
);

function Gallery() {
  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Every shape × every preset</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))',
          gap: 8,
        }}
      >
        {GALLERY_ITEMS.map((item) => (
          <div
            key={item.key}
            title={item.label}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Dithered
              shape={item.shape}
              brightness={item.brightness}
              size={40}
              fg={ACCENT}
              label=""
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Make it yours: live preview + controls + paste-your-SVG + advanced options
// ---------------------------------------------------------------------------

const DEFAULT_SVG = `<svg viewBox="0 0 100 100">\n  <path d="M50 5 L95 50 L50 95 L5 50 Z" />\n</svg>`;

function Customize() {
  const [shapeKey, setShapeKey] = useState<string>('rozenite');
  const [presetKey, setPresetKey] = useState<string>('gem');
  const [fg, setFg] = useState('#8232ff');
  const [customShape, setCustomShape] = useState<Shape | null>(null);
  const [svgText, setSvgText] = useState(DEFAULT_SVG);
  const [svgError, setSvgError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [cols, setCols] = useState(16);
  const [period, setPeriod] = useState(2000);
  const [noiseAmt, setNoiseAmt] = useState(0.8);

  const shape = customShape ?? shapes[shapeKey as keyof typeof shapes];

  const brightness = useMemo(() => {
    const factory = presets[presetKey as keyof typeof presets];
    return presetKey === 'gem' ? factory({ noise: noiseAmt }) : factory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey, noiseAmt]);

  const applySvg = () => {
    try {
      setCustomShape(shapeFromSvg(svgText));
      setSvgError(null);
    } catch (err) {
      setSvgError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section style={panel}>
      <h2 style={sectionTitle}>Make it yours</h2>
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
          <Dithered shape={shape} brightness={brightness} size={140} fg={fg} label="Preview" />
        </div>

        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={controlsGrid}>
            <label style={row}>
              <span style={label}>Shape</span>
              <select
                value={shapeKey}
                onChange={(e) => {
                  setShapeKey(e.target.value);
                  setCustomShape(null);
                }}
              >
                {SHAPE_ENTRIES.map(([name]) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label style={row}>
              <span style={label}>Preset</span>
              <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
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

          <div>
            <span style={label}>Or paste your own SVG</span>
            <textarea
              style={textareaStyle}
              value={svgText}
              onChange={(e) => setSvgText(e.target.value)}
              spellCheck={false}
            />
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={applySvg} style={buttonStyle}>
                Apply
              </button>
              <button onClick={() => setAdvanced((v) => !v)} style={ghostButtonStyle}>
                {advanced ? 'Hide advanced' : 'Advanced options'}
              </button>
            </div>
            {svgError && <div style={errorStyle}>{svgError}</div>}
          </div>

          {advanced && (
            <div style={controlsGrid}>
              <label style={row}>
                <span style={label}>Cols: {cols}</span>
                <input
                  type="range"
                  min={8}
                  max={48}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                />
              </label>
              <label style={row}>
                <span style={label}>Period: {period}ms</span>
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
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// React snippet + footer
// ---------------------------------------------------------------------------

const SNIPPET = `import { Dithered } from 'dithered/react';
import { shapes, presets } from 'dithered';

<Dithered shape={shapes.rozenite} brightness={presets.gem()} fg="#8232ff" />`;

function GetStarted() {
  return (
    <section
      style={{
        ...panel,
        display: 'flex',
        gap: 24,
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ flex: '1 1 320px', minWidth: 280 }}>
        <h2 style={sectionTitle}>Drop it into React</h2>
        <pre style={codeBlockStyle}>{SNIPPET}</pre>
      </div>
      <div style={{ fontSize: 13, color: '#9aa4b8' }}>
        <a href={REPO_URL} style={{ color: '#e6e8ee' }}>
          github.com/V3RON/dithered ↗
        </a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function App() {
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
      <Gallery />
      <Customize />
      <GetStarted />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');
createRoot(container).render(<App />);
