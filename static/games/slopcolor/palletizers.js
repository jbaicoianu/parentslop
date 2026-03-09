/**************************************************
 * Image Palletizer Modules
 * ES6 module exports for use in Web Workers
 **************************************************/

// Helper functions
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Chaikin's corner cutting algorithm - smooths polygonal paths
 * Each iteration replaces each line segment with two segments that "cut the corner"
 */
function chaikinSmooth(points, iterations = 2) {
  if (points.length < 3) return points;

  let smoothed = points.slice();

  for (let iter = 0; iter < iterations; iter++) {
    const newPoints = [];

    // For closed paths, wrap around
    for (let i = 0; i < smoothed.length; i++) {
      const p0 = smoothed[i];
      const p1 = smoothed[(i + 1) % smoothed.length];

      // Create two new points that "cut the corner"
      // Q is 3/4 of the way from p0 to p1
      // R is 1/4 of the way from p0 to p1
      const q = [p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25];
      const r = [p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75];

      newPoints.push(q);
      newPoints.push(r);
    }

    smoothed = newPoints;
  }

  return smoothed;
}

/**
 * Gaussian/moving average smoothing - smooths by averaging each point with neighbors
 * Keeps the same number of points, just moves them to create smoother curves
 * Good for removing pixel-boundary zigzags without creating overlaps
 * Preserves points on image boundaries to prevent gaps at edges
 */
function gaussianSmooth(points, iterations = 2, width = null, height = null) {
  if (points.length < 3) return points;

  let smoothed = points.map(p => [...p]); // Deep copy

  for (let iter = 0; iter < iterations; iter++) {
    const newPoints = [];

    // For closed paths, wrap around
    for (let i = 0; i < smoothed.length; i++) {
      const curr = smoothed[i];

      // Check if this point is on an image boundary - if so, don't smooth it
      // Use threshold of 1.5 to match RDP corner detection threshold of 1.0
      const EDGE_THRESHOLD = 1.5;
      const onBoundary = width !== null && height !== null && (
        curr[0] <= EDGE_THRESHOLD || curr[0] >= width - EDGE_THRESHOLD ||
        curr[1] <= EDGE_THRESHOLD || curr[1] >= height - EDGE_THRESHOLD
      );

      if (onBoundary) {
        // Keep boundary points exactly as they are
        newPoints.push([...curr]);
      } else {
        const prev = smoothed[(i - 1 + smoothed.length) % smoothed.length];
        const next = smoothed[(i + 1) % smoothed.length];

        // Weighted average: 0.25 * prev + 0.5 * curr + 0.25 * next
        const x = prev[0] * 0.25 + curr[0] * 0.5 + next[0] * 0.25;
        const y = prev[1] * 0.25 + curr[1] * 0.5 + next[1] * 0.25;

        newPoints.push([x, y]);
      }
    }

    smoothed = newPoints;
  }

  return smoothed;
}

/**************************************************
 * ImageToSVGPalletizer (as provided previously)  *
 **************************************************/
export class ImageToSVGPalletizer {
  constructor(opts = {}) {
    this.opts = Object.assign(
      {
        K: 30,
        algorithm: 'median-cut',
        simplifyTolerance: 1.2,
        minRegionArea: 64,
        smallRegionMergeColorDist: 25,
        outlineColor: '#0b0d0e',
        outlineWidth: 2,
        closeHoles: true,
        seed: 1337,
      },
      opts,
    );
  }
  async process(input) {
    const bmp = await this._toBitmap(input);
    const { width, height } = bmp;
    const ctx = this._makeCtx(width, height);
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    const { palette, indexBuf } =
      this.opts.algorithm === 'kmeans'
        ? this._quantizeKMeans(img, this.opts.K)
        : this._quantizeMedianCut(img, this.opts.K);
    const { labels, regions } = this._connectedComponents(indexBuf, width, height);
    this._mergeTinyRegions(indexBuf, labels, regions, width, height, palette);
    const contours = this._extractContours(indexBuf, width, height);
    const simplified = contours.map((c) =>
      Object.assign({}, c, { path: this._rdp(c.path, this.opts.simplifyTolerance) }),
    );
    const svg = this._emitSVG(simplified, palette, width, height);
    return { svg, palette, width, height, regionsCount: simplified.length };
  }
  _makeCtx(w, h) {
    const c = new OffscreenCanvas(w, h);
    return c.getContext('2d');
  }
  async _toBitmap(input) {
    // Check for ImageBitmap first (works in both main thread and worker)
    if (input instanceof ImageBitmap) {
      return input;
    }
    // DOM elements only exist in main thread, not in workers
    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
      return createImageBitmap(input);
    }
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
      return createImageBitmap(input);
    }
    if (input instanceof OffscreenCanvas) {
      return input.transferToImageBitmap();
    }
    throw new Error('Unsupported input type');
  }
  _rgbToLab(r, g, b) {
    const srgb = [r / 255, g / 255, b / 255].map((u) =>
      u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4),
    );
    let [x, y, z] = [
      0.4124564 * srgb[0] + 0.3575761 * srgb[1] + 0.1804375 * srgb[2],
      0.2126729 * srgb[0] + 0.7151522 * srgb[1] + 0.072175 * srgb[2],
      0.0193339 * srgb[0] + 0.119192 * srgb[1] + 0.9503041 * srgb[2],
    ];
    const xn = 0.95047,
      yn = 1.0,
      zn = 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x / xn),
      fy = f(y / yn),
      fz = f(z / zn);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  _labDist(a, b) {
    const dl = a[0] - b[0],
      da = a[1] - b[1],
      db = a[2] - b[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }
  _quantizeMedianCut(img, K) {
    const { data, width, height } = img;
    const sample = [];
    const step = Math.max(1, Math.floor((width * height) / 50000));
    for (let i = 0; i < data.length; i += 4 * step) {
      sample.push([data[i], data[i + 1], data[i + 2]]);
    }
    let boxes = [this._makeVBox(sample)];
    while (boxes.length < K) {
      boxes.sort((a, b) => b.volume - a.volume);
      const box = boxes.shift();
      if (!box || box.pixels.length <= 1) break;
      const [b1, b2] = this._splitVBox(box);
      boxes.push(b1, b2);
    }
    const palette = boxes.map((b) => this._avgColor(b.pixels));
    const labs = palette.map((c) => this._rgbToLab(c[0], c[1], c[2]));
    const indexBuf = new Uint16Array(width * height);
    for (let y = 0, idx = 0; y < height; y++) {
      for (let x = 0; x < width; x++, idx++) {
        const i = idx * 4;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const lab = this._rgbToLab(r, g, b);
        let best = 0,
          bestD = 1e9;
        for (let k = 0; k < labs.length; k++) {
          const d = this._labDist(lab, labs[k]);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        indexBuf[idx] = best;
      }
    }
    return {
      palette: palette.map(([r, g, b]) => ({ r, g, b, hex: this._toHex(r, g, b) })),
      indexBuf,
    };
  }
  _makeVBox(pixels) {
    let rmin = 255,
      rmax = 0,
      gmin = 255,
      gmax = 0,
      bmin = 255,
      bmax = 0;
    for (const [r, g, b] of pixels) {
      rmin = Math.min(rmin, r);
      rmax = Math.max(rmax, r);
      gmin = Math.min(gmin, g);
      gmax = Math.max(gmax, g);
      bmin = Math.min(bmin, b);
      bmax = Math.max(bmax, b);
    }
    return {
      pixels,
      rmin,
      rmax,
      gmin,
      gmax,
      bmin,
      bmax,
      get volume() {
        return (
          (1 + this.rmax - this.rmin) * (1 + this.gmax - this.gmin) * (1 + this.bmax - this.bmin)
        );
      },
    };
  }
  _splitVBox(vb) {
    const rR = vb.rmax - vb.rmin,
      gR = vb.gmax - vb.gmin,
      bR = vb.bmax - vb.bmin;
    let channel = 'r';
    if (gR >= rR && gR >= bR) channel = 'g';
    else if (bR >= rR && bR >= gR) channel = 'b';
    const arr = vb.pixels
      .slice()
      .sort((a, b) =>
        channel === 'r' ? a[0] - b[0] : channel === 'g' ? a[1] - b[1] : a[2] - b[2],
      );
    const mid = Math.floor(arr.length / 2);
    return [this._makeVBox(arr.slice(0, mid)), this._makeVBox(arr.slice(mid))];
  }
  _avgColor(pxs) {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of pxs) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = pxs.length || 1;
    return [(r / n) | 0, (g / n) | 0, (b / n) | 0];
  }
  _toHex(r, g, b) {
    const h = (v) => v.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  _quantizeKMeans(img, K) {
    const { data, width, height } = img;
    const pts = [];
    const step = Math.max(1, Math.floor((width * height) / 40000));
    for (let i = 0; i < data.length; i += 4 * step) pts.push([data[i], data[i + 1], data[i + 2]]);
    const centers = [];
    const rand = (n) => Math.floor(Math.random() * n);
    centers.push(pts[rand(pts.length)]);
    while (centers.length < K) {
      const dists = pts.map((p) =>
        Math.min(...centers.map((c) => this._labDist(this._rgbToLab(...p), this._rgbToLab(...c)))),
      );
      const sum = dists.reduce((a, b) => a + b, 0);
      let r = Math.random() * sum;
      let pick = 0;
      for (let i = 0; i < pts.length; i++) {
        r -= dists[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      centers.push(pts[pick]);
    }
    for (let iter = 0; iter < 12; iter++) {
      const buckets = Array.from({ length: K }, () => []);
      for (const p of pts) {
        let bi = 0,
          best = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._labDist(this._rgbToLab(...p), this._rgbToLab(...centers[k]));
          if (d < best) {
            best = d;
            bi = k;
          }
        }
        buckets[bi].push(p);
      }
      for (let k = 0; k < K; k++) {
        if (buckets[k].length) {
          const avg = this._avgColor(buckets[k]);
          centers[k] = avg;
        }
      }
    }
    const palette = centers.map((c) => ({
      r: c[0] | 0,
      g: c[1] | 0,
      b: c[2] | 0,
      hex: this._toHex(c[0] | 0, c[1] | 0, c[2] | 0),
    }));
    const labs = palette.map((c) => this._rgbToLab(c.r, c.g, c.b));
    const indexBuf = new Uint16Array(width * height);
    for (let y = 0, idx = 0; y < height; y++) {
      for (let x = 0; x < width; x++, idx++) {
        const i = idx * 4;
        const lab = this._rgbToLab(data[i], data[i + 1], data[i + 2]);
        let best = 0,
          bestD = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._labDist(lab, labs[k]);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        indexBuf[idx] = best;
      }
    }
    return { palette, indexBuf };
  }
  _connectedComponents(indexBuf, width, height) {
    const labels = new Int32Array(width * height).fill(-1);
    const regions = [];
    let label = 0;

    const qx = new Int32Array(width * height);
    const qy = new Int32Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const startIdx = y * width + x;
        if (labels[startIdx] !== -1) continue;
        const cls = indexBuf[startIdx];

        // BFS queue per component
        let head = 0,
          tail = 0;
        const push = (px, py) => {
          qx[tail] = px;
          qy[tail] = py;
          tail++;
        };
        push(x, y);
        labels[startIdx] = label;

        let area = 0;
        let minx = x,
          maxx = x,
          miny = y,
          maxy = y;

        while (head < tail) {
          const cx = qx[head],
            cy = qy[head];
          head++;
          area++;
          minx = Math.min(minx, cx);
          maxx = Math.max(maxx, cx);
          miny = Math.min(miny, cy);
          maxy = Math.max(maxy, cy);

          const neigh = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dx, dy] of neigh) {
            const nx = cx + dx,
              ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (labels[nidx] !== -1) continue;
            if (indexBuf[nidx] !== cls) continue;
            labels[nidx] = label;
            push(nx, ny);
          }
        }

        regions.push({
          label: label,
          cls: cls,
          area: area,
          bbox: { x: minx, y: miny, width: maxx - minx + 1, height: maxy - miny + 1 },
        });
        label++;
      }
    }
    return { labels, regions };
  }
  _mergeTinyRegions(indexBuf, labels, regions, width, height, palette) {
    const labPal = palette.map((p) => this._rgbToLab(p.r, p.g, p.b));
    for (const r of regions) {
      if (r.area >= this.opts.minRegionArea) continue;
      const bbox = r.bbox;
      let bestCls = r.cls,
        bestD = 1e9;
      for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
        for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
          const idx = y * width + x;
          if (labels[idx] !== r.label) continue;
          const neigh = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dx, dy] of neigh) {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ncls = indexBuf[ny * width + nx];
            if (ncls !== r.cls) {
              const d = this._labDist(labPal[r.cls], labPal[ncls]);
              if (d < bestD) {
                bestD = d;
                bestCls = ncls;
              }
            }
          }
        }
      }
      if (bestCls !== r.cls && bestD <= this.opts.smallRegionMergeColorDist) {
        for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
          for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
            const idx = y * width + x;
            if (labels[idx] === r.label) indexBuf[idx] = bestCls;
          }
        }
      }
    }
  }
  _extractContours(indexBuf, width, height) {
    let max = -1;
    for (let i = 0; i < indexBuf.length; i++) {
      if (indexBuf[i] > max) max = indexBuf[i];
    }
    const maxCls = max >= 0 ? max + 1 : 0;
    const contours = [];
    for (let cls = 0; cls < maxCls; cls++) {
      const path = this._traceClass(indexBuf, width, height, cls);
      for (const ring of path) {
        contours.push({ index: cls + 1, colorIndex: cls, path: ring });
      }
    }
    return contours;
  }
  _traceClass(indexBuf, width, height, cls) {
    const mask = new Uint8Array((width + 2) * (height + 2));
    const W = width + 2,
      H = height + 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        mask[(y + 1) * W + (x + 1)] = indexBuf[y * width + x] === cls ? 1 : 0;
      }
    }
    const visited = new Uint8Array(W * H);
    const rings = [];
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask[i] === 0 || visited[i]) continue;
        if (!(mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W])) {
          let cx = x,
            cy = y,
            startX = x,
            startY = y,
            prevDir = 0;
          const ring = [];
          let safety = 0;
          let firstIteration = true;
          do {
            // Check if we're back at start BEFORE adding point (except first iteration)
            if (!firstIteration && cx === startX && cy === startY) break;
            firstIteration = false;

            ring.push([cx - 1, cy - 1]);
            visited[cy * W + cx] = 1;
            let found = false;
            for (let k = 0; k < 4; k++) {
              const dir = (prevDir + 3 + k) % 4;
              const [dx, dy] = dirs[dir];
              const nx = cx + dx,
                ny = cy + dy;
              const ni = ny * W + nx;
              if (mask[ni]) {
                cx = nx;
                cy = ny;
                prevDir = dir;
                found = true;
                break;
              }
            }
            if (!found) break;
            if (++safety > 1e6) break;
          } while (true);
          if (ring.length > 2) rings.push(ring);
        }
      }
    }
    return rings;
  }
  _rdp(points, epsilon) {
    if (points.length < 3) return points.slice();
    const dmaxInfo = this._rdpFindMax(points);
    if (dmaxInfo.dmax > epsilon) {
      const res1 = this._rdp(points.slice(0, dmaxInfo.index + 1), epsilon);
      const res2 = this._rdp(points.slice(dmaxInfo.index), epsilon);
      return res1.slice(0, -1).concat(res2);
    } else {
      return [points[0], points[points.length - 1]];
    }
  }
  _rdpFindMax(points) {
    const [x1, y1] = points[0],
      [x2, y2] = points[points.length - 1];
    let dmax = 0,
      idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._pointLineDist(points[i], [x1, y1], [x2, y2]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    return { dmax, index: idx };
  }
  _pointLineDist([x0, y0], [x1, y1], [x2, y2]) {
    const A = x0 - x1,
      B = y0 - y1,
      C = x2 - x1,
      D = y2 - y1;
    const dot = A * C + B * D;
    const len = C * C + D * D;
    const t = len ? Math.max(0, Math.min(1, dot / len)) : 0;
    const x = x1 + t * C,
      y = y1 + t * D;
    return Math.hypot(x - x0, y - y0);
  }
  sobelEdges(input) {
    const w = input.width || input.naturalWidth;
    const h = input.height || input.naturalHeight;
    const ctx = this._makeCtx(w, h);
    if (input instanceof HTMLImageElement) ctx.drawImage(input, 0, 0);
    else ctx.drawImage(input, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    const d = img.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    const out = new Float32Array(w * h);
    const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1],
      ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let gx = 0,
          gy = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ww = (y + dy) * w + (x + dx);
            const k = (dy + 1) * 3 + (dx + 1);
            gx += gray[ww] * kx[k];
            gy += gray[ww] * ky[k];
          }
        out[y * w + x] = Math.hypot(gx, gy);
      }
    }
    return { width: w, height: h, data: out };
  }
  _emitSVG(contours, palette, width, height) {
    const pathToD = (pts) => {
      if (!pts.length) return '';
      const m = `M ${pts[0][0]} ${pts[0][1]}`;
      const lines = pts
        .slice(1)
        .map((p) => `L ${p[0]} ${p[1]}`)
        .join(' ');
      return `${m} ${lines} Z`;
    };
    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' data-outline-color='${this.opts.outlineColor}' data-outline-width='${this.opts.outlineWidth}'>`;
    const body = contours
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => {
        const pal = palette[c.colorIndex];
        const d = pathToD(c.path);
        const fill = pal ? pal.hex : '#cccccc';
        return `<path d='${d}' data-index='${c.index}' data-color='${fill}' fill='none'/>`;
      })
      .join('\n');
    const footer = '\n</svg>';
    return header + '\n' + body + footer;
  }
}

