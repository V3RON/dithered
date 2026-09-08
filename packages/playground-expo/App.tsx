import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  Dithered,
  circle,
  compose,
  diamond,
  fill,
  gem,
  heart,
  pulse,
  rain,
  rozenite,
  shapeFromSvgLite,
  sweep,
  wave,
  type Brightness,
  type DitherMatrix,
  type Shape,
} from 'dithered/react-native';

// Built once at module scope: `<Dithered>` re-records every frame when
// `brightness` or `shape` changes identity, so these must be stable.
const FILL_UP = fill();

// Three plain <circle> elements, parsed with `shapeFromSvgLite` (the
// native counterpart to the web playground's `shapeFromSvg`) — a live
// example of the basic-shape support (ADR 0010): every element here is
// unioned into one Shape, same as a design tool's multi-object SVG export.
const CUSTOM_SVG_SHAPE = shapeFromSvgLite(`<svg viewBox="0 0 100 100">
  <circle cx="50" cy="30" r="24" />
  <circle cx="24" cy="74" r="24" />
  <circle cx="76" cy="74" r="24" />
</svg>`);

const PRESETS: Array<{ name: string; brightness: Brightness }> = [
  { name: 'gem', brightness: gem() },
  { name: 'sweep', brightness: sweep() },
  { name: 'pulse', brightness: pulse() },
  { name: 'rain', brightness: rain() },
  { name: 'wave', brightness: wave() },
  { name: 'fill', brightness: FILL_UP },
];

const SHAPES: Array<{ name: string; shape: Shape }> = [
  { name: 'rozenite', shape: rozenite },
  { name: 'circle', shape: circle },
  { name: 'diamond', shape: diamond },
  { name: 'heart', shape: heart },
  { name: 'custom (3 circles)', shape: CUSTOM_SVG_SHAPE },
];

// Module-level, stable across renders — same reasoning as `FILL_UP` above.
const BLEND_PRIMARY = gem();
const BLEND_TARGETS: Array<{ name: string; brightness: Brightness }> = [
  { name: 'sweep', brightness: sweep() },
  { name: 'pulse', brightness: pulse() },
  { name: 'rain', brightness: rain() },
  { name: 'wave', brightness: wave() },
];
const MIX_STEPS = [0, 0.25, 0.5, 0.75, 1];

const INK = '#111111';
const MUTED = '#6b7280';
const ACCENT = '#8232ff';

// `gem()`, not `FILL_UP`: `fill()` returns a boolean brightness, which
// always resolves to the single brightest tone (see `paintFrame`'s
// boolean handling) and so can never demonstrate more than one tone.
const MULTI_TONE_BRIGHTNESS = gem();

// Darkest -> brightest, one default per tone count — identical to the web
// playground's `DEFAULT_PALETTES` (ADR 0005), accent color included.
const TONE_PALETTES: Readonly<Record<1 | 2 | 3, readonly string[]>> = {
  1: [ACCENT],
  2: ['#2a1a4a', ACCENT],
  3: ['#2a1a4a', ACCENT, '#d9c2ff'],
};

