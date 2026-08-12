// library.js —— v3 全局设置区：头部（服务状态 + 服务配置入口）+ 全局提示词
// + 资产库（分类 tabs + 卡片网格），以及段级引用 chips（cards/video 复用）。
//
// 资产语义（与后端 payload v5 对齐）：
//   📌常驻 = 注入每一段（身份锚）：进全局文本块 + 每段参考块；
//   ○按需 = 躺在库里不进模型，段内 @ 引用才挂载（插锚点 + 进本段参考块）。
// 引用键 = "类别·名字"，库里唯一（改名/新建时自动去重）。
import { el, uid, uploadImage, refThumbURL, viewURL, splitRel, lightbox,
         assetKey, cardFile, numberAssets } from "./util.js";

const KIND_ICON = { image: "🖼", audio: "🎵", video: "🎬" };

// 库内键唯一：同名同类别自动加 (2)(3)…
export function uniqueCardName(lib, category, name, excludeId) {
    const taken = new Set((lib || [])
        .filter((c) => c.id !== excludeId && (c.category || "参考") === category)
        .map((c) => c.name));
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(name + "(" + i + ")")) i++;
    return name + "(" + i + ")";
}

// 引用数：各段/镜 libRefs 里出现几次
function refCount(state, key) {
    let n = 0;
    for (const list of [state.segments || [], state.shots || []]) {
        for (const s of list) if ((s.libRefs || []).includes(key)) n++;
    }
    return n;
}

function kindOfFile(file) {
    const t = file?.type || "";
    if (t.startsWith("audio/")) return "audio";
    if (t.startsWith("video/")) return "video";
    return "image";
}

// ---------------------------------------------------------------------------
// 段级引用 chips（cards.js / video.js 复用）：返回 {element, update}
// ---------------------------------------------------------------------------

export function segRefChips(ed, { api }, seg) {
    const row = el("div", "sd2-chips");

    function update() {
        row.innerHTML = "";
        row.appendChild(el("span", "lbl", "引用资产"));
        const lib = ed.store.get().library || [];
        seg.libRefs = Array.isArray(seg.libRefs) ? seg.libRefs : [];
        const map = numberAssets(lib, seg.libRefs);
        for (const key of seg.libRefs) {
            const card = lib.find((c) => assetKey(c) === key);
            const hit = map.get(key);
            const chip = el("span", "sd2-chip" + (card ? "" : " miss"));
            if (card && cardFile(card) && (card.kind || "image") === "image") {
                const img = document.createElement("img");
                img.src = refThumbURL(api, { imageFile: cardFile(card) });
                img.loading = "lazy";
                chip.appendChild(img);
            } else if (card) {
                chip.appendChild(el("i", "", KIND_ICON[card.kind] || "📝"));
            } else {
                chip.appendChild(el("i", "", "⚠"));
            }
            chip.appendChild(el("b", "", card ? card.name : key));
            if (hit) chip.appendChild(el("u", "no", "<" + hit.tag[0] + hit.n + ">"));
            const x = el("em", "x", "×");
            x.title = "取消引用（提示词里已写的锚点文本请自行删掉）";
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                seg.libRefs = seg.libRefs.filter((k) => k !== key);
                ed.store.commit();
                update();
            });
            chip.appendChild(x);
            chip.title = card
                ? key + (hit ? " · 锚点 <" + hit.tag + " " + hit.n + ">" : " · 纯文本卡（只进提示词清单）")
                : "这张卡在库里不存在（被删/改名），后端会静默跳过——点 × 清理";
            row.appendChild(chip);
        }
        const addBtn = el("button", "sd2-chip-add", "@ 引用");
        addBtn.type = "button";
        addBtn.title = "挂载库里的卡到本段（进本段参考块；也可在提示词框里直接输入 @）";
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openPicker(addBtn);
        });
        row.appendChild(addBtn);
    }

    function openPicker(anchor) {
        document.querySelectorAll(".sd2-refpick").forEach((p) => p.remove());
        const lib = ed.store.get().library || [];
        const pop = el("div", "sd2-refpick");
        const onDemand = lib.filter((c) => c.pinned === false);
        const pinned = lib.filter((c) => c.pinned !== false);
        const mkItem = (c, disabled) => {
            const key = assetKey(c);
            const b = el("button", disabled ? "dis" : "",
                (KIND_ICON[c.kind] || "📝") + " " + key
                + (disabled ? "（常驻·每段都在）" : ""));
            b.type = "button";
            if (!disabled) {
                b.addEventListener("click", () => {
                    if (!seg.libRefs.includes(key)) {
                        seg.libRefs.push(key);
                        ed.store.commit();
                        update();
                    }
                    pop.remove();
                });
            }
            pop.appendChild(b);
        };
        if (!lib.length) pop.appendChild(el("span", "meta", "资产库还是空的，先去上方添加"));
        onDemand.forEach((c) => mkItem(c, false));
        pinned.forEach((c) => mkItem(c, true));
        document.body.appendChild(pop);
        const r = anchor.getBoundingClientRect();
        pop.style.left = Math.min(r.left, window.innerWidth - 240) + "px";
        pop.style.top = (r.bottom + 4) + "px";
        setTimeout(() => {
            document.addEventListener("pointerdown", function h(ev) {
                if (!pop.contains(ev.target)) {
                    pop.remove();
                    document.removeEventListener("pointerdown", h, true);
                }
            }, true);
        }, 0);
    }

    update();
    return { element: row, update };
}