/**************************************************
 * EnhancedImageToSVGPalletizer                   *
 * Improved approach with preprocessing & HSV     *
 **************************************************/
export class EnhancedImageToSVGPalletizer {
  constructor(opts = {}) {
    this.opts = Object.assign(
      {
        K: 20, // Fewer colors to reduce tiny regions
        algorithm: 'median-cut', // 'median-cut' or 'kmeans'
        colorSpace: 'hsv', // 'rgb', 'lab', or 'hsv'
        preprocessor: 'gaussian', // 'none', 'gaussian', 'median', 'bilateral'
        blurRadius: 2, // For gaussian blur
        medianRadius: 2, // For median filter
        bilateralSigmaSpace: 8, // For bilateral filter (spatial)
        bilateralSigmaColor: 30, // For bilateral filter (color)
        simplifyTolerance: 2.0, // More aggressive simplification
        minRegionArea: 120, // Larger min area to reduce tiny regions
        smallRegionMergeColorDist: 35, // More aggressive merging
        outlineColor: '#0b0d0e',
        outlineWidth: 2,
        seed: 1337,
      },
      opts,
    );
  }

  async process(input) {
    const bmp = await this._toBitmap(input);
    const { width, height } = bmp;
    const ctx = this._makeCtx(width, height);
    ctx.drawImage(bmp, 0, 0);
    let img = ctx.getImageData(0, 0, width, height);

    // Preprocessing to reduce noise
    if (this.opts.preprocessor === 'gaussian') {
      img = this._gaussianBlur(img, this.opts.blurRadius);
    } else if (this.opts.preprocessor === 'median') {
      img = this._medianFilter(img, this.opts.medianRadius);
    } else if (this.opts.preprocessor === 'bilateral') {
      img = this._bilateralFilter(
        img,
        this.opts.bilateralSigmaSpace,
        this.opts.bilateralSigmaColor,
      );
    }

    // Quantize in chosen color space
    const { palette, indexBuf } = this._quantize(img, this.opts.K);

    // Connected components
    const { labels, regions } = this._connectedComponents(indexBuf, width, height);

    // Merge tiny regions
    this._mergeTinyRegions(indexBuf, labels, regions, width, height, palette);

    // Extract and simplify contours
    const contours = this._extractContours(indexBuf, width, height);
    const simplified = contours.map((c) => {
      // First simplify with RDP to reduce points
      const rdpPath = this._rdp(c.path, this.opts.simplifyTolerance);
      // Then smooth with Chaikin's algorithm to remove jaggedness
      // Use only 1 iteration to prevent paths from expanding into neighbors
      const smoothed = chaikinSmooth(rdpPath, 1);
      return Object.assign({}, c, { path: smoothed });
    });

    // Filter out only truly degenerate contours (very minimal filtering)
    const minPathLength = 3; // Minimum number of points
    const filtered = simplified.filter((c) => c.path.length >= minPathLength);

    const svg = this._emitSVG(filtered, palette, width, height);
    return { svg, palette, width, height, regionsCount: filtered.length };
  }

  // Gaussian blur preprocessing
  _gaussianBlur(imageData, radius) {
    const { data, width, height } = imageData;
    const output = new ImageData(width, height);
    const kernel = this._makeGaussianKernel(radius);
    const kSize = kernel.length;
    const kHalf = Math.floor(kSize / 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0,
          g = 0,
          b = 0,
          wSum = 0;

        for (let ky = 0; ky < kSize; ky++) {
          for (let kx = 0; kx < kSize; kx++) {
            const px = Math.min(Math.max(x + kx - kHalf, 0), width - 1);
            const py = Math.min(Math.max(y + ky - kHalf, 0), height - 1);
            const idx = (py * width + px) * 4;
            const w = kernel[ky][kx];

            r += data[idx] * w;
            g += data[idx + 1] * w;
            b += data[idx + 2] * w;
            wSum += w;
          }
        }

        const outIdx = (y * width + x) * 4;
        output.data[outIdx] = r / wSum;
        output.data[outIdx + 1] = g / wSum;
        output.data[outIdx + 2] = b / wSum;
        output.data[outIdx + 3] = 255;
      }
    }

