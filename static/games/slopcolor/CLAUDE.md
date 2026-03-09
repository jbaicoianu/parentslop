# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a color-by-number game implemented as a single-page web application. It runs entirely in the browser using vanilla JavaScript and HTML5 Canvas. Users can either load SVG files with pre-defined color regions or drop raster images which are automatically converted into color-by-number puzzles using k-means/median-cut quantization and contour tracing.

## Running the Application

Open `index.html` in a web browser. No build step or package manager required—this is a zero-dependency vanilla JS project.

## Architecture

### Single-File Structure

The entire application is in `tap-color.js` (referenced by `index.html`). The code is organized into logical sections:

1. **Utilities & Event Bus** - Core EventBus pattern for decoupled communication
2. **Camera2D** - Zooming/panning viewport (ZUI - Zoomable User Interface)
3. **Data Models** - Region, PaletteEntry, GameState (game state management)
4. **SVGLoader** - Parses SVG files with `data-index` attributes into Region objects
5. **CanvasRenderer** - Renders the game canvas, palette bar, progress bar
6. **Controller** - Handles all user input (tap/click, pan, zoom, drag-drop, keyboard)
7. **Storage** - localStorage-based persistence (saves progress per puzzle)
8. **App bootstrap** - Main App object that initializes and coordinates everything
9. **ImageToSVGPalletizer** - Converts raster images to SVG color-by-number puzzles

### Key Classes and Responsibilities

**GameState** (tap-color.js:31)
- Central state management with EventBus for reactivity
- Tracks regions (fillable areas), palette (color entries), active color index
- Manages completion logic and hint tokens
- Emits events: `region-filled`, `active-changed`, `puzzle-complete`

**SVGLoader** (tap-color.js:36)
- Parses SVG text into Region objects
- Supports: `<path>`, `<polygon>`, `<rect>`, `<circle>`, `<ellipse>`
- Reads `data-index` (required) and `data-color` attributes
- Computes bounding boxes and label positions using getBBox()

**CanvasRenderer** (tap-color.js:44)
- Owns Camera2D for pan/zoom transforms
- Four rendering layers: main canvas (regions), active color checkerboard pattern, progress bar, palette bar
- Uses Path2D for efficient hit testing and rendering
- Label positioning algorithm at tap-color.js:68-90 finds optimal text placement
- Active color checkerboard: Draws Photoshop-style grey checkerboard on unfilled regions matching the active color index to help users locate them

**Controller** (tap-color.js:97)
- Pointer events for tap-to-fill, pan (single touch/mouse), pinch-zoom (two-finger)
- Wheel events for zoom
- Drag-and-drop: SVG files load directly, raster images trigger palettization
- Keyboard: H = hint, P = export PNG

**ImageToSVGPalletizer** (tap-color.js:180)
- Converts raster images into color-by-number SVGs
- Two quantization algorithms: median-cut (default) or k-means
- Connected components analysis to extract regions
- Ramer-Douglas-Peucker (RDP) for path simplification
- Merges tiny regions based on color distance in LAB space

### Data Flow

1. User drops file → `Controller.onDrop` (tap-color.js:104)
2. If SVG → `App.loadSVGText` → `SVGLoader.parse` → creates Regions
3. If raster → `ImageToSVGPalletizer.process` → generates SVG → `App.loadSVGText`
4. GameState populated, renderer fits to screen
5. User taps region → `Controller.handleTapOrPalette` → `GameState.setFilled`
6. GameState emits events → Renderer redraws → Storage saves progress

### Persistence

Progress is saved to localStorage keyed by `'cxbn:' + hash(svgText)`. Each puzzle stores:
- `filledIds`: array of filled region IDs
- `activeIndex`: currently selected color
- `hintTokens`: remaining hints

### SVG Format Requirements

SVG elements must have:
- `data-index`: integer (1-based) indicating which palette color
- `data-color`: hex color (optional, falls back to generated hues)

SVG root can specify:
- `data-outline-color`: default `#111`
- `data-outline-width`: default `1.5`

Example:
```xml
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>
  <circle cx='200' cy='200' r='40' data-index='1' data-color='#facc15' />
  <path d='M...' data-index='2' data-color='#f472b6' />
</svg>
```

## Key Implementation Details

### Coordinate Systems

The renderer uses three coordinate spaces:
- **Screen space**: Canvas pixels (includes devicePixelRatio)
- **World space**: SVG coordinate system
- **UI space**: Fixed screen-space UI elements (palette, progress bar)

Transform methods: `Camera2D.screenToWorld()`, `Camera2D.worldToScreen()`

### Region Selection

Hit testing uses `CanvasRenderingContext2D.isPointInPath()` with Path2D objects. When user taps:
1. Check if tap is in palette bar (switch active color)
2. Convert screen coords to world coords
3. Test all unfilled regions with matching `activeIndex`
4. First hit gets filled

### Active Color Highlighting

