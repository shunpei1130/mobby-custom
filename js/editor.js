export function createEditor({ canvas, templateSelect, assetGrid, templatePreviewImg }) {
  const ctx = canvas.getContext("2d");
  const DPR = Math.max(1, Math.floor(window.devicePixelRatio || 1));

  let templateImg = new Image();
  let templateUrl = "";
  const watermarkImg = new Image();
  watermarkImg.crossOrigin = "anonymous";
  try {
    watermarkImg.src = new URL("../assets/stickers/Logo.png", import.meta.url).href;
  } catch (e) {
    watermarkImg.src = "/assets/stickers/Logo.png";
  }

  function ensureWatermarkLoaded() {
    if (watermarkImg.complete && watermarkImg.naturalWidth) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      watermarkImg.onload = () => resolve(true);
      watermarkImg.onerror = () => resolve(false);
    });
  }
  let objects = []; // {type:'img'|'text'|'path', ...}
  let selectedId = null;
  let drag = null;
  let drawMode = "select";
  let objectEditEnabled = false;
  let drawing = null;
  let dragMoved = false;
  let rotateDrag = null;
  let scaleDrag = null;
  let erasing = null;
  let drawTool = "pen";
  let pinch = null;
  let viewDrag = null;
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  const MIN_VIEW_SCALE = 0.8;
  const MAX_VIEW_SCALE = 2.6;
  const VIEW_SCALE_SNAP = 0.03;
  const TEMPLATE_INSET_RATIO = 0.09;
  const DESIGN_INSET_RATIO = 0.08;
  const activePointers = new Map();
  const sampleSpacing = 2;
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 1.2;
  let history = [];
  let redoStack = [];
  let historyListener = null;
  let penOptions = {
    color: "#3a2f26",
    size: 6,
    effect: "none",
    effectColor: "#00f5ff",
    effectBlur: 18,
    strokeColor: "#000000",
    strokeWidth: 0
  };
  let eraserOptions = {
    size: 24
  };

  function applyEffect(ctx, effect, effectColor, effectBlur) {
    if (!effect || effect === "none") {
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      return;
    }
    const blur = Math.max(0, Number(effectBlur || 0));
    ctx.shadowColor = effectColor || "#000000";
    ctx.shadowBlur = blur;
    if (effect === "shadow") {
      const offset = Math.max(2, Math.round(blur * 0.15) || 2);
      ctx.shadowOffsetX = offset;
      ctx.shadowOffsetY = offset;
    } else {
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  }

  function normalizeEffectOptions(opts = {}) {
    return {
      effect: opts.effect || "none",
      effectColor: opts.effectColor || "#00f5ff",
      effectBlur: Number(opts.effectBlur || 0),
      strokeColor: opts.strokeColor || "#000000",
      strokeWidth: Number(opts.strokeWidth || 0)
    };
  }

  function cloneObjects(list) {
    return list.map((o) => {
      if (o.type === "img") {
        return { ...o, img: o.img };
      }
      if (o.type === "path") {
        return { ...o, points: o.points.map((p) => ({ x: p.x, y: p.y })) };
      }
      return { ...o };
    });
  }

  function snapshot() {
    return {
      objects: cloneObjects(objects),
      selectedId,
    };
  }

  function notifyHistory() {
    if (historyListener) historyListener({ canUndo: history.length > 1, canRedo: redoStack.length > 0 });
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 80) history.shift();
    redoStack = [];
    notifyHistory();
  }

  function restore(state) {
    objects = cloneObjects(state.objects);
    selectedId = state.selectedId;
    draw();
  }

  function fitCanvas() {
    const cssW = canvas.clientWidth || 900;
    const cssH = cssW;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.floor(cssW * DPR);
    canvas.height = Math.floor(cssH * DPR);
    clampViewOffset();
    syncTemplatePreviewTransform();
    draw();
  }

  function loadTemplate(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { templateImg = img; templateUrl = url || ""; draw(); resolve(); };
      img.onerror = reject;
      img.src = encodeURI(url);
    });
  }

  async function setState(state) {
    const next = state || {};
    const items = Array.isArray(next.objects) ? next.objects : [];
    viewScale = Number.isFinite(next.viewScale) ? clampViewScale(next.viewScale) : 1;
    viewOffsetX = Number.isFinite(next.viewOffsetX) ? next.viewOffsetX : 0;
    viewOffsetY = Number.isFinite(next.viewOffsetY) ? next.viewOffsetY : 0;
    clampViewOffset();
    syncTemplatePreviewTransform();
    const defaultCenter = getTemplateCenter();
    selectedId = null;
    objects = [];

    if (next.template && next.template !== templateUrl) {
      try {
        await loadTemplate(next.template);
      } catch (_) {
        // ignore: keep current template if load fails
      }
    }

    const imageLoads = items
      .filter((o) => o.type === "img" && (o.src || o.url))
      .map((o) => new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          objects.push({
            type: "img",
            id: o.id || crypto.randomUUID(),
            img,
            name: o.name || "",
            src: o.src || o.url,
            x: Number.isFinite(o.x) ? o.x : defaultCenter.x,
            y: Number.isFinite(o.y) ? o.y : defaultCenter.y,
            s: Number.isFinite(o.s) ? o.s : 0.35,
            r: Number.isFinite(o.r) ? o.r : 0,
            opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
            w: img.width,
            h: img.height
          });
          resolve();
        };
        img.onerror = () => resolve();
        img.src = encodeURI(o.src || o.url);
      }));

    for (const o of items) {
      if (o.type === "path") {
        objects.push({
          type: "path",
          id: o.id || crypto.randomUUID(),
          points: Array.isArray(o.points) ? o.points.map((p) => ({ x: p.x, y: p.y })) : [],
          color: o.color || "#000000",
          size: Number(o.size || 1),
          opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
          effect: o.effect || "none",
          effectColor: o.effectColor || "#00f5ff",
          effectBlur: Number(o.effectBlur || 0),
          strokeColor: o.strokeColor || "#000000",
          strokeWidth: Number(o.strokeWidth || 0)
        });
      } else if (o.type === "text") {
        objects.push({
          type: "text",
          id: o.id || crypto.randomUUID(),
          text: o.text || "",
          fontFamily: o.fontFamily || "Noto Sans JP",
          size: Number.isFinite(o.size) ? o.size : 36,
          color: o.color || "#ffffff",
          x: Number.isFinite(o.x) ? o.x : defaultCenter.x,
          y: Number.isFinite(o.y) ? o.y : defaultCenter.y,
          s: Number.isFinite(o.s) ? o.s : 1,
          r: Number.isFinite(o.r) ? o.r : 0,
          opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
          effect: o.effect || "none",
          effectColor: o.effectColor || "#00f5ff",
          effectBlur: Number(o.effectBlur || 0),
          strokeColor: o.strokeColor || "#000000",
          strokeWidth: Number(o.strokeWidth || 0)
        });
      }
    }

    if (imageLoads.length) {
      await Promise.all(imageLoads);
    }
    draw();
    history = [snapshot()];
    redoStack = [];
    notifyHistory();
  }

  function addAsset(assetUrl, name) {
    const center = getTemplateCenter();
    const scale = name === "Logo" ? 0.22 : 0.35;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const id = crypto.randomUUID();
      objects.push({
        type: "img",
        id,
        img,
        name,
        src: assetUrl,
        x: center.x,
        y: center.y,
        s: scale,
        r: 0,
        opacity: 1,
        w: img.width,
        h: img.height,
      });
      selectedId = id;
      draw();
      pushHistory();
    };
    img.src = encodeURI(assetUrl);
  }

  function addText(text, fontFamily = "Noto Sans JP", size = 36, style = {}) {
    const t = String(text || "").trim();
    if (!t) return;
    const effect = normalizeEffectOptions(style);
    const id = crypto.randomUUID();
    const center = getTemplateCenter();
    objects.push({
      type: "text",
      id,
      text: t,
      fontFamily,
      size,
      color: style.color || "#ffffff",
      x: center.x,
      y: center.y,
      s: 1,
      r: Number(style.r || 0),
      opacity: Number.isFinite(style.opacity) ? style.opacity : 1,
      effect: effect.effect,
      effectColor: effect.effectColor,
      effectBlur: effect.effectBlur,
      strokeColor: effect.strokeColor,
      strokeWidth: effect.strokeWidth
    });
    selectedId = id;
    draw();
    pushHistory();
  }

  function clearAll() {
    objects = [];
    selectedId = null;
    draw();
    pushHistory();
  }

  function hitTest(px, py) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.type === "path") continue;
      const cos = Math.cos(-o.r);
      const sin = Math.sin(-o.r);
      const dx = px - o.x;
      const dy = py - o.y;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;

      if (o.type === "img") {
        const halfW = (o.w * o.s) / 2;
        const halfH = (o.h * o.s) / 2;
        if (lx >= -halfW && lx <= halfW && ly >= -halfH && ly <= halfH) return o.id;
      } else {
        ctx.save();
        ctx.font = `${o.size}px "${o.fontFamily}"`;
        const w = ctx.measureText(o.text).width * o.s;
        const h = o.size * o.s;
        ctx.restore();
        if (lx >= -w / 2 && lx <= w / 2 && ly >= -h / 2 && ly <= h / 2) return o.id;
      }
    }
    return null;
  }

  function getObjectBounds(o) {
    if (o.type === "img") {
      return { w: o.w * o.s, h: o.h * o.s };
    }
    ctx.save();
    ctx.font = `${o.size}px "${o.fontFamily}"`;
    const w = ctx.measureText(o.text).width * o.s;
    const h = o.size * o.s;
    ctx.restore();
    return { w, h };
  }

  function getDeleteHandle(o) {
    const bounds = getObjectBounds(o);
    const offset = Math.max(10 * DPR, Math.min(bounds.w, bounds.h) * 0.08);
    const radius = Math.max(12 * DPR, Math.min(bounds.w, bounds.h) * 0.09);
    const localX = bounds.w / 2 + offset;
    const localY = -bounds.h / 2 - offset;
    const cos = Math.cos(o.r);
    const sin = Math.sin(o.r);
    return {
      x: o.x + localX * cos - localY * sin,
      y: o.y + localX * sin + localY * cos,
      radius
    };
  }

  function getScaleHandle(o) {
    const bounds = getObjectBounds(o);
    const offset = Math.max(14 * DPR, Math.min(bounds.w, bounds.h) * 0.1);
    const radius = Math.max(16 * DPR, Math.min(bounds.w, bounds.h) * 0.1);
    const localX = bounds.w / 2 + offset;
    const localY = bounds.h / 2 + offset;
    const cos = Math.cos(o.r);
    const sin = Math.sin(o.r);
    return {
      x: o.x + localX * cos - localY * sin,
      y: o.y + localX * sin + localY * cos,
      radius
    };
  }

  function hitDeleteHandle(px, py, o) {
    if (o.type !== "img") return false;
    const handle = getDeleteHandle(o);
    const dx = px - handle.x;
    const dy = py - handle.y;
    return (dx * dx + dy * dy) <= (handle.radius * handle.radius);
  }

  function hitScaleHandle(px, py, o) {
    if (o.type === "path") return false;
    const handle = getScaleHandle(o);
    const dx = px - handle.x;
    const dy = py - handle.y;
    return (dx * dx + dy * dy) <= (handle.radius * handle.radius);
  }

  function getRotationRing(px, py, o) {
    const dx = px - o.x;
    const dy = py - o.y;
    const dist = Math.hypot(dx, dy);
    const bounds = getObjectBounds(o);
    const base = Math.max(bounds.w, bounds.h) * 0.5;
    const ring = Math.max(26 * DPR, base + 16 * DPR);
    const thick = 10 * DPR;
    if (dist >= ring - thick && dist <= ring + thick) return { ring, dist };
    return null;
  }

  function distToSegmentSquared(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby;
    if (ab2 === 0) return apx * apx + apy * apy;
    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy;
  }

  function sampleAlongLine(ax, ay, bx, by, spacing) {
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist <= spacing) return [];
    const steps = Math.floor(dist / spacing);
    const points = [];
    for (let i = 1; i <= steps; i++) {
      const t = (spacing * i) / dist;
      points.push({ x: ax + dx * t, y: ay + dy * t });
    }
    return points;
  }

  function eraseAt(x, y) {
    const radius = Math.max(1, Number(eraserOptions.size || 0) * 0.5);
    const r2 = radius * radius;
    let changed = false;
    const next = [];

    for (const o of objects) {
      if (o.type !== "path") {
        next.push(o);
        continue;
      }

      let anyRemoved = false;
      let current = [];
      const segments = [];

      for (let i = 0; i < o.points.length; i++) {
        const p = o.points[i];
        const dx = p.x - x;
        const dy = p.y - y;
        const pointHit = (dx * dx + dy * dy) <= r2;
        let segHit = false;
        if (i > 0) {
          const prev = o.points[i - 1];
          segHit = distToSegmentSquared(x, y, prev.x, prev.y, p.x, p.y) <= r2;
        }
        if (pointHit || segHit) {
          anyRemoved = true;
          if (current.length > 1) segments.push(current);
          current = [];
          if (!pointHit && !segHit) {
            current.push(p);
          }
        } else {
          current.push(p);
        }
      }
      if (current.length > 1) segments.push(current);

      if (!anyRemoved) {
        next.push(o);
        continue;
      }

      changed = true;
      for (const seg of segments) {
        next.push({
          ...o,
          id: crypto.randomUUID(),
          points: seg.map((p) => ({ x: p.x, y: p.y }))
        });
      }
    }

    if (changed) {
      objects = next;
      if (selectedId && !objects.find(o => o.id === selectedId)) selectedId = null;
    }
    return changed;
  }

  function drawStroke(points, width, color, effect) {
    if (!points.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    if (effect) applyEffect(ctx, effect.effect, effect.effectColor, effect.effectBlur);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { pad, w, h } = getTemplateRect();

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, w, h);
    ctx.clip();
    ctx.save();
    ctx.translate(viewOffsetX, viewOffsetY);
    ctx.scale(viewScale, viewScale);
    if (templateImg?.width) {
      ctx.drawImage(templateImg, pad, pad, w, h);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(pad, pad, w, h);
    }

    for (const o of objects) {
      if (o.type !== "path") continue;
      ctx.save();
      ctx.globalAlpha = Number.isFinite(o.opacity) ? o.opacity : 1;
      if (o.strokeWidth > 0) {
        drawStroke(o.points, o.size + o.strokeWidth * 2, o.strokeColor, null);
      }
      drawStroke(o.points, o.size, o.color, o);
      ctx.restore();
    }
    ctx.restore();

    ctx.restore();

    ctx.save();
    ctx.translate(viewOffsetX, viewOffsetY);
    ctx.scale(viewScale, viewScale);

    for (const o of objects) {
      if (o.type === "path") continue;
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.r);
      ctx.scale(o.s, o.s);
      ctx.globalAlpha = Number.isFinite(o.opacity) ? o.opacity : 1;

      if (o.type === "img") {
        ctx.drawImage(o.img, -o.w / 2, -o.h / 2);
      } else {
        ctx.fillStyle = o.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${o.size}px "${o.fontFamily}"`;
        applyEffect(ctx, o.effect, o.effectColor, o.effectBlur);
        if (o.strokeWidth > 0) {
          ctx.lineWidth = o.strokeWidth * 2;
          ctx.strokeStyle = o.strokeColor;
          ctx.strokeText(o.text, 0, 0);
        }
        ctx.fillText(o.text, 0, 0);
      }
      ctx.restore();

      if (o.id === selectedId && canEditObjects()) {
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(o.r);
        ctx.strokeStyle = "rgba(106,168,255,.9)";
        ctx.lineWidth = Math.max(2, 2 * DPR);

        if (o.type === "img") {
          ctx.strokeRect(-(o.w * o.s) / 2, -(o.h * o.s) / 2, o.w * o.s, o.h * o.s);
        } else {
          ctx.font = `${o.size}px "${o.fontFamily}"`;
          const tw = ctx.measureText(o.text).width * o.s;
          const th = o.size * o.s;
          ctx.strokeRect(-tw / 2, -th / 2, tw, th);
        }
        ctx.restore();
      }
    }

    if (selectedId && canEditObjects()) {
      const selected = objects.find(v => v.id === selectedId);
      if (selected && selected.type !== "path") {
        const bounds = getObjectBounds(selected);
        const ring = Math.max(26 * DPR, Math.max(bounds.w, bounds.h) * 0.5 + 16 * DPR);
        ctx.save();
        ctx.translate(selected.x, selected.y);
        ctx.strokeStyle = "rgba(106,168,255,.55)";
        ctx.lineWidth = Math.max(2, 2 * DPR);
        ctx.setLineDash([6 * DPR, 6 * DPR]);
        ctx.beginPath();
        ctx.arc(0, 0, ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(106,168,255,.9)";
        ctx.beginPath();
        ctx.arc(ring, 0, 4 * DPR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const scaleHandle = getScaleHandle(selected);
        ctx.save();
        ctx.fillStyle = "rgba(106,168,255,.9)";
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.lineWidth = Math.max(2, 2 * DPR);
        ctx.beginPath();
        ctx.arc(scaleHandle.x, scaleHandle.y, scaleHandle.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      if (selected && selected.type === "img") {
        const handle = getDeleteHandle(selected);
        ctx.save();
        ctx.fillStyle = "rgba(28,34,48,.9)";
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.lineWidth = Math.max(2, 2 * DPR);
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, handle.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const cross = handle.radius * 0.6;
        ctx.beginPath();
        ctx.moveTo(handle.x - cross, handle.y - cross);
        ctx.lineTo(handle.x + cross, handle.y + cross);
        ctx.moveTo(handle.x + cross, handle.y - cross);
        ctx.lineTo(handle.x - cross, handle.y + cross);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function toCanvasScreenCoordsFromPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * DPR,
      y: (clientY - rect.top) * DPR
    };
  }

  function toCanvasScreenCoords(e) {
    return toCanvasScreenCoordsFromPoint(e.clientX, e.clientY);
  }

  function toCanvasCoordsFromPoint(clientX, clientY) {
    return toCanvasScreenCoordsFromPoint(clientX, clientY);
  }

  function toCanvasCoords(e) {
    const screen = toCanvasScreenCoords(e);
    return {
      x: screen.x,
      y: screen.y
    };
  }

  function toTemplateCoordsFromPoint(clientX, clientY) {
    const screen = toCanvasScreenCoordsFromPoint(clientX, clientY);
    return {
      x: (screen.x - viewOffsetX) / viewScale,
      y: (screen.y - viewOffsetY) / viewScale
    };
  }

  function toTemplateCoords(e) {
    return toTemplateCoordsFromPoint(e.clientX, e.clientY);
  }

  function getTemplateCenter() {
    return {
      x: (canvas.width / 2 - viewOffsetX) / viewScale,
      y: (canvas.height / 2 - viewOffsetY) / viewScale
    };
  }

  function getTemplateRect() {
    const pad = canvas.width * TEMPLATE_INSET_RATIO;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    return { pad, w, h, left: pad, top: pad, right: pad + w, bottom: pad + h };
  }

  function getDesignRect() {
    const pad = canvas.width * DESIGN_INSET_RATIO;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    return { left: pad, top: pad, right: pad + w, bottom: pad + h };
  }

  function isInsideDesignArea(x, y) {
    const rect = getDesignRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function updatePointer(e) {
    const screen = toCanvasScreenCoords(e);
    const { x, y } = toCanvasCoords(e);
    activePointers.set(e.pointerId, { x, y, sx: screen.x, sy: screen.y, type: e.pointerType });
    return { x, y };
  }

  function clampScale(value) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  function clampViewScale(value) {
    return Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, value));
  }

  function canEditObjects() {
    return objectEditEnabled;
  }

  function canZoomView() {
    return drawMode !== "draw";
  }

  function syncTemplatePreviewTransform() {
    if (!templatePreviewImg) return;
    const { pad } = getTemplateRect();
    const offsetX = (viewOffsetX + (viewScale - 1) * pad) / DPR;
    const offsetY = (viewOffsetY + (viewScale - 1) * pad) / DPR;
    templatePreviewImg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${viewScale})`;
    templatePreviewImg.style.transformOrigin = "0 0";
  }

  function clampViewOffset() {
    const { pad, w, h } = getTemplateRect();
    const minX = (pad + w) * (1 - viewScale);
    const maxX = pad * (1 - viewScale);
    const minY = (pad + h) * (1 - viewScale);
    const maxY = pad * (1 - viewScale);
    if (minX > maxX) {
      viewOffsetX = (pad + w / 2) * (1 - viewScale);
    } else {
      viewOffsetX = Math.min(maxX, Math.max(minX, viewOffsetX));
    }
    if (minY > maxY) {
      viewOffsetY = (pad + h / 2) * (1 - viewScale);
    } else {
      viewOffsetY = Math.min(maxY, Math.max(minY, viewOffsetY));
    }
  }

  function resetViewIfClose() {
    if (Math.abs(viewScale - 1) > VIEW_SCALE_SNAP) return false;
    viewScale = 1;
    viewOffsetX = 0;
    viewOffsetY = 0;
    syncTemplatePreviewTransform();
    return true;
  }

  function applyViewScale(nextScale, centerX, centerY) {
    let clamped = clampViewScale(nextScale);
    const shouldSnap = Math.abs(clamped - 1) <= VIEW_SCALE_SNAP;
    if (shouldSnap) clamped = 1;
    const ratio = clamped / viewScale;
    viewOffsetX = centerX - (centerX - viewOffsetX) * ratio;
    viewOffsetY = centerY - (centerY - viewOffsetY) * ratio;
    viewScale = clamped;
    if (shouldSnap) {
      viewOffsetX = 0;
      viewOffsetY = 0;
    }
    clampViewOffset();
    syncTemplatePreviewTransform();
  }

  function getViewScale() {
    return viewScale;
  }

  function getViewScaleRange() {
    return { min: MIN_VIEW_SCALE, max: MAX_VIEW_SCALE };
  }

  function setViewScale(nextScale, options = {}) {
    if (!Number.isFinite(nextScale)) return viewScale;
    let centerX = canvas.width / 2;
    let centerY = canvas.height / 2;
    if (Number.isFinite(options.clientX) && Number.isFinite(options.clientY)) {
      const screen = toCanvasScreenCoordsFromPoint(options.clientX, options.clientY);
      centerX = screen.x;
      centerY = screen.y;
    } else if (Number.isFinite(options.centerX) && Number.isFinite(options.centerY)) {
      centerX = options.centerX;
      centerY = options.centerY;
    }
    applyViewScale(nextScale, centerX, centerY);
    draw();
    return viewScale;
  }

  function maybeStartPinch() {
    if (activePointers.size !== 2) return false;
    const points = Array.from(activePointers.values());
    if (!isInsideDesignArea(points[0].x, points[0].y) || !isInsideDesignArea(points[1].x, points[1].y)) {
      return false;
    }
    if (canEditObjects() && selectedId) {
      const o = objects.find(v => v.id === selectedId);
      if (!o || o.type === "path") return false;
      const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      pinch = {
        type: "object",
        id: o.id,
        startDist: dist || 1,
        startScale: o.s
      };
    } else if (canZoomView()) {
      const dist = Math.hypot(points[0].sx - points[1].sx, points[0].sy - points[1].sy);
      const centerX = (points[0].sx + points[1].sx) / 2;
      const centerY = (points[0].sy + points[1].sy) / 2;
      pinch = {
        type: "view",
        startDist: dist || 1,
        startScale: viewScale,
        centerX,
        centerY
      };
    } else {
      return false;
    }
    drag = null;
    rotateDrag = null;
    scaleDrag = null;
    drawing = null;
    erasing = null;
    viewDrag = null;
    return true;
  }

  canvas.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  }, { passive: false });

  let touchPinch = null;
  canvas.addEventListener("touchstart", (e) => {
    if (!e.touches || e.touches.length !== 2) return;
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const p0 = toCanvasCoordsFromPoint(t0.clientX, t0.clientY);
    const p1 = toCanvasCoordsFromPoint(t1.clientX, t1.clientY);
    if (!isInsideDesignArea(p0.x, p0.y) || !isInsideDesignArea(p1.x, p1.y)) return;
    if (canEditObjects() && selectedId) {
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      touchPinch = { type: "object", id: selectedId, startDist: dist || 1, startScale: objects.find(v => v.id === selectedId)?.s || 1 };
    } else if (canZoomView()) {
      const s0 = toCanvasScreenCoordsFromPoint(t0.clientX, t0.clientY);
      const s1 = toCanvasScreenCoordsFromPoint(t1.clientX, t1.clientY);
      const dist = Math.hypot(s0.x - s1.x, s0.y - s1.y);
      touchPinch = {
        type: "view",
        startDist: dist || 1,
        startScale: viewScale,
        centerX: (s0.x + s1.x) / 2,
        centerY: (s0.y + s1.y) / 2
      };
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    if (!touchPinch || !e.touches || e.touches.length !== 2) return;
    if (touchPinch.type === "view" && !canZoomView()) {
      touchPinch = null;
      return;
    }
    if (touchPinch.type === "object" && !canEditObjects()) {
      touchPinch = null;
      return;
    }
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (touchPinch.type === "view") {
      const s0 = toCanvasScreenCoordsFromPoint(t0.clientX, t0.clientY);
      const s1 = toCanvasScreenCoordsFromPoint(t1.clientX, t1.clientY);
      const dist = Math.hypot(s0.x - s1.x, s0.y - s1.y);
      const nextScale = clampViewScale(touchPinch.startScale * (dist / touchPinch.startDist));
      if (viewScale !== nextScale) {
        applyViewScale(nextScale, (s0.x + s1.x) / 2, (s0.y + s1.y) / 2);
        draw();
      }
    } else {
      const p0 = toCanvasCoordsFromPoint(t0.clientX, t0.clientY);
      const p1 = toCanvasCoordsFromPoint(t1.clientX, t1.clientY);
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      const o = objects.find(v => v.id === touchPinch.id);
      if (o) {
        const nextScale = clampScale(touchPinch.startScale * (dist / touchPinch.startDist));
        if (o.s !== nextScale) {
          o.s = nextScale;
          draw();
        }
      }
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    if (touchPinch && touchPinch.type === "object") {
      pushHistory();
    }
    if (touchPinch && touchPinch.type === "view") {
      if (resetViewIfClose()) draw();
    }
    touchPinch = null;
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") {
      canvas.setPointerCapture(e.pointerId);
    } else {
      canvas.style.touchAction = "none";
    }
    const { x, y } = updatePointer(e);
    const screen = toCanvasScreenCoords(e);
    const { x: tx, y: ty } = toTemplateCoords(e);
    if (maybeStartPinch()) {
      draw();
      return;
    }
    const currentSelection = selectedId ? objects.find(v => v.id === selectedId) : null;
    const hitHandle = currentSelection && currentSelection.type !== "path"
      && (hitDeleteHandle(tx, ty, currentSelection)
        || hitScaleHandle(tx, ty, currentSelection)
        || !!getRotationRing(tx, ty, currentSelection));
    const hitId = hitTest(tx, ty);
    const hitObject = !!hitId || !!hitHandle;
    objectEditEnabled = hitObject;
    if (drawMode === "draw" && !hitObject) {
      if (activePointers.size > 1) {
        return;
      }
      if (drawTool === "eraser") {
        erasing = { pointerId: e.pointerId, lastX: tx, lastY: ty };
        const changed = eraseAt(tx, ty);
        if (changed) draw();
        return;
      }
      const id = crypto.randomUUID();
      drawing = { id, pointerId: e.pointerId, lastX: tx, lastY: ty };
      const effect = normalizeEffectOptions(penOptions);
      objects.push({
        type: "path",
        id,
        points: [{ x: tx, y: ty }],
        color: penOptions.color,
        size: penOptions.size,
        effect: effect.effect,
        effectColor: effect.effectColor,
        effectBlur: effect.effectBlur,
        strokeColor: effect.strokeColor,
        strokeWidth: effect.strokeWidth
      });
      selectedId = null;
      drag = null;
      draw();
      return;
    }
    if (!canEditObjects()) {
      if (canZoomView() && isInsideDesignArea(x, y)) {
        viewDrag = {
          pointerId: e.pointerId,
          startX: screen.x,
          startY: screen.y,
          startOffsetX: viewOffsetX,
          startOffsetY: viewOffsetY
        };
      }
      if (selectedId || drag || rotateDrag || scaleDrag || drawing || erasing) {
        selectedId = null;
        drag = null;
        rotateDrag = null;
        scaleDrag = null;
        drawing = null;
        erasing = null;
        dragMoved = false;
        draw();
      }
      return;
    }
    const current = selectedId ? objects.find(v => v.id === selectedId) : null;
    if (current && current.type !== "path") {
      if (hitDeleteHandle(tx, ty, current)) {
        objects = objects.filter(v => v.id !== current.id);
        selectedId = null;
        draw();
        pushHistory();
        return;
      }
      if (hitScaleHandle(tx, ty, current)) {
        if (!isInsideDesignArea(x, y)) {
          return;
        }
        const dist = Math.hypot(tx - current.x, ty - current.y);
        scaleDrag = {
          id: current.id,
          startDist: dist || 1,
          baseScale: current.s
        };
        drag = null;
        rotateDrag = null;
        drawing = null;
        erasing = null;
        draw();
        return;
      }
      const ring = getRotationRing(tx, ty, current);
      if (ring) {
        rotateDrag = {
          id: current.id,
          startAngle: Math.atan2(ty - current.y, tx - current.x),
          baseRotation: current.r
        };
        drag = null;
        draw();
        return;
      }
    }
    const id = hitTest(tx, ty);
    selectedId = id;
    if (id) {
      const o = objects.find(v => v.id === id);
      drag = { id, dx: tx - o.x, dy: ty - o.y };
      dragMoved = false;
    } else {
      drag = null;
    }
    draw();
  });

  canvas.addEventListener("pointermove", (e) => {
    updatePointer(e);
    if (e.pointerType === "touch" && (activePointers.size >= 2 || drawing || drag || rotateDrag || scaleDrag || pinch || erasing || viewDrag)) {
      e.preventDefault();
    }
    if (pinch && activePointers.size === 2) {
      const points = Array.from(activePointers.values());
      if (pinch.type === "view") {
        const dist = Math.hypot(points[0].sx - points[1].sx, points[0].sy - points[1].sy);
        const centerX = (points[0].sx + points[1].sx) / 2;
        const centerY = (points[0].sy + points[1].sy) / 2;
        const nextScale = clampViewScale(pinch.startScale * (dist / pinch.startDist));
        if (viewScale !== nextScale) {
          applyViewScale(nextScale, centerX, centerY);
          draw();
        }
      } else {
        const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const o = objects.find(v => v.id === pinch.id);
        if (o) {
          const nextScale = clampScale(pinch.startScale * (dist / pinch.startDist));
          if (o.s !== nextScale) {
            o.s = nextScale;
            draw();
          }
        }
      }
      return;
    }
    if (viewDrag && viewDrag.pointerId === e.pointerId) {
      const screen = toCanvasScreenCoords(e);
      viewOffsetX = viewDrag.startOffsetX + (screen.x - viewDrag.startX);
      viewOffsetY = viewDrag.startOffsetY + (screen.y - viewDrag.startY);
      clampViewOffset();
      syncTemplatePreviewTransform();
      draw();
      return;
    }
    if (scaleDrag && scaleDrag.id) {
      const o = objects.find(v => v.id === scaleDrag.id);
      if (!o) return;
      const { x, y } = toTemplateCoords(e);
      const dist = Math.hypot(x - o.x, y - o.y);
      const nextScale = clampScale(scaleDrag.baseScale * (dist / scaleDrag.startDist));
      if (o.s !== nextScale) {
        o.s = nextScale;
        draw();
      }
      return;
    }
    if (erasing && erasing.pointerId === e.pointerId) {
      const { x, y } = toTemplateCoords(e);
      const samples = sampleAlongLine(erasing.lastX, erasing.lastY, x, y, sampleSpacing * DPR);
      let changed = false;
      for (const p of samples) {
        if (eraseAt(p.x, p.y)) changed = true;
      }
      erasing.lastX = x;
      erasing.lastY = y;
      if (changed) draw();
      return;
    }
    if (rotateDrag && rotateDrag.id) {
      const o = objects.find(v => v.id === rotateDrag.id);
      if (!o) return;
      const { x, y } = toTemplateCoords(e);
      const next = Math.atan2(y - o.y, x - o.x);
      o.r = rotateDrag.baseRotation + (next - rotateDrag.startAngle);
      draw();
      return;
    }
    if (drawing && drawing.pointerId === e.pointerId) {
      const o = objects.find(v => v.id === drawing.id);
      if (!o) return;
      const { x, y } = toTemplateCoords(e);
      const samples = sampleAlongLine(drawing.lastX, drawing.lastY, x, y, sampleSpacing * DPR);
      if (samples.length) {
        for (const p of samples) o.points.push(p);
        drawing.lastX = x;
        drawing.lastY = y;
        draw();
      }
      return;
    }
    if (!drag) return;
    const { x, y } = toTemplateCoords(e);
    const o = objects.find(v => v.id === drag.id);
    if (!o) return;
    const nextX = x - drag.dx;
    const nextY = y - drag.dy;
    if (o.x !== nextX || o.y !== nextY) {
      o.x = nextX;
      o.y = nextY;
      dragMoved = true;
    }
    draw();
  });

  canvas.addEventListener("pointerup", (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) {
      canvas.style.touchAction = "pan-y";
    }
    if (pinch && activePointers.size < 2) {
      const wasViewPinch = pinch.type === "view";
      const shouldSave = pinch.type === "object";
      pinch = null;
      if (wasViewPinch && resetViewIfClose()) {
        draw();
      }
      if (shouldSave) pushHistory();
      return;
    }
    if (viewDrag && viewDrag.pointerId === e.pointerId) {
      viewDrag = null;
      return;
    }
    if (scaleDrag) {
      scaleDrag = null;
      pushHistory();
      return;
    }
    if (erasing && erasing.pointerId === e.pointerId) {
      erasing = null;
      pushHistory();
      return;
    }
    if (rotateDrag) {
      rotateDrag = null;
      pushHistory();
      return;
    }
    if (drawing && drawing.pointerId === e.pointerId) {
      drawing = null;
      pushHistory();
      return;
    }
    if (drag && dragMoved) pushHistory();
    drag = null;
  });
  canvas.addEventListener("pointercancel", () => {
    activePointers.clear();
    canvas.style.touchAction = "pan-y";
    drawing = null;
    drag = null;
    rotateDrag = null;
    erasing = null;
    pinch = null;
    scaleDrag = null;
    viewDrag = null;
  });

  canvas.addEventListener("wheel", (e) => {
    if (!canEditObjects() || !selectedId) return;
    e.preventDefault();
    const o = objects.find(v => v.id === selectedId);
    if (!o) return;
    const delta = Math.sign(e.deltaY) * -0.04;
    o.s = clampScale(o.s + delta);
    draw();
    pushHistory();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (!canEditObjects() || !selectedId) return;
    const o = objects.find(v => v.id === selectedId);
    if (!o) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      objects = objects.filter(v => v.id !== selectedId);
      selectedId = null;
      draw();
      pushHistory();
    }
    if (e.key.toLowerCase() === "q") { o.r -= 0.08; draw(); pushHistory(); }
    if (e.key.toLowerCase() === "e") { o.r += 0.08; draw(); pushHistory(); }
  });

  function dataUrlToBlob(dataUrl) {
    const [meta, encoded] = dataUrl.split(",");
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
    const binary = atob(encoded);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function exportPngBlob(options = {}) {
    const hideUi = !!options.hideUi;
    const prevSelectedId = selectedId;
    const prevViewScale = viewScale;
    const prevViewOffsetX = viewOffsetX;
    const prevViewOffsetY = viewOffsetY;
    if (hideUi) {
      selectedId = null;
      viewScale = 1;
      viewOffsetX = 0;
      viewOffsetY = 0;
      syncTemplatePreviewTransform();
      draw();
    }
    const markCanvas = document.createElement("canvas");
    markCanvas.width = canvas.width;
    markCanvas.height = canvas.height;
    const markCtx = markCanvas.getContext("2d");
    markCtx.drawImage(canvas, 0, 0);
    let blob = await new Promise((resolve) => markCanvas.toBlob(resolve, "image/png", 1.0));
    if (!blob) {
      const dataUrl = markCanvas.toDataURL("image/png");
      blob = dataUrlToBlob(dataUrl);
    }
    if (hideUi) {
      selectedId = prevSelectedId;
      viewScale = prevViewScale;
      viewOffsetX = prevViewOffsetX;
      viewOffsetY = prevViewOffsetY;
      syncTemplatePreviewTransform();
      draw();
    }
    return blob;
  }

  let resetAssetSelectionCallback = null;
  function setAssets(assetList, options = {}) {
    assetGrid.innerHTML = "";
    const onUnlock = typeof options.onUnlock === "function" ? options.onUnlock : null;
    const groups = [
      { key: "mobby", label: "モビー" },
      { key: "lucky", label: "素材" },
      { key: "logo", label: "Logo" },
    ];

    const grouped = new Map(groups.map((g) => [g.key, []]));
    const isMobbyAsset = (name, url) => /モビ[ィー]/.test(name) || /モビ[ィー]/.test(url) || /モビィ透過済|モビー透過済/.test(url);

    for (const a of assetList) {
      const url = String(a.url || "");
      const name = String(a.name || "");
      let key = "lucky";
      if (name === "Logo") {
        key = "logo";
      } else if (isMobbyAsset(name, url)) {
        key = "mobby";
      }
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(a);
    }

    const tabs = document.createElement("div");
    tabs.className = "assetTabs";
    const row = document.createElement("div");
    row.className = "assetRow hidden";
    const empty = document.createElement("p");
    empty.className = "muted assetEmpty";
    empty.textContent = "カテゴリを選択してください。";
    const actions = document.createElement("div");
    actions.className = "assetActions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn assetAddBtn";
    addBtn.type = "button";
    const addBtnLabel = "追加";
    const unlockBtnLabel = "解放";
    addBtn.textContent = addBtnLabel;
    addBtn.disabled = true;
    actions.appendChild(addBtn);

    const tabButtons = new Map();
    let activeKey = null;
    let selectedAsset = null;
    let selectedAssetButton = null;

    function updateAddButton() {
      if (!selectedAsset) {
        addBtn.disabled = true;
        addBtn.textContent = addBtnLabel;
        return;
      }
      addBtn.disabled = false;
      if (selectedAsset.locked) {
        const price = Number(selectedAsset.price || 0);
        addBtn.textContent = price ? `${price}ptで解放` : unlockBtnLabel;
        return;
      }
      addBtn.textContent = addBtnLabel;
    }

    function setSelectedAsset(button) {
      if (!button) return;
      const assetUrl = button.dataset.assetUrl || "";
      const assetName = button.dataset.assetName || "";
      const assetPrice = Number(button.dataset.assetPrice || 0);
      const assetLocked = button.dataset.assetLocked === "1";
      const found = assetList.find((item) => item.url === assetUrl && item.name === assetName);
      const price = Number(found?.price ?? assetPrice ?? 0);
      const locked = typeof found?.locked === "boolean" ? found.locked : assetLocked;
      const asset = {
        ...(found || {}),
        url: assetUrl,
        name: assetName,
        price,
        locked
      };
      if (selectedAssetButton) selectedAssetButton.classList.remove("selected");
      selectedAssetButton = button;
      selectedAsset = asset;
      selectedAssetButton.classList.add("selected");
      updateAddButton();
    }

    function clearSelectedAsset() {
      if (selectedAssetButton) selectedAssetButton.classList.remove("selected");
      selectedAssetButton = null;
      selectedAsset = null;
      updateAddButton();
    }

    function renderGroup(key) {
      row.innerHTML = "";
      clearSelectedAsset();
      const items = grouped.get(key) || [];
      const sorted = [...items].sort((a, b) => {
        const aLocked = !!a.locked;
        const bLocked = !!b.locked;
        if (aLocked === bLocked) return 0;
        return aLocked ? 1 : -1;
      });
      row.classList.remove("hidden");
      activeKey = key;
      empty.classList.add("hidden");
      const lockedLabel = "";
      if (!sorted.length) {
        empty.textContent = "素材がまだありません。";
        empty.classList.remove("hidden");
      }
      for (const a of sorted) {
        const div = document.createElement("button");
        div.className = "asset";
        div.type = "button";
        div.innerHTML = `<img src="${a.url}" alt=""><span>${a.name}</span>`;
        div.dataset.assetUrl = a.url;
        div.dataset.assetName = a.name;
        div.dataset.assetLocked = a.locked ? "1" : "0";
        div.dataset.assetPrice = String(a.price || 0);
        if (a.locked) {
          div.classList.add("locked");
          div.setAttribute("aria-disabled", "true");
          const badgeText = a.price ? `${a.price}pt` : lockedLabel;
          if (badgeText) {
            const badge = document.createElement("span");
            badge.className = "assetPrice";
            badge.textContent = badgeText;
            div.appendChild(badge);
          }
        }
        div.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedAsset(div);
          }
        });
        div.addEventListener("click", () => {
          if (dragMoved) return;
          setSelectedAsset(div);
        });
        row.appendChild(div);
      }
    }

    function updateTabs() {
      for (const [key, btn] of tabButtons.entries()) {
        btn.classList.toggle("active", key === activeKey);
      }
    }

    function resetAssetSelection() {
      activeKey = null;
      row.classList.add("hidden");
      empty.textContent = "カテゴリを選択してください。";
      empty.classList.remove("hidden");
      clearSelectedAsset();
      updateTabs();
    }

    for (const group of groups) {
      const btn = document.createElement("button");
      btn.className = "assetTab";
      btn.type = "button";
      btn.textContent = group.label;
      btn.addEventListener("click", () => {
        renderGroup(group.key);
        updateTabs();
      });
      tabButtons.set(group.key, btn);
      tabs.appendChild(btn);
    }

    assetGrid.appendChild(tabs);
    assetGrid.appendChild(row);
    assetGrid.appendChild(empty);
    assetGrid.appendChild(actions);

    let isDragScroll = false;
    let dragStartX = 0;
    let dragStartLeft = 0;
    let dragMoved = false;
    let pendingAssetButton = null;
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      isDragScroll = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartLeft = row.scrollLeft;
      const assetButton = e.target.closest(".asset");
      pendingAssetButton = assetButton ? assetButton : null;
      row.setPointerCapture(e.pointerId);
    });
    row.addEventListener("pointermove", (e) => {
      if (!isDragScroll) return;
      const delta = e.clientX - dragStartX;
      if (Math.abs(delta) > 2) dragMoved = true;
      row.scrollLeft = dragStartLeft - delta;
      if (dragMoved) e.preventDefault();
    });
    row.addEventListener("pointerup", () => {
      isDragScroll = false;
      if (!dragMoved && pendingAssetButton) {
        setSelectedAsset(pendingAssetButton);
      }
      pendingAssetButton = null;
    });
    row.addEventListener("pointercancel", () => {
      isDragScroll = false;
      pendingAssetButton = null;
    });
    row.addEventListener("wheel", (e) => {
      if (!row.scrollWidth || row.scrollWidth <= row.clientWidth) return;
      row.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    addBtn.addEventListener("click", () => {
      if (!selectedAsset) return;
      if (selectedAsset.locked) {
        if (onUnlock) onUnlock(selectedAsset);
        return;
      }
      if (selectedAsset.url) addAsset(selectedAsset.url, selectedAsset.name);
      assetGrid.dispatchEvent(new CustomEvent("assetadd"));
    });

    resetAssetSelectionCallback = resetAssetSelection;
    resetAssetSelection();
  }

  function getUsedAssetNames() {
    return objects.filter(o => o.type === "img").map(o => o.name);
  }

  function getState() {
    const safeObjects = objects.map((o) => {
      if (o.type === "img") {
        return {
          type: "img",
          id: o.id,
          name: o.name || "",
          src: o.src || "",
          x: o.x,
          y: o.y,
          s: o.s,
          r: o.r,
          opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
          w: o.w,
          h: o.h
        };
      }
      if (o.type === "text") {
        return {
          type: "text",
          id: o.id,
          text: o.text || "",
          fontFamily: o.fontFamily || "Noto Sans JP",
          size: o.size,
          color: o.color || "#ffffff",
          x: o.x,
          y: o.y,
          s: o.s,
          r: o.r,
          opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
          effect: o.effect || "none",
          effectColor: o.effectColor || "#00f5ff",
          effectBlur: o.effectBlur || 0,
          strokeColor: o.strokeColor || "#000000",
          strokeWidth: o.strokeWidth || 0
        };
      }
      return {
        type: "path",
        id: o.id,
        points: Array.isArray(o.points) ? o.points.map((p) => ({ x: p.x, y: p.y })) : [],
        color: o.color || "#000000",
        size: o.size || 1,
        opacity: Number.isFinite(o.opacity) ? o.opacity : 1,
        effect: o.effect || "none",
        effectColor: o.effectColor || "#00f5ff",
        effectBlur: o.effectBlur || 0,
        strokeColor: o.strokeColor || "#000000",
        strokeWidth: o.strokeWidth || 0
      };
    });
    return {
      template: templateUrl,
      canvasW: canvas.width,
      canvasH: canvas.height,
      viewScale: Number.isFinite(viewScale) ? viewScale : 1,
      viewOffsetX: Number.isFinite(viewOffsetX) ? viewOffsetX : 0,
      viewOffsetY: Number.isFinite(viewOffsetY) ? viewOffsetY : 0,
      objects: safeObjects
    };
  }

  function setDrawMode(mode) {
    const nextMode = mode === "draw" ? "draw" : "select";
    if (drawMode === nextMode) return;
    drawMode = nextMode;
    objectEditEnabled = false;
    selectedId = null;
    drag = null;
    rotateDrag = null;
    scaleDrag = null;
    drawing = null;
    erasing = null;
    pinch = null;
    touchPinch = null;
    viewDrag = null;
    activePointers.clear();
    dragMoved = false;
    draw();
  }

  function setPenOptions(opts = {}) {
    const effect = normalizeEffectOptions(opts);
    penOptions = {
      color: opts.color || penOptions.color,
      size: Number(opts.size || penOptions.size),
      effect: effect.effect,
      effectColor: effect.effectColor,
      effectBlur: effect.effectBlur,
      strokeColor: effect.strokeColor,
      strokeWidth: effect.strokeWidth
    };
  }

  function setEraserOptions(opts = {}) {
    eraserOptions = {
      size: Number(opts.size || eraserOptions.size)
    };
  }

  function setDrawTool(tool) {
    drawTool = tool === "eraser" ? "eraser" : "pen";
  }

  function clearDraw() {
    objects = objects.filter(o => o.type !== "path");
    if (selectedId && !objects.find(o => o.id === selectedId)) selectedId = null;
    draw();
    pushHistory();
  }

  function applyTextStyleToSelected(style = {}) {
    if (!selectedId) return;
    const o = objects.find(v => v.id === selectedId);
    if (!o || o.type !== "text") return;
    let changed = false;
    if (style.color && o.color !== style.color) { o.color = style.color; changed = true; }
    if (style.fontFamily && o.fontFamily !== style.fontFamily) { o.fontFamily = style.fontFamily; changed = true; }
    if (Number.isFinite(style.size) && o.size !== style.size) { o.size = style.size; changed = true; }
    if (Number.isFinite(style.r) && o.r !== style.r) { o.r = style.r; changed = true; }
    if ("effect" in style || "effectColor" in style || "effectBlur" in style || "strokeColor" in style || "strokeWidth" in style) {
      const effect = normalizeEffectOptions(style);
      if (o.effect !== effect.effect) { o.effect = effect.effect; changed = true; }
      if (o.effectColor !== effect.effectColor) { o.effectColor = effect.effectColor; changed = true; }
      if (o.effectBlur !== effect.effectBlur) { o.effectBlur = effect.effectBlur; changed = true; }
      if (o.strokeColor !== effect.strokeColor) { o.strokeColor = effect.strokeColor; changed = true; }
      if (o.strokeWidth !== effect.strokeWidth) { o.strokeWidth = effect.strokeWidth; changed = true; }
    }
    if (changed) {
      draw();
      pushHistory();
    }
  }

  function updateSelectedText(text) {
    if (!selectedId) return false;
    const o = objects.find(v => v.id === selectedId);
    if (!o || o.type !== "text") return false;
    const next = String(text ?? "");
    if (o.text === next) return true;
    o.text = next;
    draw();
    pushHistory();
    return true;
  }

  function removeById(id) {
    if (!id) return;
    objects = objects.filter(v => v.id !== id);
    if (selectedId === id) selectedId = null;
    draw();
    pushHistory();
  }

  function upsertImage(opts = {}) {
    const id = opts.id || crypto.randomUUID();
    const existing = objects.find(v => v.id === id);
    const shouldApplyLayout = !!opts.forceLayout || !existing;
    if (!opts.src) {
      if (existing) removeById(id);
      return Promise.resolve(null);
    }
    if (existing && existing.type === "img" && existing.src === opts.src) {
      existing.name = opts.name || existing.name;
      if (Number.isFinite(opts.opacity)) existing.opacity = opts.opacity;
      if (shouldApplyLayout) {
        if (Number.isFinite(opts.x)) existing.x = opts.x;
        if (Number.isFinite(opts.y)) existing.y = opts.y;
        if (Number.isFinite(opts.s)) existing.s = opts.s;
        if (Number.isFinite(opts.r)) existing.r = opts.r;
      }
      draw();
      pushHistory();
      return Promise.resolve(id);
    }

    const defaultCenter = getTemplateCenter();
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (existing && existing.type === "img") {
          existing.img = img;
          existing.src = opts.src;
          existing.name = opts.name || existing.name;
          existing.w = img.width;
          existing.h = img.height;
          if (Number.isFinite(opts.opacity)) existing.opacity = opts.opacity;
          if (shouldApplyLayout) {
            if (Number.isFinite(opts.x)) existing.x = opts.x;
            if (Number.isFinite(opts.y)) existing.y = opts.y;
            if (Number.isFinite(opts.s)) existing.s = opts.s;
            if (Number.isFinite(opts.r)) existing.r = opts.r;
          }
        } else {
          objects.push({
            type: "img",
            id,
            img,
            name: opts.name || "",
            src: opts.src,
            x: Number.isFinite(opts.x) ? opts.x : defaultCenter.x,
            y: Number.isFinite(opts.y) ? opts.y : defaultCenter.y,
            s: Number.isFinite(opts.s) ? opts.s : 0.35,
            r: Number.isFinite(opts.r) ? opts.r : 0,
            opacity: Number.isFinite(opts.opacity) ? opts.opacity : 1,
            w: img.width,
            h: img.height
          });
        }
        draw();
        pushHistory();
        resolve(id);
      };
      img.onerror = reject;
      img.src = encodeURI(opts.src);
    });
  }

  function upsertText(opts = {}) {
    const id = opts.id || crypto.randomUUID();
    const text = String(opts.text ?? "").trim();
    const existing = objects.find(v => v.id === id);
    if (!text) {
      if (existing) removeById(id);
      return id;
    }
    const shouldApplyLayout = !!opts.forceLayout || !existing;
    if (existing && existing.type === "text") {
      existing.text = text;
      if (opts.fontFamily) existing.fontFamily = opts.fontFamily;
      if (Number.isFinite(opts.size)) existing.size = opts.size;
      if (opts.color) existing.color = opts.color;
      if (Number.isFinite(opts.opacity)) existing.opacity = opts.opacity;
      if (Number.isFinite(opts.r)) existing.r = opts.r;
      if (shouldApplyLayout) {
        if (Number.isFinite(opts.x)) existing.x = opts.x;
        if (Number.isFinite(opts.y)) existing.y = opts.y;
      }
      const effect = normalizeEffectOptions(opts);
      existing.effect = effect.effect;
      existing.effectColor = effect.effectColor;
      existing.effectBlur = effect.effectBlur;
      existing.strokeColor = effect.strokeColor;
      existing.strokeWidth = effect.strokeWidth;
      draw();
      pushHistory();
      return id;
    }

    const defaultCenter = getTemplateCenter();
    objects.push({
      type: "text",
      id,
      text,
      fontFamily: opts.fontFamily || "Noto Sans JP",
      size: Number.isFinite(opts.size) ? opts.size : 36,
      color: opts.color || "#ffffff",
      x: Number.isFinite(opts.x) ? opts.x : defaultCenter.x,
      y: Number.isFinite(opts.y) ? opts.y : defaultCenter.y,
      s: 1,
      r: Number.isFinite(opts.r) ? opts.r : 0,
      opacity: Number.isFinite(opts.opacity) ? opts.opacity : 1,
      effect: opts.effect || "none",
      effectColor: opts.effectColor || "#00f5ff",
      effectBlur: Number(opts.effectBlur || 0),
      strokeColor: opts.strokeColor || "#000000",
      strokeWidth: Number(opts.strokeWidth || 0)
    });
    draw();
    pushHistory();
    return id;
  }

  templateSelect?.addEventListener("change", () => loadTemplate(templateSelect.value));
  window.addEventListener("resize", fitCanvas);
  history = [snapshot()];
  notifyHistory();

  return {
    fitCanvas,
    loadTemplate,
    setState,
    setAssets,
    addText,
    clearAll,
    draw,
    exportPngBlob,
    getUsedAssetNames,
    getState,
    getViewScale,
    getViewScaleRange,
    setViewScale,
    setDrawMode,
    setPenOptions,
    setEraserOptions,
    setDrawTool,
    clearDraw,
    applyTextStyleToSelected,
    updateSelectedText,
    removeById,
    upsertImage,
    upsertText,
    undo() {
      if (history.length <= 1) return false;
      const current = history.pop();
      redoStack.push(current);
      restore(history[history.length - 1]);
      notifyHistory();
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      const state = redoStack.pop();
      history.push(state);
      restore(state);
      notifyHistory();
      return true;
    },
    setHistoryListener(fn) {
      historyListener = fn;
      notifyHistory();
    },
    resetAssetSelection() {
      resetAssetSelectionCallback?.();
    },
  };
}
