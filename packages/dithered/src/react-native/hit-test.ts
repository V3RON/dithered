import { FillType, Skia } from '@shopify/react-native-skia';
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
  // Skia's default fill type is Winding, i.e. nonzero — only evenodd needs setting.
  if (shape.fillRule === 'evenodd') {
    path.setFillType(FillType.EvenOdd);
  }
  return (x, y) => path.contains(x, y);
}