    return output;
  }

  _makeGaussianKernel(radius) {
    const size = radius * 2 + 1;
    const kernel = [];
    const sigma = radius / 2;
    const twoSigmaSq = 2 * sigma * sigma;

    for (let y = 0; y < size; y++) {
      kernel[y] = [];
      for (let x = 0; x < size; x++) {
        const dx = x - radius;
        const dy = y - radius;
        kernel[y][x] = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
      }
    }

    return kernel;
  }

  // Median filter preprocessing
  _medianFilter(imageData, radius) {
    const { data, width, height } = imageData;
    const output = new ImageData(width, height);
    const size = radius * 2 + 1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rVals = [],
          gVals = [],
          bVals = [];

        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const px = Math.min(Math.max(x + dx, 0), width - 1);
            const py = Math.min(Math.max(y + dy, 0), height - 1);
            const idx = (py * width + px) * 4;

            rVals.push(data[idx]);
            gVals.push(data[idx + 1]);
            bVals.push(data[idx + 2]);
          }
        }

        rVals.sort((a, b) => a - b);
        gVals.sort((a, b) => a - b);
        bVals.sort((a, b) => a - b);

        const mid = Math.floor(rVals.length / 2);
        const outIdx = (y * width + x) * 4;
        output.data[outIdx] = rVals[mid];
        output.data[outIdx + 1] = gVals[mid];
        output.data[outIdx + 2] = bVals[mid];
        output.data[outIdx + 3] = 255;
      }
    }

    return output;
  }

  // Bilateral filter (edge-preserving smoothing)
  _bilateralFilter(imageData, sigmaSpace, sigmaColor) {
    const { data, width, height } = imageData;
    const output = new ImageData(width, height);
    const radius = Math.ceil(sigmaSpace * 2);
    const twoSigmaSpaceSq = 2 * sigmaSpace * sigmaSpace;
    const twoSigmaColorSq = 2 * sigmaColor * sigmaColor;

    // Precompute spatial weights (same for every pixel)
    const spatialWeights = new Float32Array((2 * radius + 1) * (2 * radius + 1));
    let swIdx = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const spaceDist = dx * dx + dy * dy;
        spatialWeights[swIdx++] = Math.exp(-spaceDist / twoSigmaSpaceSq);
      }
    }

    // Precompute color weight lookup table
    const maxColorDist = 195075; // 255^2 * 3
    const colorLUT = new Float32Array(maxColorDist + 1);
    for (let i = 0; i <= maxColorDist; i++) {
      colorLUT[i] = Math.exp(-i / twoSigmaColorSq);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centerIdx = (y * width + x) * 4;
        const centerR = data[centerIdx];
        const centerG = data[centerIdx + 1];
        const centerB = data[centerIdx + 2];

        let r = 0,
          g = 0,
          b = 0,
          wSum = 0;
        let swIdx = 0;

        for (let dy = -radius; dy <= radius; dy++) {
          const py = Math.min(Math.max(y + dy, 0), height - 1);
          for (let dx = -radius; dx <= radius; dx++) {
            const px = Math.min(Math.max(x + dx, 0), width - 1);
            const idx = (py * width + px) * 4;

            const spaceWeight = spatialWeights[swIdx++];

            const dr = data[idx] - centerR;
            const dg = data[idx + 1] - centerG;
            const db = data[idx + 2] - centerB;
            const colorDist = dr * dr + dg * dg + db * db;
            const colorWeight = colorLUT[colorDist];

            const w = spaceWeight * colorWeight;
            r += data[idx] * w;
            g += data[idx + 1] * w;
            b += data[idx + 2] * w;
            wSum += w;
          }
        }

        output.data[centerIdx] = r / wSum;
        output.data[centerIdx + 1] = g / wSum;
        output.data[centerIdx + 2] = b / wSum;
        output.data[centerIdx + 3] = 255;
      }
    }

    return output;
  }

  // Color space conversion helpers
  _rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / delta + 2) / 6;
      else h = ((r - g) / delta + 4) / 6;
    }

    const s = max === 0 ? 0 : delta / max;
    const v = max;

    return [h * 360, s * 100, v * 100];
  }

  _hsvToRgb(h, s, v) {
    h /= 360;
    s /= 100;
    v /= 100;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r, g, b;
    switch (i % 6) {
      case 0:
        r = v;
        g = t;
        b = p;
        break;
      case 1:
        r = q;
        g = v;
        b = p;
        break;
      case 2:
        r = p;
        g = v;
        b = t;
        break;
      case 3:
        r = p;
        g = q;
        b = v;
        break;
      case 4:
        r = t;
        g = p;
        b = v;
        break;
      case 5:
        r = v;
        g = p;
        b = q;
        break;
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  _hsvDist(a, b) {
    // Circular hue distance
    const dh = Math.min(Math.abs(a[0] - b[0]), 360 - Math.abs(a[0] - b[0]));
    const ds = a[1] - b[1];
    const dv = a[2] - b[2];
    // Weight hue less than saturation/value
    return Math.sqrt(dh * dh * 0.5 + ds * ds + dv * dv);
  }

  _rgbToLab(r, g, b) {
    const srgb = [r / 255, g / 255, b / 255].map((u) =>
      u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4),
    );
    let [x, y, z] = [
      0.4124564 * srgb[0] + 0.3575761 * srgb[1] + 0.1804375 * srgb[2],
      0.2126729 * srgb[0] + 0.7151522 * srgb[1] + 0.072175 * srgb[2],
      0.0193339 * srgb[0] + 0.119192 * srgb[1] + 0.9503041 * srgb[2],
    ];
    const xn = 0.95047,
      yn = 1.0,
      zn = 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x / xn),
      fy = f(y / yn),
      fz = f(z / zn);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  _labDist(a, b) {
    const dl = a[0] - b[0],
      da = a[1] - b[1],
      db = a[2] - b[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }

  // Quantization using selected color space
  _quantize(img, K) {
    if (this.opts.colorSpace === 'hsv') {
      return this._quantizeHSV(img, K);
    } else if (this.opts.algorithm === 'kmeans') {
      return this._quantizeKMeans(img, K);
    } else {
      return this._quantizeMedianCut(img, K);
    }
  }

  _quantizeHSV(img, K) {
    const { data, width, height } = img;
    const sample = [];
    const step = Math.max(1, Math.floor((width * height) / 50000));

    for (let i = 0; i < data.length; i += 4 * step) {
      const hsv = this._rgbToHsv(data[i], data[i + 1], data[i + 2]);
      sample.push({ rgb: [data[i], data[i + 1], data[i + 2]], hsv });
    }

    // K-means in HSV space
    const centers = [];
    const rand = (n) => Math.floor(Math.random() * n);
    centers.push(sample[rand(sample.length)].hsv);

    while (centers.length < K) {
      const dists = sample.map((p) => Math.min(...centers.map((c) => this._hsvDist(p.hsv, c))));
      const sum = dists.reduce((a, b) => a + b, 0);
      let r = Math.random() * sum;
      let pick = 0;
      for (let i = 0; i < sample.length; i++) {
        r -= dists[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      centers.push(sample[pick].hsv);
    }

    // Iterate k-means
    for (let iter = 0; iter < 12; iter++) {
      const buckets = Array.from({ length: K }, () => []);
      for (const p of sample) {
        let bi = 0,
          best = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._hsvDist(p.hsv, centers[k]);
          if (d < best) {
            best = d;
            bi = k;
          }
        }
        buckets[bi].push(p);
      }
      for (let k = 0; k < K; k++) {
        if (buckets[k].length) {
          const avgH = buckets[k].reduce((sum, p) => sum + p.hsv[0], 0) / buckets[k].length;
          const avgS = buckets[k].reduce((sum, p) => sum + p.hsv[1], 0) / buckets[k].length;
          const avgV = buckets[k].reduce((sum, p) => sum + p.hsv[2], 0) / buckets[k].length;
          centers[k] = [avgH, avgS, avgV];
        }
      }
    }

    const palette = centers.map((hsv) => {
      const rgb = this._hsvToRgb(hsv[0], hsv[1], hsv[2]);
      return { r: rgb[0], g: rgb[1], b: rgb[2], hex: this._toHex(rgb[0], rgb[1], rgb[2]) };
    });

    // Assign pixels to nearest center
    const indexBuf = new Uint16Array(width * height);
    for (let y = 0, idx = 0; y < height; y++) {
      for (let x = 0; x < width; x++, idx++) {
        const i = idx * 4;
        const hsv = this._rgbToHsv(data[i], data[i + 1], data[i + 2]);
        let best = 0,
          bestD = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._hsvDist(hsv, centers[k]);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        indexBuf[idx] = best;
      }
    }

    return { palette, indexBuf };
  }

  // Reuse methods from original palettizer
  _makeCtx(w, h) {
    const c = new OffscreenCanvas(w, h);
    return c.getContext('2d');
  }

  async _toBitmap(input) {
    if (input instanceof ImageBitmap) return input;
    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) return createImageBitmap(input);
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) return createImageBitmap(input);
    if (input instanceof OffscreenCanvas) return input.transferToImageBitmap();
    throw new Error('Unsupported input type');
  }

  _toHex(r, g, b) {
    const h = (v) => v.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  _avgColor(pxs) {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of pxs) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = pxs.length || 1;
    return [(r / n) | 0, (g / n) | 0, (b / n) | 0];
  }

  _quantizeMedianCut(img, K) {
    const { data, width, height } = img;
    const sample = [];
    const step = Math.max(1, Math.floor((width * height) / 50000));
    for (let i = 0; i < data.length; i += 4 * step) {
      sample.push([data[i], data[i + 1], data[i + 2]]);
    }
    let boxes = [this._makeVBox(sample)];
    while (boxes.length < K) {
      boxes.sort((a, b) => b.volume - a.volume);
      const box = boxes.shift();
      if (!box || box.pixels.length <= 1) break;
      const [b1, b2] = this._splitVBox(box);
      boxes.push(b1, b2);
    }
    const palette = boxes.map((b) => this._avgColor(b.pixels));
    const labs = palette.map((c) => this._rgbToLab(c[0], c[1], c[2]));
    const indexBuf = new Uint16Array(width * height);
    for (let y = 0, idx = 0; y < height; y++) {
      for (let x = 0; x < width; x++, idx++) {
        const i = idx * 4;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const lab = this._rgbToLab(r, g, b);
        let best = 0,
          bestD = 1e9;
        for (let k = 0; k < labs.length; k++) {
          const d = this._labDist(lab, labs[k]);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        indexBuf[idx] = best;
      }
    }
    return {
      palette: palette.map(([r, g, b]) => ({ r, g, b, hex: this._toHex(r, g, b) })),
      indexBuf,
    };
  }

  _makeVBox(pixels) {
    let rmin = 255,
      rmax = 0,
      gmin = 255,
      gmax = 0,
      bmin = 255,
      bmax = 0;
    for (const [r, g, b] of pixels) {
      rmin = Math.min(rmin, r);
      rmax = Math.max(rmax, r);
      gmin = Math.min(gmin, g);
      gmax = Math.max(gmax, g);
      bmin = Math.min(bmin, b);
      bmax = Math.max(bmax, b);
    }
    return {
      pixels,
      rmin,
      rmax,
      gmin,
      gmax,
      bmin,
      bmax,
      get volume() {
        return (
          (1 + this.rmax - this.rmin) * (1 + this.gmax - this.gmin) * (1 + this.bmax - this.bmin)
        );
      },
    };
  }

  _splitVBox(vb) {
    const rR = vb.rmax - vb.rmin,
      gR = vb.gmax - vb.gmin,
      bR = vb.bmax - vb.bmin;
    let channel = 'r';
    if (gR >= rR && gR >= bR) channel = 'g';
    else if (bR >= rR && bR >= gR) channel = 'b';
    const arr = vb.pixels
      .slice()
      .sort((a, b) =>
        channel === 'r' ? a[0] - b[0] : channel === 'g' ? a[1] - b[1] : a[2] - b[2],
      );
    const mid = Math.floor(arr.length / 2);
    return [this._makeVBox(arr.slice(0, mid)), this._makeVBox(arr.slice(mid))];
  }

  _quantizeKMeans(img, K) {
    const { data, width, height } = img;
    const pts = [];
    const step = Math.max(1, Math.floor((width * height) / 40000));
    for (let i = 0; i < data.length; i += 4 * step) pts.push([data[i], data[i + 1], data[i + 2]]);
    const centers = [];
    const rand = (n) => Math.floor(Math.random() * n);
    centers.push(pts[rand(pts.length)]);
    while (centers.length < K) {
      const dists = pts.map((p) =>
        Math.min(...centers.map((c) => this._labDist(this._rgbToLab(...p), this._rgbToLab(...c)))),
      );
      const sum = dists.reduce((a, b) => a + b, 0);
      let r = Math.random() * sum;
      let pick = 0;
      for (let i = 0; i < pts.length; i++) {
        r -= dists[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      centers.push(pts[pick]);
    }
    for (let iter = 0; iter < 12; iter++) {
      const buckets = Array.from({ length: K }, () => []);
      for (const p of pts) {
        let bi = 0,
          best = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._labDist(this._rgbToLab(...p), this._rgbToLab(...centers[k]));
          if (d < best) {
            best = d;
            bi = k;
          }
        }
        buckets[bi].push(p);
      }
      for (let k = 0; k < K; k++) {
        if (buckets[k].length) {
          const avg = this._avgColor(buckets[k]);
          centers[k] = avg;
        }
      }
    }
    const palette = centers.map((c) => ({
      r: c[0] | 0,
      g: c[1] | 0,
      b: c[2] | 0,
      hex: this._toHex(c[0] | 0, c[1] | 0, c[2] | 0),
    }));
    const labs = palette.map((c) => this._rgbToLab(c.r, c.g, c.b));
    const indexBuf = new Uint16Array(width * height);
    for (let y = 0, idx = 0; y < height; y++) {
      for (let x = 0; x < width; x++, idx++) {
        const i = idx * 4;
        const lab = this._rgbToLab(data[i], data[i + 1], data[i + 2]);
        let best = 0,
          bestD = 1e9;
        for (let k = 0; k < K; k++) {
          const d = this._labDist(lab, labs[k]);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        indexBuf[idx] = best;
      }
    }
    return { palette, indexBuf };
  }

  _connectedComponents(indexBuf, width, height) {
    const labels = new Int32Array(width * height).fill(-1);
    const regions = [];
    let label = 0;
    const qx = new Int32Array(width * height);
    const qy = new Int32Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const startIdx = y * width + x;
        if (labels[startIdx] !== -1) continue;
        const cls = indexBuf[startIdx];

        let head = 0,
          tail = 0;
        const push = (px, py) => {
          qx[tail] = px;
          qy[tail] = py;
          tail++;
        };
        push(x, y);
        labels[startIdx] = label;

        let area = 0;
        let minx = x,
          maxx = x,
          miny = y,
          maxy = y;

        while (head < tail) {
          const cx = qx[head],
            cy = qy[head];
          head++;
          area++;
          minx = Math.min(minx, cx);
          maxx = Math.max(maxx, cx);
          miny = Math.min(miny, cy);
          maxy = Math.max(maxy, cy);

          const neigh = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dx, dy] of neigh) {
            const nx = cx + dx,
              ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (labels[nidx] !== -1) continue;
            if (indexBuf[nidx] !== cls) continue;
            labels[nidx] = label;
            push(nx, ny);
          }
        }

        regions.push({
          label: label,
          cls: cls,
          area: area,
          bbox: { x: minx, y: miny, width: maxx - minx + 1, height: maxy - miny + 1 },
        });
        label++;
      }
    }
    return { labels, regions };
  }

  _mergeTinyRegions(indexBuf, labels, regions, width, height, palette) {
    const labPal =
      this.opts.colorSpace === 'hsv'
        ? palette.map((p) => this._rgbToHsv(p.r, p.g, p.b))
        : palette.map((p) => this._rgbToLab(p.r, p.g, p.b));

    const distFunc =
      this.opts.colorSpace === 'hsv' ? this._hsvDist.bind(this) : this._labDist.bind(this);

    for (const r of regions) {
      if (r.area >= this.opts.minRegionArea) continue;
      const bbox = r.bbox;
      let bestCls = r.cls,
        bestD = 1e9;
      for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
        for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
          const idx = y * width + x;
          if (labels[idx] !== r.label) continue;
          const neigh = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dx, dy] of neigh) {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ncls = indexBuf[ny * width + nx];
            if (ncls !== r.cls) {
              const d = distFunc(labPal[r.cls], labPal[ncls]);
              if (d < bestD) {
                bestD = d;
                bestCls = ncls;
              }
            }
          }
        }
      }
      if (bestCls !== r.cls && bestD <= this.opts.smallRegionMergeColorDist) {
        for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
          for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
            const idx = y * width + x;
            if (labels[idx] === r.label) indexBuf[idx] = bestCls;
          }
        }
      }
    }
  }

  _extractContours(indexBuf, width, height) {
    let max = -1;
    for (let i = 0; i < indexBuf.length; i++) {
      if (indexBuf[i] > max) max = indexBuf[i];
    }
    const maxCls = max >= 0 ? max + 1 : 0;
    const contours = [];
    for (let cls = 0; cls < maxCls; cls++) {
      const path = this._traceClass(indexBuf, width, height, cls);
      for (const ring of path) {
        contours.push({ index: cls + 1, colorIndex: cls, path: ring });
      }
    }
    return contours;
  }

  _traceClass(indexBuf, width, height, cls) {
    // Use marching squares algorithm for clean contour extraction
    // This creates smooth, non-backtracking paths
    console.log(`[Marching Squares] Tracing class ${cls} in ${width}x${height} image`);

    // Create binary mask for this class
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      mask[i] = indexBuf[i] === cls ? 1 : 0;
    }

    // Build edge map using marching squares
    // Each cell can have edges on its 4 sides: top, right, bottom, left
    const edges = new Map(); // key: "x,y,dir" -> true if edge exists

    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        // Get 2x2 cell values (top-left, top-right, bottom-right, bottom-left)
        const tl = mask[y * width + x];
        const tr = mask[y * width + (x + 1)];
        const br = mask[(y + 1) * width + (x + 1)];
        const bl = mask[(y + 1) * width + x];

        // Create marching squares case (0-15)
        const caseValue = (tl << 3) | (tr << 2) | (br << 1) | bl;

        // Add edges based on case
        // Edges are placed between pixels where the value changes
        switch (caseValue) {
          case 0:  // ....
          case 15: // ####
            // No edges - all same
            break;
          case 1:  // ...#
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            edges.set(`${x},${y},3`, true);      // left edge going down
            break;
          case 2:  // ..#.
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
          case 3:  // ..##
            edges.set(`${x},${y},3`, true);      // left edge going down
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            break;
          case 4:  // .#..
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            break;
          case 5:  // .#.#
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            edges.set(`${x},${y},3`, true);      // left edge going down
            break;
          case 6:  // .##.
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
          case 7:  // .###
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x},${y},3`, true);      // left edge going down
            break;
          case 8:  // #...
            edges.set(`${x},${y},3`, true);      // left edge going down
            edges.set(`${x},${y},0`, true);      // top edge going right
            break;
          case 9:  // #..#
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
          case 10: // #.#.
            edges.set(`${x},${y},3`, true);      // left edge going down
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
          case 11: // #.##
            edges.set(`${x},${y},0`, true);      // top edge going right
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            break;
          case 12: // ##..
            edges.set(`${x},${y},3`, true);      // left edge going down
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            break;
          case 13: // ##.#
            edges.set(`${x + 1},${y},1`, true);  // right edge going down
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
          case 14: // ###.
            edges.set(`${x},${y},3`, true);      // left edge going down
            edges.set(`${x},${y + 1},0`, true);  // bottom edge going right
            break;
        }
      }
    }

    // Now follow edges to create contours
    const contours = [];
    const usedEdges = new Set();

    // Direction vectors: 0=right, 1=down, 2=left, 3=up
    const dx = [1, 0, -1, 0];
    const dy = [0, 1, 0, -1];

    for (const edgeKey of edges.keys()) {
      if (usedEdges.has(edgeKey)) continue;

      const [startX, startY, startDir] = edgeKey.split(',').map(Number);
      const contour = [];
      let x = startX, y = startY, dir = startDir;
      let safety = 0;

      do {
        const key = `${x},${y},${dir}`;
        if (usedEdges.has(key)) break;
        usedEdges.add(key);

        // Add current vertex
        contour.push([x, y]);

        // Move to next position
        x += dx[dir];
        y += dy[dir];

        // Find next edge by looking at possible turns
        let found = false;
        for (const turn of [0, -1, 1, 2]) { // straight, left, right, reverse
          const newDir = (dir + turn + 4) % 4;
          const nextKey = `${x},${y},${newDir}`;
          if (edges.has(nextKey) && !usedEdges.has(nextKey)) {
            dir = newDir;
            found = true;
            break;
          }
        }

        if (!found) break;
        if (++safety > 100000) break;
      } while (x !== startX || y !== startY || dir !== startDir);

      if (contour.length > 2) {
        contours.push(contour);
      }
    }

    return contours;
  }

  _rdp(points, epsilon) {
    if (points.length < 3) return points.slice();
    const dmaxInfo = this._rdpFindMax(points);
    if (dmaxInfo.dmax > epsilon) {
      const res1 = this._rdp(points.slice(0, dmaxInfo.index + 1), epsilon);
      const res2 = this._rdp(points.slice(dmaxInfo.index), epsilon);
      return res1.slice(0, -1).concat(res2);
    } else {
      return [points[0], points[points.length - 1]];
    }
  }

  _rdpFindMax(points) {
    const [x1, y1] = points[0],
      [x2, y2] = points[points.length - 1];
    let dmax = 0,
      idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._pointLineDist(points[i], [x1, y1], [x2, y2]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    return { dmax, index: idx };
  }

  _pointLineDist([x0, y0], [x1, y1], [x2, y2]) {
    const A = x0 - x1,
      B = y0 - y1,
      C = x2 - x1,
      D = y2 - y1;
    const dot = A * C + B * D;
    const len = C * C + D * D;
    const t = len ? Math.max(0, Math.min(1, dot / len)) : 0;
    const x = x1 + t * C,
      y = y1 + t * D;
    return Math.hypot(x - x0, y - y0);
  }

  _cleanPath(points) {
    // Remove only duplicate consecutive points (very light cleaning)
    if (points.length < 3) return points;

    const cleaned = [points[0]];
    const minDist = 0.1; // Very small threshold - only remove true duplicates

    for (let i = 1; i < points.length; i++) {
      const prev = cleaned[cleaned.length - 1];
      const curr = points[i];
      const dist = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);

      // Skip only if points are essentially identical
      if (dist < minDist) continue;

      cleaned.push(curr);
    }

    return cleaned.length >= 3 ? cleaned : points;
  }

  _emitSVG(contours, palette, width, height) {
    const pathToD = (pts) => {
      if (!pts.length) return '';
      const m = `M ${pts[0][0]} ${pts[0][1]}`;
      const lines = pts
        .slice(1)
        .map((p) => `L ${p[0]} ${p[1]}`)
        .join(' ');
      return `${m} ${lines} Z`;
    };
    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' data-outline-color='${this.opts.outlineColor}' data-outline-width='${this.opts.outlineWidth}'>`;
    const body = contours
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => {
        const pal = palette[c.colorIndex];
        const d = pathToD(c.path);
        const fill = pal ? pal.hex : '#cccccc';
        return `<path d='${d}' data-index='${c.index}' data-color='${fill}' fill='none'/>`;
      })
      .join('\n');
    const footer = '\n</svg>';
    return header + '\n' + body + footer;
  }
}

