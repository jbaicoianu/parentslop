/*
tap-color.js — Main application file
-------------------------------------
Assumes an HTML page with a single <canvas id="app"></canvas> element.
This file contains:
- The color-by-number game (renderer, controller, SVG loader)
- Image library management with localStorage
- Worker wrapper for non-blocking image processing
- Drag & drop integration: dropping a raster image triggers worker-based palettization → SVG → loads into the app; dropping an SVG loads directly.

Image palletizer classes are in palletizers.js (ES6 module).
Image processing runs in image-processor-worker.js (Web Worker).
*/

/*************************
 * Utilities & Event Bus *
 *************************/
class EventBus {
  constructor() {
    this.listeners = new Map();
  }
  on(t, f) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(f);
    return () => this.off(t, f);
  }
  off(t, f) {
    const s = this.listeners.get(t);
    if (s) s.delete(f);
  }
  emit(t, d) {
    const s = this.listeners.get(t);
    if (s)
      for (const f of s) {
        try {
          f(d);
        } catch (e) {
          console.error(e);
        }
      }
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hashString = (str) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
};

/****************
 * Camera (ZUI) *
 ****************/
class Camera2D {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.minScale = 0.1;
    this.maxScale = 40;
    this.bounds = null; // Set by renderer: { x, y, width, height }
  }
  apply(ctx, canvas) {
    const sx = canvas.width / 2,
      sy = canvas.height / 2;
    ctx.translate(sx, sy);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.x, -this.y);
  }
  screenToWorld(px, py, canvas) {
    const sx = canvas.width / 2,
      sy = canvas.height / 2;
    return { x: (px - sx) / this.scale + this.x, y: (py - sy) / this.scale + this.y };
  }
  worldToScreen(wx, wy, canvas) {
    const sx = canvas.width / 2,
      sy = canvas.height / 2;
    return { x: (wx - this.x) * this.scale + sx, y: (wy - this.y) * this.scale + sy };
  }
  zoomAt(factor, cx, cy, canvas) {
    const before = this.screenToWorld(cx, cy, canvas);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(cx, cy, canvas);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
  constrainToBounds(canvas) {
    if (!this.bounds) return;

    // Allow panning 1/3 of the way past the edge
    const overpanFraction = 1 / 3;

    // Calculate visible world dimensions
    const viewWidth = canvas.width / this.scale;
    const viewHeight = canvas.height / this.scale;

    // Calculate allowed overpan in world units
    const overpanX = this.bounds.width * overpanFraction;
    const overpanY = this.bounds.height * overpanFraction;

    // Constrain camera center position
    const minX = this.bounds.x - overpanX;
    const maxX = this.bounds.x + this.bounds.width + overpanX;
    const minY = this.bounds.y - overpanY;
    const maxY = this.bounds.y + this.bounds.height + overpanY;

    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
  }
}

/****************
 * Data Models  *
 ****************/
class Region {
  constructor({ id, index, color, path2d, svgType, svgAttrs, bbox, labelPos }) {
    this.id = id;
    this.index = index;
    this.color = color;
    this.path2d = path2d;
    this.svgType = svgType;
    this.svgAttrs = svgAttrs;
    this.filled = false;
    this.bbox = bbox || { x: 0, y: 0, width: 0, height: 0 };
    this.labelPos = labelPos || {
      x: this.bbox.x + this.bbox.width / 2,
      y: this.bbox.y + this.bbox.height / 2,
    };
  }
}
class PaletteEntry {
  constructor(index, color) {
    this.index = index;
    this.color = color || '#888';
    this.total = 0;
    this.found = 0;
  }
}
class GameState {
  constructor() {
    this.regions = [];
    this.palette = new Map();
    this.activeIndex = 1;
    this.events = new EventBus();
    this.imageKey = 'default';
    this.hintTokens = 3;
    this.originalImage = null;  // ImageBitmap of original image
    this.imageWidth = 0;
    this.imageHeight = 0;
  }
  setImageKey(k) {
    this.imageKey = k;
  }
  addRegion(r) {
    this.regions.push(r);
    if (!this.palette.has(r.index)) this.palette.set(r.index, new PaletteEntry(r.index, r.color));
    this.palette.get(r.index).total++;
  }
  setFilled(region, filled = true) {
    if (region.filled === filled) return;
    region.filled = filled;
    const p = this.palette.get(region.index);
    const wasComplete = (p.found === p.total);
    p.found += filled ? 1 : -1;
    const isNowComplete = (p.found === p.total);

    // Check if this color just became complete
    if (!wasComplete && isNowComplete) {
      this.events.emit('color-complete', { index: region.index, color: p.color });
    }

    this.events.emit('region-filled', { region });
    if (this.isIndexComplete(this.activeIndex)) {
      const next = this.nextIncompleteIndex(this.activeIndex);
      if (next != null) {
        this.setActiveIndex(next);
      } else {
        this.events.emit('puzzle-complete', {});
      }
    }
  }
  setActiveIndex(i) {
    this.activeIndex = i;
    this.events.emit('active-changed', { activeIndex: i });
  }
  isIndexComplete(i) {
    const p = this.palette.get(i);
    if (!p) return true;
    return p.found >= p.total;
  }
  nextIncompleteIndex(from = 1) {
    const keys = [...this.palette.keys()].sort((a, b) => a - b);
    const start = Math.max(0, keys.indexOf(from));
    for (const k of keys.slice(start + 1)) if (!this.isIndexComplete(k)) return k;
    for (const k of keys) if (!this.isIndexComplete(k)) return k;
    return null;
  }
  overallProgress() {
    const t = [...this.palette.values()].reduce(
      (a, p) => {
        a.total += p.total;
        a.found += p.found;
        return a;
      },
      { total: 0, found: 0 },
    );
    return t.total ? t.found / t.total : 0;
  }
}

/****************
 * SVG Loader   *
 ****************/
