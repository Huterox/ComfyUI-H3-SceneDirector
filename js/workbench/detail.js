// detail.js —— 片段详情面板（选中段的编辑区）。
//
// 左侧：段提示词的大 textarea（打字只 commit 不重绘，失焦内容保留）；
// 右侧：时长输入（change 才结构重绘，避免打断输入）+ 段级资产图钉
// （图钉 = 只对本段生效的参考图，<Picture> 编号接在全局带图资产之后）。
//
// 图钉来源二选一：从场景资产里挑一张带图的卡（复制引用进 seg.assets），
// 或现场上传新图。点图钉上的 × 移除。

import { globalPicCount, normAsset } from "./state.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function createDetail({ store, backend, getSelected }) {
    const root = el("div", "h3wb-detail");
    const ta = el("textarea", "h3wb-prompt");
    ta.placeholder = "本段提示词（动作/场景/声音描述；开头写承接上段的状态，结尾写收尾状态）";
    const side = el("div", "h3wb-dside");
    root.appendChild(ta);
    root.appendChild(side);

    let cur = -1;
    let pop = null;   // 图钉选择弹层

    // 隐藏文件选择器（上传新图钉用）
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    root.appendChild(fileInput);
    fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        const seg = store.get().segments[cur];
        if (!seg) return;
        try {
            const info = await backend.uploadImage(file);
            seg.assets.push({ category: "场景", name: "", image: info.name,
                              subfolder: info.subfolder || "", note: "" });
            store.commit({ structural: true });
        } catch (e) {
            console.error("[h3-workbench] 图钉上传失败", e);
        }
    });

    ta.addEventListener("input", () => {
        const seg = store.get().segments[cur];
        if (!seg) return;
        seg.prompt = ta.value;
        store.commit();   // 轻量修改：防抖写回，不重绘（保焦点）
    });

    function closePop() {
        if (pop) { pop.remove(); pop = null; }
        document.removeEventListener("click", onDocClick, true);
    }
    function onDocClick(e) {
        if (pop && !pop.contains(e.target)) closePop();
    }

    // 图钉选择弹层：列出场景资产里带图的卡 + "上传新图"
    function openPinPop(anchor) {
        closePop();
        const seg = store.get().segments[cur];
        if (!seg) return;
        pop = el("div", "h3wb-pinpop");
        const gPics = store.get().assets.filter((a) => a.image);
        if (!gPics.length) {
            pop.appendChild(el("div", null, "（场景资产里还没有带图的卡）"));
        }
        for (const a of gPics) {
            const b = el("button");
            const img = document.createElement("img");
            img.src = backend.inputURL(a);
            b.appendChild(img);
            b.appendChild(document.createTextNode(
                (a.category || "资产") + " · " + (a.name || a.image)));
            b.addEventListener("click", () => {
                seg.assets.push({ ...normAsset(a, "场景") });
                store.commit({ structural: true });
                closePop();
            });
            pop.appendChild(b);
        }
        const sep = el("div", "sep");
        pop.appendChild(sep);
        const up = el("button", null, "⤒ 上传新图…");
        up.addEventListener("click", () => { closePop(); fileInput.click(); });
        pop.appendChild(up);
        // 弹层挂到 .h3wb-pins（position:relative）里，定位才生效
        anchor.appendChild(pop);
        document.addEventListener("click", onDocClick, true);
    }

    function renderSide(i) {
        side.innerHTML = "";
        const seg = store.get().segments[i];

        const durWrap = el("div");
        durWrap.appendChild(el("label", "h3wb-label", "时长（秒）"));
        const dur = el("input", "h3wb-durinput");
        dur.type = "number"; dur.min = "0.2"; dur.max = "60"; dur.step = "0.1";
        dur.value = seg ? seg.duration : 5.0;
        dur.addEventListener("change", () => {
            if (!seg) return;
            const v = parseFloat(dur.value);
            seg.duration = Number.isFinite(v) ? Math.min(60, Math.max(0.2, v)) : 5.0;
            store.commit({ structural: true });   // 卡宽/时刻都要重算
        });
        durWrap.appendChild(dur);
        side.appendChild(durWrap);

        const pinWrap = el("div");
        pinWrap.appendChild(el("label", "h3wb-label", "段级图钉（本段参考图）"));
        const pins = el("div", "h3wb-pins");
        if (seg) {
            // 图钉的 <Picture> 序号 = 全局带图资产数 + 段内带图序号
            let pic = globalPicCount(store.get());
            for (const a of seg.assets) {
                if (!a.image) continue;
                pic += 1;
                const pin = el("div", "h3wb-pin");
                pin.title = "<Picture " + pic + "> " + (a.name || a.image);
                const img = document.createElement("img");
                img.src = backend.inputURL(a);
                pin.appendChild(img);
                pin.appendChild(el("i", null, "P" + pic));
                const x = el("u", null, "×");
                x.title = "移除本图钉";
                x.addEventListener("click", () => {
                    seg.assets.splice(seg.assets.indexOf(a), 1);
                    store.commit({ structural: true });
                });
                pin.appendChild(x);
                pins.appendChild(pin);
            }
        }
        const addBtn = el("button", "h3wb-pinadd", "+");
        addBtn.title = "加图钉：从场景资产选择，或上传新图";
        addBtn.addEventListener("click", () => openPinPop(pins));
        pins.appendChild(addBtn);
        pinWrap.appendChild(pins);
        side.appendChild(pinWrap);
    }

    // 切段时重建编辑区；textarea 的值只在切换时写入，打字过程不被重绘打断
    function setSegment(i) {
        if (i === cur) { renderSide(i); return; }
        cur = i;
        closePop();
        const seg = store.get().segments[i];
        ta.value = seg ? seg.prompt : "";
        ta.disabled = !seg;
        renderSide(i);
    }

    function dispose() { closePop(); }

    return { element: root, setSegment, dispose };
}