/**************************************************
 * StructureAwareImagePalletizer                  *
 * Edge-aware superpixel segmentation approach    *
 **************************************************/
export class StructureAwareImagePalletizer {
  constructor(opts = {}) {
    // Difficulty presets
    const DIFFICULTY_PRESETS = {
      easy: {
        targetRegions: 80,
        targetColors: 12,
        compactness: 25,
        minRegionArea: 200,
        colorMergeThreshold: 15,  // More selective merging
      },
      medium: {
        targetRegions: 300,
        targetColors: 20,
        compactness: 20,
        minRegionArea: 120,
        colorMergeThreshold: 10,
      },
      hard: {
        targetRegions: 600,
        targetColors: 30,
        compactness: 18,
        minRegionArea: 80,
        colorMergeThreshold: 8,   // Much more selective
      },
      expert: {
        targetRegions: 1000,
        targetColors: 40,
        compactness: 15,
        minRegionArea: 50,
        colorMergeThreshold: 6,   // Very selective
      }
    };

    // Apply difficulty preset if specified
    const difficulty = opts.difficulty || 'medium';
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.medium;

    this.opts = Object.assign({
      difficulty: difficulty,
      targetRegions: preset.targetRegions,      // Target number of initial superpixels
      targetColors: preset.targetColors,        // Target number of colors in final palette
      compactness: preset.compactness,          // SLIC compactness (spatial vs color weight)
      iterations: 10,                           // SLIC iteration count
      minRegionArea: preset.minRegionArea,      // Minimum region size in pixels
      colorMergeThreshold: preset.colorMergeThreshold,  // LAB distance for merging similar regions
      outlineColor: '#0b0d0e',
      outlineWidth: 2
    }, opts);
  }

