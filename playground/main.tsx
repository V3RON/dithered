import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { Brightness, Shape } from 'dithered';
import { presets, shapeFromSvg, shapes } from 'dithered';
import { Dithered } from 'dithered/react';

// ---------------------------------------------------------------------------
// styling helpers (inline styles only — no CSS framework)
// ---------------------------------------------------------------------------

const panel: CSSProperties = {
  background: '#141821',
  border: '1px solid #262c3a',
  borderRadius: 8,
  padding: 16,
  marginBottom: 24,
};

const label: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#9aa4b8',
  marginBottom: 4,
};

const row: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const controlsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 16,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 90,
  background: '#0b0d12',
  color: '#e6e8ee',
  border: '1px solid #262c3a',
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  resize: 'vertical',
};

const errorStyle: CSSProperties = {
  color: '#ff6b6b',
  fontSize: 12,
  marginTop: 6,
  whiteSpace: 'pre-wrap',
};

// ---------------------------------------------------------------------------
// Gallery: every shape x every preset, size 64
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
    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Gallery — every shape × every preset</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
          gap: 12,
        }}
      >
        {GALLERY_ITEMS.map((item) => (
          <div key={item.key} style={{ textAlign: 'center' }}>
            <Dithered shape={item.shape} brightness={item.brightness} size={64} label="" />
            <div style={{ fontSize: 10, color: '#9aa4b8', marginTop: 4 }}>{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Control panel: one large (size 160) instance
// ---------------------------------------------------------------------------

function ControlPanel() {
  const [shapeKey, setShapeKey] = useState<string>('rozenite');
  const [presetKey, setPresetKey] = useState<string>('gem');
  const [fg, setFg] = useState('#8232ff');
  const [transparentBg, setTransparentBg] = useState(true);
  const [bg, setBg] = useState('#0b0d12');
  const [cols, setCols] = useState(16);
  const [period, setPeriod] = useState(2000);
  const [noiseAmt, setNoiseAmt] = useState(0.8);
  const [paused, setPaused] = useState(false);
  const [progressEnabled, setProgressEnabled] = useState(false);
  const [progress, setProgress] = useState(0.5);

  const shape = shapes[shapeKey as keyof typeof shapes];

  const brightness = useMemo(() => {
    const factory = presets[presetKey as keyof typeof presets];
    return presetKey === 'gem' ? factory({ noise: noiseAmt }) : factory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey, noiseAmt]);

  return (
    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Control panel</h2>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <Dithered
          shape={shape}
          brightness={brightness}
          size={160}
          fg={fg}
          bg={transparentBg ? 'transparent' : bg}
          cols={cols}
          period={period}
          paused={paused}
          progress={progressEnabled ? progress : undefined}
          label="Preview"
        />

        <div style={{ ...controlsGrid, flex: 1, minWidth: 280 }}>
          <label style={row}>
            <span style={label}>Shape</span>
            <select value={shapeKey} onChange={(e) => setShapeKey(e.target.value)}>
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
            <span style={label}>Foreground</span>
            <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
          </label>

          <label style={row}>
            <span style={label}>
              Background{' '}
              <input
                type="checkbox"
                checked={transparentBg}
                onChange={(e) => setTransparentBg(e.target.checked)}
              />{' '}
              transparent
            </span>
            <input
              type="color"
              value={bg}
              disabled={transparentBg}
              onChange={(e) => setBg(e.target.value)}
            />
          </label>

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

          <label style={row}>
            <span style={label}>
              <input
                type="checkbox"
                checked={paused}
                disabled={progressEnabled}
                onChange={(e) => setPaused(e.target.checked)}
              />{' '}
              Paused
            </span>
          </label>

          <label style={row}>
            <span style={label}>
              <input
                type="checkbox"
                checked={progressEnabled}
                onChange={(e) => setProgressEnabled(e.target.checked)}
              />{' '}
              Determinate progress
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={progress}
              disabled={!progressEnabled}
              onChange={(e) => setProgress(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom SVG
// ---------------------------------------------------------------------------

const DEFAULT_SVG = `<svg viewBox="0 0 100 100">\n  <path d="M50 5 L95 50 L50 95 L5 50 Z" />\n</svg>`;

function CustomSvgPanel() {
  const [svgText, setSvgText] = useState(DEFAULT_SVG);
  const [shape, setShape] = useState<Shape | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    try {
      setShape(shapeFromSvg(svgText));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShape(null);
    }
  };

  return (
    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Custom SVG</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <textarea
            style={textareaStyle}
            value={svgText}
            onChange={(e) => setSvgText(e.target.value)}
            spellCheck={false}
          />
          <button onClick={apply} style={{ marginTop: 8 }}>
            Apply
          </button>
          {error && <div style={errorStyle}>{error}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 96 }}>
          {shape && <Dithered shape={shape} brightness={presets.gem()} size={96} label="" />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom brightness
// ---------------------------------------------------------------------------

const DEFAULT_BRIGHTNESS_CODE = '(cell, t) => 0.5 + 0.5 * Math.sin((cell.u + t) * Math.PI * 2)';

/**
 * Compiles a user-typed brightness expression at runtime. This is a dev-only
 * playground (never shipped), so evaluating arbitrary pasted code via
 * `new Function` is an acceptable, contained way to let people experiment
 * live without a build step.
 */
function compileBrightness(code: string): { fn?: Brightness; error?: string } {
  try {
    // eslint-disable-next-line no-new-func
    const value = new Function(`"use strict"; return (${code});`)();
    if (typeof value !== 'function') {
      throw new Error('Expected an expression that evaluates to a function, e.g. (cell, t) => ...');
    }
    return { fn: value as Brightness };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function CustomBrightnessPanel() {
  const [code, setCode] = useState(DEFAULT_BRIGHTNESS_CODE);
  const [applied, setApplied] = useState(DEFAULT_BRIGHTNESS_CODE);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const compiled = useMemo(() => compileBrightness(applied), [applied]);

  const brightness: Brightness | undefined = useMemo(() => {
    if (!compiled.fn) return undefined;
    let reported = false;
    return (cell, t) => {
      try {
        return compiled.fn!(cell, t);
      } catch (err) {
        if (!reported) {
          reported = true;
          setRuntimeError(err instanceof Error ? err.message : String(err));
        }
        return 0;
      }
    };
  }, [compiled.fn]);

  const apply = () => {
    setRuntimeError(null);
    setApplied(code);
  };

  return (
    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Custom brightness</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <textarea
            style={textareaStyle}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
          <button onClick={apply} style={{ marginTop: 8 }}>
            Apply
          </button>
          {compiled.error && <div style={errorStyle}>{compiled.error}</div>}
          {!compiled.error && runtimeError && <div style={errorStyle}>{runtimeError}</div>}
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 128 }}
        >
          {brightness && (
            <Dithered shape={shapes.square} brightness={brightness} size={128} label="" />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function App() {
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 64px' }}>
      <h1>dithered playground</h1>
      <ControlPanel />
      <CustomSvgPanel />
      <CustomBrightnessPanel />
      <Gallery />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');
createRoot(container).render(<App />);