To help users locate unfilled regions of the active color, a checkerboard pattern is drawn over them:
- Pattern uses alternating light grey (#cccccc) and dark grey (#999999) squares (like Photoshop's transparency grid)
- Uses canvas clipping to ensure pattern only appears within region boundaries
- Checker size scales with camera zoom (always appears as ~10px on screen)
- **Performance**:
  - Creates pattern once at fixed 20x20 pixel size (never 0-size)
  - Uses `ctx.createPattern()` for efficient browser-native tiling
  - Scales pattern using context transforms (no blurring - `imageSmoothingEnabled = false`)
- Only drawn on unfilled regions matching `game.activeIndex`

Implementation in `CanvasRenderer.drawActiveColorHatch()` and `_createCheckerboardPattern()` (tap-color.js:436)

### Auto-Progression

When all regions of the active color are filled, the game automatically switches to the next incomplete color index. When all colors are complete, emits `puzzle-complete` event.

### Image Palettization Pipeline

Three palettizers are available:

**ImageToSVGPalletizer** (original, tap-color.js:180):
1. Sample pixels (every ~50000th pixel to stay performant)
2. Quantize to K colors (median-cut or k-means in LAB color space)
3. Assign each pixel to nearest palette color
4. Connected components analysis (BFS flood-fill)
5. Merge regions smaller than `minRegionArea` into neighbors
6. Trace contours using marching-squares-like algorithm
7. Simplify paths with RDP algorithm
8. Emit SVG with `<path>` elements

Configuration options:
- `K`: number of colors (default 30)
- `algorithm`: 'median-cut' or 'kmeans'
- `simplifyTolerance`: RDP epsilon (default 1.2)
- `minRegionArea`: pixels, regions below this are merged (default 64)
- `smallRegionMergeColorDist`: LAB distance threshold (default 25)

**EnhancedImageToSVGPalletizer** (new, tap-color.js:238) - **Currently Active**:
Adds preprocessing and alternative color spaces to reduce noise and produce more natural-looking regions.

Pipeline:
1. **Preprocessing** - Apply filter to reduce noise and smooth minor variations:
   - `gaussian`: Gaussian blur (configurable radius)
   - `median`: Median filter (good for salt-and-pepper noise)
   - `bilateral`: Edge-preserving blur (preserves sharp boundaries while smoothing)
2. Quantize in chosen color space (RGB/LAB/HSV)
3. Connected components analysis
4. More aggressive tiny region merging
5. Contour extraction and simplification
6. Emit SVG

Configuration options (all from ImageToSVGPalletizer plus):
- `colorSpace`: 'rgb', 'lab', or 'hsv' (default 'hsv' for more perceptually uniform colors)
- `preprocessor`: 'none', 'gaussian', 'median', or 'bilateral' (default 'gaussian')
- `blurRadius`: Gaussian blur radius (default 2)
- `medianRadius`: Median filter radius (default 2)
- `bilateralSigmaSpace`: Bilateral filter spatial sigma (default 8)
- `bilateralSigmaColor`: Bilateral filter color sigma (default 30)
- `K`: default 20 (fewer colors to reduce fragmentation)
- `minRegionArea`: default 120 (more aggressive merging)
- `simplifyTolerance`: default 2.0 (more aggressive simplification)

**StructureAwareImagePalletizer** (new, tap-color.js:2396) - **Currently Active**:
Structure-first approach using SLIC superpixel segmentation. Creates aesthetically pleasing, uniform-sized regions that respect edges.

**Key Difference:** Instead of quantizing colors first, it segments the image based on structure/edges, then assigns colors.

Pipeline:
1. **Light bilateral filtering** - Reduce noise while preserving edges
2. **SLIC superpixel segmentation** - Creates roughly uniform-sized regions that:
   - Respect image edges and boundaries
   - Balance spatial proximity and color similarity
   - Avoid huge blobs and tiny dots
3. **Connectivity enforcement** - Merge orphan pixels into neighbors
4. **Region merging** - Merge similar adjacent regions based on color (LAB distance)
5. **Color quantization** - Use median-cut on region colors to create final palette
6. **Contour extraction and smoothing** - RDP + Chaikin smoothing

**Advantages:**
- More uniform region sizes (no huge blobs or thousands of tiny dots)
- Respects image structure and edges
- More aesthetically pleasing shapes
- Better handling of both uniform and textured areas

Configuration options:

**Difficulty Presets** (recommended):
- `difficulty: 'easy'` - ~80 regions, ~12 colors, large regions (beginners)
- `difficulty: 'medium'` - ~200 regions, ~20 colors, medium regions
- `difficulty: 'hard'` - **DEFAULT** - ~400 regions, ~30 colors, smaller regions (good challenge)
- `difficulty: 'expert'` - ~700 regions, ~40 colors, tiny details (very challenging)

**Advanced Options** (override preset values):
- `targetRegions`: Target number of initial superpixels
- `targetColors`: Target number of colors in final palette
- `compactness`: SLIC spatial vs color weight (higher = more compact/square shapes)
- `iterations`: SLIC refinement iterations (default 10)
- `minRegionArea`: Minimum region size in pixels
- `colorMergeThreshold`: LAB distance threshold for merging similar regions

**Switching Between Palettizers:**
Edit `Controller.onDrop()` (tap-color.js:740) to choose which palettizer to use.

## Modifying the Code

### Adding New SVG Shape Support

Edit `SVGLoader.parse()` (tap-color.js:36). Add the tag to the `supported` array and implement path construction in the element loop.

### Customizing Palette UI

Modify `CanvasRenderer.drawPaletteBar()` (tap-color.js:54). The `_paletteRects` array is used for hit testing in `paletteHitTest()`.

### Changing Quantization Algorithm

Pass `algorithm: 'kmeans'` to ImageToSVGPalletizer constructor. K-means uses k-means++ initialization and LAB color space.

### Improving Label Placement

The current algorithm (`CanvasRenderer._bestLabelPoint()`, tap-color.js:68) finds the point farthest from edges using binary search on stroke width. For complex shapes, consider implementing a proper distance transform or medial axis.

## Common Patterns

**Adding Event Listeners:**
```javascript
this.game.events.on('region-filled', ({ region }) => {
  // handle event
});
```

**Triggering Re-render:**
```javascript
this.renderer.start();  // requests animation frame
```

**Saving State:**
```javascript
App.saveProgress();          // immediate
App.saveProgressDebounced(); // debounced 200ms
```