  _signedArea(ring) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      area += ring[i][0] * ring[j][1];
      area -= ring[j][0] * ring[i][1];
    }
    return area / 2;
  }

  _getBoundingBox(ring) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  _isRingInside(inner, outer) {
    // Simple point-in-polygon test using the first point of inner ring
    if (inner.length === 0) return false;
    const [px, py] = inner[0];

    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i];
      const [xj, yj] = outer[j];

      const intersect = ((yi > py) !== (yj > py)) &&
                       (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  _groupContoursWithHoles(rings) {
    if (!rings || rings.length === 0) return [];
    if (rings.length === 1) return [[rings[0]]];

    // Calculate area for each ring (signed area determines winding)
    const ringData = rings
      .filter(ring => ring && ring.length > 0)
      .map(ring => ({
        ring,
        area: this._signedArea(ring),
        bbox: this._getBoundingBox(ring)
      }));

    // Separate outer boundaries (positive area) from holes (negative area)
    const outers = ringData.filter(r => r.area > 0);
    const holes = ringData.filter(r => r.area < 0);

    // If no clear separation, treat largest as outer
    if (outers.length === 0) {
      if (ringData.length === 0) return [];
      ringData.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
      return [[ringData[0].ring]]; // Just return largest
    }

    // For each outer, find holes that are inside it
    const groups = [];
    for (const outer of outers) {
      const group = [outer.ring];

      // Find holes contained within this outer boundary
      for (const hole of holes) {
        if (this._isRingInside(hole.ring, outer.ring)) {
          // Reverse winding to ensure opposite direction
          group.push(hole.ring.slice().reverse());
        }
      }

      groups.push(group);
    }

    return groups;
  }

  async process(input) {
    const bmp = await this._toBitmap(input);
    const { width, height } = bmp;
    const ctx = this._makeCtx(width, height);
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);

    console.log(`Processing ${width}x${height} image with structure-aware segmentation (difficulty: ${this.opts.difficulty})...`);

    // 1. Light bilateral filtering to reduce noise while preserving edges
    // Use difficulty-appropriate blur strength
    const blurParams = {
      easy: { sigmaSpace: 5, sigmaColor: 20 },
      medium: { sigmaSpace: 4, sigmaColor: 12 },
      hard: { sigmaSpace: 3, sigmaColor: 8 },
      expert: { sigmaSpace: 2, sigmaColor: 5 }
    };
    const blur = blurParams[this.opts.difficulty] || blurParams.medium;
    const smoothed = this._bilateralFilter(img, blur.sigmaSpace, blur.sigmaColor);

    // 2. SLIC superpixel segmentation
    const { labels, numSuperpixels } = this._slicSegmentation(smoothed, this.opts.targetRegions);
    console.log(`SLIC created ${numSuperpixels} superpixels`);

    // 3. Compute average color for each superpixel
    const regionColors = this._computeRegionColors(smoothed, labels, numSuperpixels);

    // 4. Merge similar adjacent regions
    const { mergedLabels, numRegions } = this._mergeRegions(
      smoothed, labels, regionColors, width, height, numSuperpixels
    );
    console.log(`After merging: ${numRegions} regions`);

    // 5. Absorb dark outline regions into adjacent colored regions
    // This prevents outlines from becoming fillable regions
    const { labels: finalMergedLabels, numRegions: finalNumRegions } = this._absorbOutlineRegions(
      smoothed, mergedLabels, numRegions, width, height
    );
    console.log(`After absorbing outlines: ${finalNumRegions} regions`);

    // 6. Extract contours from merged regions BEFORE color quantization
    // This preserves individual region boundaries
    const contours = this._extractContours(finalMergedLabels, width, height);
    console.log(`Extracted ${contours.length} contours from ${finalNumRegions} regions`);

    // 7. Quantize colors to final palette
    const { palette, regionToPaletteMap } = this._quantizeRegionColorsWithMap(
      smoothed, finalMergedLabels, finalNumRegions
    );
    console.log(`Final palette: ${palette.length} colors`);

    // 8. Map contours to palette colors
    // IMPORTANT: index must match colorIndex so regions with same color share same palette entry
    const contoursWithColors = contours.map((c) => {
      const paletteIndex = regionToPaletteMap[c.colorIndex];
      return {
        index: paletteIndex + 1,  // Palette index (1-30) - game uses 1-indexed
        colorIndex: paletteIndex,  // Same as index, for consistency
        paths: c.paths  // Use new paths format (array of paths for even-odd fill)
      };
    });

    // 9. Simplify paths
    const simplified = contoursWithColors.map((c) => {
      // Apply RDP simplification then Gaussian smoothing to each path (outer + holes)
      const processedPaths = c.paths.map(path => {
        // Step 1: RDP to reduce point count (removes redundant/collinear points)
        // Lower epsilon = more detail. Pass width/height to preserve edge/corner points
        const rdpPath = this._rdp(path, 0.5, width, height);
        // Step 2: Gaussian smoothing to pull points away from pixel boundaries
        // Pass width/height to preserve edge points
        return gaussianSmooth(rdpPath, 3, width, height);
      });
      return Object.assign({}, c, { paths: processedPaths });
    });

    // Filter out contours where the outer path (first path) has too few points
    const filtered = simplified.filter((c) => c.paths && c.paths.length > 0 && c.paths[0].length >= 3);

    // Calculate stats
    const regionsPerColor = filtered.length / palette.length;
    console.log(`Final result: ${filtered.length} total regions, ${palette.length} colors, ~${regionsPerColor.toFixed(1)} regions/color`);

    const svg = this._emitSVG(filtered, palette, width, height);
    return { svg, palette, width, height, regionsCount: filtered.length };
  }

  _slicSegmentation(img, targetSuperpixels) {
    const { data, width, height } = img;
    const numPixels = width * height;

    // PRE-CONVERT ENTIRE IMAGE TO LAB COLOR SPACE
    // This is a huge optimization - converts once instead of millions of times in loops
    console.log('Pre-converting image to LAB color space...');
    const labImage = new Float32Array(numPixels * 3);
    for (let i = 0; i < numPixels; i++) {
      const dataIdx = i * 4;
      const r = data[dataIdx];
      const g = data[dataIdx + 1];
      const b = data[dataIdx + 2];
      const lab = this._rgbToLab(r, g, b);
      labImage[i * 3] = lab[0];
      labImage[i * 3 + 1] = lab[1];
      labImage[i * 3 + 2] = lab[2];
    }
    console.log('LAB conversion complete');

    // Calculate grid spacing for approximately targetSuperpixels
    const S = Math.sqrt(numPixels / targetSuperpixels);
    const gridW = Math.ceil(width / S);
    const gridH = Math.ceil(height / S);
    const numClusters = gridW * gridH;

    console.log(`SLIC grid: ${gridW}x${gridH} (spacing=${S.toFixed(1)})`);

    // Initialize cluster centers on a grid
    const centers = [];
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const cx = Math.min(Math.floor((gx + 0.5) * S), width - 1);
        const cy = Math.min(Math.floor((gy + 0.5) * S), height - 1);
        const pxIdx = cy * width + cx;
        const labIdx = pxIdx * 3;
        centers.push({
          x: cx,
          y: cy,
          l: labImage[labIdx],
          a: labImage[labIdx + 1],
          b: labImage[labIdx + 2]
        });
      }
    }

    // SLIC iterations
    let labels = new Int32Array(width * height).fill(-1);
    let distances = new Float32Array(width * height).fill(Infinity);

    for (let iter = 0; iter < this.opts.iterations; iter++) {
      // Assignment step
      distances.fill(Infinity);

      for (let k = 0; k < centers.length; k++) {
        const c = centers[k];
        // Search in 2S x 2S region around cluster center
        const minX = Math.max(0, Math.floor(c.x - 2 * S));
        const maxX = Math.min(width - 1, Math.ceil(c.x + 2 * S));
        const minY = Math.max(0, Math.floor(c.y - 2 * S));
        const maxY = Math.min(height - 1, Math.ceil(c.y + 2 * S));

        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const pxIdx = y * width + x;
            const labIdx = pxIdx * 3;

            // Read from pre-converted LAB image
            const l = labImage[labIdx];
            const a = labImage[labIdx + 1];
            const b = labImage[labIdx + 2];

            // Combined distance (color + spatial)
            const dc = Math.sqrt(
              (l - c.l) ** 2 + (a - c.a) ** 2 + (b - c.b) ** 2
            );
            const ds = Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2);
            const D = dc + (ds / S) * this.opts.compactness;

            if (D < distances[pxIdx]) {
              distances[pxIdx] = D;
              labels[pxIdx] = k;
            }
          }
        }
      }

      // Update step
      const sums = Array.from({ length: centers.length }, () => ({
        x: 0, y: 0, l: 0, a: 0, b: 0, count: 0
      }));

      for (let i = 0; i < numPixels; i++) {
        const label = labels[i];
        if (label >= 0) {
          const x = i % width;
          const y = Math.floor(i / width);
          const labIdx = i * 3;

          sums[label].x += x;
          sums[label].y += y;
          sums[label].l += labImage[labIdx];
          sums[label].a += labImage[labIdx + 1];
          sums[label].b += labImage[labIdx + 2];
          sums[label].count++;
        }
      }

      for (let k = 0; k < centers.length; k++) {
        if (sums[k].count > 0) {
          centers[k].x = sums[k].x / sums[k].count;
          centers[k].y = sums[k].y / sums[k].count;
          centers[k].l = sums[k].l / sums[k].count;
          centers[k].a = sums[k].a / sums[k].count;
          centers[k].b = sums[k].b / sums[k].count;
        }
      }
    }

    // Enforce connectivity (merge orphan pixels into neighbors)
    const { labels: connectedLabels, numLabels } = this._enforceConnectivity(labels, width, height, Math.floor(this.opts.minRegionArea / 4));

    return { labels: connectedLabels, numSuperpixels: numLabels };
  }

  _enforceConnectivity(labels, width, height, minSize) {
    const newLabels = new Int32Array(width * height);
    newLabels.fill(-1);
    let newLabel = 0;
    const visited = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const startIdx = y * width + x;
        if (visited[startIdx]) continue;

        const oldLabel = labels[startIdx];
        const component = [];
        const queue = [[x, y]];
        visited[startIdx] = 1;

        while (queue.length > 0) {
          const [cx, cy] = queue.shift();
          const idx = cy * width + cx;
          component.push(idx);

          const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const [dx, dy] of neighbors) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (visited[nidx]) continue;
            if (labels[nidx] === oldLabel) {
              visited[nidx] = 1;
              queue.push([nx, ny]);
            }
          }
        }

        // Assign new label to this component
        if (component.length >= minSize) {
          for (const idx of component) {
            newLabels[idx] = newLabel;
          }
          newLabel++;
        } else {
          // Merge into nearest neighbor
          let componentHasNeighbor = false;
          let neighborLabel = -1;

          // Find any neighboring label for this small component
          for (const idx of component) {
            const x = idx % width;
            const y = Math.floor(idx / width);

            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const nidx = ny * width + nx;
              if (newLabels[nidx] >= 0) {
                neighborLabel = newLabels[nidx];
                componentHasNeighbor = true;
                break;
              }
            }
            if (componentHasNeighbor) break;
          }

          // Assign all pixels in component to the neighbor label or a new label
          const assignedLabel = componentHasNeighbor ? neighborLabel : newLabel;
          for (const idx of component) {
            newLabels[idx] = assignedLabel;
          }
          if (!componentHasNeighbor) newLabel++;
        }
      }
    }

    return { labels: newLabels, numLabels: newLabel };
  }

  _computeRegionColors(img, labels, numRegions) {
    const { data, width, height } = img;
    const sums = Array.from({ length: numRegions }, () => ({ r: 0, g: 0, b: 0, count: 0 }));

    for (let i = 0; i < width * height; i++) {
      const label = labels[i];
      if (label < 0) continue;
      const dataIdx = i * 4;
      sums[label].r += data[dataIdx];
      sums[label].g += data[dataIdx + 1];
      sums[label].b += data[dataIdx + 2];
      sums[label].count++;
    }

    return sums.map((s) => ({
      r: s.count > 0 ? s.r / s.count : 0,
      g: s.count > 0 ? s.g / s.count : 0,
      b: s.count > 0 ? s.b / s.count : 0,
    }));
  }

  _mergeRegions(img, labels, colors, width, height, numRegions) {
    // Build adjacency graph
    const adjacency = Array.from({ length: numRegions }, () => new Set());

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const label = labels[idx];
        if (label < 0) continue;

        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          const nlabel = labels[nidx];
          if (nlabel >= 0 && nlabel !== label) {
            adjacency[label].add(nlabel);
            adjacency[nlabel].add(label);
          }
        }
      }
    }

    // Iterative greedy merging to prevent transitive chains
    // This approach recomputes colors after each merge, preventing distant regions
    // from being merged through intermediate similar regions
    let currentLabels = new Int32Array(labels);
    let currentColors = colors.slice();
    let currentAdjacency = adjacency.map(set => new Set(set));
    let activeRegions = new Set(Array.from({ length: numRegions }, (_, i) => i));

    let mergeHappened = true;
    while (mergeHappened) {
      mergeHappened = false;

      // Find best merge candidate (smallest color distance among adjacent regions)
      let bestPair = null;
      let bestDist = this.opts.colorMergeThreshold;

      for (const i of activeRegions) {
        const colorI = currentColors[i];
        if (!colorI) continue;
        const labI = this._rgbToLab(colorI.r, colorI.g, colorI.b);

        for (const j of currentAdjacency[i]) {
          if (!activeRegions.has(j) || j <= i) continue;
          const colorJ = currentColors[j];
          if (!colorJ) continue;
          const labJ = this._rgbToLab(colorJ.r, colorJ.g, colorJ.b);
          const dist = this._labDist(labI, labJ);

          if (dist < bestDist) {
            bestDist = dist;
            bestPair = [i, j];
          }
        }
      }

      // If we found a merge candidate, merge it
      if (bestPair) {
        mergeHappened = true;
        const [regionA, regionB] = bestPair;

        // Merge B into A - relabel all B pixels to A
        for (let i = 0; i < currentLabels.length; i++) {
          if (currentLabels[i] === regionB) {
            currentLabels[i] = regionA;
          }
        }

        // Recompute merged region's color
        currentColors[regionA] = this._computeSingleRegionColor(
          img,
          currentLabels,
          regionA
        );

        // Update adjacency: A inherits B's neighbors
        for (const neighbor of currentAdjacency[regionB]) {
          if (neighbor !== regionA) {
            currentAdjacency[regionA].add(neighbor);
            currentAdjacency[neighbor].delete(regionB);
            currentAdjacency[neighbor].add(regionA);
          }
        }
        currentAdjacency[regionA].delete(regionB);

        // Remove B from active regions
        activeRegions.delete(regionB);
        currentColors[regionB] = null;
      }
    }

    // Create new label mapping for remaining active regions
    const newLabelMap = new Map();
    let newLabelCounter = 0;
    for (const oldLabel of activeRegions) {
      newLabelMap.set(oldLabel, newLabelCounter++);
    }

    // Relabel with compacted indices
    const mergedLabels = new Int32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const oldLabel = currentLabels[i];
      if (oldLabel >= 0 && newLabelMap.has(oldLabel)) {
        mergedLabels[i] = newLabelMap.get(oldLabel);
      } else {
        mergedLabels[i] = -1;
      }
    }

    return { mergedLabels, numRegions: newLabelCounter };
  }

  _computeSingleRegionColor(img, labels, regionLabel) {
    // Compute average color for a single region
    const { data, width, height } = img;
    let r = 0, g = 0, b = 0, count = 0;

    for (let i = 0; i < width * height; i++) {
      if (labels[i] === regionLabel) {
        const dataIdx = i * 4;
        r += data[dataIdx];
        g += data[dataIdx + 1];
        b += data[dataIdx + 2];
        count++;
      }
    }

    return count > 0 ? { r: r / count, g: g / count, b: b / count } : { r: 0, g: 0, b: 0 };
  }

  _quantizeRegionColors(img, labels, numRegions) {
    // Compute average color for each merged region
    const regionColors = this._computeRegionColors(img, labels, numRegions);

    // Use median-cut to quantize region colors
    const colorSamples = regionColors
      .filter((c) => c.r !== undefined)
      .map((c) => [c.r, c.g, c.b]);

    const K = Math.min(this.opts.targetColors, numRegions);
    const boxes = [this._makeVBox(colorSamples)];

    while (boxes.length < K && boxes.length < colorSamples.length) {
      boxes.sort((a, b) => b.volume - a.volume);
      const box = boxes.shift();
      if (!box || box.pixels.length <= 1) break;
      const [b1, b2] = this._splitVBox(box);
      boxes.push(b1, b2);
    }

    const palette = boxes.map((b) => {
      const avg = this._avgColor(b.pixels);
      return { r: avg[0], g: avg[1], b: avg[2], hex: this._toHex(avg[0], avg[1], avg[2]) };
    });

    // Assign each region to nearest palette color
    const labs = palette.map((c) => this._rgbToLab(c.r, c.g, c.b));
    const regionToPalette = regionColors.map((c) => {
      const lab = this._rgbToLab(c.r, c.g, c.b);
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < labs.length; k++) {
        const d = this._labDist(lab, labs[k]);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      return best;
    });

    // Create final labels mapped to palette indices
    const finalLabels = new Int32Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
      const regionLabel = labels[i];
      finalLabels[i] = regionLabel >= 0 ? regionToPalette[regionLabel] : -1;
    }

    return { palette, finalLabels };
  }

  _quantizeRegionColorsWithMap(img, labels, numRegions) {
    // Compute average color for each merged region
    const regionColors = this._computeRegionColors(img, labels, numRegions);

    // Use median-cut to quantize region colors
    const colorSamples = regionColors
      .filter((c) => c.r !== undefined)
      .map((c) => [c.r, c.g, c.b]);

    const K = Math.min(this.opts.targetColors, numRegions);
    const boxes = [this._makeVBox(colorSamples)];

    while (boxes.length < K && boxes.length < colorSamples.length) {
      boxes.sort((a, b) => b.volume - a.volume);
      const box = boxes.shift();
      if (!box || box.pixels.length <= 1) break;
      const [b1, b2] = this._splitVBox(box);
      boxes.push(b1, b2);
    }

    const palette = boxes.map((b) => {
      const avg = this._avgColor(b.pixels);
      return { r: avg[0], g: avg[1], b: avg[2], hex: this._toHex(avg[0], avg[1], avg[2]) };
    });

    // Assign each region to nearest palette color
    const labs = palette.map((c) => this._rgbToLab(c.r, c.g, c.b));
    const regionToPaletteMap = regionColors.map((c) => {
      const lab = this._rgbToLab(c.r, c.g, c.b);
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < labs.length; k++) {
        const d = this._labDist(lab, labs[k]);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      return best;
    });

    return { palette, regionToPaletteMap };
  }

  // Reuse utility methods from EnhancedImageToSVGPalletizer
  _makeCtx(w, h) { const c=new OffscreenCanvas(w, h); return c.getContext('2d'); }
  async _toBitmap(input) { if(input instanceof ImageBitmap) return input; if(typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) return createImageBitmap(input); if(typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) return createImageBitmap(input); if(input instanceof OffscreenCanvas) return input.transferToImageBitmap(); throw new Error('Unsupported input type'); }
  _toHex(r,g,b) { const h=(v)=>v.toString(16).padStart(2,'0'); return `#${h(r)}${h(g)}${h(b)}`; }
  _avgColor(pxs) { let r=0,g=0,b=0; for(const p of pxs){ r+=p[0]; g+=p[1]; b+=p[2]; } const n=pxs.length||1; return [r/n|0,g/n|0,b/n|0]; }
  _rgbToLab(r,g,b) { const srgb=[r/255,g/255,b/255].map(u=>u<=0.04045? u/12.92 : Math.pow((u+0.055)/1.055,2.4)); let [x,y,z]=[0.4124564*srgb[0]+0.3575761*srgb[1]+0.1804375*srgb[2], 0.2126729*srgb[0]+0.7151522*srgb[1]+0.0721750*srgb[2], 0.0193339*srgb[0]+0.1191920*srgb[1]+0.9503041*srgb[2]]; const xn=0.95047,yn=1.00000,zn=1.08883; const f=(t)=> t>0.008856? Math.cbrt(t) : 7.787*t+16/116; const fx=f(x/xn), fy=f(y/yn), fz=f(z/zn); return [116*fy-16, 500*(fx-fy), 200*(fy-fz)]; }
  _labDist(a,b) { const dl=a[0]-b[0], da=a[1]-b[1], db=a[2]-b[2]; return Math.sqrt(dl*dl+da*da+db*db); }
  _makeVBox(pixels) { let rmin=255,rmax=0,gmin=255,gmax=0,bmin=255,bmax=0; for(const [r,g,b] of pixels){ rmin=Math.min(rmin,r); rmax=Math.max(rmax,r); gmin=Math.min(gmin,g); gmax=Math.max(gmax,g); bmin=Math.min(bmin,b); bmax=Math.max(bmax,b);} return { pixels, rmin,rmax,gmin,gmax,bmin,bmax, get volume(){ return (1+this.rmax-this.rmin)*(1+this.gmax-this.gmin)*(1+this.bmax-this.bmin);} }; }
  _splitVBox(vb) { const rR=vb.rmax-vb.rmin, gR=vb.gmax-vb.gmin, bR=vb.bmax-vb.bmin; let channel='r'; if(gR>=rR && gR>=bR) channel='g'; else if(bR>=rR && bR>=gR) channel='b'; const arr=vb.pixels.slice().sort((a,b)=> channel==='r'? a[0]-b[0] : channel==='g'? a[1]-b[1] : a[2]-b[2]); const mid=Math.floor(arr.length/2); return [this._makeVBox(arr.slice(0,mid)), this._makeVBox(arr.slice(mid))]; }

  _absorbOutlineRegions(img, labels, numRegions, width, height) {
    // Identify dark outline regions and merge them into adjacent colored regions
    // This prevents outlines from becoming fillable regions - our drawn paths replace them

    const regionColors = this._computeRegionColors(img, labels, numRegions);

    // Identify outline regions (very dark in LAB color space)
    const outlineRegions = new Set();
    const darknessThreshold = 50; // L value in LAB (0=black, 100=white)

    for (let i = 0; i < regionColors.length; i++) {
      const c = regionColors[i];
      const lab = this._rgbToLab(c.r, c.g, c.b);
      if (lab[0] < darknessThreshold) { // L (lightness) < 50
        outlineRegions.add(i);
      }
    }

    console.log(`Identified ${outlineRegions.size} dark outline regions (L < ${darknessThreshold})`);

    if (outlineRegions.size === 0) {
      // No outlines detected, return as-is
      return { labels, numRegions };
    }

    // Reassign each pixel in outline regions to nearest non-outline neighbor
    const newLabels = new Int32Array(labels);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const label = labels[idx];

        if (label >= 0 && outlineRegions.has(label)) {
          // This pixel is part of an outline region - find nearest non-outline neighbor
          const neighborCounts = new Map();

          // Check 8-connected neighborhood
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

              const nidx = ny * width + nx;
              const nlabel = labels[nidx];

              if (nlabel >= 0 && !outlineRegions.has(nlabel)) {
                // Found a non-outline neighbor
                neighborCounts.set(nlabel, (neighborCounts.get(nlabel) || 0) + 1);
              }
            }
          }

          // Assign to most common non-outline neighbor
          if (neighborCounts.size > 0) {
            let bestLabel = -1;
            let bestCount = 0;
            for (const [nlabel, count] of neighborCounts) {
              if (count > bestCount) {
                bestCount = count;
                bestLabel = nlabel;
              }
            }
            newLabels[idx] = bestLabel;
          }
          // else: keep original label (isolated outline pixel with no colored neighbors)
        }
      }
    }

    // Compact labels to remove gaps from absorbed regions
    // First pass: build mapping for all unique labels
    const uniqueLabels = new Set();
    for (let i = 0; i < newLabels.length; i++) {
      if (newLabels[i] >= 0) {
        uniqueLabels.add(newLabels[i]);
      }
    }

    const labelMap = new Map();
    let newLabelCounter = 0;
    for (const oldLabel of uniqueLabels) {
      labelMap.set(oldLabel, newLabelCounter++);
    }

    // Second pass: remap all labels
    const compactedLabels = new Int32Array(newLabels.length);
    for (let i = 0; i < newLabels.length; i++) {
      const oldLabel = newLabels[i];
      if (oldLabel >= 0 && labelMap.has(oldLabel)) {
        compactedLabels[i] = labelMap.get(oldLabel);
      } else {
        compactedLabels[i] = -1;
      }
    }

    return { labels: compactedLabels, numRegions: newLabelCounter };
  }

  _bilateralFilter(imageData, sigmaSpace, sigmaColor) {
    const { data, width, height } = imageData;
    const output = new ImageData(width, height);
    const radius = Math.ceil(sigmaSpace * 2);
    const twoSigmaSpaceSq = 2 * sigmaSpace * sigmaSpace;
    const twoSigmaColorSq = 2 * sigmaColor * sigmaColor;

    // OPTIMIZATION 1: Precompute spatial weights (same for every pixel)
    const spatialWeights = new Float32Array((2 * radius + 1) * (2 * radius + 1));
    let swIdx = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const spaceDist = dx * dx + dy * dy;
        spatialWeights[swIdx++] = Math.exp(-spaceDist / twoSigmaSpaceSq);
      }
    }

    // OPTIMIZATION 2: Precompute color weight lookup table
    // Colors can differ by 0-441 (sqrt(255^2 + 255^2 + 255^2) ≈ 441)
    const maxColorDist = 195075; // 255^2 * 3
    const colorLUT = new Float32Array(maxColorDist + 1);
    for (let i = 0; i <= maxColorDist; i++) {
      colorLUT[i] = Math.exp(-i / twoSigmaColorSq);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centerIdx = (y * width + x) * 4;
        const centerR = data[centerIdx];
        const centerG = data[centerIdx + 1];
        const centerB = data[centerIdx + 2];

        let r = 0, g = 0, b = 0, wSum = 0;
        let swIdx = 0;

        for (let dy = -radius; dy <= radius; dy++) {
          const py = Math.min(Math.max(y + dy, 0), height - 1);
          for (let dx = -radius; dx <= radius; dx++) {
            const px = Math.min(Math.max(x + dx, 0), width - 1);
            const idx = (py * width + px) * 4;

            // OPTIMIZATION 3: Use precomputed spatial weight
            const spaceWeight = spatialWeights[swIdx++];

            // OPTIMIZATION 4: Use lookup table for color weight
            const dr = data[idx] - centerR;
            const dg = data[idx + 1] - centerG;
            const db = data[idx + 2] - centerB;
            const colorDist = dr * dr + dg * dg + db * db;
            const colorWeight = colorLUT[colorDist];

            const w = spaceWeight * colorWeight;
            r += data[idx] * w;
            g += data[idx + 1] * w;
            b += data[idx + 2] * w;
            wSum += w;
          }
        }

        output.data[centerIdx] = r / wSum;
        output.data[centerIdx + 1] = g / wSum;
        output.data[centerIdx + 2] = b / wSum;
        output.data[centerIdx + 3] = 255;
      }
    }

    return output;
  }

  _extractContours(indexBuf, width, height) {
    let max = -1;
    for (let i = 0; i < indexBuf.length; i++) {
      if (indexBuf[i] > max) max = indexBuf[i];
    }
    const maxCls = max >= 0 ? max + 1 : 0;
    const contours = [];
    for (let cls = 0; cls < maxCls; cls++) {
      const rings = this._traceClass(indexBuf, width, height, cls);

      // Group rings by hierarchy (outer boundaries vs holes)
      const grouped = this._groupContoursWithHoles(rings);

      for (const group of grouped) {
        contours.push({
          index: cls + 1,
          colorIndex: cls,
          paths: group // Array of paths: [outer, hole1, hole2, ...]
        });
      }
    }
    return contours;
  }
  _traceClass(indexBuf, width, height, cls) {
    // Choose which algorithm to use for contour extraction
    // Comment/uncomment to switch between algorithms:

    return this._traceClassMooreNeighbor(indexBuf, width, height, cls);
    // return this._traceClassMarchingSquares(indexBuf, width, height, cls);
  }

  _traceClassMooreNeighbor(indexBuf, width, height, cls) {
    // Original Moore-neighbor boundary tracing algorithm
    // Walks around region boundaries using 4-directional neighbors

    const mask = new Uint8Array((width + 2) * (height + 2));
    const W = width + 2,
      H = height + 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        mask[(y + 1) * W + (x + 1)] = indexBuf[y * width + x] === cls ? 1 : 0;
      }
    }
    const visited = new Uint8Array(W * H);
    const rings = [];
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask[i] === 0 || visited[i]) continue;
        if (!(mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W])) {
          let cx = x,
            cy = y,
            startX = x,
            startY = y,
            prevDir = 0;
          const ring = [];
          let safety = 0;
          let firstIteration = true;
          do {
            // Check if we're back at start BEFORE adding point (except first iteration)
            if (!firstIteration && cx === startX && cy === startY) break;
            firstIteration = false;

            ring.push([cx - 1, cy - 1]);
            visited[cy * W + cx] = 1;
            let found = false;
            for (let k = 0; k < 4; k++) {
              const dir = (prevDir + 3 + k) % 4;
              const [dx, dy] = dirs[dir];
              const nx = cx + dx,
                ny = cy + dy;
              const ni = ny * W + nx;
              if (mask[ni]) {
                cx = nx;
                cy = ny;
                prevDir = dir;
                found = true;
                break;
              }
            }
            if (!found) break;
            if (++safety > 1e6) break;
          } while (true);
          if (ring.length > 2) rings.push(ring);
        }
      }
    }
    return rings;
  }

  _traceClassMarchingSquares(indexBuf, width, height, cls) {
    // Marching squares: creates line segments at pixel boundaries, then connects them into contours
    // WARNING: Greedy segment connection can create self-crossing paths

    // Build binary mask
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      mask[i] = indexBuf[i] === cls ? 1 : 0;
    }

    // Store line segments as pairs of points
    // Each segment connects two adjacent grid points
    const segments = [];

    // Process each 2x2 cell
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        // Get the 4 corners of this cell (TL, TR, BR, BL)
        const tl = mask[y * width + x];
        const tr = mask[y * width + (x + 1)];
        const br = mask[(y + 1) * width + (x + 1)];
        const bl = mask[(y + 1) * width + x];

        // Compute marching squares case (0-15)
        const cellCase = (tl << 3) | (tr << 2) | (br << 1) | bl;

        // Grid points for this cell's edges:
        // Top-left corner of cell is at (x, y)
        const n = [x + 0.5, y];      // North edge midpoint
        const e = [x + 1, y + 0.5];  // East edge midpoint
        const s = [x + 0.5, y + 1];  // South edge midpoint
        const w = [x, y + 0.5];      // West edge midpoint

        // Add line segments based on case
        // Each case draws lines between edge midpoints
        switch (cellCase) {
          case 0: case 15: break; // All same, no boundary
          case 1: case 14: segments.push([w, s]); break;
          case 2: case 13: segments.push([s, e]); break;
          case 3: case 12: segments.push([w, e]); break;
          case 4: case 11: segments.push([n, e]); break;
          case 5: segments.push([w, n], [s, e]); break; // Saddle
          case 6: case 9: segments.push([n, s]); break;
          case 7: case 8: segments.push([w, n]); break;
          case 10: segments.push([w, s], [n, e]); break; // Saddle
        }
      }
    }

    // Now connect segments into closed loops
    const contours = [];
    const used = new Set();

    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;

      const contour = [];
      const [start, end] = segments[i];
      contour.push([...start], [...end]);
      used.add(i);

      let currentEnd = end;
      let safety = 0;

      // Keep following connected segments until we close the loop
      while (safety++ < 10000) {
        let found = false;

        for (let j = 0; j < segments.length; j++) {
          if (used.has(j)) continue;

          const [segStart, segEnd] = segments[j];

          // Check if this segment connects to our current endpoint
          if (Math.abs(currentEnd[0] - segStart[0]) < 0.01 &&
              Math.abs(currentEnd[1] - segStart[1]) < 0.01) {
            // Segment continues from current end
            contour.push([...segEnd]);
            currentEnd = segEnd;
            used.add(j);
            found = true;
            break;
          } else if (Math.abs(currentEnd[0] - segEnd[0]) < 0.01 &&
                     Math.abs(currentEnd[1] - segEnd[1]) < 0.01) {
            // Segment is reversed
            contour.push([...segStart]);
            currentEnd = segStart;
            used.add(j);
            found = true;
            break;
          }
        }

        // Check if we've closed the loop
        if (Math.abs(currentEnd[0] - start[0]) < 0.01 &&
            Math.abs(currentEnd[1] - start[1]) < 0.01) {
          break; // Closed loop
        }

        if (!found) break; // Can't continue
      }

      if (contour.length > 2) {
        contours.push(contour);
      }
    }

    return contours;
  }
  _rdp(points, epsilon, width = null, height = null) {
    if (points.length < 3) return points.slice();

    const isCorner = (point) => {
      if (!width || !height) return false;
      const THRESHOLD = 1;
      return (
        (point[0] <= THRESHOLD && point[1] <= THRESHOLD) || // Top-left
        (point[0] >= width - THRESHOLD && point[1] <= THRESHOLD) || // Top-right
        (point[0] >= width - THRESHOLD && point[1] >= height - THRESHOLD) || // Bottom-right
        (point[0] <= THRESHOLD && point[1] >= height - THRESHOLD) // Bottom-left
      );
    };

    const isOnBoundary = (point) => {
      return width !== null && height !== null && (
        point[0] <= 0.5 || point[0] >= width - 0.5 ||
        point[1] <= 0.5 || point[1] >= height - 0.5
      );
    };

    // Find corners in the segment - these must always be kept
    const cornerIndices = [];
    for (let i = 0; i < points.length; i++) {
      if (isCorner(points[i])) {
        cornerIndices.push(i);
      }
    }

    // If we have corners in this segment, force split at the first one
    if (cornerIndices.length > 0 && cornerIndices[0] > 0 && cornerIndices[0] < points.length - 1) {
      const idx = cornerIndices[0];
      const res1 = this._rdp(points.slice(0, idx + 1), epsilon, width, height);
      const res2 = this._rdp(points.slice(idx), epsilon, width, height);
      return res1.slice(0, -1).concat(res2);
    }

    const dmaxInfo = this._rdpFindMax(points, width, height);
    if (dmaxInfo.dmax > epsilon) {
      const res1 = this._rdp(points.slice(0, dmaxInfo.index + 1), epsilon, width, height);
      const res2 = this._rdp(points.slice(dmaxInfo.index), epsilon, width, height);
      return res1.slice(0, -1).concat(res2);
    } else {
      // Base case: keep start, end, and any CORNERS in between (not all edge points!)
      const result = [points[0]];
      for (let i = 1; i < points.length - 1; i++) {
        if (isCorner(points[i])) {
          result.push(points[i]);
        }
      }
      result.push(points[points.length - 1]);
      return result;
    }
  }
  _rdpFindMax(points, width = null, height = null) {
    const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
    let dmax = 0, idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._pointLineDist(points[i], [x1, y1], [x2, y2]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    return { dmax, index: idx };
  }
  _pointLineDist([x0, y0], [x1, y1], [x2, y2]) {
    const A = x0 - x1, B = y0 - y1, C = x2 - x1, D = y2 - y1;
    const dot = A * C + B * D;
    const len = C * C + D * D;
    const t = len ? Math.max(0, Math.min(1, dot / len)) : 0;
    const x = x1 + t * C, y = y1 + t * D;
    return Math.hypot(x - x0, y - y0);
  }
  _emitSVG(contours, palette, width, height) {
    const pathToD = (pts) => {
      if (!pts.length) return '';
      const m = `M ${pts[0][0]} ${pts[0][1]}`;
      const lines = pts.slice(1).map(p => `L ${p[0]} ${p[1]}`).join(' ');
      return `${m} ${lines} Z`;
    };

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' data-outline-color='${this.opts.outlineColor}' data-outline-width='${this.opts.outlineWidth}'>`;

    const body = contours
      .sort((a, b) => {
        // Sort by total area (sum of all sub-paths)
        const aPaths = a.paths || (a.path ? [a.path] : []);
        const bPaths = b.paths || (b.path ? [b.path] : []);
        const aLen = aPaths.reduce((sum, p) => sum + (p ? p.length : 0), 0);
        const bLen = bPaths.reduce((sum, p) => sum + (p ? p.length : 0), 0);
        return bLen - aLen;
      })
      .map(c => {
        const pal = palette[c.colorIndex];
        const fill = pal ? pal.hex : '#cccccc';

        // Handle both old format (single path) and new format (multiple paths with holes)
        let d;
        if (c.paths) {
          // New format: combine outer + holes into single path data for even-odd fill
          d = c.paths.map(pathToD).join(' ');
        } else {
          // Old format: single path
          d = pathToD(c.path);
        }

        return `<path d='${d}' data-index='${c.index}' data-color='${fill}' fill='none' fill-rule='evenodd'/>`;
      })
      .join('\n');

    const footer = '\n</svg>';
    return header + '\n' + body + footer;
  }
}