// The named matrices, in the order the "Matrix" chips offer them.
const MATRIX_NAMES: Extract<DitherMatrix, string>[] = ['bayer2', 'bayer4', 'bayer8', 'blueNoise'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.row}>{children}</View>
    </View>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.tile}>
      {children}
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0.35);
  const [blendName, setBlendName] = useState('none');
  const [mix, setMix] = useState(0.5);
  const [toneCount, setToneCount] = useState<1 | 2 | 3>(1);
  const [matrix, setMatrix] = useState<Extract<DitherMatrix, string>>('bayer4');

  const blendTarget = BLEND_TARGETS.find((t) => t.name === blendName);
  const blended = blendTarget
    ? compose.blend(BLEND_PRIMARY, blendTarget.brightness, mix)
    : BLEND_PRIMARY;
  const palette = TONE_PALETTES[toneCount];

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>dithered/react-native</Text>
          <Text style={styles.subtitle}>
            The same core as the web renderer, drawn through react-native-skia.
          </Text>

          <Section title="Presets">
            {PRESETS.map(({ name, brightness }) => (
              <Tile key={name} label={name}>
                <Dithered
                  shape={rozenite}
                  brightness={brightness}
                  size={56}
                  fg={INK}
                  paused={paused}
                  label={`${name} loader`}
                />
              </Tile>
            ))}
          </Section>

          <Section title="Shapes">
            {SHAPES.map(({ name, shape }) => (
              <Tile key={name} label={name}>
                <Dithered
                  shape={shape}
                  size={56}
                  fg={INK}
                  paused={paused}
                  label={`${name} loader`}
                />
              </Tile>
            ))}
          </Section>

          <Section title="Determinate">
            <Tile label={`progress ${progress.toFixed(2)}`}>
              <Dithered
                shape={rozenite}
                brightness={FILL_UP}
                size={72}
                fg={INK}
                progress={progress}
                label="Uploading"
              />
            </Tile>
            <Tile label="grid 28 cols">
              <Dithered shape={circle} size={72} cols={28} fg={INK} paused={paused} label="" />
            </Tile>
          </Section>

          <Section title="Blend with">
            <View style={{ gap: 12 }}>
              <Tile label={blendTarget ? `gem × ${blendName} @ ${mix.toFixed(2)}` : 'gem'}>
                <Dithered
                  shape={rozenite}
                  brightness={blended}
                  size={72}
                  fg={INK}
                  paused={paused}
                  label="Blended loader"
                />
              </Tile>
              <View style={styles.chipRow}>
                <Chip
                  label="none"
                  active={blendName === 'none'}
                  onPress={() => setBlendName('none')}
                />
                {BLEND_TARGETS.map(({ name }) => (
                  <Chip
                    key={name}
                    label={name}
                    active={name === blendName}
                    onPress={() => setBlendName(name)}
                  />
                ))}
              </View>
              {blendTarget && (
                <View style={styles.chipRow}>
                  {MIX_STEPS.map((m) => (
                    <Chip
                      key={m}
                      label={`${m.toFixed(2)}`}
                      active={m === mix}
                      onPress={() => setMix(m)}
                    />
                  ))}
                </View>
              )}
            </View>
          </Section>

          <Section title="Multi-tone palette">
            <View style={{ gap: 12 }}>
              <Tile label={`${toneCount} tone${toneCount > 1 ? 's' : ''}`}>
                <Dithered
                  shape={rozenite}
                  brightness={MULTI_TONE_BRIGHTNESS}
                  size={72}
                  fg={toneCount === 1 ? palette[0] : [...palette]}
                  paused={paused}
                  label={`rozenite, ${toneCount} tones`}
                />
              </Tile>
              <View style={styles.chipRow}>
                {([1, 2, 3] as const).map((count) => (
                  <Chip
                    key={count}
                    label={`${count}`}
                    active={count === toneCount}
                    onPress={() => setToneCount(count)}
                  />
                ))}
              </View>
            </View>
          </Section>

          <Section title="Dither matrix">
            <View style={{ gap: 12 }}>
              <Tile label={matrix}>
                <Dithered
                  shape={rozenite}
                  brightness={FILL_UP}
                  size={72}
                  fg={INK}
                  matrix={matrix}
                  paused={paused}
                  label={`rozenite, ${matrix}`}
                />
              </Tile>
              <View style={styles.chipRow}>
                {MATRIX_NAMES.map((name) => (
                  <Chip
                    key={name}
                    label={name}
                    active={name === matrix}
                    onPress={() => setMatrix(name)}
                  />
                ))}
              </View>
            </View>
          </Section>

          <View style={styles.controls}>
            <Pressable style={styles.button} onPress={() => setPaused((p) => !p)}>
              <Text style={styles.buttonText}>{paused ? 'Resume' : 'Pause'}</Text>
            </Pressable>
            <Pressable
              style={styles.button}
              onPress={() => setProgress((p) => (p >= 1 ? 0 : Math.min(1, p + 0.25)))}
            >
              <Text style={styles.buttonText}>Step progress</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fafafa' },
  content: { padding: 20, gap: 28 },
  title: { fontSize: 24, fontWeight: '700', color: INK },
  subtitle: { fontSize: 14, color: MUTED, marginTop: -20 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 1, color: MUTED },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  tile: { alignItems: 'center', gap: 6 },
  tileLabel: { fontSize: 11, color: MUTED },
  controls: { flexDirection: 'row', gap: 12 },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: INK,
  },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  chipActive: { backgroundColor: INK, borderColor: INK },
  chipText: { fontSize: 12, color: INK, fontWeight: '600' },
  chipTextActive: { color: '#ffffff' },
});
