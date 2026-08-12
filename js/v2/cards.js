// cards.js —— v3 模式主区渲染：批量卡（t2v/i2v/r2v）与 fl2v 镜组。
// 全局面板/公共面板已由 library.js 的全局设置区（资产库）取代。
//
// 交互：
//   * 卡上改提示词（轻量 commit 不重绘，保焦点）/秒数（结构重绘）/
//     首帧（i2v/r2v；点击上传、拖拽上传、× 清除、点击放大）/勾选运行/换序/删除；
//   * 引用 chips 行（library.segRefChips）：本段挂载的按需卡，× 取消，@ 引用挂载；
//   * 提示词框 @ 引用：选中 = 插锚点 + 挂载本段（v5「@ 引用即挂载」）；
//   * 🪄 对话改写：开/关 agentchat 面板（项目 agent 多轮改写，提案「应用此版」）。
import { el, uploadImage, refThumbURL, lightbox, setDuration,
         assetKey, numberAssets, taskKeyFromLabel } from "./util.js";
import { segRefChips } from "./library.js";

export function createCards(ed, { api }) {

    // 对话改写的目标描述（后端 compose_wand_message 的输入）
    function chatTarget(key, name, getObj, taskKey) {
        return () => {
            const o = getObj();
            return { key, name, task: taskKey(),
                     duration: Number(o?.durationSec) || 5.0,
                     text: o?.prompt || "" };
        };
    }

    // 资产清单（带给 agent：知道有哪些 @键 可用，不发明新资产）
    function assetBrief() {
        return (ed.store.get().library || []).map((c) => ({
            key: assetKey(c), kind: c.kind || "image", pinned: c.pinned !== false,
        }));
    }

    // --- 通用小件 -----------------------------------------------------------

    function filePicker(onFile) {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.style.display = "none";
        inp.addEventListener("change", () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (f) onFile(f);
        });
        document.body.appendChild(inp);
        inp.click();
    }

    async function doUpload(file) {
        const info = await uploadImage(api, file);
        return info.subfolder ? info.subfolder + "/" + info.name : info.name;
    }

    // 16:9 图槽（i2v 源图 / fl2v 首尾帧）：obj = {imageFile}
    function frameSlot(obj, label, onChange) {
        const slot = el("div", "sd2-frame" + (obj.imageFile ? " has" : ""));
        let clickTimer = 0;
        if (obj.imageFile) {
            const img = document.createElement("img");
            img.src = refThumbURL(api, obj);
            slot.appendChild(img);
            slot.appendChild(el("span", "cap", label));
            const x = el("u", "x", "×");
            x.title = "清除";
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                clearTimeout(clickTimer);
                obj.imageFile = "";
                onChange();
            });
            slot.appendChild(x);
            slot.title = "点击更换；双击放大";
        } else {
            slot.innerHTML = label + "<br>点击上传";
        }
        slot.addEventListener("click", () => {
            clearTimeout(clickTimer);
            clickTimer = setTimeout(() => filePicker(async (f) => {
                try {
                    obj.imageFile = await doUpload(f);
                    onChange();
                } catch (err) { console.error("[sd2] 上传失败", err); }
            }), 260);
        });
        if (obj.imageFile) {
            slot.addEventListener("dblclick", () => {
                clearTimeout(clickTimer);
                lightbox(refThumbURL(api, obj), false);
            });
        }
        return slot;
    }

    // @ 引用候选（v3：列资产库的卡）。选中时 mention 弹层先按 insert 插锚点，
    // 再回调 onPick 挂载（onPick 只挂非常驻且未挂载的）。锚点编号用
    // 「假设已挂载」的口径预算，保证插进去的编号与后端渲染时一致。
    function mentionItems(getSeg) {
        const s = ed.store.get();
        const lib = s.library || [];
        const seg = getSeg?.() || null;
        const curRefs = seg ? (seg.libRefs || []) : [];
        return lib.map((c) => {
            const key = assetKey(c);
            const pinned = c.pinned !== false;
            if (!seg && !pinned) return null;   // 全局提示词只列常驻卡
            const refs = curRefs.includes(key) || pinned ? curRefs : [...curRefs, key];
            const hit = numberAssets(lib, refs).get(key);
            return { key, pinned,
                     label: (pinned ? "📌" : "○") + " " + key,
                     insert: hit ? "<" + hit.tag + " " + hit.n + ">" : c.name };
        }).filter(Boolean);
    }

    function onPickMount(seg, chipsRef) {
        return (item) => {
            if (!seg || item.pinned) return;   // 常驻卡天然在每段，无需挂载
            seg.libRefs = Array.isArray(seg.libRefs) ? seg.libRefs : [];
            if (!seg.libRefs.includes(item.key)) {
                seg.libRefs.push(item.key);
                ed.store.commit();          // 轻量 commit（序列化生效，不重绘保焦点）
                chipsRef?.update();         // chips 行局部刷新
            }
        };
    }

    function statusTag(st) {
        if (!st) return null;
        const [cls, text] = st.cached && !st.will_render ? ["ok", "已缓存"]
            : st.will_render && st.cached ? ["warn", "将级联重渲"]
            : !st.cached ? ["bad", "待渲染"] : ["none", ""];
        if (!text) return null;
        return el("span", "sd2-tag " + cls, text);
    }

    // --- 批量卡（t2v/i2v/r2v） ----------------------------------------------

    function batchCard(seg, i) {
        const s = ed.store.get();
        const mode = ed.store.mode();
        const isR2v = mode === "r2v";
        // i2v/r2v 都显示首帧槽（r2v 可用首帧做锚定；后端 genImage 全任务可读）
        const showFirstFrame = mode === "i2v" || isR2v;

        const card = el("div", "sd2-card" + (i === ed.selectedIndex ? " sel" : ""));
        card.addEventListener("pointerdown", () => {
            if (ed.selectedIndex !== i) { ed.selectedIndex = i; ed.render(); }
        });

        const head = el("div", "sd2-card-head");
        if (s.runSelectEnabled) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = s.runSelection.includes(i);
            cb.title = "勾选=参与本次运行";
            cb.addEventListener("click", (e) => e.stopPropagation());
            cb.addEventListener("change", () => {
                const sel = new Set(s.runSelection);
                if (cb.checked) sel.add(i); else sel.delete(i);
                s.runSelection = [...sel].sort((a, b) => a - b);
                ed.store.commit();
            });
            head.appendChild(cb);
        }
        head.appendChild(el("b", "", "片段 " + (i + 1)));
        const st = ed.statuses?.statuses?.[i];
        head.appendChild(el("span", "meta",
            (Number(seg.durationSec) || 5).toFixed(1) + "s · " + seg.frameCount + " 帧 @24fps · " + mode
            + (st?.seed != null ? " · seed " + st.seed : "")));
        head.appendChild(el("span", "sp"));
        const left = el("button", "sd2-btn sm", "◀");
        left.title = "前移";
        left.addEventListener("click", (e) => {
            e.stopPropagation();
            if (i <= 0) return;
            [s.segments[i - 1], s.segments[i]] = [s.segments[i], s.segments[i - 1]];
            ed.selectedIndex = i - 1;
            ed.store.commit({ structural: true });
        });
        const right = el("button", "sd2-btn sm", "▶");
        right.title = "后移";
        right.addEventListener("click", (e) => {
            e.stopPropagation();
            if (i >= s.segments.length - 1) return;
            [s.segments[i + 1], s.segments[i]] = [s.segments[i], s.segments[i + 1]];
            ed.selectedIndex = i + 1;
            ed.store.commit({ structural: true });
        });
        const del = el("button", "sd2-btn sm danger", "删除");
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            if (s.segments.length <= 1) return;
            s.segments.splice(i, 1);
            ed.store.commit({ structural: true });
        });
        head.appendChild(left);
        head.appendChild(right);
        head.appendChild(del);
        card.appendChild(head);

        const row = el("div", "sd2-card-row");
        if (showFirstFrame) {
            const col = el("div", "sd2-framesrc");
            col.appendChild(el("span", "lbl", isR2v ? "首帧（可选锚定）" : "源图（首帧）"));
            col.appendChild(frameSlot(seg.genImage, "源图",
                () => ed.store.commit({ structural: true })));
            row.appendChild(col);
        }
        const body = el("div", "sd2-card-body");
        const chipsRef = segRefChips(ed, { api }, seg);
        const segKey = "seg:" + i;
        body.appendChild(ed.promptbox.promptArea(
            () => seg.prompt,
            (v) => { seg.prompt = v; ed.store.commit(); },
            { wandTarget: i,
              mentionScope: () => mentionItems(() => seg),
              onPick: onPickMount(seg, chipsRef),
              onWand: () => ed.agentchat?.toggle(segKey) },
        ));
        if (ed.agentchat?.isOpen(segKey)) {
            body.appendChild(ed.agentchat.panel(segKey, {
                name: "片段 " + (i + 1),
                makeTarget: chatTarget(segKey, "片段 " + (i + 1),
                    () => ed.store.get().segments[i],
                    () => taskKeyFromLabel(ed.store.get().segments[i]?.taskType
                        || ed.store.mode())),
                assets: assetBrief,
                apply: (v) => {
                    const sg = ed.store.get().segments[i];
                    if (sg) { sg.prompt = v; ed.store.commit({ structural: true }); }
                },
            }));
        }

        // 时长 + 状态徽标
        const durRow = el("div", "sd2-durrow");
        durRow.appendChild(el("span", "lbl", "秒数"));
        const dur = el("input", "sd2-inp num");
        dur.type = "number"; dur.min = "0.2"; dur.max = "21.3"; dur.step = "0.1";
        dur.value = seg.durationSec;
        dur.addEventListener("change", () => {
            const d = setDuration(parseFloat(dur.value) || 5.0);
            seg.durationSec = d.durationSec;
            seg.frameCount = d.frameCount;
            ed.store.commit({ structural: true });
        });
        durRow.appendChild(dur);
        const stTag = statusTag(st);
        if (stTag) durRow.appendChild(stTag);
        body.appendChild(durRow);

        body.appendChild(chipsRef.element);
        row.appendChild(body);
        card.appendChild(row);
        return card;
    }

    // --- fl2v 镜组 ------------------------------------------------------------

    function fl2vCard(shot, i) {
        const s = ed.store.get();
        const card = el("div", "sd2-card" + (i === ed.selectedIndex ? " sel" : ""));
        card.addEventListener("pointerdown", () => {
            if (ed.selectedIndex !== i) { ed.selectedIndex = i; ed.render(); }
        });
        const head = el("div", "sd2-card-head");
        head.appendChild(el("b", "", "镜 " + (i + 1)));
        head.appendChild(el("span", "meta", (Number(shot.durationSec) || 5).toFixed(1) + "s · "
            + setDuration(shot.durationSec).frameCount + " 帧"));
        head.appendChild(el("span", "sp"));
        const left = el("button", "sd2-btn sm", "◀");
        left.addEventListener("click", (e) => {
            e.stopPropagation();
            if (i <= 0) return;
            [s.shots[i - 1], s.shots[i]] = [s.shots[i], s.shots[i - 1]];
            ed.selectedIndex = i - 1;
            ed.store.commit({ structural: true });
        });
        const right = el("button", "sd2-btn sm", "▶");
        right.addEventListener("click", (e) => {
            e.stopPropagation();
            if (i >= s.shots.length - 1) return;
            [s.shots[i + 1], s.shots[i]] = [s.shots[i], s.shots[i + 1]];
            ed.selectedIndex = i + 1;
            ed.store.commit({ structural: true });
        });
        const del = el("button", "sd2-btn sm danger", "删除");
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            if (s.shots.length <= 1) return;
            s.shots.splice(i, 1);
            ed.store.commit({ structural: true });
        });
        head.appendChild(left);
        head.appendChild(right);
        head.appendChild(del);
        card.appendChild(head);

        const row = el("div", "sd2-card-row");
        const slots = el("div", "sd2-flslots");
        slots.appendChild(frameSlot(shot.startImage, "首帧", () => ed.store.commit({ structural: true })));
        slots.appendChild(el("span", "arr", "→"));
        slots.appendChild(frameSlot(shot.endImage, "尾帧（可空）", () => ed.store.commit({ structural: true })));
        row.appendChild(slots);

        const body = el("div", "sd2-card-body");
        const chipsRef = segRefChips(ed, { api }, shot);
        const shotKey = "shot:" + i;
        body.appendChild(ed.promptbox.promptArea(
            () => shot.prompt,
            (v) => { shot.prompt = v; ed.store.commit(); },
            { wandTarget: "shot:" + i,
              mentionScope: () => mentionItems(() => shot),
              onPick: onPickMount(shot, chipsRef),
              onWand: () => ed.agentchat?.toggle(shotKey) },
        ));
        if (ed.agentchat?.isOpen(shotKey)) {
            body.appendChild(ed.agentchat.panel(shotKey, {
                name: "镜 " + (i + 1),
                makeTarget: chatTarget(shotKey, "镜 " + (i + 1),
                    () => ed.store.get().shots[i], () => "fl2v"),
                assets: assetBrief,
                apply: (v) => {
                    const sh = ed.store.get().shots[i];
                    if (sh) { sh.prompt = v; ed.store.commit({ structural: true }); }
                },
            }));
        }
        const durRow = el("div", "sd2-durrow");
        durRow.appendChild(el("span", "lbl", "本镜秒数"));
        const dur = el("input", "sd2-inp num");
        dur.type = "number"; dur.min = "0.2"; dur.max = "21.3"; dur.step = "0.1";
        dur.value = shot.durationSec;
        dur.addEventListener("change", () => {
            shot.durationSec = setDuration(parseFloat(dur.value) || 5.0).durationSec;
            ed.store.commit({ structural: true });
        });
        durRow.appendChild(dur);
        const total = s.shots.reduce((a, x) => a + (parseFloat(x.durationSec) || 5), 0);
        durRow.appendChild(el("span", "meta", "总时长 = 各镜之和（只读）："
            + total.toFixed(1) + "s"));
        body.appendChild(durRow);
        body.appendChild(chipsRef.element);
        row.appendChild(body);
        card.appendChild(row);
        return card;
    }

    // --- 渲染入口 --------------------------------------------------------------

    function render(main) {
        const s = ed.store.get();
        const mode = ed.store.mode();
        main.innerHTML = "";

        if (mode === "v2v" || mode === "rv2v") {
            ed.videoEditor.render(main);
            return;
        }

        if (ed.store.isFl2v()) {
            if (!s.shots.length) s.shots.push(ed.store.newShot(5.0));
            s.shots.forEach((sh, i) => main.appendChild(fl2vCard(sh, i)));
            return;
        }

        s.segments.forEach((seg, i) => main.appendChild(batchCard(seg, i)));
    }

    return { render };
}