class SVGLoader {
  static _measureCtx() {
    if (!this.__mc) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d');
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      this.__mc = ctx;
    }
    return this.__mc;
  }

  static _bestLabelPoint(path2d, bbox) {
    const ctx = this._measureCtx();
    const centerX = bbox.x + bbox.width / 2;
    const centerY = bbox.y + bbox.height / 2;

    // Simple heuristic: find valid point closest to bbox center
    // This avoids expensive isPointInStroke() calls entirely
    // Still handles holes (evenodd) and concave shapes
    const steps = 5;
    let bestDist = Infinity;
    let best = { x: centerX, y: centerY };

    for (let iy = 0; iy < steps; iy++) {
      for (let ix = 0; ix < steps; ix++) {
        const x = bbox.x + ((ix + 0.5) * bbox.width) / steps;
        const y = bbox.y + ((iy + 0.5) * bbox.height) / steps;

        // Only one isPointInPath call per point (respects holes via evenodd)
        if (!ctx.isPointInPath(path2d, x, y, 'evenodd')) continue;

        // Score by distance to bbox center (closer = better)
        const dx = x - centerX;
        const dy = y - centerY;
        const dist = dx * dx + dy * dy; // squared distance (no sqrt needed)

        if (dist < bestDist) {
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return best;
  }

  static async parse(svgText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    document.body.appendChild(svg);
    svg.style.position = 'absolute';
    svg.style.left = '-10000px';
    svg.style.top = '-10000px';
    svg.style.visibility = 'hidden';
    const supported = ['path', 'polygon', 'rect', 'circle', 'ellipse'];
    const elements = [];
    for (const tag of supported) {
      elements.push(...svg.querySelectorAll(tag + '[data-index]'));
    }
    const regions = [];
    let idCounter = 1;
    const fallbackColor = (idx) => {
      const hues = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
      const h = hues[(idx - 1) % hues.length];
      return `hsl(${h} 70% 55%)`;
    };
    for (const el of elements) {
      const index = parseInt(el.getAttribute('data-index')) || 1;
      const color = el.getAttribute('data-color') || fallbackColor(index);
      const p = new Path2D();
      let bbox = { x: 0, y: 0, width: 0, height: 0 };
      let labelPos = null;
      const type = el.tagName.toLowerCase();
      const attrs = {};
      for (const a of el.getAttributeNames()) attrs[a] = el.getAttribute(a);
      try {
        const b = el.getBBox();
        bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
        // Default to bbox center, will be replaced with better position below
        labelPos = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      } catch (e) {}
      if (type === 'path') {
        const d = el.getAttribute('d');
        const path = new Path2D(d);
        p.addPath(path);
      } else if (type === 'polygon') {
        const pts = (el.getAttribute('points') || '')
          .trim()
          .split(/\s+/)
          .map((x) => x.split(',').map(Number));
        if (pts.length) {
          p.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
          p.closePath();
        }
      } else if (type === 'rect') {
        const x = +el.getAttribute('x') || 0,
          y = +el.getAttribute('y') || 0,
          w = +el.getAttribute('width') || 0,
          h = +el.getAttribute('height') || 0,
          rx = +el.getAttribute('rx') || 0,
          ry = +el.getAttribute('ry') || 0;
        if (rx > 0 || ry > 0) {
          const rrx = rx || ry,
            rry = ry || rx;
          const right = x + w,
            bottom = y + h;
          p.moveTo(x + rrx, y);
          p.lineTo(right - rrx, y);
          p.quadraticCurveTo(right, y, right, y + rry);
          p.lineTo(right, bottom - rry);
          p.quadraticCurveTo(right, bottom, right - rrx, bottom);
          p.lineTo(x + rrx, bottom);
          p.quadraticCurveTo(x, bottom, x, bottom - rry);
          p.lineTo(x, y + rry);
          p.quadraticCurveTo(x, y, x + rrx, y);
          p.closePath();
        } else {
          p.rect(x, y, w, h);
        }
      } else if (type === 'circle') {
        const cx = +el.getAttribute('cx') || 0,
          cy = +el.getAttribute('cy') || 0,
          r = +el.getAttribute('r') || 0;
        p.moveTo(cx + r, cy);
        p.arc(cx, cy, r, 0, Math.PI * 2);
      } else if (type === 'ellipse') {
        const cx = +el.getAttribute('cx') || 0,
          cy = +el.getAttribute('cy') || 0,
          rx = +el.getAttribute('rx') || 0,
          ry = +el.getAttribute('ry') || 0;
        p.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      }

      // Calculate optimal label position using distance-to-edge algorithm
      // This runs once during SVG load, not per-frame
      // Ensures labels are in "thick" parts of regions, avoiding holes and thin areas
      if (bbox.width > 0 && bbox.height > 0) {
        labelPos = SVGLoader._bestLabelPoint(p, bbox);
      }

      regions.push(
        new Region({
          id: idCounter++,
          index,
          color,
          path2d: p,
          svgType: type,
          svgAttrs: attrs,
          bbox,
          labelPos,
        }),
      );
    }
    const outlineColor = svg.getAttribute('data-outline-color') || '#111';
    const outlineWidth = parseFloat(svg.getAttribute('data-outline-width') || '1.5');
    svg.remove();
    return { regions, outlineColor, outlineWidth };
  }
}

/****************
 * Effects      *
 ****************/
class EffectsManager {
  constructor(renderer, game) {
    this.renderer = renderer;
    this.game = game;
    this.particles = [];
    this.shakeOffset = { x: 0, y: 0 };
    this.shakeVelocity = { x: 0, y: 0 };
    this.shakeDecay = 0.85;
    this.enableParticles = true;
    this.enableScreenShake = false;  // Disabled - too weak, needs rework
    this.enableHaptics = true;
  }

  onRegionTap(x, y, region) {
    if (this.enableParticles) this.spawnParticles(x, y, region.color);
    if (this.enableScreenShake) this.triggerShake();
    if (this.enableHaptics) this.triggerHaptic();
  }

  spawnParticles(x, y, color, options = {}) {
    // Options: { count, speedMult, sizeMult }
    // Legacy support: if options is a boolean, treat as "large" mode
    let count, speedMultiplier, sizeMultiplier;

    if (typeof options === 'boolean') {
      // Legacy mode: large = true/false
      const large = options;
      count = large ? 30 + Math.floor(Math.random() * 20) : 10 + Math.floor(Math.random() * 6);
      speedMultiplier = large ? 2.5 : 1;
      sizeMultiplier = large ? 2 : 1;
    } else {
      // New configurable mode
      count = options.count ?? (10 + Math.floor(Math.random() * 6));
      speedMultiplier = options.speedMult ?? 0.7;
      sizeMultiplier = options.sizeMult ?? 1;
    }

    // Scale velocity by camera zoom to maintain constant screen-space speed
    const velocityScale = 1 / this.renderer.camera.scale;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = (2 + Math.random() * 3) * speedMultiplier;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed * velocityScale,
        vy: Math.sin(angle) * speed * velocityScale,
        life: 1.0,
        decay: 0.015 + Math.random() * 0.01,
        size: (3 + Math.random() * 3) * sizeMultiplier,
        color
      });
    }
  }

  triggerShake() {
    // Add random impulse to camera shake
    const strength = 3;
    this.shakeVelocity.x += (Math.random() - 0.5) * strength;
    this.shakeVelocity.y += (Math.random() - 0.5) * strength;
  }

  triggerHaptic() {
    if ('vibrate' in navigator) {
      navigator.vibrate(10); // Short 10ms haptic pulse
    }
  }

  update(deltaTime) {
    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // Update screen shake
    this.shakeOffset.x += this.shakeVelocity.x;
    this.shakeOffset.y += this.shakeVelocity.y;

    // Apply decay
    this.shakeVelocity.x *= this.shakeDecay;
    this.shakeVelocity.y *= this.shakeDecay;
    this.shakeOffset.x *= this.shakeDecay;
    this.shakeOffset.y *= this.shakeDecay;

    // Snap to zero when very small
    if (Math.abs(this.shakeOffset.x) < 0.01) this.shakeOffset.x = 0;
    if (Math.abs(this.shakeOffset.y) < 0.01) this.shakeOffset.y = 0;
    if (Math.abs(this.shakeVelocity.x) < 0.01) this.shakeVelocity.x = 0;
    if (Math.abs(this.shakeVelocity.y) < 0.01) this.shakeVelocity.y = 0;
  }

  draw(ctx) {
    // Draw particles in world coordinates with constant screen size
    for (const p of this.particles) {
      const alpha = p.life;
      // Divide by scale to maintain constant screen size regardless of zoom
      const radius = p.size / this.renderer.camera.scale;

      ctx.save();

      // Draw subtle dark outline for visibility on light backgrounds
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * 0.3;
      ctx.fillStyle = '#000000';
      ctx.shadowBlur = 3 / this.renderer.camera.scale;
      ctx.shadowColor = '#000000';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 1.05, 0, Math.PI * 2);
      ctx.fill();

      // Draw colored glow halo with additive blending
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowBlur = 8 / this.renderer.camera.scale;
      ctx.shadowColor = p.color;
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Draw bright core on top with additive blending
      ctx.shadowBlur = 4 / this.renderer.camera.scale;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  drawScreenSpace(ctx) {
    // Draw particles in screen space (on top of UI) by converting world coords to screen coords
    for (const p of this.particles) {
      const alpha = p.life;
      const radius = p.size; // Fixed screen size

      // Convert world coordinates to screen coordinates
      const screen = this.renderer.camera.worldToScreen(p.x, p.y, this.renderer.canvas);

      ctx.save();

      // Draw subtle dark outline for visibility on light backgrounds
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * 0.3;
      ctx.fillStyle = '#000000';
      ctx.shadowBlur = 3;
      ctx.shadowColor = '#000000';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius * 1.05, 0, Math.PI * 2);
      ctx.fill();

      // Draw colored glow halo with additive blending
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.color;
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Draw bright core on top with additive blending
      ctx.shadowBlur = 4;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  hasActiveEffects() {
    return this.particles.length > 0 ||
           Math.abs(this.shakeOffset.x) > 0.01 ||
           Math.abs(this.shakeOffset.y) > 0.01;
  }
}

/****************
 * Renderer     *
 ****************/
class CanvasRenderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.camera = new Camera2D();
    this.effects = new EffectsManager(this, game);
    this.paletteBarHeight = 96;
    this.progressBarHeight = 10;
    this.margin = 12;
    this.paletteItemMinWidth = 64;
    this.numberFont = '12px Inter, system-ui, sans-serif';
    this.outlineColor = '#111';
    this.outlineWidth = 1.5;
    this.hoverRegion = null;
    this.debugRegion = null; // Region inspector for debug mode (Ctrl+hover)
    this._raf = null;
    this._checkerboardPattern = null;
    this._lastEffectsUpdate = 0;

    // Layered masking system: white overlay + static checkerboard + animated checkerboard
    this.whiteOverlayCanvas = null;  // Cached white overlay for unfilled regions
    this.whiteOverlayCtx = null;
    this.staticCheckerboardCanvas = null;  // Cached checkerboard for filled active regions
    this.staticCheckerboardCtx = null;
    this.animatedCanvas = null;  // Animated expanding checkerboard circles
    this.animatedCtx = null;

    this.activeAnimations = [];  // { region, clickX, clickY, startTime, duration }
    this._animationRaf = null;
    this._lastAnimationFrame = 0;
    this.animationFPS = 60;

    // Cached paths for masking layers
    this._whiteClipPath = null;  // Clip for unfilled regions
    this._whiteClipDirty = true;
    this._activeCheckerClipPath = null;  // Clip for filled active color regions
    this._activeCheckerClipDirty = true;
    this._cachedOutlinePath = null;  // Combined outline path for all regions
    this._outlinesDirty = true;

    addEventListener('resize', () => this.resize());
    this.resize();
  }
  setStyle({ outlineColor, outlineWidth }) {
    this.outlineColor = outlineColor;
    this.outlineWidth = outlineWidth;
  }
  initMask(width, height) {
    // Create separate canvas layers for compositing

    // 1. White overlay for unfilled regions
    this.whiteOverlayCanvas = document.createElement('canvas');
    this.whiteOverlayCanvas.width = width;
    this.whiteOverlayCanvas.height = height;
    this.whiteOverlayCtx = this.whiteOverlayCanvas.getContext('2d');

    // 2. Static checkerboard for filled active color regions
    this.staticCheckerboardCanvas = document.createElement('canvas');
    this.staticCheckerboardCanvas.width = width;
    this.staticCheckerboardCanvas.height = height;
    this.staticCheckerboardCtx = this.staticCheckerboardCanvas.getContext('2d');

    // 3. Animated checkerboard for expanding reveal circles
    this.animatedCanvas = document.createElement('canvas');
    this.animatedCanvas.width = width;
    this.animatedCanvas.height = height;
    this.animatedCtx = this.animatedCanvas.getContext('2d');

    // Reset state
    this.activeAnimations = [];
    this._whiteClipPath = null;
    this._whiteClipDirty = true;
    this._activeCheckerClipPath = null;
    this._activeCheckerClipDirty = true;

    if (this._animationRaf) {
      cancelAnimationFrame(this._animationRaf);
      this._animationRaf = null;
    }
  }
  worldBounds() {
    if (!this.game.regions.length) return { x: 0, y: 0, width: 100, height: 100 };
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (const r of this.game.regions) {
      x1 = Math.min(x1, r.bbox.x);
      y1 = Math.min(y1, r.bbox.y);
      x2 = Math.max(x2, r.bbox.x + r.bbox.width);
      y2 = Math.max(y2, r.bbox.y + r.bbox.height);
    }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  fitToScreen(padding = 20) {
    const b = this.worldBounds();
    const dpr = devicePixelRatio || 1;
    const w = this.canvas.width;
    // Convert UI heights to device pixels for proper calculation
    const bottomUI = (this.paletteBarHeight + this.progressBarHeight + this.margin * 2) * dpr;
    const h = this.canvas.height - bottomUI;
    const sx = (w - padding * 2) / b.width;
    const sy = (h - padding * 2) / b.height;
    this.camera.scale = clamp(Math.min(sx, sy), 0.05, 10);
    this.camera.x = b.x + b.width / 2;
    this.camera.y = b.y + b.height / 2;
    // Store bounds for panning constraints
    this.camera.bounds = b;
  }
  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    if (!this._raf) this.draw();
  }
  start() {
    if (!this._raf) this._raf = requestAnimationFrame(() => this.draw());
  }
  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  draw() {
    this._raf = null;
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;

    // Update effects
    const now = performance.now();
    const deltaTime = now - this._lastEffectsUpdate;
    this._lastEffectsUpdate = now;
    this.effects.update(deltaTime / 1000); // Convert to seconds

    // Continue rendering if hover active, debug mode active, animations running, or effects active
    if (this.hoverRegion || this.debugRegion || this.activeAnimations.length > 0 || this.effects.hasActiveEffects()) {
      this.start();
    }

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#202324';
    ctx.fillRect(0, 0, w, h);
    const bottomUI = this.paletteBarHeight + this.progressBarHeight + this.margin * 2;
    const viewHeight = h - bottomUI;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, viewHeight);
    ctx.clip();
    ctx.save();

    // Apply screen shake offset first (in screen space)
    ctx.translate(this.effects.shakeOffset.x, this.effects.shakeOffset.y);

    // Then apply normal camera transform
    this.camera.apply(ctx, this.canvas);

    // Layered rendering: image + static checkerboard + animated checkerboard + white overlay
    if (this.game.originalImage && this.whiteOverlayCanvas) {
      // 1. Draw the original image (bottom layer)
      ctx.drawImage(this.game.originalImage, 0, 0);

      // 2. Draw static checkerboard layer (filled active color regions)
      if (this._activeCheckerClipDirty) {
        this._rebuildActiveCheckerboardLayer();
      }
      ctx.drawImage(this.staticCheckerboardCanvas, 0, 0);

      // 3. Draw animated checkerboard layer (expanding reveal circles)
      if (this.activeAnimations.length > 0) {
        this._drawAnimatedCheckerboard();
        ctx.drawImage(this.animatedCanvas, 0, 0);
      }

      // 4. Draw white overlay (unfilled regions)
      if (this._whiteClipDirty) {
        this._rebuildWhiteOverlay();
      }
      ctx.drawImage(this.whiteOverlayCanvas, 0, 0);

      // 5. Draw region outlines (cached as single path for performance)
      if (this._outlinesDirty) {
        this._rebuildOutlinePath();
      }

      ctx.lineWidth = this.outlineWidth / this.camera.scale;
      ctx.strokeStyle = this.outlineColor;
      ctx.stroke(this._cachedOutlinePath);
    } else {
      // Fallback: old behavior (fill with palette colors)
      for (const r of this.game.regions) {
        ctx.lineWidth = this.outlineWidth / this.camera.scale;
        ctx.strokeStyle = this.outlineColor;
        ctx.fillStyle = r.filled ? r.color : '#fff';
        ctx.fill(r.path2d);
        ctx.stroke(r.path2d);
      }

      // Draw criss-cross hatch pattern on unfilled regions of the active color
      this.drawActiveColorHatch(ctx, null);  // null = all unfilled regions
    }

    if (this.hoverRegion && !this.hoverRegion.filled) {
      ctx.lineWidth = (this.outlineWidth * 2) / this.camera.scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke(this.hoverRegion.path2d);
    }

    // Debug mode: draw inspected region with red outline
    if (this.debugRegion) {
      ctx.lineWidth = (this.outlineWidth * 3) / this.camera.scale;
      ctx.strokeStyle = 'rgba(255,0,0,0.95)';
      ctx.stroke(this.debugRegion.path2d);
    }

    const numThresholdPxArea = 24 * 24;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const baseFontPx = 12;
    for (const r of this.game.regions) {
      const isAnimating = this.activeAnimations.some(anim => anim.region === r);
      if (r.filled || isAnimating) continue;  // Hide label if filled or animating
      const areaScreen = r.bbox.width * this.camera.scale * (r.bbox.height * this.camera.scale);
      if (areaScreen < numThresholdPxArea) continue;
      const fontPx =
        clamp(baseFontPx * Math.sqrt(areaScreen / numThresholdPxArea), 10, 24) / this.camera.scale;
      ctx.font = `${fontPx}px Inter, system-ui, sans-serif`;
      const { x, y } = r.labelPos;
      ctx.lineWidth = 3.5 / this.camera.scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(String(r.index), x, y);
      ctx.fillText(String(r.index), x, y);
    }

    ctx.restore();
    ctx.restore();
    this.drawProgressBar(w, h);
    this.drawPaletteBar(w, h);
    this.drawBackButton(w, h);

    // Draw particles on top of everything in screen space
    this.effects.drawScreenSpace(ctx);
  }

  _createCheckerboardPattern() {
    // Create pattern at a fixed pixel size to avoid blur and 0-size issues
    const patternCanvas = document.createElement('canvas');
    const pixelSize = 20; // Fixed size in screen pixels (10px per checker)
    patternCanvas.width = pixelSize;
    patternCanvas.height = pixelSize;
    const pctx = patternCanvas.getContext('2d');

    // Disable image smoothing for crisp edges
    pctx.imageSmoothingEnabled = false;

    // Draw 2x2 checkerboard at fixed pixel size
    const lightGrey = '#cccccc';
    const darkGrey = '#999999';
    const halfSize = pixelSize / 2;

    pctx.fillStyle = lightGrey;
    pctx.fillRect(0, 0, halfSize, halfSize);
    pctx.fillRect(halfSize, halfSize, halfSize, halfSize);

    pctx.fillStyle = darkGrey;
    pctx.fillRect(halfSize, 0, halfSize, halfSize);
    pctx.fillRect(0, halfSize, halfSize, halfSize);

    return this.ctx.createPattern(patternCanvas, 'repeat');
  }

  drawActiveColorHatch(ctx, onlyAnimating = null) {
    // Draw checkerboard pattern on unfilled regions matching the active index (like Photoshop transparency)
    let activeRegions = this.game.regions.filter(
      (r) => !r.filled && r.index === this.game.activeIndex
    );

    // Filter based on animation state if specified
    if (onlyAnimating === true) {
      // Only regions currently being revealed
      activeRegions = activeRegions.filter(r =>
        this.activeAnimations.some(anim => anim.region === r)
      );
    } else if (onlyAnimating === false) {
      // Only regions NOT currently being revealed
      activeRegions = activeRegions.filter(r =>
        !this.activeAnimations.some(anim => anim.region === r)
      );
    }

    if (activeRegions.length === 0) return;

    // Create pattern once (fixed pixel size, no need to recreate on zoom)
    if (!this._checkerboardPattern) {
      this._checkerboardPattern = this._createCheckerboardPattern();
    }

    ctx.save();

    // Disable image smoothing for crisp checkerboard
    ctx.imageSmoothingEnabled = false;

    // Draw checkerboard pattern for each active region
    for (const region of activeRegions) {
      ctx.save();

      // Clip to the region shape
      ctx.beginPath();
      ctx.clip(region.path2d);

      // Scale the pattern to world coordinates
      // Pattern is 20px, we want it to appear as 20 world units / camera scale
      const worldPatternSize = 20 / this.camera.scale;
      const patternScale = worldPatternSize / 20;

      // Apply transform to scale the pattern
      ctx.translate(region.bbox.x, region.bbox.y);
      ctx.scale(patternScale, patternScale);

      // Fill with the tiled pattern
      ctx.fillStyle = this._checkerboardPattern;
      const { bbox } = region;
      ctx.fillRect(0, 0, bbox.width / patternScale, bbox.height / patternScale);

      ctx.restore();
    }

    ctx.restore();
  }

  drawProgressBar(w, h) {
    const ctx = this.ctx;
    const dpr = devicePixelRatio || 1;
    const m = this.margin * dpr;
    const ph = this.progressBarHeight * dpr;
    const pbH = this.paletteBarHeight * dpr;
    const y = h - (pbH + ph + m * 2);
    const x = m,
      width = w - m * 2;
    const pct = this.game.overallProgress();
    ctx.save();
    ctx.fillStyle = '#0f1417';
    ctx.fillRect(x, y, width, ph);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x, y, width * pct, ph);
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#e8e6e3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(pct * 100)}%`, x + width / 2, y + ph / 2);
    ctx.restore();
  }
  drawPaletteBar(w, h) {
    const ctx = this.ctx;
    const dpr = devicePixelRatio || 1;
    const m = this.margin * dpr;
    const pbH = this.paletteBarHeight * dpr;
    const y = h - (pbH + m);
    const x = m,
      width = w - m * 2,
      height = pbH;
    this._paletteRects = [];
    ctx.save();
    ctx.fillStyle = '#111315';
    ctx.fillRect(x, y, width, height);
    const entries = [...this.game.palette.values()].sort((a, b) => a.index - b.index);
    const n = entries.length || 1;
    const itemW = Math.max(this.paletteItemMinWidth, Math.floor((width - m * (n + 1)) / n));
    let ix = x + m;
    for (const p of entries) {
      const isActive = p.index === this.game.activeIndex;
      const itemY = y + m;
      const itemH = height - m * 2;
      ctx.fillStyle = isActive ? '#1f2937' : '#161a1d';
      ctx.fillRect(ix, itemY, itemW, itemH);
      const swH = Math.min(36, itemH - 28);
      ctx.fillStyle = p.color;
      ctx.fillRect(ix + 8, itemY + 8, itemW - 16, swH);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.strokeRect(ix + 8, itemY + 8, itemW - 16, swH);
      ctx.font = 'bold 14px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#e8e6e3';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${p.index}`, ix + 8, itemY + 8 + swH + 6);
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#b7babd';
      ctx.fillText(`${p.found}/${p.total}`, ix + 8 + 22, itemY + 8 + swH + 8);

      // Draw green checkmark if complete
      const isComplete = (p.found === p.total);
      if (isComplete) {
        ctx.save();
        // Draw drop shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = '#22c55e';
        ctx.font = 'bold 32px Inter, system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('✓', ix + itemW - 6, itemY + itemH - 4);
        ctx.restore();
      }

      if (isActive) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#3b82f6';
        ctx.strokeRect(ix + 0.5, itemY + 0.5, itemW - 1, itemH - 1);
      }
      this._paletteRects.push({ x: ix, y: itemY, w: itemW, h: itemH, index: p.index });
      ix += itemW + m;
    }
    const hintText = `Hints: ${this.game.hintTokens}`;
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#e8e6e3';
    ctx.textAlign = 'right';
    ctx.fillText(hintText, x + width - 8, y + height - 18);
    ctx.restore();
  }
  paletteHitTest(px, py) {
    if (!this._paletteRects) return null;
    for (const r of this._paletteRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.index;
    }
    return null;
  }

  drawBackButton(w, h) {
    const ctx = this.ctx;
    const m = this.margin;
    const buttonSize = 40;
    const buttonX = m;
    const buttonY = m;

    // Store hit area for click detection
    this._backButtonRect = { x: buttonX, y: buttonY, w: buttonSize, h: buttonSize };

    ctx.save();

    // Button background
    ctx.fillStyle = 'rgba(17, 19, 21, 0.9)';
    ctx.fillRect(buttonX, buttonY, buttonSize, buttonSize);

    // Button border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(buttonX + 0.5, buttonY + 0.5, buttonSize - 1, buttonSize - 1);

    // Draw back arrow (chevron left)
    ctx.strokeStyle = '#e8e6e3';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const centerX = buttonX + buttonSize / 2;
    const centerY = buttonY + buttonSize / 2;
    ctx.moveTo(centerX + 5, centerY - 8);
    ctx.lineTo(centerX - 3, centerY);
    ctx.lineTo(centerX + 5, centerY + 8);
    ctx.stroke();

    ctx.restore();
  }

  backButtonHitTest(px, py) {
    if (!this._backButtonRect) return false;
    const r = this._backButtonRect;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // Animation system for revealing regions
  startRevealAnimation(region, clickX, clickY) {
    if (!this.whiteOverlayCanvas || !this.game.originalImage) {
      // Fallback if no masking layers
      this.game.setFilled(region, true);
      this._whiteClipDirty = true;
      this._activeCheckerClipDirty = true;
      return;
    }

    // Don't restart animation if region is already animating
    const alreadyAnimating = this.activeAnimations.some(anim => anim.region === region);
    if (alreadyAnimating) {
      return;
    }

    // Mark region as filled immediately (updates palette counts and triggers events)
    this.game.setFilled(region, true);

    // Add to active animations
    this.activeAnimations.push({
      region,
      clickX,
      clickY,
      startTime: performance.now(),
      duration: 800,  // 800ms animation - snappy but satisfying
      progress: 0
    });

    // Immediately mark layers dirty to remove region from white/static checkerboard
    this._whiteClipDirty = true;
    this._activeCheckerClipDirty = true;

    // Start animation loop if not already running
    if (!this._animationRaf) {
      this.updateAnimations();
    }
  }

  updateAnimations() {
    const now = performance.now();

    // Throttle to target FPS for better performance
    const frameTime = 1000 / this.animationFPS;
    if (now - this._lastAnimationFrame < frameTime) {
      // Skip this frame, schedule next one
      this._animationRaf = requestAnimationFrame(() => this.updateAnimations());
      return;
    }
    this._lastAnimationFrame = now;

    let anyActive = false;

    for (let i = this.activeAnimations.length - 1; i >= 0; i--) {
      const anim = this.activeAnimations[i];
      const elapsed = now - anim.startTime;
      const rawProgress = Math.min(elapsed / anim.duration, 1.0);

      // Use easing function for smoother animation
      anim.progress = 1 - Math.pow(1 - rawProgress, 3); // ease-out cubic

      if (rawProgress >= 1.0) {
        // Animation complete - rebuild layers
        this._whiteClipDirty = true;
        this._activeCheckerClipDirty = true;
        this.activeAnimations.splice(i, 1);
      } else {
        anyActive = true;
      }
    }

    // Trigger redraw
    this.start();

    // Continue animation loop if there are active animations
    if (anyActive) {
      this._animationRaf = requestAnimationFrame(() => this.updateAnimations());
    } else {
      this._animationRaf = null;
    }
  }

  _rebuildWhiteOverlay() {
    // Build white overlay for unfilled regions excluding active color and animating regions
    const ctx = this.whiteOverlayCtx;
    ctx.clearRect(0, 0, this.whiteOverlayCanvas.width, this.whiteOverlayCanvas.height);

    // White shows for regions that are NOT (filled OR active color OR animating)
    // Holes are already built into the path2d objects via even-odd fill rule
    this._whiteClipPath = new Path2D();
    for (const r of this.game.regions) {
      const isAnimating = this.activeAnimations.some(anim => anim.region === r);
      if (!r.filled && r.index !== this.game.activeIndex && !isAnimating) {
        this._whiteClipPath.addPath(r.path2d);
      }
    }

    // Fill clipped area with white (using even-odd rule - holes are built into paths)
    // First stroke the path to expand regions into pixel-boundary gaps
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke(this._whiteClipPath);
    ctx.clip(this._whiteClipPath, 'evenodd');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.whiteOverlayCanvas.width, this.whiteOverlayCanvas.height);
    ctx.restore();

    this._whiteClipDirty = false;
  }

  _rebuildActiveCheckerboardLayer() {
    // Build static checkerboard for unfilled active color regions (excluding animating)
    const ctx = this.staticCheckerboardCtx;
    ctx.clearRect(0, 0, this.staticCheckerboardCanvas.width, this.staticCheckerboardCanvas.height);

    // Build clip path for unfilled regions matching active color that are not animating
    // Holes are already built into the path2d objects via even-odd fill rule
    this._activeCheckerClipPath = new Path2D();
    for (const r of this.game.regions) {
      const isAnimating = this.activeAnimations.some(anim => anim.region === r);
      if (!r.filled && r.index === this.game.activeIndex && !isAnimating) {
        this._activeCheckerClipPath.addPath(r.path2d);
      }
    }

    // Draw checkerboard pattern in clipped area (using even-odd rule - holes are built into paths)
    // First stroke the path to expand regions into pixel-boundary gaps
    ctx.save();
    if (!this._checkerboardPattern) {
      this._checkerboardPattern = this._createCheckerboardPattern();
    }
    ctx.strokeStyle = this._checkerboardPattern;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke(this._activeCheckerClipPath);
    ctx.clip(this._activeCheckerClipPath, 'evenodd');
    this._drawCheckerboardPattern(ctx);
    ctx.restore();

    this._activeCheckerClipDirty = false;
  }

  _drawAnimatedCheckerboard() {
    // Draw checkerboard for animating regions with expanding transparent circle
    const ctx = this.animatedCtx;
    ctx.clearRect(0, 0, this.animatedCanvas.width, this.animatedCanvas.height);

    if (this.activeAnimations.length === 0) return;

    for (const anim of this.activeAnimations) {
      const { region, clickX, clickY, progress } = anim;

      ctx.save();

      // Clip to region boundary
      ctx.clip(region.path2d);

      // Draw checkerboard for entire region
      this._drawCheckerboardPattern(ctx);

      // Cut out expanding circle using destination-out compositing
      ctx.globalCompositeOperation = 'destination-out';

      // Calculate reveal radius
      const bbox = region.bbox;
      const corners = [
        { x: bbox.x, y: bbox.y },
        { x: bbox.x + bbox.width, y: bbox.y },
        { x: bbox.x, y: bbox.y + bbox.height },
        { x: bbox.x + bbox.width, y: bbox.y + bbox.height }
      ];
      const maxDist = Math.max(...corners.map(c =>
        Math.hypot(c.x - clickX, c.y - clickY)
      ));
      const radius = maxDist * progress;

      // Draw expanding circle (will erase from checkerboard)
      ctx.fillStyle = 'rgba(0,0,0,1)'; // Color doesn't matter, just alpha
      ctx.beginPath();
      ctx.arc(clickX, clickY, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  _drawCheckerboardPattern(ctx) {
    // Draw checkerboard pattern on the entire canvas (clipping controls visibility)
    // Pattern is 20px screen size, needs to map to world coordinates
    if (!this._checkerboardPattern) {
      this._checkerboardPattern = this._createCheckerboardPattern();
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this._checkerboardPattern;
    const canvas = ctx.canvas;

    // The pattern is 20px, draw it tiled across the canvas at that size
    // No transforms needed - the off-screen canvas is already in world coordinates
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  _regionContains(container, contained) {
    // Check if container region completely contains the contained region
    const cBox = container.bbox;
    const oBox = contained.bbox;

    // Quick bbox check first
    if (oBox.x < cBox.x || oBox.y < cBox.y ||
        oBox.x + oBox.width > cBox.x + cBox.width ||
        oBox.y + oBox.height > cBox.y + cBox.height) {
      return false;
    }

    // Check if center point of contained region is inside container path
    // Use 'evenodd' fill rule to match SVG rendering
    const cx = oBox.x + oBox.width / 2;
    const cy = oBox.y + oBox.height / 2;
    return this.ctx.isPointInPath(container.path2d, cx, cy, 'evenodd');
  }

  _rebuildOutlinePath() {
    // Combine all region outlines into single path for efficient rendering
    const outlinePath = new Path2D();
    for (const r of this.game.regions) {
      outlinePath.addPath(r.path2d);
    }
    this._cachedOutlinePath = outlinePath;
    this._outlinesDirty = false;
  }
}

/****************
 * Controller   *
 ****************/
class Controller {
  constructor(canvas, game, renderer, app) {
    this.canvas = canvas;
    this.game = game;
    this.r = renderer;
    this.app = app;
    this.isPanning = false;
    this.lastX = 0;
    this.lastY = 0;
    this.activePointers = new Map();
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    addEventListener('pointerup', (e) => this.onPointerUp(e));
    addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('mousemove', (e) => this.onHover(e));

    // Prevent context menu (right-click)
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('drop', (e) => this.onDrop(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }
  onPointerDown(e) {
    // Ignore non-primary buttons (right-click, middle-click, etc.)
    if (e.button !== 0) return;

    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.activePointers.size === 1) this.isPanning = true;
    this.handleTapOrPalette(e);
  }
  onPointerMove(e) {
    const prev = this.activePointers.get(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.activePointers.size === 1 && this.isPanning) {
      const dx = e.clientX - this.lastX,
        dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const dpr = devicePixelRatio || 1;
      this.r.camera.x -= (dx * dpr) / this.r.camera.scale;
      this.r.camera.y -= (dy * dpr) / this.r.camera.scale;
      this.r.camera.constrainToBounds(this.r.canvas);
      this.r.start();
      // Update URL hash with new camera position
      this.app.updateCameraHash();
    }
    if (this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      const dx = pts[1].x - pts[0].x,
        dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy);
      if (this._pinchDist) {
        const factor = dist / this._pinchDist;
        const cx = (pts[0].x + pts[1].x) / 2,
          cy = (pts[0].y + pts[1].y) / 2;
        this.r.camera.zoomAt(factor, cx * devicePixelRatio, cy * devicePixelRatio, this.r.canvas);
        this.r.camera.constrainToBounds(this.r.canvas);
        this.r.start();
        // Update URL hash with new camera position
        this.app.updateCameraHash();
      }
      this._pinchDist = dist;
    }
  }
  onPointerUp(e) {
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      this.isPanning = false;
      this._pinchDist = null;
    }
  }
  onWheel(e) {
    e.preventDefault();
    const zoomFactor = Math.pow(1.0015, -e.deltaY);
    const rect = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * devicePixelRatio;
    const cy = (e.clientY - rect.top) * devicePixelRatio;
    this.r.camera.zoomAt(zoomFactor, cx, cy, this.r.canvas);
    this.r.camera.constrainToBounds(this.r.canvas);
    this.r.start();
    // Update URL hash with new camera position
    this.app.updateCameraHash();
  }
  onHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * devicePixelRatio;
    const py = (e.clientY - rect.top) * devicePixelRatio;
    const world = this.r.camera.screenToWorld(px, py, this.r.canvas);

    // Debug mode: Ctrl key enables region inspector
    const isDebugMode = e.ctrlKey || e.metaKey;

    // In debug mode, search ALL regions regardless of color or filled state
    const candidates = isDebugMode
      ? this.game.regions
      : this.game.regions.filter(
          (r) => !r.filled && r.index === this.game.activeIndex &&
            !this.r.activeAnimations.some(anim => anim.region === r),
        );

    let hit = null;
    for (const r of candidates) {
      if (this.r.ctx.isPointInPath(r.path2d, world.x, world.y, 'evenodd')) {
        hit = r;
        break;
      }
    }

    if (isDebugMode) {
      // Debug mode: set debugRegion and clear hoverRegion
      if (this.r.debugRegion !== hit) {
        this.r.debugRegion = hit;
        this.r.hoverRegion = null;
        if (!this.r._raf) {
          this.r.start();
        }
      }
    } else {
      // Normal mode: set hoverRegion and clear debugRegion
      if (this.r.hoverRegion !== hit || this.r.debugRegion !== null) {
        this.r.hoverRegion = hit;
        this.r.debugRegion = null;
        if (!this.r._raf) {
          this.r.start();
        }
      }
    }
  }
  handleTapOrPalette(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * devicePixelRatio;
    const py = (e.clientY - rect.top) * devicePixelRatio;

    // Debug mode: Ctrl+click logs region details
    if ((e.ctrlKey || e.metaKey) && this.r.debugRegion) {
      this.logRegionDebugInfo(this.r.debugRegion);
      return;
    }

    // Check for back button click
    if (this.r.backButtonHitTest(px, py)) {
      App.showLibrary(true);
      return;
    }

    const paletteIndex = this.r.paletteHitTest(px, py);
    if (paletteIndex != null) {
      this.game.setActiveIndex(paletteIndex);
      this.r.start();
      return;
    }
    const world = this.r.camera.screenToWorld(px, py, this.r.canvas);
    const candidates = this.game.regions.filter(
      (r) => !r.filled && r.index === this.game.activeIndex,
    );
    let hit = null;
    for (const r of candidates) {
      if (this.r.ctx.isPointInPath(r.path2d, world.x, world.y, 'evenodd')) {
        hit = r;
        break;
      }
    }
    if (hit) {
      // Clear hover effect immediately
      this.r.hoverRegion = null;
      // Start reveal animation instead of immediate fill
      this.r.startRevealAnimation(hit, world.x, world.y);
      // Trigger effects (particles, shake, haptic)
      this.r.effects.onRegionTap(world.x, world.y, hit);
      App.saveProgressDebounced();
    } else {
      this.game.events.emit('wrong-tap', { point: world, activeIndex: this.game.activeIndex });
    }
  }
  logRegionDebugInfo(region) {
    console.group(`%c🔍 Region Inspector`, 'font-weight: bold; font-size: 14px; color: #ff0000;');
    console.log('Region ID:', region.id);
    console.log('Color Index:', region.index);
    console.log('Color:', region.color);
    console.log('Filled:', region.filled);
    console.log('SVG Type:', region.svgType);
    console.log('Bounding Box:', region.bbox);
    console.log('Label Position:', region.labelPos);

    // Log SVG path data
    if (region.svgType === 'path' && region.svgAttrs?.d) {
      const pathData = region.svgAttrs.d;
      console.log('SVG Path Length:', pathData.length, 'chars');

      // Count the number of points (L commands + M command)
      const lCommands = (pathData.match(/L/g) || []).length;
      const mCommands = (pathData.match(/M/g) || []).length;
      console.log('Path Commands:', { M: mCommands, L: lCommands, Total: mCommands + lCommands });

      // Show first 200 chars as preview
      const preview = pathData.length > 200 ? pathData.substring(0, 200) + '...' : pathData;
      console.log('Path Preview:', preview);

      // Full path data
      console.log('Full SVG Path (d attribute):');
      console.log(pathData);
    } else if (region.svgAttrs) {
      console.log('SVG Attributes:', region.svgAttrs);
    }

    console.groupEnd();
  }
  async onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      const text = await file.text();
      await App.loadSVGText(text);
      return;
    }
    if (file.type.startsWith('image/')) {
      // raster → palletize using worker
      const imgURL = URL.createObjectURL(file);
      const img = new Image();
      img.src = imgURL;
      await img.decode();
      const bmp = await createImageBitmap(img);
      URL.revokeObjectURL(imgURL);

      // Process using worker (non-blocking)
      // Use saved preferences or defaults
      const processor = localStorage.getItem('tapcolor_processor') || 'structure-aware';
      const difficulty = localStorage.getItem('tapcolor_difficulty') || 'medium';

      const svg = await new Promise((resolve, reject) => {
        App.imageProcessor.processImage(bmp, difficulty, {
          processor,
          onProgress: (progress) => {
            console.log(`[Worker] ${progress.status} (${progress.progress}%)`);
          },
          onComplete: (result) => {
            resolve(result.svg);
          },
          onError: (error) => {
            reject(error);
          }
        });
      });

      await App.loadSVGText(svg, bmp);  // Pass original image
      return;
    }
    console.warn('Unsupported drop type:', file.type);
  }
  onKey(e) {
    if (e.key === 'h' || e.key === 'H') App.useHint();
    if (e.key === 'p' || e.key === 'P') App.exportPNG();
  }
}

/****************
 * Persistence  *
 ****************/
class Storage {
  static load(key) {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }
  static save(key, data) {
    try {
      const json = JSON.stringify(data);
      localStorage.setItem(key, json);
      console.log(`Saved ${key} (${(json.length / 1024).toFixed(1)}KB)`);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded! Try deleting old images from library.');
        alert('Storage full! Please delete some images from your library.');
      } else {
        console.error('Error saving to localStorage:', e);
      }
    }
  }
}

/****************
 * Image Processor Worker Wrapper *
 ****************/
class ImageProcessorWorker {
  constructor() {
    // Create module worker (ES6 import/export support)
    // Add cache-busting to ensure worker updates are loaded
    this.worker = new Worker(`image-processor-worker.js?v=${Date.now()}`, { type: 'module' });
    this.pendingCallbacks = new Map();

    // Set up message handler for processing
    this.worker.addEventListener('message', (e) => {
      const { type, payload } = e.data;
      const callbacks = this.pendingCallbacks.get('current');

      if (!callbacks) return;

      switch (type) {
        case 'PROGRESS':
          if (callbacks.onProgress) {
            callbacks.onProgress(payload);
          }
          break;
        case 'COMPLETE':
          if (callbacks.onComplete) {
            callbacks.onComplete(payload);
          }
          this.pendingCallbacks.delete('current');
          break;
        case 'ERROR':
          if (callbacks.onError) {
            callbacks.onError(new Error(payload.message));
          }
          this.pendingCallbacks.delete('current');
          break;
      }
    });
  }

  async processImage(imageBitmap, difficulty, options = {}) {
    // Support both old API (callbacks as 3rd param) and new API (options object)
    let callbacks, processor;

    console.log('Wrapper received options:', JSON.stringify({
      hasProcessor: !!options.processor,
      processorValue: options.processor,
      hasCallbacks: !!(options.onProgress || options.onComplete || options.onError),
      optionsType: typeof options
    }));

    if (typeof options === 'string') {
      // Transitional: processor as string, callbacks missing
      processor = options;
      callbacks = {};
      console.log('Branch: string processor');
    } else if (options.processor) {
      // New API: options object with processor property
      processor = options.processor;
      callbacks = options; // Callbacks are in the same object
      console.log('Branch: options.processor');
    } else if (options.onProgress || options.onComplete || options.onError) {
      // Old API: callbacks passed directly without processor
      callbacks = options;
      processor = 'structure-aware'; // Default
      console.log('Branch: old API, defaulting to structure-aware');
    } else {
      // Fallback
      processor = 'structure-aware';
      callbacks = {};
      console.log('Branch: fallback to structure-aware');
    }

    // Store callbacks
    this.pendingCallbacks.set('current', callbacks);

    console.log('ImageProcessorWorker sending to worker - processor:', processor, 'difficulty:', difficulty);

    // Extract image data from ImageBitmap
    const canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);

    // Send to worker
    this.worker.postMessage({
      type: 'PROCESS_IMAGE',
      payload: {
        imageData: imageData.data.buffer,
        width: imageBitmap.width,
        height: imageBitmap.height,
        difficulty,
        processor
      }
    }, [imageData.data.buffer]); // Transfer the buffer for performance
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

/****************
 * Image Library *
 ****************/
// IndexedDB wrapper for storing images with much larger quota than localStorage
// IndexedDB typically supports 50MB+ (varies by browser), vs localStorage's ~5-10MB limit
class ImageDB {
  static DB_NAME = 'tap-color-db';
  static DB_VERSION = 1;
  static STORE_NAME = 'images';
  static dbPromise = null;

  static async getDB() {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          console.log('Created IndexedDB object store for images');
        }
      };
    });

    return this.dbPromise;
  }

  static async getAll() {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('Failed to get all images from IndexedDB:', error);
      return [];
    }
  }

  static async get(id) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('Failed to get image from IndexedDB:', error);
      return null;
    }
  }

  static async save(entry) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.put(entry);

        request.onsuccess = () => {
          console.log(`Saved image to IndexedDB: ${entry.name}`);
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('Failed to save image to IndexedDB:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => {
          console.log(`Deleted image from IndexedDB: ${id}`);
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('Failed to delete image from IndexedDB:', error);
      throw error;
    }
  }

  // Migrate data from localStorage to IndexedDB
  static async migrateFromLocalStorage() {
    try {
      const oldData = Storage.load('tap-color:library');
      if (!oldData || oldData.length === 0) {
        console.log('No localStorage data to migrate');
        return;
      }

      console.log(`Migrating ${oldData.length} images from localStorage to IndexedDB...`);

      for (const entry of oldData) {
        await this.save(entry);
      }

      // Clear old localStorage data
      Storage.save('tap-color:library', []);
      console.log('Migration complete! Cleared localStorage.');
    } catch (error) {
      console.error('Migration failed:', error);
    }
  }
}

class ImageLibrary {
  static async getAll() {
    return await ImageDB.getAll();
  }

  static async save(entry) {
    await ImageDB.save(entry);
  }

  static async delete(id) {
    await ImageDB.delete(id);
  }

  static async get(id) {
    return await ImageDB.get(id);
  }
}

// Custom element: <library-screen>
class LibraryScreen extends HTMLElement {
  connectedCallback() {
    // Attach event listeners once, render happens when showLibrary() is called
    this.attachEventListeners();
  }

  async render() {
    const library = await ImageLibrary.getAll();
    console.log(`Rendering library with ${library.length} images`);

    this.innerHTML = `
      <div class="library-header">
        <h1>Image Library</h1>
        <p>Select an image to start coloring</p>
      </div>
      <div class="library-grid">
        ${library.map(entry => `
          <div class="library-item" data-id="${entry.id}">
            <div class="library-item-thumbnail">
              <img src="${entry.thumbnail}" alt="${entry.name}" />
            </div>
            <div class="library-item-name">${entry.name}</div>
            <button class="library-item-delete" data-id="${entry.id}">&times;</button>
          </div>
        `).join('')}
        <div class="library-item library-add-new">
          <div class="library-add-icon">+</div>
          <div class="library-add-text">Add New Image</div>
          <input type="file" class="library-file-input" accept="image/*" style="display:none" />
        </div>
      </div>
    `;
  }

  attachEventListeners() {
    // Only attach listeners once using event delegation
    if (this._listenersAttached) return;
    this._listenersAttached = true;

    // Use event delegation for library items and delete buttons
    this.addEventListener('click', async (e) => {
      // Delete button
      if (e.target.classList.contains('library-item-delete')) {
        e.stopPropagation();
        const id = e.target.dataset.id;
        if (confirm('Delete this image from library?')) {
          await ImageLibrary.delete(id);
          await this.render();
        }
        return;
      }

      // Library item
      const item = e.target.closest('.library-item[data-id]');
      if (item) {
        const id = item.dataset.id;
        this.showDifficultySelector(id);
        return;
      }

      // Add new button
      if (e.target.closest('.library-add-new')) {
        const fileInput = this.querySelector('.library-file-input');
        fileInput?.click();
        return;
      }
    });

    // File input change - use event delegation since input is recreated on render
    this.addEventListener('change', (e) => {
      if (e.target.classList.contains('library-file-input')) {
        const file = e.target.files?.[0];
        if (file) {
          console.log('File selected:', file.name);
          this.dispatchEvent(new CustomEvent('add-image', { detail: { file } }));
          // Reset input so same file can be selected again
          e.target.value = '';
        }
      }
    });

    // Drag and drop
    this.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.classList.add('drag-over');
    });
    this.addEventListener('dragleave', (e) => {
      if (e.target === this) {
        this.classList.remove('drag-over');
      }
    });
    this.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        this.dispatchEvent(new CustomEvent('add-image', { detail: { file } }));
      }
    });

    // Prevent context menu
    this.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    });
  }

  async showDifficultySelector(entryId) {
    const entry = await ImageLibrary.get(entryId);
    if (!entry) return;

    // If only one difficulty available, load it directly
    const availableDifficulties = Object.keys(entry.processedSVGs);
    if (availableDifficulties.length === 1) {
      this.dispatchEvent(new CustomEvent('select-image', {
        detail: { entryId, difficulty: availableDifficulties[0] }
      }));
      return;
    }

    // Show selector if multiple difficulties
    const modal = document.createElement('difficulty-modal');
    modal.setAttribute('entry-id', entryId);
    document.body.appendChild(modal);

    modal.addEventListener('select', (e) => {
      this.dispatchEvent(new CustomEvent('select-image', {
        detail: { entryId, difficulty: e.detail.difficulty }
      }));
    });
  }
}

// Custom element: <difficulty-modal>
class DifficultyModal extends HTMLElement {
  async connectedCallback() {
    const entryId = this.getAttribute('entry-id');
    const entry = await ImageLibrary.get(entryId);
    if (!entry) {
      this.remove();
      return;
    }

    this.innerHTML = `
      <div class="difficulty-content">
        <h2>Select Difficulty</h2>
        <p class="difficulty-image-name">${entry.name}</p>
        <div class="difficulty-options">
          ${entry.processedSVGs.easy ? `
            <button class="difficulty-btn" data-difficulty="easy">
              <div class="difficulty-btn-title">Easy</div>
              <div class="difficulty-btn-desc">~80 regions, ~12 colors</div>
            </button>
          ` : ''}
          ${entry.processedSVGs.medium ? `
            <button class="difficulty-btn" data-difficulty="medium">
              <div class="difficulty-btn-title">Medium</div>
              <div class="difficulty-btn-desc">~300 regions, ~20 colors</div>
            </button>
          ` : ''}
          ${entry.processedSVGs.hard ? `
            <button class="difficulty-btn" data-difficulty="hard">
              <div class="difficulty-btn-title">Hard</div>
              <div class="difficulty-btn-desc">~600 regions, ~30 colors</div>
            </button>
          ` : ''}
          ${entry.processedSVGs.expert ? `
            <button class="difficulty-btn" data-difficulty="expert">
              <div class="difficulty-btn-title">Expert</div>
              <div class="difficulty-btn-desc">~700 regions, ~40 colors</div>
            </button>
          ` : ''}
        </div>
        <button class="difficulty-cancel">Cancel</button>
      </div>
    `;

    this.querySelectorAll('.difficulty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const difficulty = btn.dataset.difficulty;
        this.dispatchEvent(new CustomEvent('select', { detail: { difficulty } }));
        this.remove();
      });
    });

    this.querySelector('.difficulty-cancel').addEventListener('click', () => {
      this.remove();
    });

    this.addEventListener('click', (e) => {
      if (e.target === this) {
        this.remove();
      }
    });
  }
}

// Custom element: <image-config-modal>
class ImageConfigModal extends HTMLElement {
  constructor() {
    super();
    this.imageFile = null;
    this.imageBitmap = null;

    // Load saved preferences or use defaults
    this.currentProcessor = localStorage.getItem('tapcolor_processor') || 'structure-aware';
    this.currentDifficulty = localStorage.getItem('tapcolor_difficulty') || 'medium';

    this.processing = false;
    this.processingId = 0; // Track which processing run we're on
    this.latestSVG = null;
  }

  async init(file, defaultName) {
    console.log('ImageConfigModal init', file.name);
    this.imageFile = file;
    this.defaultName = defaultName;

    // Load image
    const imgURL = URL.createObjectURL(file);
    const img = new Image();
    img.src = imgURL;
    await new Promise((resolve) => (img.onload = resolve));
    this.imageBitmap = await createImageBitmap(img);
    URL.revokeObjectURL(imgURL);

    console.log('Image loaded, rendering modal...');
    this.render();
    this.attachListeners();

    // Auto-start processing with saved settings
    this.querySelector('.preview-section').style.display = 'block';
    this.processImage();
  }

  render() {
    this.innerHTML = `
      <div class="image-config-content">
        <h2>Configure Image</h2>

        <div class="config-section">
          <label>Name:</label>
          <input type="text" class="name-input" value="${this.defaultName}" />
        </div>

        <div class="config-section">
          <label>Processor:</label>
          <select class="processor-select">
            <option value="structure-aware" ${this.currentProcessor === 'structure-aware' ? 'selected' : ''}>Structure-Aware (Recommended)</option>
            <option value="segment-anything" ${this.currentProcessor === 'segment-anything' ? 'selected' : ''}>Segment Anything (SAM) - Requires Service</option>
            <option value="region-growing" ${this.currentProcessor === 'region-growing' ? 'selected' : ''}>Region Growing</option>
            <option value="kmeans" ${this.currentProcessor === 'kmeans' ? 'selected' : ''}>K-Means</option>
            <option value="posterize" ${this.currentProcessor === 'posterize' ? 'selected' : ''}>Posterize</option>
          </select>
        </div>

        <div class="config-section">
          <label>Difficulty:</label>
          <select class="difficulty-select">
            <option value="easy" ${this.currentDifficulty === 'easy' ? 'selected' : ''}>Easy (~80 regions, ~12 colors)</option>
            <option value="medium" ${this.currentDifficulty === 'medium' ? 'selected' : ''}>Medium (~300 regions, ~20 colors)</option>
            <option value="hard" ${this.currentDifficulty === 'hard' ? 'selected' : ''}>Hard (~600 regions, ~30 colors)</option>
            <option value="expert" ${this.currentDifficulty === 'expert' ? 'selected' : ''}>Expert (~700 regions, ~40 colors)</option>
          </select>
        </div>

        <div class="config-section">
          <button class="config-btn-process">Process Image</button>
        </div>

        <div class="config-section preview-section" style="display: none;">
          <label>Preview:</label>
          <div class="preview-container">
            <div class="preview-spinner">
              <div class="spinner"></div>
              <p class="preview-status">Processing...</p>
            </div>
            <canvas class="preview-canvas" style="display: none;"></canvas>
          </div>
        </div>

        <div class="config-buttons">
          <button class="config-btn-cancel">Cancel</button>
          <button class="config-btn-ok" disabled>Add to Library</button>
        </div>
      </div>
    `;
  }

  attachListeners() {
    // Keyboard handler for ESC key
    this.keyHandler = (e) => {
      if (e.key === 'Escape') {
        this.dispatchEvent(new CustomEvent('cancel'));
        this.cleanup();
      }
    };
    document.addEventListener('keydown', this.keyHandler);

    this.querySelector('.processor-select').addEventListener('change', (e) => {
      this.currentProcessor = e.target.value;
      localStorage.setItem('tapcolor_processor', this.currentProcessor);
      // Restart processing with new settings
      this.processImage();
    });

    this.querySelector('.difficulty-select').addEventListener('change', (e) => {
      this.currentDifficulty = e.target.value;
      localStorage.setItem('tapcolor_difficulty', this.currentDifficulty);
      // Restart processing with new settings
      this.processImage();
    });

    this.querySelector('.config-btn-process').addEventListener('click', () => {
      // Show preview section and start processing
      this.querySelector('.preview-section').style.display = 'block';
      this.processImage();
    });

    this.querySelector('.config-btn-ok').addEventListener('click', () => {
      const name = this.querySelector('.name-input').value.trim() || this.defaultName;
      if (this.latestSVG) {
        this.dispatchEvent(new CustomEvent('submit', {
          detail: {
            name,
            svg: this.latestSVG,
            difficulty: this.currentDifficulty,
            processor: this.currentProcessor
          }
        }));
        this.cleanup();
      }
    });

    this.querySelector('.config-btn-cancel').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('cancel'));
      this.cleanup();
    });

    this.addEventListener('click', (e) => {
      if (e.target === this) {
        this.dispatchEvent(new CustomEvent('cancel'));
        this.cleanup();
      }
    });
  }

  cleanup() {
    // Remove keyboard event listener
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler);
    }
    this.remove();
  }

  async processImage() {
    if (this.processing) {
      console.log('Already processing, skipping...');
      return;
    }
    this.processing = true;
    this.processingId++; // Increment ID for this processing run
    const currentId = this.processingId; // Capture ID for callbacks

    console.log('Modal processImage - processor:', this.currentProcessor, 'difficulty:', this.currentDifficulty, 'ID:', currentId);

    // Show spinner, disable OK button
    this.querySelector('.preview-spinner').style.display = 'flex';
    this.querySelector('.preview-canvas').style.display = 'none';
    this.querySelector('.config-btn-ok').disabled = true;

    try {
      // Get the image processor worker
      const worker = window.App?.imageProcessor;
      console.log('Worker:', worker);
      if (!worker) {
        throw new Error('Image processor not available');
      }

      const svg = await new Promise((resolve, reject) => {
        worker.processImage(this.imageBitmap, this.currentDifficulty, {
          processor: this.currentProcessor,
          onProgress: (progress) => {
            const statusEl = this.querySelector('.preview-status');
            if (statusEl) statusEl.textContent = progress.status;
          },
          onComplete: (result) => {
            console.log('Processing complete!');
            resolve(result.svg);
          },
          onError: (error) => {
            console.error('Worker error:', error);
            reject(error);
          }
        });
      });

      this.latestSVG = svg;
      console.log('SVG generated, size:', svg.length);

      // Parse SVG and apply data-color as fill for preview rendering
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;

      // Find all elements with data-color and set fill attribute
      const elementsWithColor = svgRoot.querySelectorAll('[data-color]');
      console.log('Found', elementsWithColor.length, 'elements with data-color');
      elementsWithColor.forEach(el => {
        const color = el.getAttribute('data-color');
        if (color) {
          el.setAttribute('fill', color);
        }
      });

      // Serialize back to string
      const serializer = new XMLSerializer();
      const renderedSVG = serializer.serializeToString(svgDoc);

      // Render SVG to canvas
      const svgBlob = new Blob([renderedSVG], { type: 'image/svg+xml' });
      const svgURL = URL.createObjectURL(svgBlob);

      // Count regions and colors
      const regions = elementsWithColor.length;
      const colorSet = new Set();
      elementsWithColor.forEach(el => {
        const color = el.getAttribute('data-color');
        if (color) colorSet.add(color);
      });
      const colors = colorSet.size;

      const img = new Image();
      img.onload = () => {
        // Only update UI if this is still the current processing run
        if (currentId !== this.processingId) {
          console.log('Ignoring stale preview for ID:', currentId, 'current:', this.processingId);
          URL.revokeObjectURL(svgURL);
          return;
        }

        console.log('Image loaded, dimensions:', img.width, 'x', img.height);
        URL.revokeObjectURL(svgURL);

        // Draw to canvas maintaining aspect ratio, scaled up for preview
        const canvas = this.querySelector('.preview-canvas');
        const ctx = canvas.getContext('2d');

        // Scale to a reasonable preview size (target ~600px on larger dimension)
        const targetSize = 600;
        const scale = Math.min(targetSize / img.width, targetSize / img.height);
        canvas.width = Math.floor(img.width * scale);
        canvas.height = Math.floor(img.height * scale);
        console.log('Canvas dimensions set to:', canvas.width, 'x', canvas.height, 'scale:', scale);

        // Draw the image scaled up
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        console.log('Drew image to canvas');

        // Update status with image info
        const statusEl = this.querySelector('.preview-status');
        if (statusEl) {
          statusEl.textContent = `${regions} regions, ${colors} colors`;
        }

        // Show canvas, hide spinner, enable OK button
        this.querySelector('.preview-spinner').style.display = 'none';
        canvas.style.display = 'block';
        this.querySelector('.config-btn-ok').disabled = false;
        console.log('Preview displayed on canvas for ID:', currentId);
      };
      img.onerror = (err) => {
        // Only handle error if this is still the current processing run
        if (currentId !== this.processingId) {
          console.log('Ignoring stale error for ID:', currentId);
          URL.revokeObjectURL(svgURL);
          return;
        }

        URL.revokeObjectURL(svgURL);
        console.error('Failed to load SVG:', err);
        throw new Error('Failed to render SVG preview');
      };
      console.log('Setting img.src to:', svgURL);
      img.src = svgURL;

    } catch (error) {
      console.error('Processing error:', error);
      const statusEl = this.querySelector('.preview-status');
      if (statusEl) statusEl.textContent = 'Error: ' + error.message;
      // Keep OK button disabled on error
    } finally {
      this.processing = false;
    }
  }
}

// Custom element: <processing-modal>
class ProcessingModal extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="processing-content">
        <h2>Processing Image...</h2>
        <p class="processing-status">Preparing...</p>
        <div class="processing-spinner"></div>
      </div>
    `;
  }

  setStatus(status) {
    const statusEl = this.querySelector('.processing-status');
    if (statusEl) statusEl.textContent = status;
  }
}