// ---------------------------------------------------------------------------
// 全局设置区（头部 + 全局提示词 + 资产库）
// ---------------------------------------------------------------------------

export function createLibrary(ed, { api }) {
    const root = el("div", "sd2-lib");

    // 头部：标题 + 服务状态 + 服务配置入口
    const head = el("div", "sd2-lib-head");
    head.appendChild(el("b", "", "全局设置"));
    head.appendChild(el("span", "meta", "风格 / 角色 / 声纹 —— 常驻卡与全局提示词拼接到每一段"));
    head.appendChild(el("span", "sp"));
    const svcLlm = el("span", "meta svc", "LLM：—");
    const svcImg = el("span", "meta svc", "生图：—");
    head.appendChild(svcLlm);
    head.appendChild(svcImg);
    const cfgBtn = el("button", "sd2-btn sm", "服务配置");
    cfgBtn.title = "LLM 与生图服务的端点/密钥（存服务端，不随工作流外泄）";
    cfgBtn.addEventListener("click", () => ed.config?.open());
    head.appendChild(cfgBtn);
    root.appendChild(head);

    // 全局提示词（🪄 对话改写；@ 只列常驻卡——按需卡不在全局清单里）
    // promptArea 只建一次（保 textarea 焦点）；对话面板挂 chatHolder，随 render 刷新
    const gpRow = el("div", "sd2-lib-gp");
    gpRow.appendChild(ed.promptbox.promptArea(
        () => ed.store.get().global.prompt,
        (v) => { ed.store.get().global.prompt = v; ed.store.commit(); },
        { wandTarget: "global", mentionScope: () => pinnedMentionItems(),
          onWand: () => ed.agentchat?.toggle("global") },
    ));
    root.appendChild(gpRow);
    const chatHolder = el("div", "");
    root.appendChild(chatHolder);

    function pinnedMentionItems() {
        const lib = ed.store.get().library || [];
        const map = numberAssets(lib, []);
        return lib.filter((c) => c.pinned !== false).map((c) => {
            const key = assetKey(c);
            const hit = map.get(key);
            return { label: key + "（常驻）", key, pinned: true,
                     insert: hit ? "<" + hit.tag + " " + hit.n + ">" : c.name };
        });
    }

    // 资产库：tabs + 网格
    const libBar = el("div", "sd2-lib-bar");
    libBar.appendChild(el("b", "", "资产库"));
    const tabs = el("div", "sd2-lib-tabs");
    libBar.appendChild(tabs);
    libBar.appendChild(el("span", "sp"));
    libBar.appendChild(el("span", "meta",
        "📌常驻 = 每段注入（身份锚）；○按需 = 段内 @ 引用才进模型"));
    root.appendChild(libBar);
    const grid = el("div", "sd2-lib-grid");
    root.appendChild(grid);

    let activeTab = "全部";

    function categories() {
        const set = new Set();
        for (const c of ed.store.get().library || []) set.add(c.category || "参考");
        return ["全部", ...set];
    }

    function renderTabs() {
        tabs.innerHTML = "";
        for (const cat of categories()) {
            const b = el("button", cat === activeTab ? "on" : "", cat);
            b.type = "button";
            b.addEventListener("click", () => { activeTab = cat; render(); });
            tabs.appendChild(b);
        }
        if (!categories().includes(activeTab)) activeTab = "全部";
    }

    function thumb(c) {
        const box = el("div", "sd2-asset-thumb");
        const f = cardFile(c);
        if (f && (c.kind || "image") === "image") {
            const img = document.createElement("img");
            img.src = refThumbURL(api, { imageFile: f });
            img.loading = "lazy";
            box.appendChild(img);
            box.addEventListener("dblclick", () => lightbox(refThumbURL(api, { imageFile: f }), false));
        } else if (f && c.kind === "video") {
            const v = document.createElement("video");
            const { image, subfolder } = splitRel(f);
            v.src = viewURL(api, image, subfolder, "input");
            v.muted = true;
            v.preload = "metadata";
            box.appendChild(v);
            box.addEventListener("dblclick", () =>
                lightbox(viewURL(api, image, subfolder, "input"), true));
        } else {
            box.appendChild(el("span", "ico", KIND_ICON[c.kind] || "📝"));
        }
        return box;
    }

    function cardEl(c) {
        const key = assetKey(c);
        const card = el("div", "sd2-asset" + (c.pinned !== false ? " pinned" : ""));
        card.appendChild(thumb(c));
        const nameRow = el("div", "sd2-asset-name");
        nameRow.appendChild(el("b", "", c.name || "（未命名）"));
        nameRow.appendChild(el("span", "cat", c.category || "参考"));
        card.appendChild(nameRow);
        if (c.note) card.appendChild(el("div", "sd2-asset-note", c.note));
        const acts = el("div", "sd2-asset-acts");
        const pin = el("button", "pin" + (c.pinned !== false ? " on" : ""),
            c.pinned !== false ? "📌 常驻" : "○ 按需");
        pin.type = "button";
        pin.title = c.pinned !== false
            ? "常驻：注入每一段（身份锚）。点击改为按需"
            : "按需：段内 @ 引用才进模型。点击改为常驻";
        pin.addEventListener("click", () => {
            c.pinned = c.pinned === false;
            ed.store.commit({ structural: true });
        });
        acts.appendChild(pin);
        const editBtn = el("button", "", "编辑");
        editBtn.type = "button";
        editBtn.addEventListener("click", () => openEditor(card, c));
        acts.appendChild(editBtn);
        const n = refCount(ed.store.get(), key);
        if (n > 0) {
            const badge = el("span", "sd2-asset-refs", "引用 " + n);
            badge.title = "被 " + n + " 个片段引用";
            acts.appendChild(badge);
        }
        card.appendChild(acts);
        return card;
    }

    // 卡片编辑弹层：名称/分类/备注 + 删除（删除会顺带清掉各段引用）
    function openEditor(anchorCard, c) {
        document.querySelectorAll(".sd2-asset-edit").forEach((p) => p.remove());
        const lib = ed.store.get().library || [];
        const pop = el("div", "sd2-asset-edit");
        pop.appendChild(el("div", "hd", "编辑资产卡"));
        const nameInp = el("input", "sd2-inp");
        nameInp.value = c.name;
        nameInp.placeholder = "名字（@ 引用时用）";
        const catInp = el("input", "sd2-inp");
        catInp.value = c.category;
        catInp.placeholder = "分类（角色/场景/道具…）";
        catInp.setAttribute("list", "sd2-cat-list");
        const dl = document.createElement("datalist");
        dl.id = "sd2-cat-list";
        for (const cat of categories().slice(1)) dl.appendChild(new Option(cat, cat));
        pop.appendChild(dl);
        const noteInp = el("textarea", "sd2-prompt");
        noteInp.rows = 2;
        noteInp.value = c.note;
        noteInp.placeholder = "备注（进提示词清单的补充描述，可空）";
        for (const [lbl, inp] of [["名字", nameInp], ["分类", catInp], ["备注", noteInp]]) {
            const r = el("div", "row");
            r.appendChild(el("span", "lbl", lbl));
            r.appendChild(inp);
            pop.appendChild(r);
        }
        const ops = el("div", "ops");
        const okBtn = el("button", "p", "完成");
        okBtn.type = "button";
        okBtn.addEventListener("click", () => {
            const newCat = catInp.value.trim() || "参考";
            const newName = uniqueCardName(lib, newCat, nameInp.value.trim() || c.name, c.id);
            const oldKey = assetKey(c);
            c.category = newCat;
            c.name = newName;
            c.note = noteInp.value.trim();
            const newKey = assetKey(c);
            if (newKey !== oldKey) {
                // 改名联动：各段引用键跟着改（不然引用全挂）
                for (const list of [ed.store.get().segments, ed.store.get().shots]) {
                    for (const s of list || []) {
                        s.libRefs = (s.libRefs || []).map((k) => k === oldKey ? newKey : k);
                    }
                }
            }
            ed.store.commit({ structural: true });
            pop.remove();
        });
        const delBtn = el("button", "d", "删除卡");
        delBtn.type = "button";
        delBtn.addEventListener("click", () => {
            const key = assetKey(c);
            const n = refCount(ed.store.get(), key);
            if (n > 0 && !window.confirm(
                "「" + key + "」正被 " + n + " 个片段引用，删除会一并清掉这些引用。继续？")) return;
            const i = lib.indexOf(c);
            if (i >= 0) lib.splice(i, 1);
            for (const list of [ed.store.get().segments, ed.store.get().shots]) {
                for (const s of list || []) {
                    s.libRefs = (s.libRefs || []).filter((k) => k !== key);
                }
            }
            ed.store.commit({ structural: true });
            pop.remove();
        });
        const cancelBtn = el("button", "", "取消");
        cancelBtn.type = "button";
        cancelBtn.addEventListener("click", () => pop.remove());
        ops.appendChild(okBtn);
        ops.appendChild(delBtn);
        ops.appendChild(cancelBtn);
        pop.appendChild(ops);
        document.body.appendChild(pop);
        const r = anchorCard.getBoundingClientRect();
        pop.style.left = Math.min(r.left, window.innerWidth - 320) + "px";
        pop.style.top = Math.max(8, r.top - 40) + "px";
        setTimeout(() => {
            document.addEventListener("pointerdown", function h(ev) {
                if (!pop.contains(ev.target)) {
                    pop.remove();
                    document.removeEventListener("pointerdown", h, true);
                }
            }, true);
        }, 0);
    }

    function addCard() {
        const box = el("div", "sd2-asset add");
        box.innerHTML = "<span>＋</span><em>添加资产</em>";
        box.title = "上传图片/音频/视频建卡（也可直接拖文件进来）";
        const onFiles = async (files) => {
            const lib = ed.store.get().library || [];
            for (const f of files) {
                try {
                    const info = await uploadImage(api, f);
                    const rel = info.subfolder ? info.subfolder + "/" + info.name : info.name;
                    const kind = kindOfFile(f);
                    const cat = activeTab !== "全部" ? activeTab
                        : kind === "audio" ? "音频" : kind === "video" ? "视频" : "角色";
                    lib.push({
                        id: uid(), category: cat,
                        name: uniqueCardName(lib, cat, f.name.replace(/\.[^.]+$/, "")),
                        imageFile: rel, note: "", kind,
                        pinned: true,   // 缺省常驻（对齐旧版"全局资产全量注入"）
                    });
                } catch (err) { console.error("[sd2] 资产上传失败", err); }
            }
            ed.store.get().library = lib;
            ed.store.commit({ structural: true });
        };
        box.addEventListener("click", () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*,audio/*,video/*";
            inp.multiple = true;
            inp.style.display = "none";
            inp.addEventListener("change", () => {
                const fs = [...(inp.files || [])];
                inp.remove();
                if (fs.length) onFiles(fs);
            });
            document.body.appendChild(inp);
            inp.click();
        });
        box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
        box.addEventListener("dragleave", () => box.classList.remove("drop"));
        box.addEventListener("drop", (e) => {
            e.preventDefault();
            box.classList.remove("drop");
            const fs = [...(e.dataTransfer?.files || [])]
                .filter((f) => /^(image|audio|video)\//.test(f.type));
            if (fs.length) onFiles(fs);
        });
        return box;
    }

    function render() {
        renderTabs();
        grid.innerHTML = "";
        const lib = ed.store.get().library || [];
        for (const c of lib) {
            if (activeTab !== "全部" && (c.category || "参考") !== activeTab) continue;
            grid.appendChild(cardEl(c));
        }
        grid.appendChild(addCard());
        // 全局对话改写面板（开关状态在 ed.chatState，随 render 挂载/卸载）
        chatHolder.innerHTML = "";
        if (ed.agentchat?.isOpen("global")) {
            chatHolder.appendChild(ed.agentchat.panel("global", {
                name: "全局提示词",
                makeTarget: () => ({
                    key: "global", name: "全局提示词", task: ed.store.mode(),
                    duration: Number(ed.store.get().segments[0]?.durationSec) || 5.0,
                    text: ed.store.get().global.prompt || "",
                }),
                assets: () => (ed.store.get().library || [])
                    .filter((c) => c.pinned !== false)
                    .map((c) => ({ key: assetKey(c), kind: c.kind || "image",
                                   pinned: true })),
                apply: (v) => {
                    ed.store.get().global.prompt = v;
                    ed.store.commit({ structural: true });
                },
            }));
        }
    }

    // 服务状态摘要（config.js 保存后也会调）
    async function refreshConfig() {
        try {
            const r = await api.fetchApi("/h3_scenedirector/config");
            if (!r.ok) throw new Error("HTTP " + r.status);
            const cfg = await r.json();
            const llm = cfg.llm || {};
            svcLlm.textContent = "LLM："
                + (llm.model ? (llm.api_format === "anthropic" ? "Anthropic" : "OpenAI 兼容")
                    + " · " + llm.model + " ✓" : "未配置");
            const img = cfg.image || {};
            svcImg.textContent = "生图："
                + (img.provider === "seedream" ? "Seedream ✓"
                    : img.provider === "nanobanana" ? "nanobanana ✓" : "未启用");
        } catch (e) {
            svcLlm.textContent = "LLM：读取失败";
            svcImg.textContent = "";
        }
    }

    return { element: root, render, refreshConfig };
}
