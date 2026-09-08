import { Skia } from '@shopify/react-native-skia';
import type { HitTester, Shape } from '../shape';

/**
 * A Skia-backed {@link HitTester}, the React Native counterpart to the
 * browser's `Path2D` + `isPointInPath`.
 */
export function skiaHitTester(shape: Shape): HitTester {
  const path = Skia.Path.MakeFromSVGString(shape.path);
  if (!path) {
    throw new Error(`dithered: Skia could not parse the shape's path data.`);
  }
  return (x, y) => path.contains(x, y);
}
