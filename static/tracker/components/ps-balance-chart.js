// ps-balance-chart: Canvas-based balance-over-time chart with zoom and pan
class PsBalanceChart extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
    this._canvas = null;
    this._ctx = null;
    this._dpr = window.devicePixelRatio || 1;

    // View state
    this._offsetX = 0;   // pan offset in pixels (negative = scrolled right)
    this._scaleX = 1;    // zoom level (1 = default, higher = zoomed in)
    this._minScale = 0.3;
    this._maxScale = 20;

    // Interaction state
    this._dragging = false;
    this._dragStartX = 0;
    this._dragStartOffset = 0;
    this._tooltip = null; // { x, y, event } or null
    this._pinchStartDist = 0;
    this._pinchStartScale = 1;

    // Cached data
    this._timeline = [];
    this._currencies = [];

    // Bound handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("completion:added", () => this._refresh()),
      eventBus.on("completion:approved", () => this._refresh()),
      eventBus.on("redemption:added", () => this._refresh()),
      eventBus.on("balances:changed", () => this._refresh()),
    );
    this._buildDOM();
    this._refresh();
  }

  disconnectedCallback() {
    this._unsubs.forEach(u => u());
    if (this._resizeObs) this._resizeObs.disconnect();
    this._removeListeners();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        :host { display: block; }
        .chart-wrap {
          position: relative;
          width: 100%;
          min-height: 260px;
        }
        canvas {
          width: 100%;
          height: 100%;
          display: block;
          cursor: grab;
          touch-action: none;
        }
        canvas.dragging { cursor: grabbing; }
        .tooltip {
          position: absolute;
          background: #1a1d2e;
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 0.72rem;
          color: var(--text);
          pointer-events: none;
          z-index: 10;
          white-space: nowrap;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .tooltip .tt-type { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; margin-bottom: 2px; }
        .tooltip .tt-label { font-weight: 600; margin-bottom: 2px; }
        .tooltip .tt-amount { font-size: 0.7rem; }
        .tooltip .tt-amount.positive { color: var(--success); }
        .tooltip .tt-amount.negative { color: var(--danger); }
        .tooltip .tt-date { font-size: 0.62rem; color: var(--muted); margin-top: 3px; }

        .chart-legend {
          display: flex;
          gap: 12px;
          margin-top: 8px;
          font-size: 0.65rem;
          color: var(--muted);
          justify-content: center;
          flex-wrap: wrap;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .legend-swatch {
          width: 10px;
          height: 3px;
          border-radius: 1px;
        }
        .legend-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
        }
        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: var(--muted);
          font-size: 0.85rem;
        }
        .zoom-hint {
          text-align: center;
          font-size: 0.6rem;
          color: var(--muted);
          margin-top: 4px;
        }
      </style>
      <div class="chart-wrap">
        <canvas></canvas>
      </div>
      <div class="chart-legend" id="legend"></div>
      <div class="zoom-hint">Scroll to zoom · Drag to pan</div>
    `;

    this._canvas = this.shadowRoot.querySelector("canvas");
    this._ctx = this._canvas.getContext("2d");

    this._addListeners();

    this._resizeObs = new ResizeObserver(() => this._draw());
    this._resizeObs.observe(this._canvas.parentElement);
  }

  _addListeners() {
    const c = this._canvas;
    c.addEventListener("mousedown", this._onMouseDown);
    c.addEventListener("mousemove", this._onMouseMove);
    c.addEventListener("mouseup", this._onMouseUp);
    c.addEventListener("mouseleave", this._onMouseLeave);
    c.addEventListener("wheel", this._onWheel, { passive: false });
    c.addEventListener("touchstart", this._onTouchStart, { passive: false });
    c.addEventListener("touchmove", this._onTouchMove, { passive: false });
    c.addEventListener("touchend", this._onTouchEnd);
  }

  _removeListeners() {
    if (!this._canvas) return;
    const c = this._canvas;
    c.removeEventListener("mousedown", this._onMouseDown);
    c.removeEventListener("mousemove", this._onMouseMove);
    c.removeEventListener("mouseup", this._onMouseUp);
    c.removeEventListener("mouseleave", this._onMouseLeave);
    c.removeEventListener("wheel", this._onWheel);
    c.removeEventListener("touchstart", this._onTouchStart);
    c.removeEventListener("touchmove", this._onTouchMove);
    c.removeEventListener("touchend", this._onTouchEnd);
  }

  _refresh() {
    const user = tracker.getCurrentUser();
    if (!user) return;
    this._timeline = tracker.buildBalanceTimeline(user.id);
    this._currencies = trackerStore.currencies.data;

    // Default view: fit last 30 days or all data
    if (this._timeline.length > 0) {
      this._fitView();
    }
    this._draw();
    this._updateLegend();
  }

  _fitView() {
    this._scaleX = 1;
    this._offsetX = 0;
  }

  // --- Coordinate system ---
  // Data space: X = timestamp (ms), Y = balance value
  // Screen space: X/Y in CSS pixels on canvas

  _getDataBounds() {
    if (this._timeline.length === 0) {
      const now = Date.now();
      return { minT: now - 30 * 86400000, maxT: now, minV: 0, maxV: 10 };
    }

    const times = this._timeline.map(e => new Date(e.date).getTime());
    let minT = Math.min(...times);
    let maxT = Math.max(...times);

    // Add some padding
    const range = maxT - minT || 86400000;
    minT -= range * 0.05;
    maxT += range * 0.05;

    // Get all running balance values across all currencies
    let minV = 0, maxV = 0;
    for (const ev of this._timeline) {
      for (const val of Object.values(ev.runningBalance)) {
        if (val < minV) minV = val;
        if (val > maxV) maxV = val;
      }
    }
    const vRange = maxV - minV || 10;
    minV -= vRange * 0.1;
    maxV += vRange * 0.1;

    return { minT, maxT, minV, maxV };
  }

  _dataToScreen(t, v, bounds, rect) {
    const pad = { top: 20, right: 20, bottom: 35, left: 50 };
    const plotW = rect.width - pad.left - pad.right;
    const plotH = rect.height - pad.top - pad.bottom;

    const tRange = bounds.maxT - bounds.minT;
    const vRange = bounds.maxV - bounds.minV;

    const sx = pad.left + ((t - bounds.minT) / tRange) * plotW * this._scaleX + this._offsetX;
    const sy = pad.top + plotH - ((v - bounds.minV) / vRange) * plotH;

    return { x: sx, y: sy };
  }

  _screenToData(sx, sy, bounds, rect) {
    const pad = { top: 20, right: 20, bottom: 35, left: 50 };
    const plotW = rect.width - pad.left - pad.right;
    const plotH = rect.height - pad.top - pad.bottom;

    const tRange = bounds.maxT - bounds.minT;
    const vRange = bounds.maxV - bounds.minV;

    const t = bounds.minT + ((sx - pad.left - this._offsetX) / (plotW * this._scaleX)) * tRange;
    const v = bounds.minV + ((pad.top + plotH - sy) / plotH) * vRange;

    return { t, v };
  }

  _draw() {
    if (!this._canvas || !this._ctx) return;

    const wrap = this._canvas.parentElement;
    const cssW = wrap.clientWidth;
    const cssH = Math.max(wrap.clientHeight, 260);
    const dpr = this._dpr;

    this._canvas.width = cssW * dpr;
    this._canvas.height = cssH * dpr;
    this._canvas.style.height = cssH + "px";

    const ctx = this._ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const rect = { width: cssW, height: cssH };
    const bounds = this._getDataBounds();
    const pad = { top: 20, right: 20, bottom: 35, left: 50 };

    if (this._timeline.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No history data yet", cssW / 2, cssH / 2);
      return;
    }

    // --- Grid lines ---
    this._drawGrid(ctx, bounds, rect, pad);

    // --- Draw lines per currency ---
    const currencyColors = this._getCurrencyColors();
    const drawnCurrencies = new Set();

    for (const [currId, color] of Object.entries(currencyColors)) {
      // Build stepped line data
      const points = [];
      for (const ev of this._timeline) {
        const t = new Date(ev.date).getTime();
        const v = ev.runningBalance[currId] || 0;
        const pt = this._dataToScreen(t, v, bounds, rect);
        points.push({ ...pt, ev, t, v });
      }

      if (points.length === 0) continue;
      drawnCurrencies.add(currId);

      // Draw stepped line
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";

      // Start from zero at the first point's time
      const firstPt = this._dataToScreen(points[0].t, 0, bounds, rect);
      ctx.moveTo(firstPt.x, firstPt.y);

      let prevY = firstPt.y;
      for (const pt of points) {
        // Horizontal to new x, then vertical to new y (stepped)
        ctx.lineTo(pt.x, prevY);
        ctx.lineTo(pt.x, pt.y);
        prevY = pt.y;
      }
      // Extend to current time
      const nowPt = this._dataToScreen(Date.now(), points[points.length - 1].v, bounds, rect);
      ctx.lineTo(nowPt.x, prevY);

      ctx.stroke();

      // Draw fill under line
      ctx.lineTo(nowPt.x, this._dataToScreen(Date.now(), bounds.minV, bounds, rect).y);
      ctx.lineTo(firstPt.x, this._dataToScreen(points[0].t, bounds.minV, bounds, rect).y);
      ctx.closePath();
      ctx.fillStyle = color.replace("1)", "0.06)").replace("rgb", "rgba");
      ctx.fill();
    }

    // --- Draw event markers ---
    const markerPositions = [];
    for (const ev of this._timeline) {
      const t = new Date(ev.date).getTime();
      // Draw marker at the primary currency balance
      const primaryCurr = Object.keys(ev.deltas)[0];
      if (!primaryCurr) continue;
      const v = ev.runningBalance[primaryCurr] || 0;
      const pt = this._dataToScreen(t, v, bounds, rect);

      const markerColor = ev.type === "earned" ? "rgb(80, 250, 123)"
        : ev.type === "penalty" ? "rgb(255, 107, 129)"
        : ev.type === "purchase" ? "rgb(102, 217, 239)"
        : "rgb(241, 196, 15)";

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = markerColor;
      ctx.fill();
      ctx.strokeStyle = "#0d0e16";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      markerPositions.push({ x: pt.x, y: pt.y, ev });
    }

    this._markerPositions = markerPositions;

    // --- Draw tooltip ---
    if (this._tooltip) {
      this._drawTooltip(this._tooltip);
    }
  }

  _drawGrid(ctx, bounds, rect, pad) {
    const plotW = rect.width - pad.left - pad.right;
    const plotH = rect.height - pad.top - pad.bottom;

    // Y axis gridlines
    const vRange = bounds.maxV - bounds.minV;
    const yStep = this._niceStep(vRange, 5);

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "10px system-ui, sans-serif";

    for (let v = Math.ceil(bounds.minV / yStep) * yStep; v <= bounds.maxV; v += yStep) {
      const pt = this._dataToScreen(bounds.minT, v, bounds, rect);
      const y = pt.y;
      if (y < pad.top || y > rect.height - pad.bottom) continue;

      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(rect.width - pad.right, y);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillText(this._formatAxisVal(v), pad.left - 6, y);
    }

    // X axis date labels
    const tRange = bounds.maxT - bounds.minT;
    const visibleRange = tRange / this._scaleX;

    let labelFormat, tStep;
    if (visibleRange < 2 * 86400000) {
      // Less than 2 days: show hours
      tStep = this._niceTimeStep(visibleRange, 6);
      labelFormat = "hour";
    } else if (visibleRange < 60 * 86400000) {
      // Less than 60 days: show days
      tStep = this._niceTimeStep(visibleRange, 8);
      labelFormat = "day";
    } else {
      // Show months
      tStep = this._niceTimeStep(visibleRange, 6);
      labelFormat = "month";
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const startT = Math.ceil(bounds.minT / tStep) * tStep;
    for (let t = startT; t <= bounds.maxT; t += tStep) {
      const pt = this._dataToScreen(t, bounds.minV, bounds, rect);
      if (pt.x < pad.left || pt.x > rect.width - pad.right) continue;

      ctx.beginPath();
      ctx.moveTo(pt.x, pad.top);
      ctx.lineTo(pt.x, rect.height - pad.bottom);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const d = new Date(t);
      let label;
      if (labelFormat === "hour") {
        label = d.toLocaleTimeString("default", { hour: "numeric", minute: "2-digit" });
      } else if (labelFormat === "day") {
        label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
      } else {
        label = d.toLocaleDateString("default", { month: "short", year: "2-digit" });
      }

      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillText(label, pt.x, rect.height - pad.bottom + 6);
    }
  }

  _niceStep(range, targetTicks) {
    const rough = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const res = rough / mag;
    if (res <= 1) return mag;
    if (res <= 2) return 2 * mag;
    if (res <= 5) return 5 * mag;
    return 10 * mag;
  }

  _niceTimeStep(rangeMs, targetTicks) {
    const steps = [
      3600000, 3600000 * 3, 3600000 * 6, 3600000 * 12,
      86400000, 86400000 * 2, 86400000 * 7, 86400000 * 14,
      86400000 * 30, 86400000 * 60, 86400000 * 90, 86400000 * 180, 86400000 * 365,
    ];
    const ideal = rangeMs / targetTicks;
    for (const s of steps) {
      if (s >= ideal) return s;
    }
    return steps[steps.length - 1];
  }

  _formatAxisVal(v) {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "k";
    if (v === Math.floor(v)) return String(v);
    return v.toFixed(1);
  }

  _getCurrencyColors() {
    const palette = [
      "rgba(102, 217, 239, 1)", "rgba(80, 250, 123, 1)", "rgba(255, 184, 108, 1)",
      "rgba(189, 147, 249, 1)", "rgba(255, 121, 198, 1)", "rgba(241, 196, 15, 1)",
    ];
    const colors = {};
    // Get currencies that appear in the timeline
    const seen = new Set();
    for (const ev of this._timeline) {
      for (const cid of Object.keys(ev.runningBalance)) seen.add(cid);
    }
    let i = 0;
    for (const cid of seen) {
      colors[cid] = palette[i % palette.length];
      i++;
    }
    return colors;
  }

  _updateLegend() {
    const legend = this.shadowRoot.getElementById("legend");
    if (!legend) return;
    const colors = this._getCurrencyColors();
    let html = "";

    // Currency lines
    for (const [cid, color] of Object.entries(colors)) {
      const c = tracker.getCurrency(cid);
      const name = c ? (c.symbol || c.name) : cid;
      html += `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span> ${name}</span>`;
    }

    // Event type dots
    html += `<span class="legend-item"><span class="legend-dot" style="background:rgb(80,250,123)"></span> Earned</span>`;
    html += `<span class="legend-item"><span class="legend-dot" style="background:rgb(255,107,129)"></span> Penalty</span>`;
    html += `<span class="legend-item"><span class="legend-dot" style="background:rgb(102,217,239)"></span> Purchase</span>`;
    html += `<span class="legend-item"><span class="legend-dot" style="background:rgb(241,196,15)"></span> Adjustment</span>`;

    legend.innerHTML = html;
  }

  _drawTooltip(tooltip) {
    // Remove existing tooltip DOM
    const existing = this.shadowRoot.querySelector(".tooltip");
    if (existing) existing.remove();

    if (!tooltip) return;

    const ev = tooltip.ev;
    const amtText = Object.entries(ev.deltas)
      .map(([cid, amt]) => tracker.formatAmount(amt, cid))
      .join(", ");
    const total = Object.values(ev.deltas).reduce((s, v) => s + v, 0);
    const date = new Date(ev.date).toLocaleString();

    const div = document.createElement("div");
    div.className = "tooltip";
    div.innerHTML = `
      <div class="tt-type">${ev.type}</div>
      <div class="tt-label">${ev.label}</div>
      <div class="tt-amount ${total >= 0 ? "positive" : "negative"}">${amtText || "\u2014"}</div>
      <div class="tt-date">${date}</div>
    `;

    // Position: above and to the right of the marker
    const wrap = this.shadowRoot.querySelector(".chart-wrap");
    const wrapRect = wrap.getBoundingClientRect();
    let left = tooltip.x + 10;
    let top = tooltip.y - 60;

    // Clamp to chart area
    if (left + 150 > wrapRect.width) left = tooltip.x - 160;
    if (top < 0) top = tooltip.y + 15;

    div.style.left = left + "px";
    div.style.top = top + "px";
    wrap.appendChild(div);
  }

  // --- Mouse handlers ---

  _onMouseDown(e) {
    this._dragging = true;
    this._dragStartX = e.clientX;
    this._dragStartOffset = this._offsetX;
    this._canvas.classList.add("dragging");
  }

  _onMouseMove(e) {
    if (this._dragging) {
      const dx = e.clientX - this._dragStartX;
      this._offsetX = this._dragStartOffset + dx;
      this._tooltip = null;
      this._draw();
      return;
    }

    // Hover detection
    if (!this._markerPositions) return;
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closest = null;
    let closestDist = 20; // max hover distance
    for (const mp of this._markerPositions) {
      const d = Math.sqrt((mp.x - mx) ** 2 + (mp.y - my) ** 2);
      if (d < closestDist) {
        closestDist = d;
        closest = mp;
      }
    }

    if (closest) {
      this._tooltip = { x: closest.x, y: closest.y, ev: closest.ev };
    } else {
      this._tooltip = null;
    }

    // Remove old tooltip and redraw if needed
    const existing = this.shadowRoot.querySelector(".tooltip");
    if (existing) existing.remove();
    if (this._tooltip) this._drawTooltip(this._tooltip);
  }

  _onMouseUp() {
    this._dragging = false;
    this._canvas.classList.remove("dragging");
  }

  _onMouseLeave() {
    this._dragging = false;
    this._canvas.classList.remove("dragging");
    this._tooltip = null;
    const existing = this.shadowRoot.querySelector(".tooltip");
    if (existing) existing.remove();
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(this._minScale, Math.min(this._maxScale, this._scaleX * zoomFactor));

    // Zoom centered on mouse position
    const ratio = newScale / this._scaleX;
    this._offsetX = mx - ratio * (mx - this._offsetX);
    this._scaleX = newScale;

    this._draw();
  }

  // --- Touch handlers ---

  _onTouchStart(e) {
    if (e.touches.length === 1) {
      e.preventDefault();
      this._dragging = true;
      this._dragStartX = e.touches[0].clientX;
      this._dragStartOffset = this._offsetX;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      this._dragging = false;
      this._pinchStartDist = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      this._pinchStartScale = this._scaleX;
      this._pinchStartOffset = this._offsetX;
      this._pinchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const rect = this._canvas.getBoundingClientRect();
      this._pinchCenterLocal = this._pinchCenterX - rect.left;
    }
  }

  _onTouchMove(e) {
    if (e.touches.length === 1 && this._dragging) {
      e.preventDefault();
      const dx = e.touches[0].clientX - this._dragStartX;
      this._offsetX = this._dragStartOffset + dx;
      this._draw();
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      const ratio = dist / (this._pinchStartDist || 1);
      const newScale = Math.max(this._minScale, Math.min(this._maxScale, this._pinchStartScale * ratio));

      const scaleRatio = newScale / this._pinchStartScale;
      this._offsetX = this._pinchCenterLocal - scaleRatio * (this._pinchCenterLocal - this._pinchStartOffset);
      this._scaleX = newScale;
      this._draw();
    }
  }

  _onTouchEnd(e) {
    if (e.touches.length < 2) {
      this._dragging = false;
    }
  }
}

customElements.define("ps-balance-chart", PsBalanceChart);
