# Hue RGB, xy, and brightness

Source: [Hue Color Conversion Formulas RGB to XY and back](https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/),
verified against the complete text supplied by the user on 2026-09-19. The web page
required developer login during review. This reference preserves the relevant
formulas locally; ordinary use does not require login or an HTML export.

## Choose a consistent conversion

The source contains two different RGB-to-XYZ matrices. Its numbered RGB-to-xy
section uses the **prose matrix** below, while `calculateXY` in its iOS example
uses the **SDK matrix**. The published xy-to-RGB matrix matches the SDK matrix,
not the prose matrix. Do not combine the prose forward conversion with that
published inverse and describe the result as a round trip.

For ordinary RGB/hex input, follow the numbered RGB-to-xy section (prose matrix).
For a preview using the same convention, use its derived inverse below. Use the
SDK pair when explicitly reproducing the SDK example. Preserve the chosen pair
through a conversion and state which convention an integration uses. An explicitly
different input color space needs its own conversion; RGB triplets alone do not
identify a color space.

## Read the target's gamut

Read the current light resource before preparing a write. Color capability is
represented by `color`; its `gamut` contains `red`, `green`, and `blue` xy vertices.
Prefer these actual vertices over hardcoded model names, the source's illustrative
A/B/C triangles, or a shared default. The bundled GET contract notes that some
lights omit gamut information. A missing gamut is not proof of a full gamut.

The source's fallback triangle `(1,0), (0,1), (0,0)` represents a generic coordinate
domain, not a measured lamp capability. If a light omits its gamut, disclose that
device gamut fitting cannot be verified; do not claim a fitted or reproducible
color. The convenience tools reject xy when the reported gamut is missing or
degenerate. Native REST/MCP fields remain subject to the bridge's capabilities.

For groups, inspect each member. A shared xy must fit every participating light
to represent the same chromaticity across the group. Do not project against one
member and assume the result fits all others. Individual projections can produce
different colors; describe that approximation when using them.

## RGB or hex to xy

Parse `#RRGGBB` as three 8-bit channels; divide each by 255. Inputs already in
`[0,1]` need no division. Validate finite values and the input range. For each
normalized channel `c`, linearize it before multiplying by either matrix:

```text
linear(c) = c / 12.92                         if c <= 0.04045
            ((c + 0.055) / 1.055) ** 2.4     otherwise
```

Let `r, g, b` denote the linear channels. Each matrix below multiplies the column
vector `[r, g, b]` to give `[X, Y, Z]`:

```text
Prose RGB -> XYZ (from the numbered RGB-to-xy section)
0.4124    0.3576    0.1805
0.2126    0.7152    0.0722
0.0193    0.1192    0.9505

SDK RGB -> XYZ (from calculateXY in the source's iOS example)
0.664511  0.154324  0.162028
0.283881  0.668433  0.047685
0.000088  0.072310  0.986039
```

For `S = X + Y + Z > 0`, compute `x = X/S`, `y = Y/S`, and retain `Y` separately
as relative luminance. Fit `(x,y)` to the target gamut as described below. Gamut
projection changes chromaticity; it does not recalculate the source's `Y`.

For black (`S = 0`), xy is undefined. Do not divide by zero or turn the SDK's
`(0,0)` NaN fallback into a lamp color request. To request black/off, use
`{"on":{"on":false}}` and leave the stored color unchanged. Hue brightness zero
means minimum light output, so it is not an off command.

As a check before gamut projection, the prose matrix maps `(255,0,0)` to roughly
`xy=(0.6400745,0.3299705), Y=0.2126`; the SDK matrix maps it to roughly
`xy=(0.7006062,0.2993010), Y=0.283881`. These are different source conventions,
not interchangeable constants for “red.”

## Project an out-of-gamut xy onto the triangle

Check triangle containment first, including its boundary with a small numerical
tolerance. For a point `P` outside the triangle, project onto each of the three
closed edge segments `A -> B`:

```text
t = clamp(dot(P-A, B-A) / dot(B-A, B-A), 0, 1)
Q = A + t * (B-A)
```

Choose the candidate `Q` with the smallest squared distance to `P`. Clamping `t`
includes the vertices when the perpendicular projection lies beyond an edge.
Reject invalid or degenerate triangles before dividing. Clamping x and y
independently to `[0,1]` does not fit a color to the lamp's triangular gamut.
Keep enough precision that rounding does not push a boundary point outside it.
Report the requested and projected xy when an exact requested color is unavailable.