/**************************************************
 * PosterizeImagePalletizer
 * Simple posterization-based approach:
 * 1. Posterize image to N colors
 * 2. Find connected regions of same color
 * 3. Filter small regions based on difficulty
 * 4. Extract contours and generate SVG
 **************************************************/
export class PosterizeImagePalletizer {
  constructor(opts = {}) {
    this.opts = Object.assign(
      {
        numColors: 16,          // Number of colors in posterized image
        difficulty: 'medium',   // Controls minimum region size
        simplifyTolerance: 0.4, // Reduced for more detail
        smoothIterations: 1,    // Chaikin smoothing iterations
        outlineColor: '#0b0d0e',
        outlineWidth: 2,
      },
      opts
    );
  }

  async process(input) {
    const bmp = await this._toBitmap(input);
    let { width, height } = bmp;

    // Downsample to max resolution to reduce detail
    const maxDimension = 600;
    let processWidth = width;
    let processHeight = height;

    if (width > maxDimension || height > maxDimension) {
      const scale = maxDimension / Math.max(width, height);
      processWidth = Math.round(width * scale);
      processHeight = Math.round(height * scale);
      console.log(`Downsampling from ${width}x${height} to ${processWidth}x${processHeight}`);
    }

    const ctx = this._makeCtx(processWidth, processHeight);
    ctx.drawImage(bmp, 0, 0, processWidth, processHeight);
    const img = ctx.getImageData(0, 0, processWidth, processHeight);

    console.log(`Processing ${processWidth}x${processHeight} image with posterize (${this.opts.numColors} colors, difficulty: ${this.opts.difficulty})...`);

    // 1. Apply median filter to reduce noise before posterization
    console.log('Applying median filter to reduce noise...');
    const filtered = this._medianFilter(img, processWidth, processHeight);

    // 2. Posterize the filtered image
    const posterized = this._posterize(filtered, this.opts.numColors);

    // 3. Find connected components
    const { labels, regions, colorMap } = this._connectedComponentsByColor(posterized, processWidth, processHeight);

    // 4. Filter and merge small regions based on difficulty and image size
    const minRegionSize = this._getMinRegionSize(this.opts.difficulty, processWidth, processHeight);
    this._filterSmallRegions(posterized, labels, regions, colorMap, processWidth, processHeight, minRegionSize);

    // 5. Group regions by color and remap to unique color indices
    const { colorToIndex, regionToColorIndex } = this._groupRegionsByColor(colorMap, regions);

    // 6. Extract contours with correct color indices
    const contours = this._extractContours(labels, processWidth, processHeight);

    // 7. Simplify and smooth contours, apply color index mapping
    const simplified = contours.map((c) => {
      const rdpPath = this._rdp(c.path, this.opts.simplifyTolerance);
      const smoothPath = this.opts.smoothIterations > 0
        ? chaikinSmooth(rdpPath, this.opts.smoothIterations)
        : rdpPath;
      return Object.assign({}, c, {
        path: smoothPath,
        colorIndex: regionToColorIndex.get(c.colorIndex) || 0
      });
    });

    // 8. Scale coordinates back to original dimensions if we downsampled
    const scale = width / processWidth;
    if (scale !== 1) {
      console.log(`Scaling coordinates by ${scale}x to match original dimensions`);
      simplified.forEach(c => {
        c.path = c.path.map(([x, y]) => [x * scale, y * scale]);
      });
    }

    // 9. Build palette from unique colors
    const palette = this._buildPaletteFromUniqueColors(colorToIndex);

    // 10. Generate SVG at original dimensions
    const svg = this._emitSVG(simplified, palette, width, height);

    console.log(`Final result: ${palette.length} unique colors, ${simplified.length} regions`);
    return { svg, palette, width, height, regionsCount: simplified.length };
  }

