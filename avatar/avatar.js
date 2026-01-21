import { createEditor } from "../js/editor.js";

const TYPE_LIST = [
  "カップル自撮りモビィ",
  "クラスアルバム映えモビィ",
  "ストーリー匂わせモビィ",
  "ストーリー撮影班モビィ",
  "ネイルこだわりモビィ",
  "プリクラ拡散モビィ",
  "ロッカー手紙モビィ",
  "体育祭モビィ",
  "制服アレンジモビィ",
  "匂わせプリクラモビィ",
  "図書委員モビィ",
  "図書室まったりモビィ",
  "学級委員モビィ",
  "屋上ひみつ恋モビィ",
  "屋上自由時間モビィ",
  "帰り道デートモビィ",
  "廊下ランウェイモビィ",
  "応援団長モビィ",
  "成績掲示板モビィ",
  "放課後こっそり通話モビィ",
  "放課後即レスモビィ",
  "教科書裏落書きモビィ",
  "文化祭センターステージモビィ",
  "文化祭広報モビィ",
  "昼休みお弁当会モビィ",
  "模試ランキングモビィ",
  "理科室研究モビィ",
  "自習室モビィ",
  "舞台袖実行委員モビィ",
  "裏アカ拡散モビィ",
  "購買前たまり場モビィ",
  "部室たまり場モビィ"
];

const NEON_COLORS = [
  { label: "ネオンピンク", value: "#ff7ad9" },
  { label: "ネオンブルー", value: "#63e6ff" },
  { label: "ネオングリーン", value: "#7cff6b" },
  { label: "ネオンパープル", value: "#b388ff" },
  { label: "ネオンイエロー", value: "#ffe66b" },
];

const DECO_TEMPLATES = [
  { id: "none", label: "なし", file: "" },
  { id: "sparkle", label: "キラキラ", file: "sparkle.png" },
  { id: "heart", label: "ハート", file: "heart.png" },
  { id: "gal", label: "平成ギャル", file: "gal.png" },
  { id: "simple", label: "シンプル枠", file: "simple.png" },
];

const typeSelect = document.getElementById("typeSelect");
const nameInput = document.getElementById("nameInput");
const msgInput = document.getElementById("msgInput");
const typeColorSelect = document.getElementById("typeColorSelect");
const nameColorSelect = document.getElementById("nameColorSelect");
const msgColorSelect = document.getElementById("msgColorSelect");
const decoSelect = document.getElementById("decoSelect");
const decoAlpha = document.getElementById("decoAlpha");
const decoAlphaLabel = document.getElementById("decoAlphaLabel");
const applyBtn = document.getElementById("applyBtn");
const useBtn = document.getElementById("useBtn");
const canvas = document.getElementById("avatarCanvas");
const assetGrid = document.getElementById("assetGrid");

const editor = createEditor({ canvas, templateSelect: null, assetGrid });
editor.fitCanvas();

const WHITE_TEMPLATE = "data:image/svg+xml;utf8," +
  encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='white'/></svg>");
editor.loadTemplate(WHITE_TEMPLATE).catch(() => {});

