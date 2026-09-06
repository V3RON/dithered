# dithered

`dithered` renders an animated ordered (Bayer) dither pattern masked to an SVG silhouette. It samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing an animated brightness field against a 4x4 Bayer threshold.