  _getMinRegionSize(difficulty, width, height) {
    const numPixels = width * height;

    // Target number of final regions based on difficulty
    const targetRegions = {
      easy: 200,      // Fewer, larger regions
      medium: 350,    // Moderate number of regions
      hard: 600,      // More regions, more detail
      expert: 900     // Many regions, fine detail
    }[difficulty] || 350;

    // Calculate minimum region size as average region size
    // This aggressively merges any region smaller than average
    const minSize = Math.floor(numPixels / targetRegions);

    // Ensure a reasonable minimum (at least 20 pixels)
    const finalMin = Math.max(20, minSize);

    console.log(`Calculated min region size: ${finalMin} pixels (targeting ~${targetRegions} regions)`);
    return finalMin;
  }

  _medianFilter(img, width, height) {
    const { data } = img;

    // Strong blur to reduce fragmentation
    const radius = 5;  // 11x11 box blur
    const passes = 3;

    console.log(`Applying ${radius*2+1}x${radius*2+1} box blur filter (${passes} passes)...`);

    let current = img;

    for (let pass = 0; pass < passes; pass++) {
      const output = new ImageData(width, height);
      const currentData = current.data;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let rSum = 0, gSum = 0, bSum = 0, count = 0;

          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              const ny = y + dy;

              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const idx = (ny * width + nx) * 4;
                rSum += currentData[idx];
                gSum += currentData[idx + 1];
                bSum += currentData[idx + 2];
                count++;
              }
            }
          }

          const outIdx = (y * width + x) * 4;
          output.data[outIdx] = Math.round(rSum / count);
          output.data[outIdx + 1] = Math.round(gSum / count);
          output.data[outIdx + 2] = Math.round(bSum / count);
          output.data[outIdx + 3] = 255;
        }
      }

      current = output;
    }

    return current;
  }

  _posterize(img, numColors) {
    const { data, width, height } = img;

    // Use median-cut quantization to reduce to numColors
    const sample = [];
    const step = Math.max(1, Math.floor((width * height) / 50000));
    for (let i = 0; i < data.length; i += 4 * step) {
      sample.push([data[i], data[i + 1], data[i + 2]]);
    }

    let boxes = [this._makeVBox(sample)];
    while (boxes.length < numColors) {
      boxes.sort((a, b) => b.count - a.count);
      const box = boxes.shift();
      if (!box) break;
      const [box1, box2] = this._splitBox(box);
      boxes.push(box1, box2);
    }

    const palette = boxes.map((box) => this._avgColor(box.colors));
    console.log(`Generated palette with ${palette.length} colors:`, palette);

    // Create posterized image by mapping each pixel to nearest palette color
    const output = new ImageData(width, height);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Find nearest palette color
      let minDist = Infinity;
      let bestColor = palette[0];
      for (const pColor of palette) {
        const dist = (r - pColor[0]) ** 2 + (g - pColor[1]) ** 2 + (b - pColor[2]) ** 2;
        if (dist < minDist) {
          minDist = dist;
          bestColor = pColor;
        }
      }

      output.data[i] = bestColor[0];
      output.data[i + 1] = bestColor[1];
      output.data[i + 2] = bestColor[2];
      output.data[i + 3] = 255;
    }

    // Verify unique colors in output
    const uniqueColors = new Set();
    for (let i = 0; i < output.data.length; i += 4) {
      const colorKey = (output.data[i] << 16) | (output.data[i + 1] << 8) | output.data[i + 2];
      uniqueColors.add(colorKey);
    }
    console.log(`Posterized image has ${uniqueColors.size} unique colors (expected ${palette.length})`);

    return output;
  }

  _makeVBox(colors) {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const [r, g, b] of colors) {
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
    }
    return { rmin, rmax, gmin, gmax, bmin, bmax, colors, count: colors.length };
  }

  _splitBox(box) {
    const rspan = box.rmax - box.rmin;
    const gspan = box.gmax - box.gmin;
    const bspan = box.bmax - box.bmin;
    const channel = rspan >= gspan && rspan >= bspan ? 0 : gspan >= bspan ? 1 : 2;
    const sorted = box.colors.slice().sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(sorted.length / 2);
    return [this._makeVBox(sorted.slice(0, mid)), this._makeVBox(sorted.slice(mid))];
  }

  _avgColor(colors) {
    let r = 0, g = 0, b = 0;
    for (const [cr, cg, cb] of colors) {
      r += cr;
      g += cg;
      b += cb;
    }
    const n = colors.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  _connectedComponentsByColor(img, width, height) {
    const { data } = img;
    const labels = new Int32Array(width * height).fill(-1);
    const regions = [];
    const colorMap = new Map(); // Maps label to RGB color
    let labelId = 0;

    // Helper: get color key for pixel
    const getColorKey = (idx) => {
      const r = data[idx * 4];
      const g = data[idx * 4 + 1];
      const b = data[idx * 4 + 2];
      return (r << 16) | (g << 8) | b;
    };

    // Flood fill to find connected components
    let singlePixelRegions = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (labels[idx] >= 0) continue;

        const colorKey = getColorKey(idx);
        const region = { id: labelId, size: 0, colorKey };

        // BFS flood fill
        const queue = [[x, y]];
        labels[idx] = labelId;

        while (queue.length > 0) {
          const [cx, cy] = queue.shift();
          const cidx = cy * width + cx;
          region.size++;

          // Check 4-connected neighbors
          const neighbors = [
            [cx - 1, cy], [cx + 1, cy],
            [cx, cy - 1], [cx, cy + 1]
          ];

          for (const [nx, ny] of neighbors) {
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nidx = ny * width + nx;
            if (labels[nidx] >= 0) continue;
            if (getColorKey(nidx) !== colorKey) continue;

            labels[nidx] = labelId;
            queue.push([nx, ny]);
          }
        }

        // Store region and color mapping
        regions.push(region);
        const r = data[idx * 4];
        const g = data[idx * 4 + 1];
        const b = data[idx * 4 + 2];
        colorMap.set(labelId, [r, g, b]);

        if (region.size === 1) singlePixelRegions++;

        labelId++;
      }
    }

    console.log(`Found ${regions.length} regions (${singlePixelRegions} single-pixel regions)`);

    // Sample some region sizes for debugging
    const sampleSizes = regions.slice(0, 10).map(r => r.size);
    console.log(`Sample region sizes:`, sampleSizes);

    return { labels, regions, colorMap };
  }

  _filterSmallRegions(img, labels, regions, colorMap, width, height, minSize) {
    // Find small regions
    const smallRegionSet = new Set();
    for (const region of regions) {
      if (region.size < minSize) {
        smallRegionSet.add(region.id);
      }
    }

    if (smallRegionSet.size === 0) {
      console.log('No small regions to filter');
      return;
    }

    console.log(`Filtering ${smallRegionSet.size} regions smaller than ${minSize} pixels`);

    // Build neighbor map in a single pass through the image
    const regionNeighbors = new Map(); // Maps region ID -> Map of neighbor ID -> count

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const label = labels[idx];

        // Only process small regions
        if (!smallRegionSet.has(label)) continue;

        if (!regionNeighbors.has(label)) {
          regionNeighbors.set(label, new Map());
        }
        const neighbors = regionNeighbors.get(label);

        // Check all 4 neighbors to ensure we find neighbors in all directions
        const neighborChecks = [
          [x + 1, y, idx + 1],      // right
          [x - 1, y, idx - 1],      // left
          [x, y + 1, idx + width],  // down
          [x, y - 1, idx - width]   // up
        ];

        for (const [nx, ny, nidx] of neighborChecks) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nlabel = labels[nidx];
            if (nlabel !== label && nlabel >= 0) {
              neighbors.set(nlabel, (neighbors.get(nlabel) || 0) + 1);
            }
          }
        }
      }
    }

    // Create region lookup for fast access
    const regionLookup = new Map();
    for (const region of regions) {
      regionLookup.set(region.id, region);
    }

    // Merge small regions into their most common neighbor
    let mergedCount = 0;
    for (const [regionId, neighbors] of regionNeighbors) {
      const region = regionLookup.get(regionId);
      if (!region || region.size >= minSize) continue; // May have grown from merges

      // Find most common neighbor
      let bestNeighbor = -1;
      let maxCount = 0;
      for (const [neighborId, count] of neighbors) {
        if (count > maxCount) {
          maxCount = count;
          bestNeighbor = neighborId;
        }
      }

      // Merge into best neighbor
      if (bestNeighbor >= 0) {
        // Update labels in-place
        for (let i = 0; i < labels.length; i++) {
          if (labels[i] === regionId) {
            labels[i] = bestNeighbor;
          }
        }

        // Update region sizes
        const neighborRegion = regionLookup.get(bestNeighbor);
        if (neighborRegion) {
          neighborRegion.size += region.size;
        }
        region.size = 0; // Mark as merged
        mergedCount++;
      }
    }

    console.log(`Merged ${mergedCount} small regions`);
  }

  _extractContours(labels, width, height) {
    // Find unique labels
    const labelSet = new Set();
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] >= 0) labelSet.add(labels[i]);
    }

    const contours = [];
    for (const label of labelSet) {
      const paths = this._traceLabel(labels, width, height, label);
      for (const path of paths) {
        contours.push({
          index: label + 1,
          colorIndex: label,
          path
        });
      }
    }

    return contours;
  }

  _traceLabel(labels, width, height, targetLabel) {
    // Create padded mask for boundary tracing
    const mask = new Uint8Array((width + 2) * (height + 2));
    const W = width + 2, H = height + 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        mask[(y + 1) * W + (x + 1)] = (labels[y * width + x] === targetLabel) ? 1 : 0;
      }
    }

    const visited = new Uint8Array(W * H);
    const rings = [];
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask[i] === 0 || visited[i]) continue;

        // Check if this is a boundary pixel
        if (!(mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W])) {
          let cx = x, cy = y, startX = x, startY = y, prevDir = 0;
          const ring = [];
          let safety = 0;

          do {
            ring.push([cx - 1, cy - 1]);
            visited[cy * W + cx] = 1;
            let found = false;

            for (let k = 0; k < 4; k++) {
              const dir = (prevDir + 3 + k) % 4;
              const [dx, dy] = dirs[dir];
              const nx = cx + dx, ny = cy + dy;
              const ni = ny * W + nx;

              if (mask[ni]) {
                cx = nx;
                cy = ny;
                prevDir = dir;
                found = true;
                break;
              }
            }

            if (!found) break;
            if (++safety > 1e6) break;
          } while (!(cx === startX && cy === startY && ring.length > 1));

          if (ring.length > 2) rings.push(ring);
        }
      }
    }

    return rings;
  }

  _groupRegionsByColor(colorMap, regions) {
    // Group regions by their actual RGB color
    const colorKeyToRegions = new Map();
    const regionToColorIndex = new Map();

    // First pass: group regions by color
    for (const region of regions) {
      if (region.size === 0) continue; // Skip merged regions

      const rgb = colorMap.get(region.id);
      if (!rgb) continue;

      // Create color key from RGB
      const colorKey = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];

      if (!colorKeyToRegions.has(colorKey)) {
        colorKeyToRegions.set(colorKey, { rgb, regionIds: [] });
      }
      colorKeyToRegions.get(colorKey).regionIds.push(region.id);
    }

    // Second pass: assign sequential color indices
    const colorToIndex = new Map();
    let colorIndex = 0;

    for (const [colorKey, { rgb, regionIds }] of colorKeyToRegions) {
      colorToIndex.set(colorKey, { index: colorIndex, rgb });

      // Map each region to this color index
      for (const regionId of regionIds) {
        regionToColorIndex.set(regionId, colorIndex);
      }

      colorIndex++;
    }

    console.log(`Grouped ${regions.length} regions into ${colorToIndex.size} unique colors`);
    return { colorToIndex, regionToColorIndex };
  }

  _buildPaletteFromUniqueColors(colorToIndex) {
    const palette = [];

    for (const [colorKey, { index, rgb }] of colorToIndex) {
      palette[index] = {
        hex: `#${rgb[0].toString(16).padStart(2, '0')}${rgb[1].toString(16).padStart(2, '0')}${rgb[2].toString(16).padStart(2, '0')}`
      };
    }

    return palette;
  }

  _rdp(points, epsilon) {
    if (points.length < 3) return points.slice();
    const dmaxInfo = this._rdpFindMax(points);
    if (dmaxInfo.dmax > epsilon) {
      const res1 = this._rdp(points.slice(0, dmaxInfo.index + 1), epsilon);
      const res2 = this._rdp(points.slice(dmaxInfo.index), epsilon);
      return res1.slice(0, -1).concat(res2);
    } else {
      return [points[0], points[points.length - 1]];
    }
  }

  _rdpFindMax(points) {
    const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
    let dmax = 0, idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._pointLineDist(points[i], [x1, y1], [x2, y2]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    return { dmax, index: idx };
  }

  _pointLineDist([x0, y0], [x1, y1], [x2, y2]) {
    const A = x0 - x1, B = y0 - y1, C = x2 - x1, D = y2 - y1;
    const dot = A * C + B * D;
    const len = C * C + D * D;
    const t = len ? Math.max(0, Math.min(1, dot / len)) : 0;
    const x = x1 + t * C, y = y1 + t * D;
    return Math.hypot(x - x0, y - y0);
  }

  _emitSVG(contours, palette, width, height) {
    const pathToD = (pts) => {
      if (!pts.length) return '';
      const m = `M ${pts[0][0]} ${pts[0][1]}`;
      const lines = pts.slice(1).map(p => `L ${p[0]} ${p[1]}`).join(' ');
      return `${m} ${lines} Z`;
    };

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' data-outline-color='${this.opts.outlineColor}' data-outline-width='${this.opts.outlineWidth}'>`;
    const body = contours
      .sort((a, b) => b.path.length - a.path.length)
      .map(c => {
        const pal = palette[c.colorIndex];
        const d = pathToD(c.path);
        const fill = pal ? pal.hex : '#cccccc';
        // Use colorIndex + 1 for data-index (1-based for display)
        return `<path d='${d}' data-index='${c.colorIndex + 1}' data-color='${fill}' fill='none'/>`;
      })
      .join('\n');
    const footer = '\n</svg>';
    return header + '\n' + body + footer;
  }

  _makeCtx(w, h) {
    const c = new OffscreenCanvas(w, h);
    return c.getContext('2d');
  }

  async _toBitmap(input) {
    if (input instanceof ImageBitmap) {
      return input;
    }
    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
      return createImageBitmap(input);
    }
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
      return createImageBitmap(input);
    }
    if (input instanceof OffscreenCanvas) {
      return input.transferToImageBitmap();
    }
    throw new Error('Unsupported input type');
  }
}
