/**
 * Barcoder 单文件入口（普通 script，支持 file:// 与本地服务器）
 */
(function () {
  "use strict";

  function t(key, params) {
    if (typeof BarcoderI18n !== "undefined" && BarcoderI18n.t) {
      return BarcoderI18n.t(key, params);
    }
    return key;
  }

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function hzToNoteName(hz) {
    if (!hz || hz < 20 || hz > 20000) return "—";
    const semitones = Math.round(12 * Math.log2(hz / 440));
    const note = NOTE_NAMES[((semitones % 12) + 12 + 9) % 12];
    const octave = 4 + Math.floor((semitones + 9) / 12);
    return note + octave;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  const BAR_COUNT = 8;
  const CANVAS_WIDTH = 900;
  const CANVAS_HEIGHT = 880;
  /** 语音转条码：最长音频（秒） */
  const AUDIO_BARCODE_MAX_SEC = 10;
  /** 语音转条码：每秒采样列数（时间细节，与列宽相乘得总长度） */
  const AUDIO_BARCODE_DEFAULT_CPS = 140;
  /** 每列像素宽度（打印/扫码枪扫过时的“条纹”宽度，越大越易匀速扫描） */
  const AUDIO_BARCODE_DEFAULT_COL_W = 6;
  /** 宽铺满后高度不超过视口此倍数时，整图缩放入一屏（避免短谱频繁抽拉） */
  const IMAGE_ONE_SCREEN_RATIO = 1.45;
  /** 导出 PNG 时的倍率（打印更清晰） */
  const BARCODE_EXPORT_SCALE = 4;
  /** 语音条码预览区高度（逻辑像素）；宽度按条码全长比例展开 */
  const AUDIO_BARCODE_VIEW_HEIGHT = 240;
  /** 语音条码内部渲染倍率（预览也使用，避免列平均糊成一片） */
  const AUDIO_BARCODE_RENDER_SCALE = 2;
  /** 绘制时条纹周期下限（像素），保证黑白各至少 1px */
  const BARCODE_MIN_PERIOD_PX = 2;
  /** A4 @ 96dpi（× BARCODE_EXPORT_SCALE ≈ 300dpi 打印） */
  const A4_PAGE_W = 794;
  const A4_PAGE_H = 1123;
  const A4_PAGE_MARGIN = 40;
  const A4_PAGE_FOOTER = 28;

  function pxSnap(v) {
    return Math.round(v);
  }

  function prepareBarcodeCtx(ctx) {
    ctx.imageSmoothingEnabled = false;
    if (typeof ctx.imageSmoothingQuality !== "undefined") ctx.imageSmoothingQuality = "low";
  }

  /** 曲线/放射纹等流线条码：抗锯齿平滑边缘 */
  function prepareSmoothBarcodeCtx(ctx) {
    ctx.imageSmoothingEnabled = true;
    if (typeof ctx.imageSmoothingQuality !== "undefined") ctx.imageSmoothingQuality = "high";
  }

  function glissCurveSteps(totalH, barW, exportScale) {
    const mul = Math.max(1, exportScale || 1);
    const base = Math.ceil(Math.max(totalH * 1.8, barW * 0.55));
    return clamp(base * mul, 96, 640);
  }

  function periodPxForDraw(period, minPx) {
    const floor = minPx != null ? minPx : BARCODE_MIN_PERIOD_PX;
    return Math.max(floor, pxSnap(period));
  }

  function downloadCanvasPng(canvas, filename) {
    const a = document.createElement("a");
    a.download = filename || "barcoder.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  }

  /** Processing Barcoder 式：沿线采样 → 移动平均 → 振镜正反拼接 → 播放 */
  function getLinePixels(x1, y1, x2, y2) {
    const pts = [];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const xi = dx / steps;
    const yi = dy / steps;
    for (let i = 0; i <= steps; i++) {
      pts.push({ x: x1 + xi * i, y: y1 + yi * i });
    }
    return pts;
  }

  function syncCanvasResolution(canvas, ctx, logW, logH) {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    if (cw <= 0) return canvas._barcoderScale || 1;
    const ch = canvas.clientHeight || Math.round(cw * (logH / logW));
    const scaleX = cw / logW;
    const scaleY = ch / logH;
    const scale = Math.min(Math.max(dpr, scaleX, scaleY), 4);
    const bw = Math.round(logW * scale);
    const bh = Math.round(logH * scale);
    if (canvas.width !== bw || canvas.height !== bh || canvas._barcoderScale !== scale) {
      canvas.width = bw;
      canvas.height = bh;
      canvas._barcoderScale = scale;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
    return scale;
  }

  function sampleLineBrightness(ctx, w, h, p1, p2) {
    const pw = ctx.canvas.width;
    const ph = ctx.canvas.height;
    const img = ctx.getImageData(0, 0, pw, ph).data;
    const sx = pw / w;
    const sy = ph / h;
    const pts = getLinePixels(p1.x * sx, p1.y * sy, p2.x * sx, p2.y * sy);
    const out = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const x = clamp(Math.floor(pts[i].x), 0, pw - 1);
      const y = clamp(Math.floor(pts[i].y), 0, ph - 1);
      const idx = (y * pw + x) * 4;
      const lum = (img[idx] + img[idx + 1] + img[idx + 2]) / (3 * 255);
      out[i] = lum * 2 - 1;
    }
    return out;
  }

  function samplePointBrightness(ctx, w, h, x, y) {
    const pw = ctx.canvas.width;
    const ph = ctx.canvas.height;
    const img = ctx.getImageData(0, 0, pw, ph).data;
    const sx = pw / w;
    const sy = ph / h;
    const px = clamp(Math.floor(x * sx), 0, pw - 1);
    const py = clamp(Math.floor(y * sy), 0, ph - 1);
    const idx = (py * pw + px) * 4;
    const lum = (img[idx] + img[idx + 1] + img[idx + 2]) / (3 * 255);
    return new Float32Array([lum * 2 - 1]);
  }

  function averageSmoothing(dat, windowSize, lerpRatio, useWindow, volume) {
    if (dat.length < 1) return new Float32Array(0);
    const ws = Math.floor(windowSize);
    if (ws <= 0) {
      const out = new Float32Array(dat.length);
      out.set(dat);
      if (useWindow && out.length > 1) {
        const n = out.length;
        for (let i = 0; i < n; i++) {
          out[i] *= 0.65 - 0.35 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
        }
      }
      if (volume !== 1) {
        for (let i = 0; i < out.length; i++) out[i] *= volume;
      }
      return out;
    }
    if (dat.length < 2) {
      const out = new Float32Array(dat.length);
      out.set(dat);
      if (volume !== 1) {
        for (let i = 0; i < out.length; i++) out[i] *= volume;
      }
      return out;
    }
    const win = Math.max(1, Math.min(ws, dat.length - 1));
    const out = new Float32Array(dat.length - win);
    let sum = 0;
    for (let i = 0; i < win; i++) sum += dat[i];
    let smoothed = sum / win;
    out[0] = smoothed;
    for (let i = 1; i < out.length; i++) {
      sum -= dat[i - 1];
      sum += dat[i + win - 1];
      smoothed += (sum / win - smoothed) * lerpRatio;
      out[i] = smoothed;
    }
    if (useWindow) {
      const n = out.length;
      for (let i = 0; i < n; i++) {
        out[i] *= 0.65 - 0.35 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
      }
    }
    if (volume !== 1) {
      for (let i = 0; i < out.length; i++) out[i] *= volume;
    }
    return out;
  }

  function removeDc(samples) {
    const out = new Float32Array(samples.length);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i];
    const mean = sum / samples.length;
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
    return out;
  }

  function signalStats(samples) {
    let min = Infinity;
    let max = -Infinity;
    let crossings = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (i > 0 && (samples[i - 1] >= 0) !== (v >= 0)) crossings++;
    }
    return { peak: max - min, crossings };
  }

  /** 纯白/纯黑等无条纹调制时不发声 */
  function isAudibleStripe(samples) {
    if (samples.length < 2) return false;
    const ac = removeDc(samples);
    const { peak, crossings } = signalStats(ac);
    return peak >= 0.1 && crossings >= 2;
  }

  function applyEdgeFade(samples, ratio) {
    const n = samples.length;
    if (n < 4) return samples;
    const fadeLen = Math.max(2, Math.floor(n * ratio));
    const out = new Float32Array(samples);
    out.set(samples);
    for (let i = 0; i < fadeLen; i++) {
      const g = (i + 1) / fadeLen;
      out[i] *= g;
      out[n - 1 - i] *= g;
    }
    return out;
  }

  function prepareBarcoderPlayback(samples) {
    if (samples.length < 2) return null;
    let ac = removeDc(samples);
    const { peak, crossings } = signalStats(ac);
    if (peak < 0.1 || crossings < 2) return null;
    let peakAbs = 0;
    for (let i = 0; i < ac.length; i++) peakAbs = Math.max(peakAbs, Math.abs(ac[i]));
    if (peakAbs > 1e-5) {
      const scale = 0.88 / peakAbs;
      for (let i = 0; i < ac.length; i++) ac[i] *= scale;
    }
    return applyEdgeFade(ac, 0.08);
  }

  function buildBarcoderSound(smoothed, mirrorSwing) {
    const n = smoothed.length;
    if (n === 0) return new Float32Array(0);
    if (n === 1) {
      const v = smoothed[0];
      if (Math.abs(v) < 0.05) return new Float32Array(0);
      return new Float32Array([v, -v, v, -v]);
    }
    if (!mirrorSwing) {
      const a = new Float32Array(n * 2);
      a.set(smoothed, 0);
      a.set(smoothed, n);
      return a;
    }
    const a = new Float32Array(n * 2);
    a.set(smoothed, 0);
    for (let i = 0; i < n; i++) a[n * 2 - 1 - i] = smoothed[i];
    return a;
  }

  function estimatePitchFromSamples(samples, sampleRate) {
    if (samples.length < 4) return 0;
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings++;
    }
    return (crossings / 2) * (sampleRate / samples.length);
  }

  /** Processing: sampleRate = frame_rate × scanWidth；f ≈ frame_rate × scanWidth / period */
  function barcoderPitchHz(mirrorFreq, scanSpan, period) {
    if (!period || period <= 0 || mirrorFreq <= 0) return 0;
    return (mirrorFreq * scanSpan) / period;
  }

  function resampleLinear(samples, outLen) {
    const out = new Float32Array(outLen);
    if (samples.length < 1 || outLen < 1) return out;
    if (samples.length === 1) {
      out.fill(samples[0]);
      return out;
    }
    for (let i = 0; i < outLen; i++) {
      const pos = (i / Math.max(1, outLen - 1)) * (samples.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const f = pos - i0;
      out[i] = samples[i0] * (1 - f) + samples[i1] * f;
    }
    return out;
  }

  /** 八条竖纹布局：随画布尺寸铺满演奏区（与方框模式相近留白比例） */
  function getVerticalBarsLayout(w, h) {
    const marginY = Math.round(h * 0.05);
    const labelCol = Math.round(w * 0.05);
    const marginX = Math.round(w * 0.05);
    const startX = labelCol + 28;
    const barW = Math.max(160, w - startX - marginX);
    const availH = h - marginY * 2;
    const gap = Math.max(8, Math.round(availH * 0.014));
    const barH = Math.max(48, Math.floor((availH - (BAR_COUNT - 1) * gap) / BAR_COUNT));
    return {
      barW,
      barH,
      startX,
      startY: marginY,
      gap,
      labelX: labelCol,
    };
  }

  class BarcoderSamplePlayer {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.fadeGain = null;
      this.source = null;
      this.ready = false;
      this.enabled = false;
    }

    init(ctx) {
      if (this.ready && this.ctx === ctx) return;
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.fadeGain = ctx.createGain();
      this.fadeGain.gain.value = 0;
      this.fadeGain.connect(this.master);
      this.master.connect(ctx.destination);
      this.ready = true;
    }

    setEnabled(on) {
      this.enabled = on;
      if (this.master) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
      if (!on) this.stop();
    }

    stop() {
      if (this.source) {
        try {
          this.source.stop();
        } catch (e) {}
        this.source.disconnect();
        this.source = null;
      }
      if (this.fadeGain && this.ctx) {
        this.fadeGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.fadeGain.gain.value = 0;
      }
    }

  /**
   * 按 Processing 的 targetSampleRate 播放；Web Audio 用设备采样率建 buffer 并重采样保音高。
   * targetSampleRate = frame_rate × scanWidth（可低于 8kHz，与 Minim 一致）。
   */
    play(samples, targetSampleRate) {
      if (!this.ready || !this.enabled) return;
      const prepared = prepareBarcoderPlayback(samples);
      if (!prepared || prepared.length < 2) return;

      const targetSr = Math.max(1, targetSampleRate);
      const ctxSr = this.ctx.sampleRate;
      const outLen = Math.max(2, Math.round((prepared.length * ctxSr) / targetSr));
      const t = this.ctx.currentTime;
      const fade = 0.004;

      if (this.source) {
        try {
          this.fadeGain.gain.cancelScheduledValues(t);
          this.fadeGain.gain.setTargetAtTime(0, t, fade);
          this.source.stop(t + fade + 0.005);
        } catch (e) {}
        this.source.disconnect();
        this.source = null;
      }

      try {
        const resampled = resampleLinear(prepared, outLen);
        const buf = this.ctx.createBuffer(1, outLen, ctxSr);
        buf.copyToChannel(resampled, 0);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.fadeGain);
        this.fadeGain.gain.cancelScheduledValues(t);
        this.fadeGain.gain.setValueAtTime(0, t);
        this.fadeGain.gain.linearRampToValueAtTime(1, t + fade);
        src.start(t);
        this.source = src;
      } catch (e) {
        console.warn("Barcoder: 播放失败", e);
      }
    }
  }

  function drawRectStripesV(ctx, dx, dy, w, h, period, duty, stripeNum, minPeriodPx, drawBorder) {
    prepareBarcodeCtx(ctx);
    dx = pxSnap(dx);
    dy = pxSnap(dy);
    w = pxSnap(w);
    h = pxSnap(h);
    const p = periodPxForDraw(period, minPeriodPx);
    const d = duty != null ? duty : 0.5;
    const bw = Math.max(1, pxSnap(p * d));
    const ww = Math.max(1, p - bw);
    let x = dx;
    const xEnd = dx + w;
    let i = 0;
    while (x < xEnd && i < stripeNum) {
      const blackW = Math.min(bw, xEnd - x);
      if (blackW > 0) {
        ctx.fillStyle = "#000";
        ctx.fillRect(pxSnap(x), dy, blackW, h);
      }
      x += blackW;
      if (x >= xEnd) break;
      const whiteW = Math.min(ww, xEnd - x);
      if (whiteW > 0) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(pxSnap(x), dy, whiteW, h);
      }
      x += whiteW;
      i++;
    }
    if (drawBorder !== false) {
      ctx.strokeStyle = "#bbb";
      ctx.lineWidth = 1;
      ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
    }
  }

  /** 与 drawRectStripesV 同周期的黑白条带（用于滑音扇形段） */
  function scoreStripeRuns(barW, period, duty) {
    const p = Math.max(SCORE_STRIPE_PERIOD_MIN, period);
    const d = duty != null ? duty : 0.5;
    const runs = [];
    let x = 0;
    while (x < barW) {
      const bw = p * d;
      const ww = p * (1 - d);
      const xBlackEnd = Math.min(x + bw, barW);
      if (xBlackEnd > x) runs.push({ x0: x, x1: xBlackEnd, black: true });
      const xWhiteEnd = Math.min(x + p, barW);
      if (xWhiteEnd > xBlackEnd) runs.push({ x0: xBlackEnd, x1: xWhiteEnd, black: false });
      x += p;
    }
    return runs;
  }

  function getGlissandoBoxGeom(w, h) {
    return {
      x: Math.round(w * 0.2),
      y: Math.round(h * 0.1),
      w: Math.round(w * 0.6),
      h: Math.round(h * 0.78),
      minPeriod: 6,
      maxPeriod: 72,
    };
  }

  /** 方框内竖纹：左密（高音）→ 右疏（低音），参考 twin fan 横向渐变 */
  function drawBoxGlissando(ctx, w, h, globalDensity) {
    prepareBarcodeCtx(ctx);
    const g = getGlissandoBoxGeom(w, h);
    const minP = Math.max(BARCODE_MIN_PERIOD_PX, g.minPeriod / globalDensity);
    const maxP = Math.max(minP + 6, g.maxPeriod / globalDensity);

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);

    let x = pxSnap(g.x);
    let black = true;
    const xEnd = g.x + g.w;
    while (x < xEnd) {
      const t = clamp((x - g.x) / g.w, 0, 1);
      const period = periodPxForDraw(minP + t * (maxP - minP));
      const bw = Math.max(1, pxSnap(period * 0.5));
      const ww = Math.max(1, period - bw);
      if (black) {
        ctx.fillStyle = "#000";
        ctx.fillRect(x, g.y, Math.min(bw, xEnd - x), g.h);
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, g.y, Math.min(ww, xEnd - x), g.h);
      }
      x += black ? bw : ww;
      black = !black;
    }

    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(g.x, g.y, g.w, g.h);
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.fillText(t("canvas.high"), g.x + 8, g.y + 18);
    ctx.fillText(t("canvas.low"), g.x + g.w - 22, g.y + 18);
  }

  function periodAtBoxX(x, w, h, globalDensity) {
    const g = getGlissandoBoxGeom(w, h);
    const t = clamp((x - g.x) / g.w, 0, 1);
    const minP = Math.max(3, g.minPeriod / globalDensity);
    const maxP = Math.max(minP + 6, g.maxPeriod / globalDensity);
    return minP + t * (maxP - minP);
  }

  function boxRadialApex(w, h) {
    const g = getGlissandoBoxGeom(w, h);
    return { g, ax: g.x, ay: g.y + g.h * 0.5 };
  }

  /** 左密右疏：左侧仍最密，但整体周期拉大便于扫描辨音 */
  function cyclesAtBoxRadial(px, w, h, globalDensity) {
    const g = getGlissandoBoxGeom(w, h);
    const t = clamp((px - g.x) / g.w, 0, 1);
    const d = Math.max(0.15, globalDensity);
    const minC = 0.1 + 0.38 * Math.pow(d, 0.6);
    const maxC = Math.max(0.02, 0.04 + 0.1 * Math.pow(d, 0.45));
    return minC + t * (maxC - minC);
  }

  function radialFanAngleRange(g, ax, ay) {
    const minA = Math.atan2(g.y - ay, 2);
    const maxA = Math.atan2(g.y + g.h - ay, 2);
    return { minA, maxA };
  }

  /** 自左中点扇形展开的直线射线角度表（左密右疏，角度铺满方框） */
  function buildRadialRayAngles(w, h, globalDensity) {
    const { g, ax, ay } = boxRadialApex(w, h);
    const { minA, maxA } = radialFanAngleRange(g, ax, ay);
    const d = Math.max(0.15, globalDensity);
    const slices = Math.max(120, Math.floor(64 + 100 * Math.pow(d, 0.75)));
    const weights = [];
    let total = 0;
    for (let s = 0; s < slices; s++) {
      const u = (s + 0.5) / slices;
      const theta = minA + u * (maxA - minA);
      const xHit = ax + Math.cos(theta) * g.w * 0.85;
      const dens = cyclesAtBoxRadial(xHit, w, h, globalDensity);
      weights.push(dens);
      total += dens;
    }
    const angles = [minA];
    let acc = 0;
    for (let s = 0; s < slices; s++) {
      acc += weights[s] / total;
      angles.push(minA + acc * (maxA - minA));
    }
    angles[angles.length - 1] = maxA;
    return { g, ax, ay, angles };
  }

  function periodAtBoxRadial(px, py, w, h, globalDensity) {
    const { ax, ay, angles } = buildRadialRayAngles(w, h, globalDensity);
    const theta = Math.atan2(py - ay, px - ax);
    const r = Math.max(6, Math.hypot(px - ax, py - ay));
    let i = 0;
    while (i < angles.length - 2 && angles[i + 1] < theta) i++;
    const dTheta = Math.max(angles[i + 1] - angles[i], 0.002);
    return Math.max(3, r * dTheta);
  }

  /** 方框内自左边中点：直线射线铺满方框（无上下三角留白） */
  function drawBoxRadialFan(ctx, w, h, globalDensity) {
    prepareSmoothBarcodeCtx(ctx);
    const { g, ax, ay, angles } = buildRadialRayAngles(w, h, globalDensity);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.x, g.y, g.w, g.h);
    ctx.clip();
    const rMax = Math.hypot(g.w, g.h) * 2;
    for (let i = 0; i < angles.length - 1; i++) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + Math.cos(angles[i]) * rMax, ay + Math.sin(angles[i]) * rMax);
      ctx.lineTo(ax + Math.cos(angles[i + 1]) * rMax, ay + Math.sin(angles[i + 1]) * rMax);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? "#000" : "#fff";
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(g.x, g.y, g.w, g.h);
    ctx.fillStyle = "#e00";
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.fillText(t("canvas.high"), g.x + 10, ay + 4);
    ctx.fillText(t("canvas.low"), g.x + g.w - 22, ay + 4);
  }

  function getAudioBarcodeViewPlan(img) {
    if (!img || !img.complete || img.width < 1 || img.height < 1) {
      return {
        logicalW: CANVAS_WIDTH,
        logicalH: AUDIO_BARCODE_VIEW_HEIGHT,
        scale: 1,
      };
    }
    const scale = AUDIO_BARCODE_VIEW_HEIGHT / img.height;
    return {
      logicalW: Math.max(1, Math.ceil(img.width * scale)),
      logicalH: AUDIO_BARCODE_VIEW_HEIGHT,
      scale,
    };
  }

  function drawAudioBarcodeImage(ctx, w, h, img) {
    prepareBarcodeCtx(ctx);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    if (img && img.complete) {
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
    }
  }

  function getImageDisplayPlan(w, h, img) {
    if (!img || !img.complete) {
      return { mode: "empty", scale: 1, drawH: 0, maxScroll: 0, scrollable: false };
    }
    const widthScale = w / img.width;
    const widthFitH = img.height * widthScale;
    if (widthFitH <= h) {
      return { mode: "width-fit", scale: widthScale, drawH: widthFitH, maxScroll: 0, scrollable: false };
    }
    if (widthFitH <= h * IMAGE_ONE_SCREEN_RATIO) {
      const fitScale = Math.min(w / img.width, h / img.height);
      const drawH = img.height * fitScale;
      return { mode: "screen-fit", scale: fitScale, drawH, maxScroll: 0, scrollable: false };
    }
    return {
      mode: "strip-scroll",
      scale: widthScale,
      drawH: widthFitH,
      maxScroll: widthFitH - h,
      scrollable: true,
    };
  }

  function drawScrollableImage(ctx, w, h, img, scrollY) {
    prepareBarcodeCtx(ctx);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    const plan = getImageDisplayPlan(w, h, img);
    if (plan.mode === "empty") return plan;
    const drawW = Math.round(img.width * plan.scale);
    const dx = Math.round((w - drawW) * 0.5);
    if (plan.mode === "width-fit" || plan.mode === "screen-fit") {
      const dy = Math.round((h - plan.drawH) * 0.5);
      ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, drawW, Math.round(plan.drawH));
      return plan;
    }
    const maxScroll = plan.maxScroll;
    scrollY = clamp(scrollY, 0, maxScroll);
    const sy = scrollY / plan.scale;
    const sh = h / plan.scale;
    ctx.drawImage(img, 0, sy, img.width, sh, 0, 0, w, h);
    return plan;
  }

  function imageStripMetrics(w, h, img) {
    const plan = getImageDisplayPlan(w, h, img);
    return { drawH: plan.drawH, maxScroll: plan.maxScroll, scrollable: plan.scrollable };
  }

  /** 单声道混合 */
  function mixAudioBufferToMono(audioBuffer) {
    const len = audioBuffer.length;
    const out = new Float32Array(len);
    const nCh = audioBuffer.numberOfChannels;
    for (let ch = 0; ch < nCh; ch++) {
      const src = audioBuffer.getChannelData(ch);
      for (let i = 0; i < len; i++) out[i] += src[i] / nCh;
    }
    return out;
  }

  /** 截取前 maxSec 秒 */
  function trimAudioBuffer(ctx, audioBuffer, maxSec) {
    if (audioBuffer.duration <= maxSec) return audioBuffer;
    const sr = audioBuffer.sampleRate;
    const len = Math.floor(maxSec * sr);
    const out = ctx.createBuffer(audioBuffer.numberOfChannels, len, sr);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      out.copyToChannel(audioBuffer.getChannelData(ch).subarray(0, len), ch);
    }
    return out;
  }

  /** 单列时间窗：峰值保瞬态 + RMS 保能量，避免均值把相邻列抹成同一灰度 */
  function sampleAudioColumn(mono, i0, i1) {
    if (i1 <= i0) return { env: 0, sign: 0 };
    let peak = 0;
    let peakVal = 0;
    let sumSq = 0;
    const n = i1 - i0;
    for (let i = i0; i < i1; i++) {
      const v = mono[i];
      const av = Math.abs(v);
      if (av > peak) {
        peak = av;
        peakVal = v;
      }
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / n);
    const env = peak * 0.8 + rms * 0.2;
    const sign = Math.abs(peakVal) > 1e-10 ? Math.sign(peakVal) : 0;
    return { env, sign };
  }

  function contrastStretchAudioColumns(envelopes) {
    const vals = [];
    for (let i = 0; i < envelopes.length; i++) {
      if (envelopes[i] > 1e-9) vals.push(envelopes[i]);
    }
    vals.sort((a, b) => a - b);
    const n = vals.length;
    if (n < 2) {
      const peak = n ? vals[0] : 1;
      return { floor: 0, span: Math.max(peak, 1e-8) };
    }
    const floor = vals[Math.min(n - 1, Math.floor(n * 0.025))];
    const ceil = vals[Math.min(n - 1, Math.floor(n * 0.985))];
    return { floor, span: Math.max(ceil - floor, 1e-8) };
  }

  /**
   * 语音波形 → 横向条码：先按 columnsPerSec 采样，再每列铺 columnWidthPx 像素宽竖条
   * options.columnMul / verticalScale 用于导出时加宽列、加高（打印更清晰）
   */
  function buildAudioWaveformBarcode(
    mono,
    sampleRate,
    durationSec,
    columnsPerSec,
    columnWidthPx,
    outHeight,
    options
  ) {
    options = options || {};
    const vScale = Math.max(1, options.verticalScale || 1);
    const colMul = Math.max(1, options.columnMul || 1);
    const cps = Math.max(20, columnsPerSec);
    const colW = Math.max(1, Math.round(columnWidthPx * colMul));
    const numCols = Math.max(1, Math.ceil(durationSec * cps));
    const width = numCols * colW;
    const height = Math.max(1, Math.round(outHeight * vScale));
    const envelopes = new Float32Array(numCols);
    const signs = new Float32Array(numCols);

    for (let c = 0; c < numCols; c++) {
      const t0 = (c / cps) * sampleRate;
      const t1 = ((c + 1) / cps) * sampleRate;
      const i0 = Math.max(0, Math.floor(t0));
      const i1 = Math.min(mono.length, Math.ceil(t1));
      const col = sampleAudioColumn(mono, i0, i1);
      envelopes[c] = col.env;
      signs[c] = col.sign;
    }

    const { floor, span } = contrastStretchAudioColumns(envelopes);
    const silenceCut = floor * 1.08;
    const gain = 1.08;

    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    prepareBarcodeCtx(ctx);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, width, height);

    for (let col = 0; col < numCols; col++) {
      let level = 0;
      if (envelopes[col] > silenceCut) {
        level = clamp(((envelopes[col] - floor) / span) * gain, 0, 1);
      }
      const signed = signs[col] * level;
      const gray = Math.round(clamp(signed * 0.5 + 0.5, 0, 1) * 255);
      ctx.fillStyle = "rgb(" + gray + "," + gray + "," + gray + ")";
      ctx.fillRect(col * colW, 0, colW, height);
    }
    c._audioBarcodeMeta = { cols: numCols, colW, cps, pxPerSec: cps * colW };
    return c;
  }

  function audioBarcodePxPerSec(cps, colW) {
    return Math.round(cps * colW);
  }

  function canvasToImage(canvas) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = canvas.toDataURL("image/png");
    });
  }

  function drawBassScene(ctx, w, h, barDensities, globalDensity, mode, customImage, imageScrollY) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    if (mode === "audio") {
      if (customImage && customImage.complete) {
        drawAudioBarcodeImage(ctx, w, h, customImage);
      } else {
        ctx.fillStyle = "#999";
        ctx.font = "16px sans-serif";
        ctx.fillText(t("canvas.pickAudio"), w * 0.22, h * 0.5);
      }
      return;
    }
    if (mode === "image") {
      if (customImage && customImage.complete) {
        drawScrollableImage(ctx, w, h, customImage, imageScrollY || 0);
      } else {
        ctx.fillStyle = "#999";
        ctx.font = "16px sans-serif";
        ctx.fillText(t("canvas.pickImage"), w * 0.22, h * 0.5);
      }
      return;
    }
    if (mode === "vertical") {
      prepareBarcodeCtx(ctx);
      const L = getVerticalBarsLayout(w, h);
      for (let i = 0; i < BAR_COUNT; i++) {
        const y0 = L.startY + i * (L.barH + L.gap);
        const d = barDensities[i] * globalDensity;
        const period = periodPxForDraw(clamp(100 / d, BARCODE_MIN_PERIOD_PX, 100));
        const stripeNum = clamp(Math.floor(L.barW / period) + 2, 3, 200);
        drawRectStripesV(ctx, L.startX, y0, L.barW, L.barH, period, 0.5, stripeNum, BARCODE_MIN_PERIOD_PX, false);
        ctx.fillStyle = "#666";
        ctx.font = "12px sans-serif";
        ctx.fillText(String(i + 1), L.labelX, y0 + L.barH * 0.5 + 4);
      }
    } else if (mode === "box-radial") {
      drawBoxRadialFan(ctx, w, h, globalDensity);
    } else {
      drawBoxGlissando(ctx, w, h, globalDensity);
    }
  }

  const NOTE_SEMITONE = {
    C: 0,
    "C#": 1,
    Db: 1,
    D: 2,
    "D#": 3,
    Eb: 3,
    E: 4,
    F: 5,
    "F#": 6,
    Gb: 6,
    G: 7,
    "G#": 8,
    Ab: 8,
    A: 9,
    "A#": 10,
    Bb: 10,
    B: 11,
  };

  /** 每个半音可选音名（黑键含升、降两种写法） */
  const CHROMATIC_SPELLINGS = [
    ["C"],
    ["C#", "Db"],
    ["D"],
    ["D#", "Eb"],
    ["E"],
    ["F"],
    ["F#", "Gb"],
    ["G"],
    ["G#", "Ab"],
    ["A"],
    ["A#", "Bb"],
    ["B"],
  ];

  function noteToHz(noteName, octave) {
    const semi = NOTE_SEMITONE[noteName];
    if (semi === undefined) return 440;
    const midi = (octave + 1) * 12 + semi;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** 解析 "C#4" / "Db4" / "B0" */
  function parsePitchToken(token) {
    const m = String(token).match(/^([A-G](?:#|b)?)(\d+)$/);
    if (!m) return null;
    const note = m[1];
    if (NOTE_SEMITONE[note] === undefined) return null;
    return { note, octave: parseInt(m[2], 10) };
  }

  const SCORE_BULK_REST = new Set(["-", "_", ".", "r", "rest", "休", "z", "x"]);

  /** 批量输入：支持 C4、缺省八度、休止符、C4+E4 合音、(C4 E4 G4) */
  function parseSinglePitchLoose(str) {
    const s = String(str).trim();
    if (!s) return null;
    const m = s.match(/^([A-Ga-g])(#|b)?(\d+)?$/);
    if (!m) return null;
    const note = m[1].toUpperCase() + (m[2] || "");
    if (NOTE_SEMITONE[note] === undefined) return null;
    const octave = m[3] != null ? parseInt(m[3], 10) : 4;
    if (octave < SCORE_OCTAVE_MIN || octave > SCORE_OCTAVE_MAX) return null;
    return { note, octave };
  }

  function tokenizeScoreBulkText(text) {
    const tokens = [];
    let i = 0;
    const s = String(text).trim();
    while (i < s.length) {
      while (i < s.length && /[\s,;|、\n\r]/.test(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === "(") {
        let depth = 1;
        let j = i + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") depth--;
          j++;
        }
        tokens.push(s.slice(i + 1, j - 1));
        i = j;
        continue;
      }
      let j = i;
      while (j < s.length && !/[\s,;|、\n\r(]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
    }
    return tokens;
  }

  function parseScoreBulkToken(raw) {
    const token = String(raw).trim();
    if (!token) return null;
    if (SCORE_BULK_REST.has(token.toLowerCase()) || token === "休") {
      return { rest: true };
    }
    if (/[+&]/.test(token)) {
      const parts = token.split(/[+&]/).filter(Boolean);
      const pitches = [];
      for (let p = 0; p < parts.length; p++) {
        const parsed = parseSinglePitchLoose(parts[p]);
        if (!parsed) return { error: token };
        pitches.push(parsed);
      }
      if (!pitches.length) return { error: token };
      return { pitches };
    }
    if (/[\s,]/.test(token)) {
      const parts = token.split(/[\s,]+/).filter(Boolean);
      const pitches = [];
      for (let p = 0; p < parts.length; p++) {
        const parsed = parseSinglePitchLoose(parts[p]);
        if (!parsed) return { error: token };
        pitches.push(parsed);
      }
      if (!pitches.length) return { error: token };
      return { pitches };
    }
    const single = parseSinglePitchLoose(token);
    if (single) return { pitches: [single] };
    return { error: token };
  }

  function parseScoreBulkText(text) {
    const tokens = tokenizeScoreBulkText(text);
    const entries = [];
    const errors = [];
    for (let t = 0; t < tokens.length; t++) {
      const r = parseScoreBulkToken(tokens[t]);
      if (!r) continue;
      if (r.error) errors.push(r.error);
      else if (r.rest) entries.push({ rest: true });
      else entries.push({ pitches: r.pitches });
    }
    return { entries, errors };
  }

  function scoreRowBulkParts(row) {
    if (row.rest) return [{ text: "-", voiceIndex: 0, sep: false }];
    const voices = getRowVoices(row);
    const parts = [];
    voices.forEach((v, i) => {
      if (i > 0) parts.push({ text: "+", voiceIndex: -1, sep: true });
      const name = v.note != null ? v.note + v.octave : "?";
      parts.push({ text: name, voiceIndex: i, sep: false });
    });
    return parts;
  }

  function scoreRowToBulkToken(row) {
    return scoreRowBulkParts(row)
      .map((p) => p.text)
      .join("");
  }

  function scoreRowsToBulkText(rows) {
    if (!rows.length) return "";
    return rows.map(scoreRowToBulkToken).join(" ");
  }

  function buildScoreRowFromBulkEntry(entry, lk) {
    if (entry.rest) {
      return {
        rest: true,
        label: t("score.rowRest"),
        hz: 0,
        period: 0,
        targetHz: 0,
        voices: [],
      };
    }
    const voices = entry.pitches.map((p) => buildScoreVoice(p.note, p.octave, lk));
    const row = {
      rest: false,
      kind: "stripes",
      voices,
      hz: voices[0].hz,
      period: voices[0].period,
      targetHz: voices[0].targetHz,
      chordWeave: voices.length > 1 ? 2 : 1,
    };
    row.label = scoreRowDisplayLabel(row);
    return row;
  }

  function midiNoteToPitch(midiNote) {
    if (midiNote < 0 || midiNote > 127) return null;
    const octave = Math.floor(midiNote / 12) - 1;
    if (octave < SCORE_OCTAVE_MIN || octave > SCORE_OCTAVE_MAX) return null;
    return { note: NOTE_NAMES[midiNote % 12], octave };
  }

  const SCORE_OCTAVE_MIN = 0;
  const SCORE_OCTAVE_MAX = 8;

  function populateScorePitchSelect(selectEl, includeRest) {
    if (!selectEl || selectEl.options.length > 1) return;
    selectEl.innerHTML = "";
    if (includeRest) {
      const restOpt = document.createElement("option");
      restOpt.value = "rest";
      restOpt.textContent = t("score.rest");
      selectEl.appendChild(restOpt);
    }
    for (let o = SCORE_OCTAVE_MIN; o <= SCORE_OCTAVE_MAX; o++) {
      const group = document.createElement("optgroup");
      group.label = t("score.octave", { n: o });
      for (let i = 0; i < CHROMATIC_SPELLINGS.length; i++) {
        for (const name of CHROMATIC_SPELLINGS[i]) {
          const opt = document.createElement("option");
          opt.value = name + o;
          opt.textContent = name + o;
          if (name === "C" && o === 4) opt.selected = true;
          group.appendChild(opt);
        }
      }
      selectEl.appendChild(group);
    }
  }

  const SCORE_STRIPE_PERIOD_MIN = 1;
  const SCORE_STRIPE_PERIOD_MAX = 120;

  function scorePitchRange(mirrorFreq, scanWidth) {
    const span = Math.max(scanWidth, 1);
    const m = Math.max(mirrorFreq, 1);
    const product = span * m;
    return {
      minHz: product / SCORE_STRIPE_PERIOD_MAX,
      maxHz: product / SCORE_STRIPE_PERIOD_MIN,
    };
  }

  function periodFromTargetHz(hz, mirrorFreq, scanWidth) {
    const span = Math.max(scanWidth, 1);
    const m = Math.max(mirrorFreq, 1);
    const ideal = (span * m) / Math.max(hz, 20);
    return clamp(ideal, SCORE_STRIPE_PERIOD_MIN, SCORE_STRIPE_PERIOD_MAX);
  }

  /** 乐谱竖纹：保留小数周期，与 f = mirrorFreq×scanWidth/period 一致 */
  function drawScoreRectStripesV(ctx, dx, dy, w, h, period, duty, stripeNum, minPeriodPx, drawBorder) {
    prepareBarcodeCtx(ctx);
    const p = Math.max(minPeriodPx != null ? minPeriodPx : SCORE_STRIPE_PERIOD_MIN, period);
    const d = duty != null ? duty : 0.5;
    for (let i = 0; i < stripeNum; i++) {
      const x0 = dx + p * i;
      if (x0 >= dx + w) break;
      const bw = p * d;
      const ww = p * (1 - d);
      ctx.fillStyle = "#000";
      ctx.fillRect(x0, dy, Math.min(bw, dx + w - x0), h);
      if (x0 + bw < dx + w) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x0 + bw, dy, Math.min(ww, dx + w - x0 - bw), h);
      }
    }
    if (drawBorder !== false) {
      ctx.strokeStyle = "#bbb";
      ctx.lineWidth = 1;
      ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
    }
  }

  function achievedHzFromPeriod(period, mirrorFreq, scanWidth) {
    return barcoderPitchHz(Math.max(mirrorFreq, 1), Math.max(scanWidth, 1), period);
  }

  /** 生日快乐 · 用户指定旋律（25 音） */
  const HAPPY_BIRTHDAY_SCORE = [
    ["G", 4],
    ["G", 4],
    ["A", 4],
    ["G", 4],
    ["C", 5],
    ["B", 4],
    ["G", 4],
    ["G", 4],
    ["A", 4],
    ["G", 4],
    ["D", 5],
    ["C", 5],
    ["G", 4],
    ["G", 4],
    ["G", 5],
    ["E", 5],
    ["C", 5],
    ["B", 4],
    ["A", 4],
    ["F", 5],
    ["F", 5],
    ["E", 5],
    ["C", 5],
    ["D", 5],
    ["C", 5],
  ];

  function scoreRowStep(L) {
    return L.rowH + L.rowGap;
  }

  function scoreTotalHeight(L, rowCount) {
    if (rowCount <= 0) return L.topPad;
    return L.topPad + rowCount * scoreRowStep(L);
  }

  function scoreRowDrawHeight(row, slotH) {
    if (!isGlissRow(row)) return slotH;
    return slotH * normalizeGliss(row).lengthMul;
  }

  function scoreRowYTop(L, rows, index) {
    let y = L.topPad;
    for (let i = 0; i < index; i++) {
      y += scoreRowDrawHeight(rows[i], L.rowH) + L.rowGap;
    }
    return y;
  }

  function scoreRowsTotalHeight(L, rows) {
    if (!rows.length) return L.topPad;
    let h = L.topPad;
    for (let i = 0; i < rows.length; i++) {
      h += scoreRowDrawHeight(rows[i], L.rowH);
      if (i < rows.length - 1) h += L.rowGap;
    }
    return h;
  }

  function scoreMaxScroll(L, rows, viewH) {
    const rowsArr = typeof rows === "number" ? null : rows;
    if (rowsArr) {
      return Math.max(0, scoreRowsTotalHeight(L, rowsArr) - viewH);
    }
    const rowCount = rows;
    return Math.max(0, L.topPad + rowCount * scoreRowStep(L) - viewH);
  }

  /** 加音后仅滚到刚好能看见新行 */
  function scoreScrollForRowCount(L, rows, viewH) {
    const rowCount = rows.length;
    if (rowCount <= 0) return 0;
    const maxScroll = scoreMaxScroll(L, rows, viewH);
    if (maxScroll <= 0) return 0;
    const lastTop = scoreRowYTop(L, rows, rowCount - 1);
    const lastH = scoreRowDrawHeight(rows[rowCount - 1], L.rowH);
    return clamp(lastTop + lastH + 8 - viewH, 0, maxScroll);
  }

  function chordWeaveCount(row) {
    const n = getRowVoices(row).length;
    if (n <= 1) return 1;
    return Math.max(1, Math.min(8, row.chordWeave || 1));
  }

  function chordTotalSegments(row) {
    const n = getRowVoices(row).length;
    if (n <= 1) return 1;
    return n * chordWeaveCount(row);
  }

  function chordVoiceIndexAtX(row, localX, stripW) {
    const voices = getRowVoices(row);
    const n = voices.length;
    if (n <= 1) return 0;
    const total = chordTotalSegments(row);
    const segW = stripW / total;
    const segIdx = clamp(Math.floor(localX / segW), 0, total - 1);
    return segIdx % n;
  }

  function normalizeGliss(row) {
    const g = row.gliss || row.radial;
    if (!g) return { dir: "lower", lengthMul: 1 };
    let lengthMul = 1;
    if (g.lengthMul != null) {
      lengthMul = clamp(g.lengthMul, 1, 4);
    } else if (g.heightFrac != null) {
      const hf = g.heightFrac;
      lengthMul = hf <= 1 ? clamp(1 + (1 - hf) * 2, 1, 4) : clamp(hf, 1, 4);
    }
    return {
      dir: g.dir === "higher" ? "higher" : "lower",
      lengthMul,
    };
  }

  /** 滑音总高度；100% = 与普通行同高 */
  function glissMetrics(slotH, gliss) {
    const g = typeof gliss.dir === "string" ? gliss : normalizeGliss({ gliss });
    const lengthMul = g.lengthMul;
    const totalH = slotH * lengthMul;
    return { gliss: g, lengthMul, totalH };
  }

  /** 0→1：顶段保持竖直，随后平滑弯向扇形（流线过渡） */
  function glissProgress(y, totalH) {
    const t = clamp(y / Math.max(totalH, 1), 0, 1);
    const bendStart = 0.14;
    if (t <= bendStart) return 0;
    const u = (t - bendStart) / (1 - bendStart);
    return u * u * (3 - 2 * u);
  }

  function glissCurveX(xt, y, totalH, cx, fan) {
    const s = glissProgress(y, totalH);
    const ff = 1 + s * (fan - 1);
    return cx + (xt - cx) * ff;
  }

  function glissFanAtY(y, totalH, pTop, gliss) {
    const pEnd = glissEndPeriod(pTop, gliss);
    const fan = glissFanScale(pTop, pEnd, gliss.dir);
    const ff = 1 + glissProgress(y, totalH) * (fan - 1);
    return clamp(pTop * ff, SCORE_STRIPE_PERIOD_MIN, SCORE_STRIPE_PERIOD_MAX);
  }

  /** 滑音末端周期；延伸越长（lengthMul 越大）音程幅度越大 */
  function glissEndPeriod(targetP, gliss) {
    const lengthMul = gliss.lengthMul != null ? gliss.lengthMul : 1;
    const sweep = 0.35 + (lengthMul - 1) * 1.6;
    if (gliss.dir === "lower") {
      return clamp(targetP * (1 + sweep), SCORE_STRIPE_PERIOD_MIN, SCORE_STRIPE_PERIOD_MAX);
    }
    return clamp(targetP / (1 + sweep), SCORE_STRIPE_PERIOD_MIN, targetP);
  }

  /** 扇形系数：<1 收拢，>1 扩散 */
  function glissFanScale(pTop, pEnd, dir) {
    const ratio = pEnd / pTop;
    if (dir === "lower") return clamp(ratio, 1, 4.5);
    return clamp(ratio, 0.18, 1);
  }

  function periodAtScoreGliss(localX, localY, row, barW, slotH) {
    const voice = getRowVoices(row)[0];
    if (!voice || !(voice.period > 0)) return 0;
    const { gliss, lengthMul, totalH } = glissMetrics(slotH, normalizeGliss(row));
    const pTop = voice.period;
    if (lengthMul <= 1) return pTop;
    return glissFanAtY(clamp(localY, 0, totalH), totalH, pTop, gliss);
  }

  /**
   * 每条纹从顶到底为一条流线：顶段与竖纹同周期同疏密，随后平滑弯向扩散/收拢。
   */
  function drawScoreGliss(ctx, x, y, barW, slotH, row, options) {
    options = options || {};
    const voice = getRowVoices(row)[0];
    if (!voice || !(voice.period > 0)) return;
    const { gliss, lengthMul, totalH } = glissMetrics(slotH, normalizeGliss(row));
    const pTop = voice.period;
    const stripeNum = clamp(Math.floor(barW / pTop) + 2, 3, 200);

    if (lengthMul <= 1) {
      drawScoreRectStripesV(ctx, x, y, barW, slotH, pTop, 0.5, stripeNum, SCORE_STRIPE_PERIOD_MIN, false);
      return;
    }

    prepareSmoothBarcodeCtx(ctx);
    const pEnd = glissEndPeriod(pTop, gliss);
    const fan = glissFanScale(pTop, pEnd, gliss.dir);
    const cx = barW * 0.5;
    const runs = scoreStripeRuns(barW, pTop, 0.5);
    const stepMul = options.forExport ? BARCODE_EXPORT_SCALE : 1;
    const steps = glissCurveSteps(totalH, barW, stepMul);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, barW, totalH);
    ctx.clip();

    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const xt0 = run.x0;
      const xt1 = run.x1;
      ctx.fillStyle = run.black ? "#000" : "#fff";
      ctx.beginPath();
      ctx.moveTo(x + xt0, y);
      ctx.lineTo(x + xt1, y);
      for (let s = 1; s <= steps; s++) {
        const ly = (s / steps) * totalH;
        ctx.lineTo(x + glissCurveX(xt1, ly, totalH, cx, fan), y + ly);
      }
      for (let s = steps - 1; s >= 0; s--) {
        const ly = (s / steps) * totalH;
        ctx.lineTo(x + glissCurveX(xt0, ly, totalH, cx, fan), y + ly);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawScoreStripesChord(ctx, x, y, barW, barH, row, voices) {
    prepareBarcodeCtx(ctx);
    const n = voices.length;
    const total = chordTotalSegments(row);
    const segW = barW / total;
    for (let s = 0; s < total; s++) {
      const v = voices[s % n];
      if (!v || !(v.period > 0)) continue;
      const sx = x + s * segW;
      const stripeNum = clamp(Math.floor(segW / v.period) + 2, 3, 200);
      drawScoreRectStripesV(ctx, sx, y, segW, barH, v.period, 0.5, stripeNum, SCORE_STRIPE_PERIOD_MIN, false);
    }
  }

  function buildScoreVoice(note, octave, lk) {
    const targetHz = noteToHz(note, octave);
    const period = periodFromTargetHz(targetHz, lk.mirrorFreq, lk.scanWidth);
    const hz = achievedHzFromPeriod(period, lk.mirrorFreq, lk.scanWidth);
    return { note, octave, hz, targetHz, period };
  }

  function getRowVoices(row) {
    if (!row || row.rest) return [];
    if (row.voices && row.voices.length > 0) return row.voices;
    return [
      {
        note: row.note,
        octave: row.octave,
        hz: row.hz,
        targetHz: row.targetHz,
        period: row.period,
      },
    ];
  }

  function isGlissRow(row) {
    return row.kind === "gliss" || row.kind === "radial";
  }

  function scoreRowDisplayLabel(row) {
    if (row.rest) return t("score.rowRest");
    let prefix = "";
    if (isGlissRow(row)) {
      const g = normalizeGliss(row);
      prefix = g.dir === "higher" ? "↑" : "↓";
    }
    const voices = getRowVoices(row);
    const body = voices
      .map((v) => {
        if (v.note == null) return row.label || "?";
        let s = v.note + v.octave;
        return s;
      })
      .join("+");
    const weave =
      voices.length > 1 && chordWeaveCount(row) > 1 ? "×" + chordWeaveCount(row) : "";
    return prefix + body + weave;
  }

  /** 左侧音名标签分段（便于按分音着色） */
  function scoreRowLabelSegments(row) {
    if (row.rest) return [{ text: t("score.rowRest"), voiceIndex: 0, meta: false }];
    const voices = getRowVoices(row);
    const segs = [];
    if (isGlissRow(row)) {
      const g = normalizeGliss(row);
      segs.push({ text: g.dir === "higher" ? "↑" : "↓", voiceIndex: -1, meta: true });
    }
    voices.forEach((v, i) => {
      if (i > 0) segs.push({ text: "+", voiceIndex: -1, meta: true });
      let s = v.note != null ? v.note + v.octave : "?";
      segs.push({ text: s, voiceIndex: i, meta: false });
    });
    const weave =
      voices.length > 1 && chordWeaveCount(row) > 1 ? "×" + chordWeaveCount(row) : "";
    if (weave) segs.push({ text: weave, voiceIndex: -1, meta: true });
    return segs;
  }

  function fillScoreRowLabel(ctx, row, x, y, highlight, pinVoiceIndex) {
    const segs = scoreRowLabelSegments(row);
    const labelColor = "#666";
    const pinNoteColor = "#d00";
    let cx = x;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      let color = labelColor;
      if (highlight === "pin") {
        if (seg.meta) color = labelColor;
        else if (row.rest) color = pinNoteColor;
        else if (pinVoiceIndex >= 0 && seg.voiceIndex === pinVoiceIndex) color = pinNoteColor;
        else if (pinVoiceIndex < 0 && seg.voiceIndex === 0) color = pinNoteColor;
      }
      ctx.fillStyle = color;
      ctx.fillText(seg.text, cx, y);
      cx += ctx.measureText(seg.text).width;
    }
  }

  function recalcScoreRow(row, lk) {
    if (row.rest) return;
    const voices = getRowVoices(row);
    voices.forEach((v) => {
      if (v.note == null) {
        const th = v.targetHz || v.hz || 440;
        v.period = periodFromTargetHz(th, lk.mirrorFreq, lk.scanWidth);
        v.hz = achievedHzFromPeriod(v.period, lk.mirrorFreq, lk.scanWidth);
        return;
      }
      const targetHz = noteToHz(v.note, v.octave);
      v.targetHz = targetHz;
      v.period = periodFromTargetHz(targetHz, lk.mirrorFreq, lk.scanWidth);
      v.hz = achievedHzFromPeriod(v.period, lk.mirrorFreq, lk.scanWidth);
    });
    row.voices = voices;
    row.label = scoreRowDisplayLabel(row);
    if (voices.length > 0) {
      row.hz = voices[0].hz;
      row.period = voices[0].period;
    }
  }

  function voiceAtStripX(row, localX, stripW) {
    const voices = getRowVoices(row);
    if (voices.length <= 1) return voices[0] || null;
    const idx = chordVoiceIndexAtX(row, localX, stripW);
    return voices[idx];
  }

  function periodAtScoreRowLocal(row, localX, localY, barW, slotH) {
    if (row.rest) return 0;
    if (isGlissRow(row)) return periodAtScoreGliss(localX, localY, row, barW, slotH);
    const voice = voiceAtStripX(row, localX, barW);
    return voice ? voice.period : 0;
  }

  function getScoreLayout(w, h, options) {
    options = options || {};
    const padX = options.withLabels === false ? 12 : 48;
    const topPad = 12;
    const rowH = 44;
    const rowGap = 2;
    const stripW = w - padX * 2;
    return { padX, topPad, rowH, rowGap, stripW };
  }

  function drawScoreRow(ctx, x, y, barW, slotH, row, highlight, options) {
    options = options || {};
    const voices = row.rest ? [] : getRowVoices(row);
    const n = Math.max(1, voices.length);
    const drawH = scoreRowDrawHeight(row, slotH);
    if (row.rest) {
      prepareBarcodeCtx(ctx);
      ctx.fillStyle = "#ececec";
      ctx.fillRect(pxSnap(x), pxSnap(y), pxSnap(barW), pxSnap(drawH));
    } else if (voices.length === 0) {
      prepareBarcodeCtx(ctx);
      ctx.fillStyle = "#fee";
      ctx.fillRect(pxSnap(x), pxSnap(y), pxSnap(barW), pxSnap(drawH));
    } else if (isGlissRow(row)) {
      drawScoreGliss(ctx, x, y, barW, slotH, row, options);
    } else if (n > 1) {
      drawScoreStripesChord(ctx, x, y, barW, drawH, row, voices);
    } else {
      prepareBarcodeCtx(ctx);
      const v = voices[0];
      if (v && v.period > 0) {
        const stripeNum = clamp(Math.floor(barW / v.period) + 2, 3, 200);
        drawScoreRectStripesV(ctx, x, y, barW, drawH, v.period, 0.5, stripeNum, SCORE_STRIPE_PERIOD_MIN, false);
      }
    }
    if (!options.forExport) {
      if (highlight === "pin") {
        ctx.strokeStyle = "#06c";
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, drawH - 1);
      } else if (highlight === "hover") {
        ctx.strokeStyle = "#e00";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, drawH - 1);
      } else {
        ctx.strokeStyle = "#bbb";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, drawH - 1);
      }
      ctx.fillStyle = "#666";
      ctx.font = n > 1 ? "10px sans-serif" : "11px sans-serif";
      const labelY = y + Math.min(drawH, slotH) * 0.65;
      const pinVi = highlight === "pin" ? (options.pinVoiceIndex != null ? options.pinVoiceIndex : 0) : -1;
      fillScoreRowLabel(ctx, row, x - 36, labelY, highlight, pinVi);
    } else if (options.withLabels) {
      ctx.fillStyle = "#444";
      ctx.font = n > 1 ? "10px sans-serif" : "11px sans-serif";
      ctx.fillText(scoreRowDisplayLabel(row), x - 36, y + Math.min(drawH, slotH) * 0.65);
    }
  }

  function drawScoreSheet(ctx, w, h, rows, scrollY, hoverIdx, pinIdx, pinVoiceIdx) {
    const L = getScoreLayout(w, h);
    const maxScroll = scoreMaxScroll(L, rows, h);
    scrollY = clamp(scrollY, 0, maxScroll);
    const pin = pinIdx >= 0 && pinIdx < rows.length ? pinIdx : -1;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    for (let i = 0; i < rows.length; i++) {
      const y = scoreRowYTop(L, rows, i) - scrollY;
      const rh = scoreRowDrawHeight(rows[i], L.rowH);
      if (y + rh < 0 || y > h) continue;
      const row = rows[i];
      let hl = false;
      if (i === pin) hl = "pin";
      else if (i === hoverIdx) hl = "hover";
      const rowOpts =
        hl === "pin" ? { pinVoiceIndex: pinVoiceIdx != null ? pinVoiceIdx : 0 } : {};
      drawScoreRow(ctx, L.padX, y, L.stripW, L.rowH, row, hl, rowOpts);
    }
    ctx.restore();
    if (rows.length === 0) {
      ctx.fillStyle = "#999";
      ctx.font = "15px sans-serif";
      ctx.fillText(t("canvas.emptyScore"), w * 0.36, h * 0.45);
    }
    if (rows.length > 0) {
      ctx.fillStyle = "#888";
      ctx.font = "11px sans-serif";
      if (scrollY > 2) ctx.fillText(t("canvas.scrollUp"), 8, 14);
      if (scrollY < maxScroll - 2) ctx.fillText(t("canvas.scrollDown"), w - 88, h - 8);
      if (pin >= 0) {
        ctx.fillStyle = "#06c";
        ctx.fillText(t("canvas.pinnedRow", { n: pin + 1 }), w - 130, 14);
      }
    }
    return scrollY;
  }

  function buildScoreRowHit(i, row, px, L) {
    if (row.rest) {
      return { globalIndex: i, row, voice: null, voiceIndex: 0 };
    }
    const localX = px - L.padX;
    const voices = getRowVoices(row);
    if (row.kind === "radial") row.kind = "gliss";
    if (isGlissRow(row)) {
      const v = voices[0] || null;
      return { globalIndex: i, row, voice: v, voiceIndex: 0 };
    }
    if (voices.length <= 1) {
      return { globalIndex: i, row, voice: voices[0] || null, voiceIndex: 0 };
    }
    const vIdx = chordVoiceIndexAtX(row, localX, L.stripW);
    return { globalIndex: i, row, voice: voices[vIdx], voiceIndex: vIdx };
  }

  /** 按行中心最近匹配，行间空隙也算入上一/下一行，避免缝隙处选中闪烁 */
  function hitTestScoreRow(px, py, w, h, rows, scrollY) {
    const L = getScoreLayout(w, h);
    if (rows.length === 0) return null;
    scrollY = clamp(scrollY, 0, scoreMaxScroll(L, rows, h));
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const y0 = scoreRowYTop(L, rows, i) - scrollY;
      const rh = scoreRowDrawHeight(rows[i], L.rowH);
      if (y0 + rh + L.rowGap < 0 || y0 > h) continue;
      const yMid = y0 + rh * 0.5;
      const reach = rh * 0.5 + L.rowGap;
      const d = Math.abs(py - yMid);
      if (d > reach) continue;
      if (d < bestDist - 0.01 || (Math.abs(d - bestDist) <= 0.01 && i < bestIdx)) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const hx = clamp(px, L.padX, L.padX + L.stripW - 1);
    return buildScoreRowHit(bestIdx, rows[bestIdx], hx, L);
  }

  function computeScorePageRanges(rows, L, contentH) {
    if (!rows.length) return [];
    const ranges = [];
    let start = 0;
    let y = L.topPad;
    for (let i = 0; i < rows.length; i++) {
      const rh = scoreRowDrawHeight(rows[i], L.rowH);
      const gap = i > start ? L.rowGap : 0;
      if (y + gap + rh > L.topPad + contentH && i > start) {
        ranges.push({ start, end: i });
        start = i;
        y = L.topPad;
      } else if (gap) {
        y += L.rowGap;
      }
      y += rh;
    }
    if (start < rows.length) ranges.push({ start, end: rows.length });
    return ranges;
  }

  function drawScoreExportRows(ctx, L, rows, options, startIdx, endIdx, yBase) {
    const pageOrigin = scoreRowYTop(L, rows, startIdx);
    const withLabels = options.withLabels !== false;
    for (let i = startIdx; i < endIdx; i++) {
      const y = scoreRowYTop(L, rows, i) - pageOrigin + yBase;
      drawScoreRow(ctx, L.padX, y, L.stripW, L.rowH, rows[i], false, {
        forExport: true,
        withLabels,
      });
    }
  }

  function downloadPngSequence(items) {
    items.forEach((item, i) => {
      setTimeout(() => downloadCanvasPng(item.canvas, item.filename), i * 400);
    });
  }

  function exportScoreSheetPng(rows, filename, options) {
    options = options || {};
    const withLabels = options.withLabels !== false;
    const scale = BARCODE_EXPORT_SCALE;
    const baseW = 900;
    const L = getScoreLayout(baseW, 880, { withLabels });
    const contentH = scoreRowsTotalHeight(L, rows) + 20;
    const baseH = Math.max(contentH, L.topPad + L.rowH + 20);
    const c = document.createElement("canvas");
    c.width = baseW * scale;
    c.height = baseH * scale;
    const ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, baseW, baseH);
    drawScoreExportRows(ctx, L, rows, options, 0, rows.length, L.topPad);
    downloadCanvasPng(c, filename || "barcoder-score.png");
  }

  function exportScoreSheetA4Png(rows, options) {
    options = options || {};
    const withLabels = options.withLabels !== false;
    const scale = BARCODE_EXPORT_SCALE;
    const baseW = A4_PAGE_W;
    const baseH = A4_PAGE_H;
    const L = getScoreLayout(baseW, baseH, { withLabels });
    const contentH = baseH - A4_PAGE_MARGIN * 2 - A4_PAGE_FOOTER;
    const ranges = computeScorePageRanges(rows, L, contentH);
    const labelTag = withLabels ? "labeled" : "barcode";
    const downloads = [];
    for (let p = 0; p < ranges.length; p++) {
      const { start, end } = ranges[p];
      const c = document.createElement("canvas");
      c.width = baseW * scale;
      c.height = baseH * scale;
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, baseW, baseH);
      drawScoreExportRows(ctx, L, rows, options, start, end, A4_PAGE_MARGIN);
      if (ranges.length > 1) {
        ctx.fillStyle = "#888";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(
          t("score.exportPage", { n: p + 1, total: ranges.length }),
          baseW - A4_PAGE_MARGIN,
          baseH - 12
        );
        ctx.textAlign = "left";
      }
      const num = String(p + 1).padStart(2, "0");
      downloads.push({
        canvas: c,
        filename: "barcoder-score-a4-" + labelTag + "-p" + num + ".png",
      });
    }
    downloadPngSequence(downloads);
  }

  function hitTestVerticalBar(w, h, px, py) {
    const L = getVerticalBarsLayout(w, h);
    for (let i = 0; i < BAR_COUNT; i++) {
      const y0 = L.startY + i * (L.barH + L.gap);
      if (px >= L.startX && px <= L.startX + L.barW && py >= y0 && py <= y0 + L.barH) return i;
    }
    return -1;
  }

  function snapRangeValue(val, min, max, step) {
    let v = clamp(val, min, max);
    if (step > 0) {
      v = Math.round(v / step) * step;
      const dec = (String(step).split(".")[1] || "").length;
      if (dec > 0) v = parseFloat(v.toFixed(dec));
      v = clamp(v, min, max);
    }
    return v;
  }

  function formatRangeStep(val, step) {
    const dec = (String(step).split(".")[1] || "").length;
    return dec > 0 ? val.toFixed(dec) : String(Math.round(val));
  }

  /** 滑块旁追加数字框，可键入精确数值；与滑块双向同步 */
  function attachRangeNumberEditor(rangeEl, options) {
    if (!rangeEl || rangeEl.dataset.numLinked === "1") return null;
    options = options || {};
    rangeEl.dataset.numLinked = "1";
    const min = parseFloat(rangeEl.min);
    const max = parseFloat(rangeEl.max);
    const step = parseFloat(rangeEl.step) || 1;
    const valEl =
      options.valEl || (options.valId ? document.getElementById(options.valId) : null);

    const num = document.createElement("input");
    num.type = "number";
    num.className = "range-num-input";
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = rangeEl.value;
    num.title = typeof BarcoderI18n !== "undefined" ? BarcoderI18n.t("ui.preciseValue") : "";
    num.setAttribute("aria-label", "精确数值");

    const row = document.createElement("div");
    row.className = "range-row";
    rangeEl.parentNode.insertBefore(row, rangeEl);
    row.appendChild(rangeEl);
    row.appendChild(num);

    const apply = (raw) => {
      const v = snapRangeValue(parseFloat(raw), min, max, step);
      rangeEl.value = String(v);
      num.value = String(v);
      const disp = options.formatDisplay
        ? options.formatDisplay(v)
        : formatRangeStep(v, step);
      if (valEl) valEl.textContent = disp;
      if (options.onChange) options.onChange(v);
      return v;
    };

    rangeEl.addEventListener("input", () => apply(rangeEl.value));
    num.addEventListener("change", () => apply(num.value));
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        apply(num.value);
        num.blur();
      }
    });

    rangeEl._barcoderNum = num;
    rangeEl._barcoderSetValue = apply;
    return { num, apply };
  }

  function setRangeControlValue(rangeId, value) {
    const el = document.getElementById(rangeId);
    if (!el) return;
    if (el._barcoderSetValue) el._barcoderSetValue(value);
    else {
      el.value = String(value);
      const valEl = document.getElementById(rangeId + "-val");
      if (valEl) valEl.textContent = String(value);
    }
  }

  class StripedBassMode {
    constructor(canvas, player) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this._canvasScale = 1;
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      this._onCanvasResize = () => this._syncCanvasResolution();
      window.addEventListener("resize", this._onCanvasResize);
      this.player = player;
      this.mirrorFreq = 22;
      this.scanWidth = 200;
      this.laserWidth = 2;
      this.lerpRatio = 0.5;
      this.mirrorSwing = true;
      this.barcodeWindow = true;
      this.autoVolume = true;
      this.globalDensity = 1;
      this.barDensities = [0.5, 1, 2, 4, 8, 12, 16, 24];
      this.barcodeType = "vertical";
      this.defaultScanAxis = "horizontal";
      this.scanLockMode = "follow";
      this.customImage = null;
      this.mouseX = CANVAS_WIDTH / 2;
      this.mouseY = CANVAS_HEIGHT / 2;
      this.prevMouseX = CANVAS_WIDTH / 2;
      this.prevMouseY = CANVAS_HEIGHT / 2;
      this.smoothVX = 0;
      this.smoothVY = 0;
      this.mouseDown = false;
      this.smoothing = 0.05;
      this.running = false;
      this.audioOn = true;
      this.frameAccum = 0;
      this.moveAccum = 0;
      this.lastPathSamples = 2;
      this.lastScanMouseX = null;
      this.lastScanMouseY = null;
      this.lastProfile = new Float32Array(0);
      this.scoreNotes = [];
      this.scoreScrollY = 0;
      this.scoreLocked = null;
      this.imageScrollY = 0;
      this.audioBarcodeBuffer = null;
      this.audioBarcodeMono = null;
      this.audioBarcodeCps = AUDIO_BARCODE_DEFAULT_CPS;
      this.audioBarcodeColW = AUDIO_BARCODE_DEFAULT_COL_W;
      this.audioBarcodeCanvas = null;
      this.audioBarcodeName = "";
      this.midiAccess = null;
      this.midiEnabled = false;
      this.midiInputId = "";
      this.midiActiveNotes = new Set();
      /** 当前一次按键手势内按下的音（全部抬起后写入一行；多音为合音） */
      this.midiChordNotes = new Set();
      this.scoreEditIndex = -1;
      this.scoreEditVoiceIndex = 0;
      this.scorePinIndex = -1;
      this.scorePinVoiceIndex = 0;
      this._scoreEditUiKey = "";
      this._scoreEditTextKey = "";
      this._scorePanelKey = "";
      this._scanRowHit = null;
      this._lastBarcodePreset = "vertical";
      this._bulkInputEditing = false;
      this._bindControls();
      this._bindAudioBarcodeControls();
      this._bindScoreControls();
      this._buildDensitySliders();
      this._bindCanvas();
      this._updateModePanels();
      this._updateScanLockUi();
    }

    _syncCanvasResolution() {
      const { w, h } = this._logicalCanvasSize();
      this._canvasScale = syncCanvasResolution(this.canvas, this.ctx, w, h);
    }

    _logicalCanvasSize() {
      if (
        this.barcodeType === "audio" &&
        this.customImage &&
        this.customImage.complete &&
        this.customImage.width > 0
      ) {
        const plan = getAudioBarcodeViewPlan(this.customImage);
        return { w: plan.logicalW, h: plan.logicalH };
      }
      return { w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
    }

    _bindControls() {
      const mirrorUnit = document.getElementById("bass-mirror-unit");
      attachRangeNumberEditor(document.getElementById("bass-mirror-freq"), {
        valId: "bass-mirror-val",
        formatDisplay: (v) => (v <= 0 ? t("scan.manual") : String(v)),
        onChange: (v) => {
          this.mirrorFreq = v;
          this.frameAccum = 0;
          this.moveAccum = 0;
          if (mirrorUnit) mirrorUnit.textContent = v <= 0 ? "" : "Hz";
        },
      });
      attachRangeNumberEditor(document.getElementById("bass-scan-width"), {
        valId: "bass-scan-width-val",
        onChange: (v) => {
          this.scanWidth = v;
          this.frameAccum = 0;
          this.moveAccum = 0;
        },
      });
      attachRangeNumberEditor(document.getElementById("bass-laser-width"), {
        valId: "bass-laser-width-val",
        onChange: (v) => {
          this.laserWidth = v;
          this.frameAccum = 0;
          this.moveAccum = 0;
        },
      });
      attachRangeNumberEditor(document.getElementById("bass-lerp"), {
        valId: "bass-lerp-val",
        onChange: (v) => (this.lerpRatio = v),
      });
      attachRangeNumberEditor(document.getElementById("bass-global-density"), {
        valId: "bass-density-val",
        formatDisplay: (v) => formatRangeStep(v, 0.05),
        onChange: (v) => (this.globalDensity = v),
      });
      document.getElementById("bass-mirror-swing").addEventListener("change", (e) => {
        this.mirrorSwing = e.target.checked;
      });
      document.getElementById("bass-barcode-window").addEventListener("change", (e) => {
        this.barcodeWindow = e.target.checked;
      });
      document.getElementById("bass-auto-volume").addEventListener("change", (e) => {
        this.autoVolume = e.target.checked;
      });
      document.querySelectorAll('input[name="bass-play-mode"]').forEach((r) => {
        r.addEventListener("change", () => {
          if (!r.checked) return;
          if (r.value === "score") this._setBarcodeType("score");
          else this._setBarcodeType(this._lastBarcodePreset || "vertical");
        });
      });
      document.querySelectorAll('input[name="bass-barcode-type"]').forEach((r) => {
        r.addEventListener("change", () => {
          if (!r.checked) return;
          this._setBarcodeType(r.value);
        });
      });
      document.querySelectorAll('input[name="bass-default-scan"]').forEach((r) => {
        r.addEventListener("change", () => {
          if (!r.checked) return;
          this.defaultScanAxis = r.value;
          this._updateStageLabel();
        });
      });
      document.querySelectorAll('input[name="bass-scan-lock"]').forEach((r) => {
        r.addEventListener("change", () => {
          if (!r.checked) return;
          this.scanLockMode = r.value;
          this._updateScanLockUi();
          this._updateStageLabel();
        });
      });
      const imgFile = document.getElementById("bass-image-file");
      if (imgFile) {
        imgFile.addEventListener("change", (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            this.customImage = img;
            this.imageScrollY = 0;
            this._setBarcodeType("image");
            const nameEl = document.getElementById("bass-image-name");
            if (nameEl) nameEl.textContent = t("bar.loaded", { name: file.name });
            this._updateStageLabel();
          };
          img.onerror = () => alert(t("bar.loadFail"));
          img.src = url;
        });
      }

      document.getElementById("bass-audio-on").addEventListener("change", (e) => {
        this.audioOn = e.target.checked;
        this._applyAudioGate();
        if (!this.audioOn) this.player.stop();
      });
    }

    _bindAudioBarcodeControls() {
      const fileEl = document.getElementById("bass-audio-file");
      if (fileEl) {
        fileEl.addEventListener("change", (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          this.audioBarcodeName = file.name;
          this._loadAudioForBarcode(file);
        });
      }
      attachRangeNumberEditor(document.getElementById("bass-audio-cps"), {
        valId: "bass-audio-cps-val",
        onChange: (v) => {
          this.audioBarcodeCps = v;
          if (this.audioBarcodeMono) this._renderAudioBarcode();
        },
      });
      attachRangeNumberEditor(document.getElementById("bass-audio-colw"), {
        valId: "bass-audio-colw-val",
        onChange: (v) => {
          this.audioBarcodeColW = v;
          if (this.audioBarcodeMono) this._renderAudioBarcode();
        },
      });
      const convertBtn = document.getElementById("bass-audio-convert");
      if (convertBtn) convertBtn.addEventListener("click", () => this._renderAudioBarcode());
      const exportBtn = document.getElementById("bass-audio-export");
      if (exportBtn) exportBtn.addEventListener("click", () => this._exportAudioBarcode());
    }

    async _getDecodeContext() {
      if (sharedCtx && sharedCtx.state !== "closed") {
        if (sharedCtx.state === "suspended") await sharedCtx.resume();
        return sharedCtx;
      }
      if (typeof window.__barcoderUnlock === "function") {
        return window.__barcoderUnlock();
      }
      throw new Error(t("bar.audioNeedUnlock"));
    }

    async _loadAudioForBarcode(file) {
      const status = document.getElementById("bass-audio-status");
      if (status) status.textContent = t("bar.audioDecoding");
      try {
        const ctx = await this._getDecodeContext();
        const arrayBuffer = await file.arrayBuffer();
        let audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        if (audioBuffer.duration > AUDIO_BARCODE_MAX_SEC) {
          audioBuffer = trimAudioBuffer(ctx, audioBuffer, AUDIO_BARCODE_MAX_SEC);
        }
        this.audioBarcodeBuffer = audioBuffer;
        this.audioBarcodeMono = mixAudioBufferToMono(audioBuffer);
        await this._renderAudioBarcode();
      } catch (err) {
        console.error(err);
        if (status) status.textContent = t("bar.audioFail", { msg: err.message || String(err) });
        alert(t("bar.audioFail", { msg: err.message || String(err) }));
      }
    }

    async _renderAudioBarcode() {
      if (!this.audioBarcodeBuffer || !this.audioBarcodeMono) {
        alert(t("bar.audioPickFirst"));
        return;
      }
      const status = document.getElementById("bass-audio-status");
      const dur = this.audioBarcodeBuffer.duration;
      const cps = this.audioBarcodeCps;
      const colW = this.audioBarcodeColW;
      const canvas = buildAudioWaveformBarcode(
        this.audioBarcodeMono,
        this.audioBarcodeBuffer.sampleRate,
        dur,
        cps,
        colW,
        CANVAS_HEIGHT,
        { verticalScale: AUDIO_BARCODE_RENDER_SCALE, columnMul: 1 }
      );
      this.audioBarcodeCanvas = canvas;
      const meta = canvas._audioBarcodeMeta || {};
      try {
        const img = await canvasToImage(canvas);
        this.customImage = img;
        this.imageScrollY = 0;
        this._setBarcodeType("audio");
        this._syncCanvasResolution();
        this._applyAudioBarcodeScanPreset();
        if (status) {
          status.textContent = t("bar.audioReady", {
            name: this.audioBarcodeName || "—",
            sec: dur.toFixed(2),
            cols: meta.cols || "—",
            colW: meta.colW || colW,
            px: canvas.width,
            pxps: meta.pxPerSec || audioBarcodePxPerSec(cps, colW),
          });
        }
        this._updateStageLabel();
      } catch (err) {
        console.error(err);
        if (status) status.textContent = t("bar.audioFail", { msg: err.message || String(err) });
      }
    }

    _exportAudioBarcode() {
      if (!this.audioBarcodeBuffer || !this.audioBarcodeMono) {
        alert(t("bar.audioExportEmpty"));
        return;
      }
      const cps = this.audioBarcodeCps;
      const colW = this.audioBarcodeColW;
      const canvas = buildAudioWaveformBarcode(
        this.audioBarcodeMono,
        this.audioBarcodeBuffer.sampleRate,
        this.audioBarcodeBuffer.duration,
        cps,
        colW,
        CANVAS_HEIGHT,
        {
          verticalScale: AUDIO_BARCODE_RENDER_SCALE * BARCODE_EXPORT_SCALE,
          columnMul: BARCODE_EXPORT_SCALE,
        }
      );
      const base = (this.audioBarcodeName || "barcode").replace(/\.[^.]+$/, "");
      downloadCanvasPng(canvas, base + "-waveform.png");
    }

    _applyAudioBarcodeScanPreset() {
      this.mirrorFreq = 0;
      this.scanWidth = 0;
      this.scanLockMode = "horizontal";
      setRangeControlValue("bass-mirror-freq", 0);
      setRangeControlValue("bass-scan-width", 0);
      const mfVal = document.getElementById("bass-mirror-val");
      if (mfVal) mfVal.textContent = t("scan.manual");
      const lockH = document.querySelector('input[name="bass-scan-lock"][value="horizontal"]');
      if (lockH) lockH.checked = true;
      this._updateScanLockUi();
    }

    _bindScoreControls() {
      populateScorePitchSelect(document.getElementById("score-pitch"), true);
      populateScorePitchSelect(document.getElementById("score-edit-pitch"), false);
      populateScorePitchSelect(document.getElementById("score-chord-pitch"), false);
      const add = document.getElementById("score-add-note");
      if (add) add.addEventListener("click", () => this._addScoreNote());
      const undo = document.getElementById("score-undo-note");
      if (undo) undo.addEventListener("click", () => this._undoScoreNote());
      const clear = document.getElementById("score-clear");
      if (clear) clear.addEventListener("click", () => this._clearScore());
      const exp = document.getElementById("score-export");
      if (exp) exp.addEventListener("click", () => this._exportScore());
      const bd = document.getElementById("score-load-birthday");
      if (bd) bd.addEventListener("click", () => this._loadHappyBirthday());
      const bulkGen = document.getElementById("score-bulk-generate");
      if (bulkGen) bulkGen.addEventListener("click", () => this._generateScoreFromBulk());
      const bulkInput = document.getElementById("score-bulk-input");
      if (bulkInput) {
        bulkInput.addEventListener("focus", () => {
          this._bulkInputEditing = true;
        });
        bulkInput.addEventListener("blur", () => {
          this._bulkInputEditing = false;
          this._syncBulkFromScore(true);
        });
      }
      const editApply = document.getElementById("score-edit-apply");
      if (editApply) editApply.addEventListener("click", () => this._applyScoreEditPitch());
      const chordAdd = document.getElementById("score-chord-add");
      if (chordAdd) chordAdd.addEventListener("click", () => this._addScoreChordVoice());
      const chordSingle = document.getElementById("score-chord-single");
      if (chordSingle) chordSingle.addEventListener("click", () => this._revertScoreRowSingle());
      const rowKind = document.getElementById("score-row-kind");
      if (rowKind) {
        rowKind.addEventListener("change", () => this._updateScoreAddKindUi());
      }
      attachRangeNumberEditor(document.getElementById("score-gliss-height"), {
        valId: "score-gliss-height-val",
      });
      attachRangeNumberEditor(document.getElementById("score-chord-weave"), {
        valId: "score-chord-weave-val",
        onChange: () => this._applyChordWeaveFromUi(),
      });
      const glissApply = document.getElementById("score-edit-kind-apply");
      if (glissApply) glissApply.addEventListener("click", () => this._applyScoreEditKind());
      const editKind = document.getElementById("score-edit-kind");
      if (editKind) editKind.addEventListener("change", () => this._updateScoreEditKindUi());
      attachRangeNumberEditor(document.getElementById("score-edit-gliss-height"), {
        valId: "score-edit-gliss-height-val",
      });
      this._updateScoreAddKindUi();
      const midiConnect = document.getElementById("score-midi-connect");
      if (midiConnect) midiConnect.addEventListener("click", () => this._requestMidiAccess());
      const midiEnable = document.getElementById("score-midi-enable");
      if (midiEnable) {
        midiEnable.addEventListener("change", (e) => {
          this.midiEnabled = e.target.checked;
          this._updateMidiStatus();
        });
      }
      const midiInput = document.getElementById("score-midi-input");
      if (midiInput) {
        midiInput.addEventListener("change", (e) => {
          this.midiInputId = e.target.value;
          this._bindMidiInput();
          this._updateMidiStatus();
        });
      }
    }

    _setBarcodeType(value) {
      const prev = this.barcodeType;
      if (value !== "score" && value !== prev) this._lastBarcodePreset = value;
      if (value === "score") {
        if (prev !== "score") this._enterScoreMode();
      } else if (prev === "score") {
        this._leaveScoreMode();
      }
      this.barcodeType = value;
      if (value !== "score") {
        const radio = document.querySelector('input[name="bass-barcode-type"][value="' + value + '"]');
        if (radio) radio.checked = true;
      }
      this._scoreEditUiKey = "";
      this.scoreEditIndex = -1;
      this._clearScoreRowPin();
      this._scorePanelKey = "";
      this._scoreEditTextKey = "";
      this._updateModePanels();
      this._syncScoreEditUi();
      if (value === "audio") this._applyAudioBarcodeScanPreset();
    }

    _enterScoreMode() {
      const mf = this.mirrorFreq > 0 ? this.mirrorFreq : 22;
      this.scoreLocked = {
        mirrorFreq: mf,
        scanWidth: this.scanWidth,
        laserWidth: this.laserWidth,
        lerpRatio: this.lerpRatio,
        mirrorSwing: this.mirrorSwing,
        barcodeWindow: this.barcodeWindow,
        autoVolume: this.autoVolume,
      };
      this._recalcAllScorePeriods();
      this._setControlsLocked(true);
      this._updateScoreSummary();
      this._updateStageLabel();
      this._updateMidiStatus();
    }

    _leaveScoreMode() {
      this._setControlsLocked(false);
      this.scoreLocked = null;
      this._updateStageLabel();
    }

    _setControlsLocked(locked) {
      const ids = [
        "bass-mirror-freq",
        "bass-scan-width",
        "bass-laser-width",
        "bass-lerp",
        "bass-global-density",
        "bass-mirror-swing",
        "bass-barcode-window",
        "bass-auto-volume",
      ];
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = locked;
          if (el._barcoderNum) el._barcoderNum.disabled = locked;
        }
      });
      this._updateScanLockUi();
    }

    _updateScanLockUi() {
      const idleOn = this.scanLockMode === "follow";
      const note = document.getElementById("bass-idle-scan-note");
      const wrap = document.getElementById("bass-idle-scan-wrap");
      if (note) note.classList.toggle("hidden", !idleOn);
      if (wrap) wrap.classList.toggle("hidden", !idleOn);
      document.querySelectorAll('input[name="bass-default-scan"]').forEach((el) => {
        el.disabled = !idleOn;
      });
    }

    _updateScoreSummary() {
      const el = document.getElementById("score-locked-summary");
      const info = document.getElementById("score-page-info");
      if (!this.scoreLocked) {
        this._syncBulkFromScore();
        return;
      }
      if (el) {
        const range = scorePitchRange(this.scoreLocked.mirrorFreq, this.scoreLocked.scanWidth);
        el.textContent = t("score.locked", {
          mf: this.scoreLocked.mirrorFreq,
          sw: this.scoreLocked.scanWidth,
          min: Math.round(range.minHz),
          max: Math.round(range.maxHz),
          nmin: hzToNoteName(range.minHz),
          nmax: hzToNoteName(range.maxHz),
        });
      }
      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      const L = getScoreLayout(w, h);
      const maxScroll = scoreMaxScroll(L, this.scoreNotes, h);
      let firstRow = -1;
      let lastRow = -1;
      for (let i = 0; i < this.scoreNotes.length; i++) {
        const y0 = scoreRowYTop(L, this.scoreNotes, i) - this.scoreScrollY;
        const rh = scoreRowDrawHeight(this.scoreNotes[i], L.rowH);
        if (y0 + rh < 0 || y0 > h) continue;
        if (firstRow < 0) firstRow = i;
        lastRow = i;
      }
      if (info) {
        if (this.scoreNotes.length === 0) {
          info.textContent = t("score.pageEmpty");
        } else if (firstRow < 0) {
          info.textContent = t("score.pageTotal", { n: this.scoreNotes.length });
        } else {
          info.textContent = t("score.pageView", {
            a: firstRow + 1,
            b: lastRow + 1,
            n: this.scoreNotes.length,
          });
        }
      }
      this._syncBulkFromScore();
    }

    _renderBulkSyncPanel() {
      const el = document.getElementById("score-bulk-sync");
      if (!el) return;
      el.replaceChildren();
      const pin = this.scorePinIndex;
      const pinVi = this.scorePinVoiceIndex;
      if (this.scoreNotes.length === 0) {
        el.textContent = "—";
        el.classList.add("score-bulk-sync--empty");
        return;
      }
      el.classList.remove("score-bulk-sync--empty");
      for (let i = 0; i < this.scoreNotes.length; i++) {
        if (i > 0) el.appendChild(document.createTextNode(" "));
        const row = this.scoreNotes[i];
        const parts = scoreRowBulkParts(row);
        const rowPinned = i === pin;
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          const span = document.createElement("span");
          span.className = "score-bulk-token";
          if (
            rowPinned &&
            !part.sep &&
            (row.rest || pinVi < 0 || part.voiceIndex === pinVi)
          ) {
            span.classList.add("score-bulk-token--pinned");
          }
          span.textContent = part.text;
          el.appendChild(span);
        }
      }
    }

    _syncBulkFromScore(forceText) {
      const input = document.getElementById("score-bulk-input");
      const editing = this._bulkInputEditing && document.activeElement === input;
      if (input && (forceText || !editing)) {
        input.value = scoreRowsToBulkText(this.scoreNotes);
      }
      this._renderBulkSyncPanel();
    }

    _updatePitchDisplay(pitch) {
      const fd = document.getElementById("bass-freq-display");
      const nd = document.getElementById("bass-note-display");
      if (fd) fd.textContent = pitch > 20 ? pitch.toFixed(0) : "—";
      if (nd) nd.textContent = pitch > 20 ? hzToNoteName(pitch) : "Hz";
    }

    _scoreHoverPitch(w, h) {
      const hit = hitTestScoreRow(
        this.mouseX,
        this.mouseY,
        w,
        h,
        this.scoreNotes,
        this.scoreScrollY
      );
      if (!hit || hit.row.rest) return 0;
      const lk = this.scoreLocked;
      if (!lk) return 0;
      const L = getScoreLayout(w, h);
      const localX = clamp(this.mouseX - L.padX, 0, Math.max(0, L.stripW - 1));
      const rowY = scoreRowYTop(L, this.scoreNotes, hit.globalIndex) - this.scoreScrollY;
      const localY = this.mouseY - rowY;
      const period = periodAtScoreRowLocal(hit.row, localX, localY, L.stripW, L.rowH);
      if (period > 0) {
        return barcoderPitchHz(lk.mirrorFreq, Math.max(lk.scanWidth, 1), period);
      }
      const v = hit.voice || getRowVoices(hit.row)[0];
      return v ? v.hz || v.targetHz || 0 : 0;
    }

    _clampScoreScroll() {
      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      const L = getScoreLayout(w, h);
      this.scoreScrollY = clamp(this.scoreScrollY, 0, scoreMaxScroll(L, this.scoreNotes, h));
    }

    _scrollScore(deltaY) {
      const step = scoreRowStep(getScoreLayout(CANVAS_WIDTH, CANVAS_HEIGHT));
      this.scoreScrollY += deltaY > 0 ? step : -step;
      this._clampScoreScroll();
      this._updateScoreSummary();
    }

    _imageStripMetrics() {
      return imageStripMetrics(CANVAS_WIDTH, CANVAS_HEIGHT, this.customImage);
    }

    _clampImageScroll() {
      const { maxScroll } = this._imageStripMetrics();
      this.imageScrollY = clamp(this.imageScrollY, 0, maxScroll);
    }

    _scrollImage(deltaY) {
      const step = 46;
      this.imageScrollY += deltaY > 0 ? step : -step;
      this._clampImageScroll();
    }

    _scrollImageKeys(dir) {
      const { scrollable } = this._imageStripMetrics();
      if (!scrollable) return;
      const step = 46;
      this.imageScrollY += dir > 0 ? step : -step;
      this._clampImageScroll();
    }

    _recalcAllScorePeriods() {
      if (!this.scoreLocked) return;
      const lk = this.scoreLocked;
      this.scoreNotes.forEach((row) => recalcScoreRow(row, lk));
    }

    _updateScoreAddKindUi() {
      const kind = document.getElementById("score-row-kind");
      const wrap = document.getElementById("score-gliss-add-wrap");
      const isGliss = kind && kind.value === "gliss";
      if (wrap) wrap.classList.toggle("hidden", !isGliss);
    }

    _readGlissAddOpts() {
      const dirEl = document.getElementById("score-gliss-dir");
      const heightEl = document.getElementById("score-gliss-height");
      return {
        dir: dirEl && dirEl.value === "higher" ? "higher" : "lower",
        lengthMul: heightEl ? parseInt(heightEl.value, 10) / 100 : 1,
      };
    }

    _pushScoreNoteRow(opts) {
      if (!this.scoreLocked) this._enterScoreMode();
      const lk = this.scoreLocked;
      if (opts.rest) {
        this.scoreNotes.push({
          rest: true,
          label: t("score.rowRest"),
          hz: 0,
          period: 0,
          targetHz: 0,
          voices: [],
        });
      } else {
        const voice = buildScoreVoice(opts.note, opts.octave, lk);
        const kind = opts.kind || "stripes";
        const row = {
          rest: false,
          kind,
          voices: [voice],
          hz: voice.hz,
          period: voice.period,
          targetHz: voice.targetHz,
          chordWeave: 1,
        };
        if (kind === "gliss") {
          row.gliss = opts.gliss || { dir: "lower", lengthMul: 1 };
        }
        row.label = scoreRowDisplayLabel(row);
        this.scoreNotes.push(row);
      }
      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      const L = getScoreLayout(w, h);
      this.scoreScrollY = scoreScrollForRowCount(L, this.scoreNotes, h);
      this._updateScoreSummary();
    }

    _addScoreNote() {
      const pitch = document.getElementById("score-pitch").value;
      if (pitch === "rest") {
        this._pushScoreNoteRow({ rest: true });
        return;
      }
      const parsed = parsePitchToken(pitch);
      if (!parsed) return;
      const kindEl = document.getElementById("score-row-kind");
      const kind = kindEl ? kindEl.value : "stripes";
      if (kind === "gliss") {
        const gliss = this._readGlissAddOpts();
        this._pushScoreNoteRow({ ...parsed, kind: "gliss", gliss });
      } else {
        this._pushScoreNoteRow({ ...parsed, kind: "stripes" });
      }
    }

    _scoreEditRowIndex() {
      if (this.scorePinIndex >= 0 && this.scorePinIndex < this.scoreNotes.length) {
        return this.scorePinIndex;
      }
      return this.scoreEditIndex;
    }

    _scoreEditVoiceIndexResolved() {
      if (this.scorePinIndex >= 0 && this.scorePinIndex < this.scoreNotes.length) {
        return this.scorePinVoiceIndex;
      }
      return this.scoreEditVoiceIndex;
    }

    _clearScoreRowPin() {
      this.scorePinIndex = -1;
      this.scorePinVoiceIndex = 0;
      this._renderBulkSyncPanel();
    }

    _toggleScoreRowPin() {
      if (this.barcodeType !== "score") return;
      if (this.scorePinIndex >= 0) {
        this._clearScoreRowPin();
        this._scoreEditUiKey = "";
        this._scorePanelKey = "";
        this._syncScoreEditUi();
        return;
      }
      const hit = this._scoreRowUnderMouse();
      if (!hit) return;
      this.scorePinIndex = hit.globalIndex;
      this.scorePinVoiceIndex = hit.voiceIndex;
      this.scoreEditIndex = hit.globalIndex;
      this.scoreEditVoiceIndex = hit.voiceIndex;
      this._scoreEditUiKey = "";
      this._scorePanelKey = "";
      this._syncScoreEditUi(hit);
      this._renderBulkSyncPanel();
    }

    _getScoreEditRow() {
      const idx = this._scoreEditRowIndex();
      if (idx < 0 || idx >= this.scoreNotes.length) return null;
      const row = this.scoreNotes[idx];
      if (row.rest) return null;
      return row;
    }

    _applyScoreEditPitch() {
      const row = this._getScoreEditRow();
      if (!row) {
        alert(t("alert.aimRow"));
        return;
      }
      if (!this.scoreLocked) this._enterScoreMode();
      const parsed = parsePitchToken(document.getElementById("score-edit-pitch").value);
      if (!parsed) return;
      const voices = getRowVoices(row);
      const vi = clamp(this._scoreEditVoiceIndexResolved(), 0, voices.length - 1);
      voices[vi] = buildScoreVoice(parsed.note, parsed.octave, this.scoreLocked);
      row.voices = voices;
      recalcScoreRow(row, this.scoreLocked);
      this._syncScoreEditUi();
    }

    _addScoreChordVoice() {
      const row = this._getScoreEditRow();
      if (!row) {
        alert(t("alert.aimRow"));
        return;
      }
      if (!this.scoreLocked) this._enterScoreMode();
      const voices = getRowVoices(row);
      if (voices.length >= 6) {
        alert(t("alert.chordMax"));
        return;
      }
      const parsed = parsePitchToken(document.getElementById("score-chord-pitch").value);
      if (!parsed) return;
      voices.push(buildScoreVoice(parsed.note, parsed.octave, this.scoreLocked));
      row.kind = "stripes";
      row.gliss = null;
      row.radial = null;
      if (!row.chordWeave) row.chordWeave = 1;
      row.voices = voices;
      recalcScoreRow(row, this.scoreLocked);
      this._syncScoreEditUi();
    }

    _revertScoreRowSingle() {
      const row = this._getScoreEditRow();
      if (!row) {
        alert(t("alert.aimRow"));
        return;
      }
      const voices = getRowVoices(row);
      if (voices.length <= 1) return;
      row.voices = [voices[0]];
      row.chordWeave = 1;
      recalcScoreRow(row, this.scoreLocked);
      this.scoreEditVoiceIndex = 0;
      if (this.scorePinIndex >= 0) this.scorePinVoiceIndex = 0;
      this._syncScoreEditUi();
    }

    _applyChordWeaveFromUi() {
      const row = this._getScoreEditRow();
      if (!row || isGlissRow(row)) return;
      const voices = getRowVoices(row);
      if (voices.length <= 1) return;
      const weaveEl = document.getElementById("score-chord-weave");
      if (!weaveEl) return;
      row.chordWeave = parseInt(weaveEl.value, 10) || 1;
      row.label = scoreRowDisplayLabel(row);
      this._scoreEditTextKey = "";
      this._syncScoreEditUi();
      this._renderBulkSyncPanel();
    }

    _readGlissEditOpts() {
      const dirEl = document.getElementById("score-edit-gliss-dir");
      const heightEl = document.getElementById("score-edit-gliss-height");
      return {
        dir: dirEl && dirEl.value === "higher" ? "higher" : "lower",
        lengthMul: heightEl ? parseInt(heightEl.value, 10) / 100 : 1,
      };
    }

    _updateScoreEditKindUi() {
      const kindEl = document.getElementById("score-edit-kind");
      const wrap = document.getElementById("score-edit-gliss-wrap");
      const isGliss = kindEl && kindEl.value === "gliss";
      if (wrap) wrap.classList.toggle("hidden", !isGliss);
    }

    _applyScoreEditKind() {
      const row = this._getScoreEditRow();
      if (!row || row.rest) {
        alert(t("alert.aimRow"));
        return;
      }
      const voices = getRowVoices(row);
      if (voices.length > 1) {
        alert(t("alert.glissSingleOnly"));
        return;
      }
      const kindEl = document.getElementById("score-edit-kind");
      const kind = kindEl ? kindEl.value : "stripes";
      if (kind === "gliss") {
        row.kind = "gliss";
        row.gliss = this._readGlissEditOpts();
        row.radial = null;
      } else {
        row.kind = "stripes";
        row.gliss = null;
        row.radial = null;
      }
      row.label = scoreRowDisplayLabel(row);
      this._scorePanelKey = "";
      this._scoreEditTextKey = "";
      this._syncScoreEditUi();
      this._renderBulkSyncPanel();
    }

    _applyGlissEditFromUi() {
      this._applyScoreEditKind();
    }

    _scoreRowToStripes() {
      const kindEl = document.getElementById("score-edit-kind");
      if (kindEl) kindEl.value = "stripes";
      this._updateScoreEditKindUi();
      this._applyScoreEditKind();
    }

    _updateScoreEditPanels(row) {
      const chordField = document.querySelector(".score-chord-field");
      const kindRow = document.getElementById("score-edit-kind-row");
      const kindActions = document.getElementById("score-edit-kind-actions");
      const kindEl = document.getElementById("score-edit-kind");
      const glissOpt = kindEl && kindEl.querySelector('option[value="gliss"]');
      const weaveEl = document.getElementById("score-chord-weave");
      const weaveVal = document.getElementById("score-chord-weave-val");
      const chordSingle = document.getElementById("score-chord-single");
      if (!row || row.rest) {
        if (chordField) chordField.classList.add("inactive");
        if (kindRow) kindRow.classList.add("hidden");
        if (kindActions) kindActions.classList.add("hidden");
        const glissWrap = document.getElementById("score-edit-gliss-wrap");
        if (glissWrap) glissWrap.classList.add("hidden");
        return;
      }
      const voices = getRowVoices(row);
      const isGliss = isGlissRow(row);
      const multi = voices.length > 1;
      if (kindRow) kindRow.classList.toggle("hidden", false);
      if (kindActions) kindActions.classList.toggle("hidden", false);
      if (glissOpt) glissOpt.disabled = multi;
      if (kindEl) {
        kindEl.value = isGliss ? "gliss" : "stripes";
        if (multi && isGliss) {
          row.kind = "stripes";
          row.gliss = null;
          row.radial = null;
          kindEl.value = "stripes";
        }
      }
      if (isGlissRow(row)) {
        const g = normalizeGliss(row);
        const dirEl = document.getElementById("score-edit-gliss-dir");
        const heightEl = document.getElementById("score-edit-gliss-height");
        if (dirEl) dirEl.value = g.dir;
        if (heightEl) {
          const pct = Math.round(g.lengthMul * 100);
          if (heightEl._barcoderSetValue) heightEl._barcoderSetValue(pct);
          else heightEl.value = String(pct);
        }
      }
      this._updateScoreEditKindUi();
      const canChord = !isGlissRow(row);
      if (chordField) chordField.classList.toggle("inactive", !canChord);
      if (weaveEl) {
        weaveEl.disabled = !multi || !canChord;
        if (weaveEl._barcoderNum) weaveEl._barcoderNum.disabled = weaveEl.disabled;
        if (multi && canChord) {
          const wv = chordWeaveCount(row);
          if (weaveEl._barcoderSetValue) weaveEl._barcoderSetValue(wv);
          else {
            weaveEl.value = String(wv);
            if (weaveVal) weaveVal.textContent = weaveEl.value;
          }
        }
      }
      if (chordSingle) chordSingle.disabled = !multi || !canChord;
    }

    _syncScoreEditUi(hit) {
      const targetEl = document.getElementById("score-edit-target");
      const voiceEl = document.getElementById("score-edit-voice-info");
      const editPitch = document.getElementById("score-edit-pitch");
      if (!targetEl) {
        this._syncBulkFromScore();
        return;
      }
      const idx = this._scoreEditRowIndex();
      const pinned = this.scorePinIndex >= 0;
      const row = idx >= 0 ? this.scoreNotes[idx] : null;
      const panelKey = row
        ? idx + ":" + row.kind + ":" + (row.rest ? "r" : getRowVoices(row).length)
        : "none";
      if (panelKey !== this._scorePanelKey) {
        this._scorePanelKey = panelKey;
        this._updateScoreEditPanels(row);
      }
      if (idx < 0) {
        targetEl.textContent = t("edit.aimPin");
        if (voiceEl) voiceEl.textContent = "";
        this._syncBulkFromScore();
        return;
      }
      if (row.rest) {
        targetEl.textContent = pinned
          ? t("edit.rowRestPin", { n: idx + 1 })
          : t("edit.rowRest", { n: idx + 1 });
        if (voiceEl) voiceEl.textContent = pinned ? t("edit.unpin") : "";
        this._syncBulkFromScore();
        return;
      }
      const voices = getRowVoices(row);
      const vi = clamp(this._scoreEditVoiceIndexResolved(), 0, voices.length - 1);
      const v = voices[vi];
      const textKey = idx + ":" + vi + ":" + scoreRowDisplayLabel(row) + ":" + pinned;
      if (textKey === this._scoreEditTextKey) {
        this._renderBulkSyncPanel();
        return;
      }
      this._scoreEditTextKey = textKey;
      targetEl.textContent = pinned
        ? t("edit.rowPin", { n: idx + 1, label: scoreRowDisplayLabel(row) })
        : t("edit.row", { n: idx + 1, label: scoreRowDisplayLabel(row) });
      if (voiceEl) {
        const parts = [];
        if (pinned) parts.push(t("edit.unpin"));
        else parts.push(t("edit.pin"));
        if (isGlissRow(row)) {
          const g = normalizeGliss(row);
          parts.push(
            g.dir === "lower" ? t("edit.glissLow") : t("edit.glissHigh"),
            t("edit.scanH")
          );
        } else if (voices.length > 1) {
          parts.push(t("edit.voice", { i: vi + 1, n: voices.length }));
          if (chordWeaveCount(row) > 1) {
            parts.push(t("edit.weave", { w: chordWeaveCount(row) }));
          }
        }
        voiceEl.textContent = parts.join(" · ");
      }
      if (editPitch && v && v.note != null) {
        editPitch.value = v.note + v.octave;
      }
      this._syncBulkFromScore();
    }

    async _requestMidiAccess() {
      if (!navigator.requestMIDIAccess) {
        alert(t("alert.midiUnsupported"));
        return;
      }
      try {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        this.midiAccess.onstatechange = () => this._refreshMidiInputs();
        this._refreshMidiInputs();
        const enable = document.getElementById("score-midi-enable");
        if (enable && !enable.checked) {
          enable.checked = true;
          this.midiEnabled = true;
        }
      } catch (err) {
        alert(t("alert.midiFail", { msg: err && err.message ? err.message : String(err) }));
        this._updateMidiStatus();
      }
    }

    _refreshMidiInputs() {
      const sel = document.getElementById("score-midi-input");
      if (!sel || !this.midiAccess) return;
      const prev = this.midiInputId;
      sel.innerHTML = "";
      if (this.midiAccess.inputs.size === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = t("score.midiNoDevice");
        sel.appendChild(opt);
        sel.disabled = true;
        this.midiInputId = "";
        this._updateMidiStatus();
        return;
      }
      this.midiAccess.inputs.forEach((input, id) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = input.name || id;
        sel.appendChild(opt);
      });
      sel.disabled = false;
      if (prev && this.midiAccess.inputs.has(prev)) {
        sel.value = prev;
        this.midiInputId = prev;
      } else {
        this.midiInputId = sel.options[0].value;
        sel.value = this.midiInputId;
      }
      this._bindMidiInput();
      this._updateMidiStatus();
    }

    _bindMidiInput() {
      if (!this.midiAccess) return;
      this.midiAccess.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      if (!this.midiInputId) return;
      const input = this.midiAccess.inputs.get(this.midiInputId);
      if (input) input.onmidimessage = (e) => this._onMidiMessage(e);
    }

    _onMidiMessage(e) {
      if (!this.midiEnabled || this.barcodeType !== "score") return;
      const data = e.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const note = data[1];
      const vel = data.length > 2 ? data[2] : 0;
      if (status === 0x90) {
        if (vel > 0) this._handleMidiNoteOn(note, vel);
        else this._handleMidiNoteOff(note);
      } else if (status === 0x80) {
        this._handleMidiNoteOff(note);
      }
    }

    _handleMidiNoteOn(note, vel) {
      if (this.midiActiveNotes.has(note)) return;
      this.midiActiveNotes.add(note);
      this.midiChordNotes.add(note);
      const pitch = midiNoteToPitch(note);
      if (pitch) {
        const sel = document.getElementById("score-pitch");
        if (sel) sel.value = pitch.note + pitch.octave;
      }
    }

    _handleMidiNoteOff(note) {
      this.midiActiveNotes.delete(note);
      if (this.midiActiveNotes.size === 0) this._commitMidiChordRow();
    }

    /** 一次手势的全部琴键抬起后：单音一行，多音合并为合音行 */
    _commitMidiChordRow() {
      if (this.midiChordNotes.size === 0) return;
      const midiNums = Array.from(this.midiChordNotes).sort((a, b) => a - b);
      this.midiChordNotes.clear();

      if (!this.scoreLocked) this._enterScoreMode();
      const lk = this.scoreLocked;
      const voices = [];
      for (let i = 0; i < midiNums.length && voices.length < 6; i++) {
        const pitch = midiNoteToPitch(midiNums[i]);
        if (pitch) voices.push(buildScoreVoice(pitch.note, pitch.octave, lk));
      }
      if (voices.length === 0) return;

      const row = {
        rest: false,
        kind: "stripes",
        voices,
        hz: voices[0].hz,
        period: voices[0].period,
        targetHz: voices[0].targetHz,
        chordWeave: voices.length > 1 ? 8 : 1,
      };
      row.label = scoreRowDisplayLabel(row);
      this.scoreNotes.push(row);

      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      const L = getScoreLayout(w, h);
      this.scoreScrollY = scoreScrollForRowCount(L, this.scoreNotes, h);
      this._updateScoreSummary();

      const sel = document.getElementById("score-pitch");
      const last = voices[voices.length - 1];
      if (sel && last.note != null) sel.value = last.note + last.octave;
    }

    _updateMidiStatus() {
      const el = document.getElementById("score-midi-status");
      if (!el) return;
      if (!navigator.requestMIDIAccess) {
        el.textContent = t("midi.unsupported");
        return;
      }
      if (!this.midiAccess) {
        el.textContent = t("midi.disconnected");
        return;
      }
      const input = this.midiInputId && this.midiAccess.inputs.get(this.midiInputId);
      const name = input ? input.name || this.midiInputId : t("midi.noDevice");
      const rec = this.midiEnabled ? t("midi.recording") : t("midi.connected");
      if (this.barcodeType !== "score") {
        el.textContent = name + " · " + rec + t("midi.needScore");
      } else {
        el.textContent = name + " · " + rec;
      }
    }

    _undoScoreNote() {
      this.scoreNotes.pop();
      this._clampScoreScroll();
      this._updateScoreSummary();
    }

    _deleteScoreRowAt(index) {
      if (index < 0 || index >= this.scoreNotes.length) return;
      if (index === this.scorePinIndex) this._clearScoreRowPin();
      else if (this.scorePinIndex > index) this.scorePinIndex--;
      this.scoreNotes.splice(index, 1);
      if (this.scoreEditIndex >= this.scoreNotes.length) this.scoreEditIndex = this.scoreNotes.length - 1;
      if (this.scoreEditIndex < 0) this.scoreEditIndex = -1;
      this._clampScoreScroll();
      this._updateScoreSummary();
      this._scoreEditUiKey = "";
      this._syncScoreEditUi();
    }

    _scoreRowUnderMouse() {
      if (this.barcodeType !== "score") return null;
      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      return hitTestScoreRow(this.mouseX, this.mouseY, w, h, this.scoreNotes, this.scoreScrollY);
    }

    _keydownTargetsFormField() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable;
    }

    _clearScore() {
      if (this.scoreNotes.length && !confirm(t("alert.clearConfirm"))) return;
      this.scoreNotes = [];
      this.scoreScrollY = 0;
      this._updateScoreSummary();
    }

    _loadHappyBirthday() {
      if (!this.scoreLocked) this._enterScoreMode();
      const lk = this.scoreLocked;
      this.scoreNotes = HAPPY_BIRTHDAY_SCORE.map(([n, o]) => {
        const voice = buildScoreVoice(n, o, lk);
        const row = {
          rest: false,
          kind: "stripes",
          voices: [voice],
          hz: voice.hz,
          period: voice.period,
          targetHz: voice.targetHz,
          chordWeave: 1,
        };
        row.label = scoreRowDisplayLabel(row);
        return row;
      });
      this.scoreScrollY = 0;
      this._updateScoreSummary();
      const bulkInput = document.getElementById("score-bulk-input");
      if (bulkInput) {
        bulkInput.value = HAPPY_BIRTHDAY_SCORE.map(([n, o]) => n + o).join(" ");
      }
    }

    _generateScoreFromBulk() {
      const input = document.getElementById("score-bulk-input");
      const status = document.getElementById("score-bulk-status");
      const text = input ? input.value.trim() : "";
      if (!text) {
        alert(t("score.bulkEmpty"));
        return;
      }
      const { entries, errors } = parseScoreBulkText(text);
      if (errors.length) {
        const msg = t("score.bulkErrors", {
          n: errors.length,
          detail: errors.slice(0, 4).join(", "),
        });
        if (status) status.textContent = msg;
        alert(msg);
        return;
      }
      if (!entries.length) {
        alert(t("score.bulkEmpty"));
        return;
      }
      const modeEl = document.querySelector('input[name="score-bulk-mode"]:checked');
      const append = modeEl && modeEl.value === "append";
      if (!append && this.scoreNotes.length && !confirm(t("score.bulkReplaceConfirm"))) return;
      if (!this.scoreLocked) this._enterScoreMode();
      const lk = this.scoreLocked;
      const newRows = entries.map((e) => buildScoreRowFromBulkEntry(e, lk));
      if (append) {
        this.scoreNotes.push(...newRows);
      } else {
        this.scoreNotes = newRows;
        this.scoreScrollY = 0;
      }
      const w = CANVAS_WIDTH;
      const h = CANVAS_HEIGHT;
      const L = getScoreLayout(w, h);
      this.scoreScrollY = scoreScrollForRowCount(L, this.scoreNotes, h);
      this._updateScoreSummary();
      if (status) status.textContent = t("score.bulkOk", { n: newRows.length });
    }

    _exportScore() {
      if (this.scoreNotes.length < 1) {
        alert(t("alert.exportEmpty"));
        return;
      }
      const picked = document.querySelector('input[name="score-export-labels"]:checked');
      const withLabels = !picked || picked.value === "with";
      const formatEl = document.querySelector('input[name="score-export-format"]:checked');
      const format = formatEl ? formatEl.value : "strip";
      const options = { withLabels };
      if (format === "a4") {
        exportScoreSheetA4Png(this.scoreNotes, options);
        return;
      }
      exportScoreSheetPng(this.scoreNotes, withLabels ? "barcoder-score-labeled.png" : "barcoder-score.png", options);
    }

    _updateStageLabel() {
      const el = document.querySelector(".scan-line-label");
      if (!el) return;
      if (this.barcodeType === "score") {
        el.textContent = t("hint.scanScore");
      } else if (this.barcodeType === "audio") {
        el.textContent = t("hint.scanAudio", {
          pxps: audioBarcodePxPerSec(this.audioBarcodeCps, this.audioBarcodeColW),
        });
      } else if (this.barcodeType === "image" && this._imageStripMetrics().scrollable) {
        el.textContent = t("hint.scanImage");
      } else {
        el.textContent = t("hint.scanDefault");
      }
    }

    _applyAudioGate() {
      this.player.setEnabled(this.audioOn);
    }

    _updateModePanels() {
      const v = this.barcodeType === "vertical";
      const box = this.barcodeType === "box";
      const fan = this.barcodeType === "box-radial";
      const img = this.barcodeType === "image";
      const audio = this.barcodeType === "audio";
      const score = this.barcodeType === "score";
      const panel = document.getElementById("panel-bass");
      if (panel) panel.classList.toggle("panel--score-mode", score);
      const playBarcode = document.querySelector('input[name="bass-play-mode"][value="barcode"]');
      const playScore = document.querySelector('input[name="bass-play-mode"][value="score"]');
      if (playBarcode) playBarcode.checked = !score;
      if (playScore) playScore.checked = score;
      const barcodePanel = document.getElementById("bass-barcode-panel");
      if (barcodePanel) barcodePanel.classList.toggle("hidden", score);
      document.getElementById("bass-per-bar-wrap").classList.toggle("hidden", !v);
      document.getElementById("bass-vertical-hint").classList.toggle("hidden", !v);
      document.getElementById("bass-box-hint").classList.toggle("hidden", !box);
      const fanHint = document.getElementById("bass-fan-hint");
      if (fanHint) fanHint.classList.toggle("hidden", !fan);
      const imgHint = document.getElementById("bass-image-hint");
      if (imgHint) imgHint.classList.toggle("hidden", !img);
      const audioHint = document.getElementById("bass-audio-hint");
      if (audioHint) audioHint.classList.toggle("hidden", !audio);
      const scoreHint = document.getElementById("bass-score-hint");
      if (scoreHint) scoreHint.classList.toggle("hidden", !score);
      const uploadWrap = document.getElementById("bass-image-upload-wrap");
      if (uploadWrap) uploadWrap.classList.toggle("hidden", !img);
      const audioWrap = document.getElementById("bass-audio-barcode-wrap");
      if (audioWrap) audioWrap.classList.toggle("hidden", !audio);
      const stageWrap = this.canvas && this.canvas.parentElement;
      if (stageWrap) stageWrap.classList.toggle("stage-wrap--audio-hscroll", audio);
      const densityWrap = document.getElementById("bass-density-wrap");
      if (densityWrap) densityWrap.classList.toggle("hidden", img || audio);
      const scorePanel = document.getElementById("bass-score-panel");
      if (scorePanel) scorePanel.classList.toggle("hidden", !score);
      this._updateMidiStatus();
      this._updateStageLabel();
    }

    _localPeriodAtMouse(w, h) {
      if (this.barcodeType === "score") {
        const hit =
          this.mouseDown && this._scanRowHit
            ? this._scanRowHit
            : hitTestScoreRow(this.mouseX, this.mouseY, w, h, this.scoreNotes, this.scoreScrollY);
        if (!hit || hit.row.rest) return 0;
        const L = getScoreLayout(w, h);
        const localX = this.mouseX - L.padX;
        const rowY = scoreRowYTop(L, this.scoreNotes, hit.globalIndex) - this.scoreScrollY;
        const localY = this.mouseY - rowY;
        return periodAtScoreRowLocal(hit.row, localX, localY, L.stripW, L.rowH);
      }
      if (this.barcodeType === "image" || this.barcodeType === "audio") return 0;
      if (this.barcodeType === "vertical") {
        const idx = hitTestVerticalBar(w, h, this.mouseX, this.mouseY);
        if (idx < 0) return 0;
        const d = this.barDensities[idx] * this.globalDensity;
        return clamp(100 / d, 5, 100);
      }
      if (this.barcodeType === "box") return periodAtBoxX(this.mouseX, w, h, this.globalDensity);
      if (this.barcodeType === "box-radial") {
        return periodAtBoxRadial(this.mouseX, this.mouseY, w, h, this.globalDensity);
      }
      return 0;
    }

    _scanSpan() {
      if (this.scanWidth > 0) return this.scanWidth;
      return Math.max(2, this.lastPathSamples);
    }

    /** 单点激光：沿自上次扫描以来的移动轨迹采样（光点拖曳成线） */
    _sampleScanRaw(w, h, mx, my, p1, p2) {
      if (this._scanSettings().scanWidth > 0) {
        return sampleLineBrightness(this.ctx, w, h, p1, p2);
      }
      const x0 = this.lastScanMouseX != null ? this.lastScanMouseX : mx;
      const y0 = this.lastScanMouseY != null ? this.lastScanMouseY : my;
      let raw = sampleLineBrightness(this.ctx, w, h, { x: x0, y: y0 }, { x: mx, y: my });
      if (raw.length < 2) {
        raw = samplePointBrightness(this.ctx, w, h, mx, my);
      }
      this.lastPathSamples = raw.length;
      this.lastScanMouseX = mx;
      this.lastScanMouseY = my;
      return raw;
    }

    _barcoderPitchHz(w, h, dt, sound, sampleRate) {
      const s = this._scanSettings();
      const period = this._localPeriodAtMouse(w, h);
      const span = s.scanWidth > 0 ? s.scanWidth : Math.max(2, this.lastPathSamples);
      if (period > 0 && s.mirrorFreq > 0) {
        return barcoderPitchHz(s.mirrorFreq, Math.max(span, 1), period);
      }
      if (period > 0 && s.mirrorFreq <= 0) {
        const speed =
          Math.hypot(this.mouseX - this.prevMouseX, this.mouseY - this.prevMouseY) / Math.max(dt, 1e-4);
        return speed / period;
      }
      return estimatePitchFromSamples(sound, sampleRate);
    }

    /** Processing: sampleRate = frame_rate × scanWidth（单点时用轨迹像素数代替线宽） */
    _scanSettings() {
      if (this.barcodeType === "score" && this.scoreLocked) {
        return {
          ...this.scoreLocked,
          scanLockMode: this.scanLockMode,
          defaultScanAxis: this.defaultScanAxis,
        };
      }
      return this;
    }

    _computeSampleRate(sound, dt) {
      const s = this._scanSettings();
      const span = s.scanWidth > 0 ? s.scanWidth : Math.max(2, this.lastPathSamples);
      if (s.mirrorFreq > 0) return s.mirrorFreq * span;
      const dur = Math.max(dt, 0.006);
      return Math.max(1, sound.length / dur);
    }

    _shouldTriggerScan(dt, mx, my) {
      if (!this.mouseDown || !this.audioOn) return false;
      if (this.mirrorFreq <= 0) {
        const dist = Math.hypot(mx - this.prevMouseX, my - this.prevMouseY);
        this.moveAccum += dist;
        const thr = this.scanWidth <= 0 ? 2 : Math.max(4, Math.min(this.scanWidth * 0.07, 28));
        if (this.moveAccum >= thr) {
          this.moveAccum = 0;
          return true;
        }
        return false;
      }
      this.frameAccum += dt;
      const framePeriod = 1 / this.mirrorFreq;
      if (this.frameAccum >= framePeriod) {
        this.frameAccum %= framePeriod;
        return true;
      }
      return false;
    }

    _buildDensitySliders() {
      const wrap = document.getElementById("bass-density-sliders");
      if (!wrap) return;
      wrap.innerHTML = "";
      for (let i = 0; i < BAR_COUNT; i++) {
        const label = document.createElement("label");
        label.innerHTML =
          t("bar.strip", { n: i + 1 }) +
          ' <span id="bar-d-' +
          i +
          '">' +
          this.barDensities[i].toFixed(1) +
          '</span>×<input type="range" min="0.5" max="40" step="0.5" value="' +
          this.barDensities[i] +
          '">';
        const input = label.querySelector('input[type="range"]');
        const idx = i;
        attachRangeNumberEditor(input, {
          valId: "bar-d-" + idx,
          formatDisplay: (v) => formatRangeStep(v, 0.5),
          onChange: (v) => {
            this.barDensities[idx] = v;
          },
        });
        wrap.appendChild(label);
      }
    }

    _canvasPos(e) {
      const rect = this.canvas.getBoundingClientRect();
      const { w, h } = this._logicalCanvasSize();
      const sx = w / rect.width;
      const sy = h / rect.height;
      return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    }

    _bindCanvas() {
      const down = (e) => {
        this.mouseDown = true;
        this.frameAccum = 0;
        this.moveAccum = 0;
        const p = this._canvasPos(e);
        this.mouseX = p.x;
        this.mouseY = p.y;
        this.prevMouseX = p.x;
        this.prevMouseY = p.y;
        this.lastScanMouseX = p.x;
        this.lastScanMouseY = p.y;
        if (this.barcodeType === "score") {
          const { w, h } = this._logicalCanvasSize();
          this._scanRowHit = hitTestScoreRow(
            p.x,
            p.y,
            w,
            h,
            this.scoreNotes,
            this.scoreScrollY
          );
        } else {
          this._scanRowHit = null;
        }
      };
      const up = () => {
        this.mouseDown = false;
        this.lastScanMouseX = null;
        this.lastScanMouseY = null;
        this._scanRowHit = null;
        this.player.stop();
      };
      this.canvas.addEventListener("mousedown", down);
      window.addEventListener("mouseup", up);
      this.canvas.addEventListener("mousemove", (e) => {
        const p = this._canvasPos(e);
        this.mouseX = p.x;
        this.mouseY = p.y;
      });
      this.canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (this.barcodeType === "score") {
            this._scrollScore(e.deltaY);
            return;
          }
          if (this.barcodeType === "image" && this._imageStripMetrics().scrollable) {
            this._scrollImage(e.deltaY);
            return;
          }
          this.scanWidth += e.deltaY > 0 ? -15 : 15;
          this.scanWidth = clamp(this.scanWidth, 0, 400);
          this.frameAccum = 0;
          this.moveAccum = 0;
          setRangeControlValue("bass-scan-width", this.scanWidth);
        },
        { passive: false }
      );
      window.addEventListener("keydown", (e) => {
        if (this.barcodeType === "score" && (e.key === "x" || e.key === "X")) {
          if (this._keydownTargetsFormField()) return;
          e.preventDefault();
          this._toggleScoreRowPin();
          return;
        }
        if (this.barcodeType === "score" && (e.key === "Delete" || e.key === "Backspace")) {
          if (this._keydownTargetsFormField()) return;
          const idx =
            this.scorePinIndex >= 0 ? this.scorePinIndex : (this._scoreRowUnderMouse() || {}).globalIndex;
          if (idx != null && idx >= 0) {
            e.preventDefault();
            this._deleteScoreRowAt(idx);
          }
          return;
        }
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        if (this.barcodeType !== "image" || !this._imageStripMetrics().scrollable) return;
        e.preventDefault();
        this._scrollImageKeys(e.key === "ArrowDown" ? 1 : -1);
      });
    }

    _scanEndpoints(w, h) {
      const mx = clamp(this.mouseX, 0, w - 1);
      const my = clamp(this.mouseY, 0, h - 1);
      let vx = mx - this.prevMouseX;
      let vy = my - this.prevMouseY;
      this.smoothVX += (vx - this.smoothVX) * this.smoothing;
      this.smoothVY += (vy - this.smoothVY) * this.smoothing;
      let dx = -this.smoothVY;
      let dy = this.smoothVX;
      const cfg = this._scanSettings();
      if (cfg.scanLockMode === "horizontal") {
        dx = 1;
        dy = 0;
      } else if (cfg.scanLockMode === "vertical") {
        dx = 0;
        dy = 1;
      } else {
        const len = Math.hypot(dx, dy);
        if (len < 0.5) {
          if (cfg.defaultScanAxis === "vertical") {
            dx = 0;
            dy = 1;
          } else {
            dx = 1;
            dy = 0;
          }
        } else {
          dx /= len;
          dy /= len;
        }
      }
      if (cfg.scanWidth <= 0) {
        return { p1: { x: mx, y: my }, p2: { x: mx, y: my }, mx, my };
      }
      const half = cfg.scanWidth / 2;
      return {
        p1: { x: clamp(mx - dx * half, 0, w - 1), y: clamp(my - dy * half, 0, h - 1) },
        p2: { x: clamp(mx + dx * half, 0, w - 1), y: clamp(my + dy * half, 0, h - 1) },
        mx,
        my,
      };
    }

    _processScanFrame(w, h) {
      const cfg = this._scanSettings();
      const { p1, p2, mx, my } = this._scanEndpoints(w, h);
      const raw = this._sampleScanRaw(w, h, mx, my, p1, p2);
      if (raw.length < 1) return null;
      const span = cfg.scanWidth > 0 ? cfg.scanWidth : Math.max(2, this.lastPathSamples);
      const vol = cfg.autoVolume ? 200 / span : 1;
      const smoothed = averageSmoothing(raw, cfg.laserWidth, cfg.lerpRatio, cfg.barcodeWindow, vol);
      if (smoothed.length < 1 || !isAudibleStripe(smoothed)) return null;
      const ac = removeDc(smoothed);
      const sound = buildBarcoderSound(ac, cfg.mirrorSwing);
      if (sound.length < 2) return null;
      return { sound, p1, p2, smoothed: ac };
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastTs = performance.now();
      this._loop();
    }

    stop() {
      this.running = false;
      this.player.stop();
    }

    _drawWaveform(smoothed, y0) {
      const ctx = this.ctx;
      const n = smoothed.length;
      if (n < 2) return;
      const baseY = y0;
      ctx.strokeStyle = "rgba(0,180,80,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = 40 + (i / n) * (CANVAS_WIDTH - 80);
        const y = baseY - smoothed[i] * 45;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    _loop() {
      if (!this.running) return;
      try {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastTs) / 1000);
        this.lastTs = now;
        this._syncCanvasResolution();
        const { w, h } = this._logicalCanvasSize();

        const { p1, p2, mx, my } = this._scanEndpoints(w, h);
        const cfg = this._scanSettings();
        if (this.barcodeType === "score") {
          const hit = hitTestScoreRow(mx, my, w, h, this.scoreNotes, this.scoreScrollY);
          const hoverIdx = hit ? hit.globalIndex : -1;
          if (this.scorePinIndex >= 0) {
            if (this.scorePinIndex >= this.scoreNotes.length) {
              this._clearScoreRowPin();
            } else {
              this.scoreEditIndex = this.scorePinIndex;
              this.scoreEditVoiceIndex = this.scorePinVoiceIndex;
            }
          } else if (hit && !this.mouseDown) {
            if (
              hit.globalIndex !== this.scoreEditIndex ||
              hit.voiceIndex !== this.scoreEditVoiceIndex
            ) {
              this.scoreEditIndex = hit.globalIndex;
              this.scoreEditVoiceIndex = hit.voiceIndex;
              const uiKey = this.scoreEditIndex + ":" + this.scoreEditVoiceIndex;
              if (uiKey !== this._scoreEditUiKey) {
                this._scoreEditUiKey = uiKey;
                this._syncScoreEditUi(hit);
              }
            }
          }
          const pinIdx = this.scorePinIndex;
          this.scoreScrollY = drawScoreSheet(
            this.ctx,
            w,
            h,
            this.scoreNotes,
            this.scoreScrollY,
            hoverIdx,
            pinIdx,
            this.scorePinVoiceIndex
          );
        } else {
          drawBassScene(
            this.ctx,
            w,
            h,
            this.barDensities,
            this.globalDensity,
            this.barcodeType,
            this.customImage,
            this.imageScrollY
          );
        }
        const span = cfg.scanWidth > 0 ? cfg.scanWidth : Math.max(2, this.lastPathSamples);
        const vol = cfg.autoVolume ? Math.min(1, (200 / span) * 0.04) : 1;
        if (cfg.scanWidth > 0) {
          this.ctx.strokeStyle = "rgba(255,0,0," + (0.4 + vol) + ")";
          this.ctx.lineWidth = Math.max(cfg.laserWidth, 1);
          this.ctx.beginPath();
          this.ctx.moveTo(p1.x, p1.y);
          this.ctx.lineTo(p2.x, p2.y);
          this.ctx.stroke();
        }
        this.ctx.fillStyle = "#e00";
        this.ctx.beginPath();
        this.ctx.arc(mx, my, cfg.scanWidth <= 0 ? 4 : 5, 0, Math.PI * 2);
        this.ctx.fill();

        if (this._shouldTriggerScan(dt, mx, my)) {
          const result = this._processScanFrame(w, h);
          if (result && result.sound.length >= 2) {
            const sampleRate = this._computeSampleRate(result.sound, dt);
            this.lastProfile = result.smoothed;
            this.player.play(result.sound, sampleRate);
            const pitch = this._barcoderPitchHz(w, h, dt, result.sound, sampleRate);
            this._updatePitchDisplay(pitch);
          } else if (this.mouseDown) {
            this.player.stop();
          }
        } else if (!this.mouseDown) {
          this.player.stop();
          this.moveAccum = 0;
          this.frameAccum = 0;
        }

        if (this.barcodeType === "score" && this.scoreLocked) {
          this._updatePitchDisplay(this._scoreHoverPitch(w, h));
        }

        this._drawWaveform(this.lastProfile, h - 40);
        this.prevMouseX = mx;
        this.prevMouseY = my;
      } catch (err) {
        console.error("Barcoder loop error:", err);
      }
      requestAnimationFrame(() => this._loop());
    }
  }

  let sharedCtx = null;
  let bassMode = null;
  const barcoderPlayer = new BarcoderSamplePlayer();

  function startEngines(ctx) {
    sharedCtx = ctx;
    barcoderPlayer.init(ctx);
    bassMode._applyAudioGate();
    bassMode.start();
  }

  function mountUnlock() {
    const overlay = document.getElementById("audio-unlock-overlay");
    const btn = document.getElementById("audio-unlock-btn");
    const status = document.getElementById("audio-unlock-status");

    if (!btn) {
      console.error("Barcoder: 找不到启动按钮");
      return;
    }

    async function doUnlock() {
      if (sharedCtx && sharedCtx.state === "running") {
        overlay.classList.add("hidden");
        return sharedCtx;
      }
      if (status) status.textContent = t("unlock.starting");
      btn.disabled = true;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error("浏览器不支持 Web Audio");
        const ctx = new Ctx();
        if (ctx.state === "suspended") await ctx.resume();
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        startEngines(ctx);
        if (status) status.textContent = t("unlock.ready");
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
        return ctx;
      } catch (e) {
        console.error(e);
        if (status) status.textContent = t("unlock.fail", { msg: e.message });
        btn.disabled = false;
        throw e;
      }
    }

    window.__barcoderUnlock = doUnlock;

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      doUnlock();
    });

  }

  function refreshPitchSelects() {
    const ids = ["score-pitch", "score-edit-pitch", "score-chord-pitch"];
    ids.forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prev = sel.value;
      const includeRest = id === "score-pitch";
      populateScorePitchSelect(sel, includeRest);
      if (prev) sel.value = prev;
    });
  }

  function onLocaleChange() {
    if (!bassMode) return;
    const canvas = bassMode.canvas;
    if (canvas) canvas.setAttribute("aria-label", t("canvas.stage"));
    refreshPitchSelects();
    bassMode._buildDensitySliders();
    bassMode._updateStageLabel();
    bassMode._updateScoreSummary();
    bassMode._updateMidiStatus();
    bassMode._syncScoreEditUi();
    const mirrorVal = document.getElementById("bass-mirror-val");
    if (mirrorVal && bassMode.mirrorFreq <= 0) mirrorVal.textContent = t("scan.manual");
  }

  function init() {
    if (typeof BarcoderI18n !== "undefined") {
      BarcoderI18n.onChange = onLocaleChange;
      BarcoderI18n.init();
    }
    const bassCanvas = document.getElementById("bass-canvas");
    if (!bassCanvas) {
      console.error("Barcoder: canvas not found");
      return;
    }
    bassMode = new StripedBassMode(bassCanvas, barcoderPlayer);
    mountUnlock();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