## Map the result to Hue v2 or MCP

Chromaticity and brightness are separate inputs. For “change the color,” omit
brightness and power unless the user also requested those changes. An explicit
brightness percentage takes precedence over the RGB-derived `Y`. When reproducing
the RGB color's relative luminance is part of the request, the v2 mapping is
`dimming.brightness = 100 * clamp(Y, 0, 1)`. This is a control-value mapping, not a
calibration of physical lamp luminance. Do not send legacy `bri` values on v2.

For a computed in-gamut `x,y`, the following shapes illustrate a color change at
35% with the light explicitly on. Replace the symbolic coordinates with numbers:

```text
REST PUT /clip/v2/resource/light/{id} body:
{"on":{"on":true},"dimming":{"brightness":35},"color":{"xy":{"x":x,"y":y}}}

Native MCP hue_update_light arguments:
{"resource_id":"<light UUID>","body":{"on":{"on":true},"dimming":{"brightness":35},"color":{"xy":{"x":x,"y":y}}}}

Convenience MCP set_light_state arguments:
{"light_id":"<light UUID>","state":{"on":true,"brightness_percent":35,"color_xy":{"x":x,"y":y}}}
```

Native tools forward documented Hue fields; they do not convert RGB or project
xy. Convenience tools validate xy against the actual light gamut and reject
unsupported coordinates; they do not silently project them. For a simple color
change, choose either xy or a white-temperature request. The convenience schema
rejects simultaneous `color_xy` and `color_temperature_kelvin`.

After a transition, compare the light's returned `color.xy`, power, and any
requested brightness with the submitted values. The convenience verifier uses
an absolute tolerance of `0.005` per xy coordinate and 1 brightness percentage
point. Native `observation_only` readback requires that comparison by the caller.
Compare xy to the projected target; a clipped RGB color cannot round-trip exactly.

## xy and luminance to an RGB preview

Fit xy to the known target gamut first when previewing that lamp. Use relative
`Y` in `[0,1]`; `dimming.brightness / 100` supplies the v2 control-value
approximation. A chromaticity-only preview can deliberately use `Y=1`, as the
source's iOS example does, but then it does not reproduce the light's brightness.
An off light renders black. Handle mathematical `Y=0` as black before division,
but remember that an on lamp at v2 brightness zero still emits its minimum output;
that control-value approximation does not establish physical black. For `Y>0`,
reject nonfinite coordinates and invalid xy (`x<0`, `y<=0`, or `x+y>1`) before
dividing; do not hide a zero y with an arbitrary epsilon.

```text
X = (Y / y) * x
Z = (Y / y) * (1 - x - y)
```

Multiply `[X,Y,Z]` by the matching inverse to obtain linear `[r,g,b]`:

```text
Prose XYZ -> RGB (derived by inverting the prose matrix above)
 3.240625477  -1.537207972  -0.498628599
-0.968930715   1.875756061   0.041517524
 0.055710120  -0.204021051   1.056995942

SDK XYZ -> RGB (the source's published xy-to-RGB coefficients)
 1.656492  -0.354851  -0.255038
-0.707196   1.655397   0.036152
 0.051713  -0.121364   1.011530
```

For display output, clamp negative linear channels to zero. Following the SDK's
normalization step, if the largest channel exceeds 1, divide all three by that
maximum; handle ties as well. This changes intensity to fit the display range.
Then encode each channel:

```text
encoded(c) = 12.92 * c                         if c <= 0.0031308
             1.055 * c ** (1 / 2.4) - 0.055   otherwise
```

Clamp residual numerical error to `[0,1]`, multiply by 255, and round for an 8-bit
RGB/hex result. Clipping, normalization, lamp brightness response, and rounding
make this a preview rather than an exact measurement of emitted light. Never
assert exact round-trip equality after those operations.

## HSV input

Normalize hue modulo 360 and validate saturation/value in `[0,100]`. Convert HSV
to floating-point RGB in `[0,1]` (for example, Python's
`colorsys.hsv_to_rgb((H % 360) / 360, S / 100, V / 100)`), then start at gamma
linearization above. Do not divide those channels by 255 again. The source's
`int R/G/B` declarations would truncate fractional values; keep floats until
final display quantization. HSV value is not XYZ luminance or v2 dimming percent.