function clampText(raw, max) {
  return (raw || "")
    .replace(/[\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function populateSelect(select, items) {
  select.innerHTML = "";
  items.forEach((item) => {
    const opt = document.createElement("option");
    if (typeof item === "string") {
      opt.value = item;
      opt.textContent = item;
    } else {
      opt.value = item.value || item.id;
      opt.textContent = item.label || item.value || item.id;
    }
    select.appendChild(opt);
  });
}

function getStickerSrc(typeName) {
  return `./assets/stickers/${typeName}.jpg`;
}

function getDecoSrc(decoId) {
  const t = DECO_TEMPLATES.find((x) => x.id === decoId);
  if (!t || !t.file) return "";
  return `./assets/deco/${t.file}`;
}

function getCanvasCenter() {
  return {
    x: canvas.width / 2,
    y: canvas.height / 2
  };
}

async function applySelections(forceLayout = false) {
  const typeName = typeSelect.value || TYPE_LIST[0];
  const name = clampText(nameInput.value, 20);
  const msg = clampText(msgInput.value, 40);
  const typeColor = typeColorSelect.value || NEON_COLORS[0].value;
  const nameColor = nameColorSelect.value || NEON_COLORS[1].value;
  const msgColor = msgColorSelect.value || NEON_COLORS[2].value;
  const decoId = decoSelect.value || "none";
  const decoAlphaValue = Math.max(0, Math.min(100, Number(decoAlpha.value || 100)));
  const decoOpacity = decoAlphaValue / 100;
  if (decoAlphaLabel) decoAlphaLabel.textContent = String(decoAlphaValue);

  const center = getCanvasCenter();

  try {
    await editor.upsertImage({
      id: "base",
      src: getStickerSrc(typeName),
      name: typeName,
      x: center.x,
      y: center.y,
      s: 0.9,
      r: 0,
      opacity: 1,
      forceLayout
    });
  } catch (e) {
    console.warn("base image load failed", e);
  }

  if (decoId && decoId !== "none") {
    try {
      await editor.upsertImage({
        id: "deco",
        src: getDecoSrc(decoId),
        name: decoId,
        x: center.x,
        y: center.y,
        s: 0.9,
        r: 0,
        opacity: decoOpacity,
        forceLayout
      });
    } catch (e) {
      console.warn("deco image load failed", e);
    }
  } else {
    editor.removeById("deco");
  }

  editor.upsertText({
    id: "typeText",
    text: typeName,
    color: typeColor,
    effect: "glow",
    effectColor: typeColor,
    effectBlur: 18,
    fontFamily: "Yomogi",
    size: 90,
    x: center.x,
    y: canvas.height * 0.12,
    r: 0,
    opacity: 1,
    forceLayout
  });

  editor.upsertText({
    id: "nameText",
    text: name,
    color: nameColor,
    effect: "glow",
    effectColor: nameColor,
    effectBlur: 16,
    fontFamily: "Yomogi",
    size: 110,
    x: canvas.width * 0.9,
    y: canvas.height * 0.9,
    r: (-18 * Math.PI) / 180,
    opacity: 1,
    forceLayout
  });

  editor.upsertText({
    id: "msgText",
    text: msg,
    color: msgColor,
    effect: "glow",
    effectColor: msgColor,
    effectBlur: 14,
    fontFamily: "Yomogi",
    size: 60,
    x: center.x,
    y: canvas.height * 0.9,
    r: 0,
    opacity: 1,
    forceLayout
  });
}

function bindLiveUpdates() {
  const handler = () => applySelections(false);
  typeSelect.addEventListener("change", handler);
  nameInput.addEventListener("input", handler);
  msgInput.addEventListener("input", handler);
  typeColorSelect.addEventListener("change", handler);
  nameColorSelect.addEventListener("change", handler);
  msgColorSelect.addEventListener("change", handler);
  decoSelect.addEventListener("change", handler);
  decoAlpha.addEventListener("input", handler);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function createAvatarDataUrlFromBlob(blob, size = 320) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    ctx.drawImage(img, 0, 0, size, size);
  } finally {
    URL.revokeObjectURL(url);
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

useBtn?.addEventListener("click", async () => {
  try {
    await applySelections(false);
    const blob = await editor.exportPngBlob({ hideUi: true });
    const dataUrl = await createAvatarDataUrlFromBlob(blob, 320);
    const origin = window.location.origin;
    const target = origin === "null" ? "*" : origin;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "mobby-avatar", dataUrl }, target);
    }
  } catch (e) {
    alert("アイコン作成に失敗: " + e.message);
  }
});

applyBtn?.addEventListener("click", async () => {
  try {
    await applySelections(false);
  } catch (e) {
    alert("更新に失敗: " + e.message);
  }
});

populateSelect(typeSelect, TYPE_LIST);
populateSelect(typeColorSelect, NEON_COLORS);
populateSelect(nameColorSelect, NEON_COLORS);
populateSelect(msgColorSelect, NEON_COLORS);
populateSelect(decoSelect, DECO_TEMPLATES);

bindLiveUpdates();
applySelections(true);
