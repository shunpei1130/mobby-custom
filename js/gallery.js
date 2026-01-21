import {
  collection, doc, addDoc, getDoc, getDocs, query, orderBy, limit,
  serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export function createGallery({ db, uid, gridEl, statusEl, modalEl, modalBodyEl, profileModalEl, profileModalBodyEl }) {
  const designsCol = collection(db, "designs");
  let cachedDocs = [];
  let currentFilter = "all";
  let filterOptions = [];
  const profileCache = new Map();

  function extractMobbyNames(state) {
    const names = new Set();
    const objects = Array.isArray(state?.objects) ? state.objects : [];
    for (const o of objects) {
      if (o?.type !== "img" || typeof o.name !== "string") continue;
      if (!/モビ[ィー]/.test(o.name)) continue;
      names.add(o.name.replace(/モビィ/g, "モビー"));
    }
    return names;
  }

  function buildFilterOptions(items) {
    const set = new Set();
    for (const item of items) {
      const names = extractMobbyNames(item.data?.state);
      for (const name of names) set.add(name);
    }
    return Array.from(set);
  }

  function getUserBestRank(targetUid) {
    if (!targetUid) return null;
    for (let i = 0; i < cachedDocs.length; i += 1) {
      if (cachedDocs[i]?.data?.uid === targetUid) {
        const rank = i + 1;
        if (rank <= 3) return rank;
        return null;
      }
    }
    return null;
  }

  function getFallbackName(nextUid) {
    if (!nextUid) return "user-unknown";
    return `user-${nextUid.slice(0, 6)}`;
  }

  async function fetchProfile(targetUid) {
    if (!targetUid) return null;
    if (profileCache.has(targetUid)) return profileCache.get(targetUid);
    try {
      const ref = doc(db, "profiles", targetUid);
      const snap = await getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      profileCache.set(targetUid, data);
      return data;
    } catch (e) {
      console.warn("profile fetch failed", e);
      profileCache.set(targetUid, null);
      return null;
    }
  }

  async function warmProfileCache(items) {
    const ids = new Set();
    for (const item of items) {
      if (item?.data?.uid) ids.add(item.data.uid);
    }
    await Promise.all(Array.from(ids).map((id) => fetchProfile(id)));
  }

  async function isFollowing(targetUid) {
    if (!uid || !targetUid || uid === targetUid) return false;
    try {
      const ref = doc(db, "profiles", uid, "following", targetUid);
      const snap = await getDoc(ref);
      return snap.exists();
    } catch (e) {
      console.warn("follow check failed", e);
      return false;
    }
  }

  async function isLiked(designId) {
    if (!uid || !designId) return false;
    try {
      const likeRef = doc(db, "designs", designId, "likesByUser", uid);
      const snap = await getDoc(likeRef);
      return snap.exists();
    } catch (e) {
      console.warn("like check failed", e);
      return false;
    }
  }

  async function toggleFollow(targetUid) {
    if (!uid || !targetUid || uid === targetUid) return { isFollowing: false, followersCount: 0 };
    const followingRef = doc(db, "profiles", uid, "following", targetUid);
    const followerRef = doc(db, "profiles", targetUid, "followers", uid);
    const myProfileRef = doc(db, "profiles", uid);
    const targetProfileRef = doc(db, "profiles", targetUid);

    let nextFollowing = false;
    let nextFollowersCount = 0;
    let nextFollowingCount = 0;

    await runTransaction(db, async (tx) => {
      const [followingSnap, mySnap, targetSnap] = await Promise.all([
        tx.get(followingRef),
        tx.get(myProfileRef),
        tx.get(targetProfileRef)
      ]);
      const myCount = Number(mySnap.data()?.followingCount || 0);
      const targetCount = Number(targetSnap.data()?.followersCount || 0);

      if (followingSnap.exists()) {
        tx.delete(followingRef);
        tx.delete(followerRef);
        nextFollowing = false;
        nextFollowingCount = Math.max(0, myCount - 1);
        nextFollowersCount = Math.max(0, targetCount - 1);
      } else {
        tx.set(followingRef, { createdAt: serverTimestamp() });
        tx.set(followerRef, { createdAt: serverTimestamp() });
        nextFollowing = true;
        nextFollowingCount = myCount + 1;
        nextFollowersCount = targetCount + 1;
      }

      tx.set(myProfileRef, { followingCount: nextFollowingCount }, { merge: true });
      tx.set(targetProfileRef, { followersCount: nextFollowersCount }, { merge: true });
    });

    const cached = profileCache.get(targetUid);
    if (cached) {
      cached.followersCount = nextFollowersCount;
      profileCache.set(targetUid, cached);
    }

    return { isFollowing: nextFollowing, followersCount: nextFollowersCount };
  }

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

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function drawStroke(ctx, points, width, color, effect) {
    if (!points?.length) return;
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

  async function renderStateToCanvas(state, canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const fallbackSize = canvas.width || 900;
    let baseSize = Number(state?.canvasW || state?.canvasH || 0);
    let renderScale = 1;
    if (!baseSize) {
      const objects = Array.isArray(state?.objects) ? state.objects : [];
      let maxCoord = 0;
      for (const o of objects) {
        if (o?.type === "path" && Array.isArray(o.points)) {
          for (const p of o.points) {
            maxCoord = Math.max(maxCoord, Number(p.x || 0), Number(p.y || 0));
          }
          continue;
        }
        if (o?.type === "img") {
          const w = Number(o.w || 0);
          const h = Number(o.h || 0);
          const s = Number(o.s || 1);
          maxCoord = Math.max(
            maxCoord,
            Number(o.x || 0) + (w * s) / 2,
            Number(o.y || 0) + (h * s) / 2
          );
          continue;
        }
        if (o?.type === "text") {
          const size = Number(o.size || 0);
          const s = Number(o.s || 1);
          maxCoord = Math.max(
            maxCoord,
            Number(o.x || 0) + (size * s) / 2,
            Number(o.y || 0) + (size * s) / 2
          );
        }
      }
      baseSize = maxCoord > fallbackSize * 1.1 ? Math.ceil(maxCoord * 1.1) : fallbackSize;
      if (baseSize <= fallbackSize * 1.1) {
        renderScale = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      }
    }

    canvas.width = Math.round(baseSize * renderScale);
    canvas.height = Math.round(baseSize * renderScale);
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

    const pad = baseSize * 0.09;
    const w = baseSize - pad * 2;
    const h = baseSize - pad * 2;

    ctx.clearRect(0, 0, baseSize, baseSize);

    const templateUrl = state?.template || "";
    if (templateUrl) {
      try {
        const templateImg = await loadImage(templateUrl);
        ctx.drawImage(templateImg, pad, pad, w, h);
      } catch (_) {
        ctx.fillStyle = "rgba(255,255,255,.06)";
        ctx.fillRect(pad, pad, w, h);
      }
    } else {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(pad, pad, w, h);
    }

    const objects = Array.isArray(state?.objects) ? state.objects : [];
    const imageLoads = objects
      .filter((o) => o.type === "img" && (o.src || o.url))
      .map((o) => {
        const src = o.src || o.url;
        return loadImage(src)
          .then((img) => ({ id: o.id, img }))
          .catch(() => null);
      });

    const loadedImages = (await Promise.all(imageLoads)).filter(Boolean);
    const imageMap = new Map(loadedImages.map((entry) => [entry.id, entry.img]));

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, w, h);
    ctx.clip();
    for (const o of objects) {
      if (o.type === "path") {
        if (o.strokeWidth > 0) {
          drawStroke(ctx, o.points, o.size + o.strokeWidth * 2, o.strokeColor, null);
        }
        drawStroke(ctx, o.points, o.size, o.color, o);
        continue;
      }

      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.r || 0);
      ctx.scale(o.s || 1, o.s || 1);

      if (o.type === "img") {
        const img = imageMap.get(o.id);
        if (img) {
          const w = o.w || img.width;
          const h = o.h || img.height;
          ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
      } else if (o.type === "text") {
        ctx.fillStyle = o.color || "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${o.size || 36}px "${o.fontFamily || "Noto Sans JP"}"`;
        applyEffect(ctx, o.effect, o.effectColor, o.effectBlur);
        if (o.strokeWidth > 0) {
          ctx.lineWidth = o.strokeWidth * 2;
          ctx.strokeStyle = o.strokeColor || "#000000";
          ctx.strokeText(o.text || "", 0, 0);
        }
        ctx.fillText(o.text || "", 0, 0);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function renderCurrent() {
    gridEl.innerHTML = "";

    const filtered = cachedDocs.filter(({ data }) => {
      if (currentFilter === "all") return true;
      const names = extractMobbyNames(data?.state);
      return names.has(currentFilter);
    });

    if (!filtered.length) {
      statusEl.textContent = "まだ投稿がありません。";
      return;
    }

    statusEl.textContent = "";
    filtered.forEach((item, index) => {
      gridEl.appendChild(renderCard(item.id, item.data, index + 1));
    });
  }

  async function fetchTop() {
    statusEl.textContent = "読み込み中...";
    gridEl.innerHTML = "";

    const q = query(designsCol, orderBy("likes", "desc"), limit(30));
    const snap = await getDocs(q);

    cachedDocs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    filterOptions = buildFilterOptions(cachedDocs);
    await warmProfileCache(cachedDocs);
    if (currentFilter !== "all" && !filterOptions.includes(currentFilter)) {
      currentFilter = "all";
    }
    renderCurrent();
  }

  function setFilter(next) {
    currentFilter = next || "all";
    renderCurrent();
  }

  function getFilterOptions() {
    return ["all", ...filterOptions];
  }

  function renderCard(id, data, rank, options = {}) {
    const el = document.createElement("div");
    el.className = "work";

    const title = escapeHtml(data.title || "Untitled");
    const likes = Number(data.likes || 0);
    const preview = data.thumb || data.imageUrl || "";
    const profile = profileCache.get(data.uid);
    const authorName = escapeHtml(profile?.username || profile?.displayName || getFallbackName(data.uid));
    const authorPhoto = profile?.avatarData || "assets/watermark/mobby.png";
    const rankBadge = rank && rank <= 3 ? `<div class="rankBadge rank${rank}">👑 ${rank}位</div>` : "";

    el.innerHTML = `
      ${rankBadge}
      <img src="${preview}" alt="">
      <div class="workBody">
        <button class="workAuthor" type="button" data-profile="1">
          <img class="workAuthorAvatar" src="${authorPhoto}" alt="${authorName}のアイコン">
          <span class="workAuthorName">${authorName}</span>
        </button>
        <div class="workTitle">${title}</div>
        <div class="workMeta">👍 ${likes} / ${formatDate(data.createdAt)}</div>
        <div class="workActions">
          <button class="btn smallBtn" data-like="1">いいね</button>
          <button class="btn smallBtn" data-open="1">コメント</button>
        </div>
      </div>
    `;

    const likeBtn = el.querySelector('[data-like="1"]');
    if (likeBtn) {
      isLiked(id).then((liked) => {
        likeBtn.classList.toggle("liked", liked);
      });
    }

    likeBtn?.addEventListener("click", async () => {
      if (!uid) {
        alert("ログインが必要");
        return;
      }
      try {
        const liked = await toggleLike(id);
        likeBtn?.classList.toggle("liked", liked);
        if (typeof options.afterLike === "function") {
          await options.afterLike();
        } else {
          await fetchTop();
        }
      }
      catch (e) { alert("いいねに失敗: " + e.message); }
    });

    el.querySelector('[data-open="1"]').addEventListener("click", async () => {
      await openModal(id, data);
    });
    el.querySelector('[data-profile="1"]').addEventListener("click", async () => {
      await openProfileModal(data.uid);
    });
    el.addEventListener("click", async (e) => {
      if (e.target.closest("button")) return;
      await openModal(id, data);
    });

    return el;
  }

  async function toggleLike(designId) {
    const designRef = doc(db, "designs", designId);
    const likeRef = doc(db, "designs", designId, "likesByUser", uid);
    let nextLiked = false;

    await runTransaction(db, async (tx) => {
      const designSnap = await tx.get(designRef);
      const likeSnap = await tx.get(likeRef);

      if (!designSnap.exists()) throw new Error("作品が見つかりません");
      const likes = Number(designSnap.data().likes || 0);

      if (likeSnap.exists()) {
        tx.delete(likeRef);
        tx.update(designRef, { likes: Math.max(0, likes - 1) });
        nextLiked = false;
      } else {
        tx.set(likeRef, { createdAt: serverTimestamp() });
        tx.update(designRef, { likes: likes + 1 });
        nextLiked = true;
      }
    });
    return nextLiked;
  }

  async function openProfileModal(targetUid) {
    if (!profileModalEl || !profileModalBodyEl) return;
    if (!targetUid) return;
    const profile = await fetchProfile(targetUid);
    const name = escapeHtml(profile?.username || profile?.displayName || getFallbackName(targetUid));
    const photo = profile?.avatarData || "assets/watermark/mobby.png";
    const bio = escapeHtml(profile?.bio || "").replace(/\n/g, "<br>");
    const followers = Number(profile?.followersCount || 0);
    const following = Number(profile?.followingCount || 0);
    const userRank = getUserBestRank(targetUid);
    const rankBadge = userRank ? `<span class="rankBadge small rank${userRank}">👑 ${userRank}位</span>` : "";
    const canFollow = !!uid && uid !== targetUid;
    const followingState = canFollow ? await isFollowing(targetUid) : false;

    profileModalBodyEl.innerHTML = `
      <div class="profileModalHeader">
        <img class="profileModalAvatar" src="${photo}" alt="${name}のアイコン">
        <div class="profileModalMeta">
          <div class="userName">${name}</div>
          <div class="muted">ID: ${name}</div>
          <div class="profileModalCounts">
            <span>フォロー中 <strong>${following}</strong></span>
            <span>フォロワー <strong id="profileModalFollowers">${followers}</strong></span>
          </div>
        </div>
        ${rankBadge}
        ${canFollow ? `<button id="profileModalFollow" class="btn ${followingState ? "active" : ""}">${followingState ? "フォロー中" : "フォロー"}</button>` : ""}
      </div>
      <div class="profileModalBio">${bio || "<span class=\"muted\">ひとことはまだありません。</span>"}</div>
    `;

    profileModalEl.showModal();

    const followBtn = profileModalBodyEl.querySelector("#profileModalFollow");
    const followersEl = profileModalBodyEl.querySelector("#profileModalFollowers");
    followBtn?.addEventListener("click", async () => {
      if (!uid) {
        alert("ログインが必要");
        return;
      }
      try {
        followBtn.disabled = true;
        const result = await toggleFollow(targetUid);
        followBtn.textContent = result.isFollowing ? "フォロー中" : "フォロー";
        followBtn.classList.toggle("active", result.isFollowing);
        if (followersEl) followersEl.textContent = String(result.followersCount);
      } catch (e) {
        alert("フォローに失敗: " + e.message);
      } finally {
        followBtn.disabled = false;
      }
    });
  }

  async function openModal(designId, data) {
    const authorProfile = await fetchProfile(data.uid);
    const authorName = escapeHtml(authorProfile?.username || authorProfile?.displayName || getFallbackName(data.uid));
    const authorPhoto = authorProfile?.avatarData || "assets/watermark/mobby.png";
    const authorFollowers = Number(authorProfile?.followersCount || 0);
    const canFollow = !!uid && !!data.uid && uid !== data.uid;
    const following = canFollow ? await isFollowing(data.uid) : false;

    const hasState = !!data?.state?.objects?.length || !!data?.state?.template;
    const previewMarkup = hasState
      ? `<canvas id="previewCanvas" class="previewMedia" width="900" height="900"></canvas>`
      : `<img src="${data.imageUrl || ""}" alt="" class="previewMedia">`;

    modalBodyEl.innerHTML = `
      <div class="row" style="align-items:flex-start;">
        ${previewMarkup}
        <div style="flex:1;min-width:240px">
          <div style="font-weight:800;font-size:18px">${escapeHtml(data.title || "Untitled")}</div>
          <div class="muted">👍 ${Number(data.likes || 0)} / ${formatDate(data.createdAt)}</div>
          <div class="authorRow">
            <img src="${authorPhoto}" alt="${authorName}のアイコン">
            <div class="authorMeta">
              <div class="userName">${authorName}</div>
              <div class="muted">ID: ${authorName} / フォロワー <span id="authorFollowersCount">${authorFollowers}</span></div>
            </div>
            ${canFollow ? `<button id="followBtn" class="btn smallBtn ${following ? "active" : ""}">${following ? "フォロー中" : "フォロー"}</button>` : ""}
          </div>

          <div class="row" style="margin-top:10px">
            <input id="commentInput" class="input" maxlength="140" placeholder="コメントを書く！（140文字まで）" style="flex:1">
            <button id="commentSend" class="btn primary">送信</button>
          </div>

          <div id="commentList"></div>
        </div>
      </div>
    `;

    modalEl.showModal();

    const previewCanvas = modalBodyEl.querySelector("#previewCanvas");
    if (previewCanvas) {
      await renderStateToCanvas(data.state, previewCanvas);
    }

    const listEl = modalBodyEl.querySelector("#commentList");
    const inputEl = modalBodyEl.querySelector("#commentInput");
    const sendBtn = modalBodyEl.querySelector("#commentSend");
    const followBtn = modalBodyEl.querySelector("#followBtn");
    const followersCountEl = modalBodyEl.querySelector("#authorFollowersCount");

    async function refreshComments() {
      listEl.innerHTML = `<div class="muted">読み込み中...</div>`;
      const commentsCol = collection(db, "designs", designId, "comments");
      const q = query(commentsCol, orderBy("createdAt", "desc"), limit(50));
      const snap = await getDocs(q);

      if (snap.empty) {
        listEl.innerHTML = `<div class="muted">コメントがまだありません。</div>`;
        return;
      }

      listEl.innerHTML = "";
      for (const c of snap.docs) {
        const cd = c.data();
        const div = document.createElement("div");
        div.className = "comment";
        div.innerHTML = `
          <div>${escapeHtml(cd.text || "")}</div>
          <small>${formatDate(cd.createdAt)} / ${shortUid(cd.uid)}</small>
        `;
        listEl.appendChild(div);
      }
    }

    sendBtn.onclick = async () => {
      if (!uid) {
        alert("ログインが必要");
        return;
      }
      const text = (inputEl.value || "").trim();
      if (!text) return;
      inputEl.value = "";
      const commentsCol = collection(db, "designs", designId, "comments");
      await addDoc(commentsCol, { uid, text, createdAt: serverTimestamp() });
      await refreshComments();
    };

    followBtn?.addEventListener("click", async () => {
      if (!uid) {
        alert("ログインが必要");
        return;
      }
      try {
        followBtn.disabled = true;
        const result = await toggleFollow(data.uid);
        followBtn.textContent = result.isFollowing ? "フォロー中" : "フォロー";
        followBtn.classList.toggle("active", result.isFollowing);
        if (followersCountEl) followersCountEl.textContent = String(result.followersCount);
      } catch (e) {
        alert("フォローに失敗: " + e.message);
      } finally {
        followBtn.disabled = false;
      }
    });

    await refreshComments();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[m]));
  }
  function shortUid(u) { return (u || "").slice(0, 6) + "..." }
  function formatDate(ts) {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("ja-JP");
  }

  return {
    fetchTop,
    setFilter,
    getFilterOptions,
    renderCard,
    warmProfileCache,
    extractMobbyNames,
    openProfileModal,
    openModal
  };
}