// Register custom elements
customElements.define('library-screen', LibraryScreen);
customElements.define('difficulty-modal', DifficultyModal);
customElements.define('image-config-modal', ImageConfigModal);
customElements.define('processing-modal', ProcessingModal);

/****************
 * App bootstrap *
 ****************/
const App = {
  canvas: null,
  game: new GameState(),
  renderer: null,
  controller: null,
  libraryScreen: null,
  imageProcessor: null,
  _saveTimer: null,

  async init(canvas) {
    this.canvas = canvas || document.getElementById('app');
    this.libraryScreen = document.getElementById('library');
    this.renderer = new CanvasRenderer(this.canvas, this.game);
    this.controller = new Controller(this.canvas, this.game, this.renderer, this);

    // Initialize image processor worker
    this.imageProcessor = new ImageProcessorWorker();

    // Migrate any existing localStorage data to IndexedDB
    await ImageDB.migrateFromLocalStorage();

    this.game.events.on('active-changed', () => {
      this.renderer._whiteClipDirty = true;
      this.renderer._activeCheckerClipDirty = true;
      // Force immediate rebuild of layers
      this.renderer._rebuildWhiteOverlay();
      this.renderer._rebuildActiveCheckerboardLayer();
      this.renderer.start();
    });
    this.game.events.on('region-filled', () => {
      this.renderer._whiteClipDirty = true;
      this.renderer._activeCheckerClipDirty = true;
      this.renderer.start();
    });
    this.game.events.on('color-complete', (data) => {
      // Find the palette swatch location for this color
      const paletteRect = this.renderer._paletteRects?.find(r => r.index === data.index);

      if (paletteRect) {
        // Calculate checkmark position (screen coordinates) - bottom right of palette item
        const screenX = paletteRect.x + paletteRect.w - 6 - 12; // right edge - padding - half checkmark width
        const screenY = paletteRect.y + paletteRect.h - 4 - 12; // bottom edge - padding - half checkmark height

        // Convert screen coordinates to world coordinates
        const world = this.renderer.camera.screenToWorld(screenX, screenY, this.canvas);

        // Spawn green particle explosion centered on checkmark
        this.renderer.effects.spawnParticles(world.x, world.y, '#22c55e', {
          count: 20 + Math.floor(Math.random() * 10),
          speedMult: 1.0,
          sizeMult: 1.3
        });
        this.renderer.start();
      }
    });
    this.game.events.on('puzzle-complete', () => {
      this.renderer.start();
      console.log('Puzzle complete! Press P to export PNG.');
    });

    // Wire up library events
    this.libraryScreen.addEventListener('select-image', (e) => {
      this.loadFromLibrary(e.detail.entryId, e.detail.difficulty);
    });
    this.libraryScreen.addEventListener('add-image', (e) => {
      this.processNewImage(e.detail.file);
    });

    // Handle browser back/forward buttons
    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.view === 'image') {
        // Forward to an image - load it without adding to history
        this.loadFromLibrary(e.state.entryId, e.state.difficulty, false);
      } else {
        // Back to library
        this.showLibrary(false);
      }
    });

    // Check if there's already a hash to restore (e.g., from a shared link or page reload)
    const hash = window.location.hash;
    const parts = hash.slice(1).split('/'); // Remove '#' and split by '/'

    if (parts[0] === 'image' && parts.length >= 3) {
      // Hash format: #image/<entryId>/<difficulty>[/<x>/<y>/<scale>]
      const entryId = parts[1];
      const difficulty = parts[2];

      // Optional camera position (for restoring viewport on reload)
      const camera = parts.length >= 6 ? {
        x: parseFloat(parts[3]),
        y: parseFloat(parts[4]),
        scale: parseFloat(parts[5])
      } : null;

      history.replaceState({ view: 'image', entryId, difficulty }, '', hash);
      // Load the image without adding history (we're restoring state)
      this.loadFromLibrary(entryId, difficulty, false, camera);
    } else {
      // No valid hash - show library as default
      history.replaceState({ view: 'library' }, '', '#library');
      // Show library screen on startup - don't add history entry (already set via replaceState)
      this.showLibrary(false);
    }
  },

  async showLibrary(updateHistory = true) {
    this.libraryScreen.style.display = 'block';
    this.canvas.style.display = 'none';
    document.body.classList.add('library-open');
    await this.libraryScreen.render();

    // Clear current image so camera hash updates don't happen in library view
    this.currentImage = null;

    // Only push history when user clicks back button in UI (not on popstate or initial load)
    if (updateHistory) {
      history.pushState({ view: 'library' }, '', '#library');
    }
  },

  hideLibrary() {
    this.libraryScreen.style.display = 'none';
    this.canvas.style.display = 'block';
    document.body.classList.remove('library-open');
    this.renderer.start();
  },

  async loadFromLibrary(entryId, difficulty, updateHistory = true, camera = null) {
    const entry = await ImageLibrary.get(entryId);
    if (!entry || !entry.processedSVGs[difficulty]) {
      console.error('Entry or difficulty not found');
      // Fall back to showing library if image doesn't exist
      this.showLibrary(false);
      history.replaceState({ view: 'library' }, '', '#library');
      return;
    }

    this.hideLibrary();

    const svgText = entry.processedSVGs[difficulty];
    const originalImage = await this.loadImageFromDataURL(entry.originalImageData);

    await this.loadSVGText(svgText, originalImage);

    // Store current image info for camera hash updates
    this.currentImage = { entryId, difficulty };

    // Apply camera position if provided (e.g., from URL restore)
    if (camera) {
      this.renderer.camera.x = camera.x;
      this.renderer.camera.y = camera.y;
      this.renderer.camera.scale = camera.scale;
      this.renderer.camera.constrainToBounds(this.renderer.canvas);
    }

    // Update hash with camera position (either restored or default)
    this.updateCameraHash();

    // Push history state when loading an image (without camera info - that's just for restore)
    if (updateHistory) {
      history.pushState(
        { view: 'image', entryId, difficulty },
        '',
        `#image/${entryId}/${difficulty}`
      );
    }
  },

  updateCameraHash() {
    // Update URL hash with camera position without creating history entry
    // Only do this if we have a current image loaded
    if (!this.currentImage) return;

    // Throttle updates to avoid excessive hash changes (max once per 200ms)
    const now = Date.now();
    if (this._lastCameraHashUpdate && now - this._lastCameraHashUpdate < 200) {
      // Schedule a delayed update if we're being throttled
      clearTimeout(this._cameraHashTimeout);
      this._cameraHashTimeout = setTimeout(() => this.updateCameraHash(), 200);
      return;
    }
    this._lastCameraHashUpdate = now;

    const { entryId, difficulty } = this.currentImage;
    const cam = this.renderer.camera;
    // Round to 2 decimal places to keep URL clean
    const x = cam.x.toFixed(2);
    const y = cam.y.toFixed(2);
    const scale = cam.scale.toFixed(2);

    const newHash = `#image/${entryId}/${difficulty}/${x}/${y}/${scale}`;

    // Use replaceState to update hash without adding to history
    history.replaceState(
      history.state, // Keep existing state
      '',
      newHash
    );
  },

  async processNewImage(file) {
    try {
      const modal = document.createElement('image-config-modal');
      document.body.appendChild(modal);

      const defaultName = file.name.replace(/\.[^/.]+$/, '');
      await modal.init(file, defaultName);

      modal.addEventListener('submit', async (e) => {
        const { name, svg, difficulty } = e.detail;

        // Show saving modal
        const savingModal = document.createElement('processing-modal');
        document.body.appendChild(savingModal);
        savingModal.setStatus('Saving to library...');

        try {
          await this.saveProcessedImage(file, name, svg, difficulty);
          savingModal.setStatus('Done!');
          await new Promise(resolve => setTimeout(resolve, 500));
        } finally {
          savingModal.remove();
        }
      });

      modal.addEventListener('cancel', () => {
        // User cancelled, do nothing
      });
    } catch (error) {
      console.error('Error processing new image:', error);
      alert('Error processing image: ' + error.message);
    }
  },

  async saveProcessedImage(file, name, svg, difficulty) {
    // Load original image for thumbnail
    const imgURL = URL.createObjectURL(file);
    const img = new Image();
    img.src = imgURL;
    await new Promise((resolve) => (img.onload = resolve));
    const bmp = await createImageBitmap(img);

    // Generate thumbnail
    const thumbnailCanvas = document.createElement('canvas');
    const thumbSize = 200;
    thumbnailCanvas.width = thumbSize;
    thumbnailCanvas.height = thumbSize;
    const thumbCtx = thumbnailCanvas.getContext('2d');
    const scale = Math.min(thumbSize / bmp.width, thumbSize / bmp.height);
    const w = bmp.width * scale;
    const h = bmp.height * scale;
    thumbCtx.drawImage(bmp, (thumbSize - w) / 2, (thumbSize - h) / 2, w, h);
    const thumbnail = thumbnailCanvas.toDataURL('image/jpeg', 0.8);

    // Store original image as JPEG data URL
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = bmp.width;
    originalCanvas.height = bmp.height;
    const originalCtx = originalCanvas.getContext('2d');
    originalCtx.drawImage(bmp, 0, 0);
    const originalImageData = originalCanvas.toDataURL('image/jpeg', 0.85);

    console.log(`Thumbnail size: ${(thumbnail.length / 1024).toFixed(1)}KB`);
    console.log(`Original image size: ${(originalImageData.length / 1024).toFixed(1)}KB`);
    console.log(`SVG size: ${(svg.length / 1024).toFixed(1)}KB`);

    // Save to library
    const processedSVGs = {};
    processedSVGs[difficulty] = svg;

    const entry = {
      id: 'img-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      name,
      thumbnail,
      originalImageData,
      processedSVGs,
      createdAt: Date.now()
    };

    await ImageLibrary.save(entry);
    console.log(`Saved "${name}" to library!`);

    // Refresh library screen
    await this.libraryScreen.render();

    URL.revokeObjectURL(imgURL);
  },


  async loadImageFromDataURL(dataURL) {
    const img = new Image();
    img.src = dataURL;
    await new Promise((resolve) => (img.onload = resolve));
    return createImageBitmap(img);
  },

  async loadSVGText(svgText, originalImage = null) {
    // Reset state
    this.game = new GameState();
    this.renderer.game = this.game;
    this.controller.game = this.game; // make sure controller points to new game

    // Re-register event listeners for new game instance
    this.game.events.on('active-changed', () => {
      this.renderer._whiteClipDirty = true;
      this.renderer._activeCheckerClipDirty = true;
      // Force immediate rebuild of layers
      this.renderer._rebuildWhiteOverlay();
      this.renderer._rebuildActiveCheckerboardLayer();
      this.renderer.start();
    });
    this.game.events.on('region-filled', () => {
      this.renderer._whiteClipDirty = true;
      this.renderer._activeCheckerClipDirty = true;
      this.renderer.start();
    });
    this.game.events.on('color-complete', (data) => {
      // Find the palette swatch location for this color
      const paletteRect = this.renderer._paletteRects?.find(r => r.index === data.index);

      if (paletteRect) {
        // Calculate checkmark position (screen coordinates) - bottom right of palette item
        const screenX = paletteRect.x + paletteRect.w - 6 - 12; // right edge - padding - half checkmark width
        const screenY = paletteRect.y + paletteRect.h - 4 - 12; // bottom edge - padding - half checkmark height

        // Convert screen coordinates to world coordinates
        const world = this.renderer.camera.screenToWorld(screenX, screenY, this.canvas);

        // Spawn green particle explosion centered on checkmark
        this.renderer.effects.spawnParticles(world.x, world.y, '#22c55e', {
          count: 20 + Math.floor(Math.random() * 10),
          speedMult: 1.0,
          sizeMult: 1.3
        });
        this.renderer.start();
      }
    });
    this.game.events.on('puzzle-complete', () => {
      this.renderer.start();
      console.log('Puzzle complete! Press P to export PNG.');
    });

    const key = 'cxbn:' + hashString(svgText);
    this.game.setImageKey(key);

    const { regions, outlineColor, outlineWidth } = await SVGLoader.parse(svgText);
    for (const r of regions) this.game.addRegion(r);
    this.renderer.setStyle({ outlineColor, outlineWidth });
    this.renderer._outlinesDirty = true;  // Mark outlines for rebuild

    // Set up original image and mask if provided
    if (originalImage) {
      this.game.originalImage = originalImage;
      this.game.imageWidth = originalImage.width;
      this.game.imageHeight = originalImage.height;
      this.renderer.initMask(originalImage.width, originalImage.height);
    }

    // Seed palette swatch colors from any region of that index
    for (const r of this.game.regions) {
      const p = this.game.palette.get(r.index);
      if (p && (!p.color || p.color === '#888')) p.color = r.color;
    }

    const saved = Storage.load(key);
    if (saved) {
      const filledIds = new Set(saved.filledIds || []);
      for (const r of this.game.regions) {
        if (filledIds.has(r.id)) {
          // Use setFilled to properly update state and trigger events
          // Note: setFilled increments palette.found, so don't do it manually
          r.filled = true;
          this.game.palette.get(r.index).found++;
        }
      }
      // Mark layers as dirty after loading saved state
      this.renderer._whiteClipDirty = true;
      this.renderer._activeCheckerClipDirty = true;

      if (saved.activeIndex) this.game.setActiveIndex(saved.activeIndex);
      this.game.hintTokens = saved.hintTokens ?? 3;
    } else {
      const minIndex = Math.min(...[...this.game.palette.keys()]);
      this.game.setActiveIndex(isFinite(minIndex) ? minIndex : 1);
    }

    this.renderer.fitToScreen();
    this.renderer.start();
  },

  saveProgress() {
    const filledIds = this.game.regions.filter((r) => r.filled).map((r) => r.id);
    Storage.save(this.game.imageKey, {
      filledIds,
      activeIndex: this.game.activeIndex,
      hintTokens: this.game.hintTokens,
    });
  },
  saveProgressDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveProgress(), 200);
  },

  useHint() {
    if (this.game.hintTokens <= 0) return;
    const target = this.game.regions.find((r) => !r.filled && r.index === this.game.activeIndex);
    if (!target) return;
    this.game.hintTokens -= 1;
    const cam = this.renderer.camera;
    const sx = cam.x,
      sy = cam.y,
      ss = cam.scale;
    const b = target.bbox;
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    const desiredScale = Math.min(6, Math.max(1, cam.scale));
    const t0 = performance.now(),
      dur = 450;
    const tick = (t) => {
      const u = clamp((t - t0) / dur, 0, 1);
      const e = u < 0.5 ? 2 * u * u : -1 + (4 - 2 * u) * u;
      cam.x = lerp(sx, cx, e);
      cam.y = lerp(sy, cy, e);
      cam.scale = lerp(ss, desiredScale, e);
      this.renderer.start();
      if (u < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    this.saveProgress();
  },

  exportPNG() {
    const { canvas, renderer, game } = this;
    const w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, w, h);
    const cam = new Camera2D();
    cam.x = renderer.camera.x;
    cam.y = renderer.camera.y;
    cam.scale = renderer.camera.scale;
    const bottomUI = renderer.paletteBarHeight + renderer.progressBarHeight + renderer.margin * 2;
    const viewHeight = h - bottomUI;
    tctx.save();
    tctx.beginPath();
    tctx.rect(0, 0, w, viewHeight);
    tctx.clip();
    tctx.save();
    cam.apply(tctx, tmp);

    // Layered mode: export original image with overlay layers
    if (game.originalImage && renderer.whiteOverlayCanvas) {
      // 1. Draw original image
      tctx.drawImage(game.originalImage, 0, 0);

      // 2. Draw static checkerboard layer
      tctx.drawImage(renderer.staticCheckerboardCanvas, 0, 0);

      // 3. Draw white overlay
      tctx.drawImage(renderer.whiteOverlayCanvas, 0, 0);

      // 4. Draw outlines
      for (const r of game.regions) {
        tctx.lineWidth = renderer.outlineWidth / cam.scale;
        tctx.strokeStyle = renderer.outlineColor;
        tctx.stroke(r.path2d);
      }
    } else {
      // Fallback: old SVG mode
      for (const r of game.regions) {
        tctx.fillStyle = r.filled ? r.color : '#fff';
        tctx.fill(r.path2d);
        tctx.lineWidth = renderer.outlineWidth / cam.scale;
        tctx.strokeStyle = renderer.outlineColor;
        tctx.stroke(r.path2d);
      }
    }

    tctx.restore();
    tctx.restore();
    const url = tmp.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'color-by-number.png';
    a.click();
  },
};

// Auto-init once DOM is ready, expecting a <canvas id="app"> present
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('app');
  if (!canvas) {
    console.warn('No #app canvas found');
    return;
  }
  // Ensure full-viewport sizing if host page hasn't styled it
  if (!canvas.style.width) canvas.style.width = '100vw';
  if (!canvas.style.height) canvas.style.height = '100vh';
  const style = getComputedStyle(document.documentElement);
  if (getComputedStyle(document.body).margin !== '0px') document.body.style.margin = '0';
  App.init(canvas);

  // Expose App to window for modal access
  window.App = App;
});
