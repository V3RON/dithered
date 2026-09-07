import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  Dithered,
  circle,
  diamond,
  fill,
  gem,
  heart,
  pulse,
  rain,
  rozenite,
  sweep,
  wave,
  type Brightness,
  type Shape,
} from 'dithered/native';

// Built once at module scope: `<Dithered>` re-records every frame when
// `brightness` or `shape` changes identity, so these must be stable.
const FILL_UP = fill();

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
];

const INK = '#111111';
const MUTED = '#6b7280';

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

export default function App() {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0.35);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>dithered/native</Text>
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
              <Dithered shape={shape} size={56} fg={INK} paused={paused} label={`${name} loader`} />
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
});
