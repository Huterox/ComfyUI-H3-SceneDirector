// cards.js —— v2 模式主区渲染：批量卡（t2v/i2v/r2v）、fl2v 镜组、
// 全局面板、r2v 公共参数面板。设计图：ui_mockups/*.png。
//
// 交互：
//   * 卡上改提示词（轻量 commit 不重绘，保焦点）/秒数（结构重绘）/
//     参考图（点击上传、拖拽上传、× 清除、点击放大）/勾选运行/换序/删除；
//   * 每段提示词框带 🪄（调 enhance.js，结果内联预览-确认-应用）；
//   * 提示词框支持 @ 引用（图片/音频/视频编号插入 <Picture N> 等）；
//   * 段参考图编号接在全局图片之后（对齐后端 <Picture N> 语义）。
import { el, fmtTime, uploadImage, refThumbURL, lightbox, splitRel,
         setDuration } from "./util.js";

export function createCards(ed, { api }) {

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

    // 参考图槽（绝对编号 index，0 基；label 显示 图片{index+1}）
    function refSlot(refList, index, onChange) {
        const ref = refList.find((r) => Number(r.index) === index && r.imageFile);
        const slot = el("div", "sd2-ref" + (ref ? " has" : ""));
        if (ref) {
            const img = document.createElement("img");
            img.src = refThumbURL(api, ref);
            img.loading = "lazy";
            slot.appendChild(img);
            slot.appendChild(el("span", "tag", "图片" + (index + 1)));
            const x = el("u", "x", "×");
            x.title = "清除这张图";
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                const i = refList.indexOf(ref);
                if (i >= 0) refList.splice(i, 1);
                onChange();
            });
            slot.appendChild(x);
            slot.title = "点击更换；双击放大";
            slot.addEventListener("dblclick", () => lightbox(refThumbURL(api, ref), false));
        } else {
            slot.textContent = "图片" + (index + 1);
            slot.title = "点击上传参考图（也可直接拖图进来）";
        }
        slot.addEventListener("click", () => filePicker(async (f) => {
            try {
                const rel = await doUpload(f);
                const old = refList.find((r) => Number(r.index) === index);
                if (old) old.imageFile = rel;
                else refList.push({ index, imageFile: rel });
                onChange();
            } catch (err) { console.error("[sd2] 上传失败", err); }
        }));
        slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("drop"); });
        slot.addEventListener("dragleave", () => slot.classList.remove("drop"));
        slot.addEventListener("drop", (e) => {
            e.preventDefault();
            slot.classList.remove("drop");
            const f = e.dataTransfer?.files?.[0];
            if (f && f.type.startsWith("image/")) {
                doUpload(f).then((rel) => {
                    const old = refList.find((r) => Number(r.index) === index);
                    if (old) old.imageFile = rel;
                    else refList.push({ index, imageFile: rel });
                    onChange();
                }).catch((err) => console.error("[sd2] 上传失败", err));
            }
        });
        return slot;
    }

    // 16:9 图槽（i2v 源图 / fl2v 首尾帧）：obj = {imageFile}
    function frameSlot(obj, label, onChange) {
        const slot = el("div", "sd2-frame" + (obj.imageFile ? " has" : ""));
        if (obj.imageFile) {
            const img = document.createElement("img");
            img.src = refThumbURL(api, obj);
            slot.appendChild(img);
            slot.appendChild(el("span", "cap", label));
            const x = el("u", "x", "×");
            x.title = "清除";
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                obj.imageFile = "";
                onChange();
            });
            slot.appendChild(x);
            slot.addEventListener("dblclick", () => lightbox(refThumbURL(api, obj), false));
        } else {
            slot.innerHTML = label + "<br>点击上传";
        }
        slot.addEventListener("click", () => filePicker(async (f) => {
            try {
                obj.imageFile = await doUpload(f);
                onChange();
            } catch (err) { console.error("[sd2] 上传失败", err); }
        }));
        return slot;
    }

    // 音频槽（r2v 公共面板）
    function audioSlot(refList, index, onChange) {
        const ref = refList.find((r) => Number(r.index) === index && r.audioFile);
        const slot = el("div", "sd2-audio" + (ref ? " has" : ""));
        slot.textContent = ref ? "音频" + (index + 1) + " · " + splitRel(ref.audioFile).image : "音频" + (index + 1);
        if (ref) {
            const x = el("u", "x", "×");
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                refList.splice(refList.indexOf(ref), 1);
                onChange();
            });
            slot.appendChild(x);
        }
        slot.addEventListener("click", () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "audio/*";
            inp.style.display = "none";
            inp.addEventListener("change", async () => {
                const f = inp.files && inp.files[0];
                inp.remove();
                if (!f) return;
                try {
                    const rel = await doUpload(f);   // /upload/image 对音频同样可用
                    const old = refList.find((r) => Number(r.index) === index);
                    if (old) old.audioFile = rel;
                    else refList.push({ index, audioFile: rel });
                    onChange();
                } catch (err) { console.error("[sd2] 上传失败", err); }
            });
            document.body.appendChild(inp);
            inp.click();
        });
        return slot;
    }

    // 视频槽（r2v 公共面板；上传走 /upload/image 通道）
    function videoSlot(refList, index, onChange) {
        const ref = refList.find((r) => Number(r.index) === index && r.videoFile);
        const slot = el("div", "sd2-video" + (ref ? " has" : ""));
        slot.textContent = ref ? "视频" + (index + 1) + " · " + splitRel(ref.videoFile).image : "视频" + (index + 1);
        if (ref) {
            const x = el("u", "x", "×");
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                refList.splice(refList.indexOf(ref), 1);
                onChange();
            });
            slot.appendChild(x);
        }
        slot.addEventListener("click", () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "video/*";
            inp.style.display = "none";
            inp.addEventListener("change", async () => {
                const f = inp.files && inp.files[0];
                inp.remove();
                if (!f) return;
                try {
                    const rel = await doUpload(f);
                    const old = refList.find((r) => Number(r.index) === index);
                    if (old) old.videoFile = rel;
                    else refList.push({ index, videoFile: rel });
                    onChange();
                } catch (err) { console.error("[sd2] 上传失败", err); }
            });
            document.body.appendChild(inp);
            inp.click();
        });
        return slot;
    }

    // 提示词框：轻量 commit + @引用 + 🪄
    function promptArea(getPrompt, setPrompt, wandTarget, mentionScope) {
        const wrap = el("div", "sd2-pwrap");
        const head = el("div", "sd2-phead");
        head.appendChild(el("span", "lbl", "提示词"));
        const wand = el("button", "sd2-wand", "🪄 扩写");
        wand.type = "button";
        wand.title = "LLM 扩写这段提示词（用增强器里的配置；结果先预览，确认才应用）";
        wand.addEventListener("click", (e) => {
            e.preventDefault();
            ed.enhancer.enhanceTarget(wandTarget);
        });
        head.appendChild(wand);
        wrap.appendChild(head);

        const ta = el("textarea", "sd2-prompt");
        ta.value = getPrompt();
        ta.placeholder = "描述这一段的画面/运镜/声音；输入 @ 引用参考素材";
        ta.addEventListener("input", () => { setPrompt(ta.value); maybeMention(ta); });
        wrap.appendChild(ta);

        // @ 引用弹层
        let pop = null;
        const closePop = () => { pop?.remove(); pop = null; };
        function maybeMention(textarea) {
            const v = textarea.value.slice(0, textarea.selectionStart);
            if (!v.endsWith("@")) { closePop(); return; }
            closePop();
            const items = mentionScope();   // [{label, insert}]
            if (!items.length) return;
            pop = el("div", "sd2-mention");
            for (const it of items) {
                const b = el("button", "", it.label);
                b.type = "button";
                b.addEventListener("click", () => {
                    const pos = textarea.selectionStart;
                    textarea.value = textarea.value.slice(0, pos) + it.insert + " " + textarea.value.slice(pos);
                    textarea.dispatchEvent(new Event("input"));
                    closePop();
                    textarea.focus();
                });
                pop.appendChild(b);
            }
            wrap.appendChild(pop);
            document.addEventListener("pointerdown", function h(ev) {
                if (pop && !pop.contains(ev.target)) { closePop(); document.removeEventListener("pointerdown", h, true); }
            }, true);
        }
        return wrap;
    }

    // 增强预览块（内联在卡里；ed.preview 由 enhance.js 写）
    function previewBlock(target) {
        const p = ed.preview;
        if (!p || p.target !== target) return null;
        const box = el("div", "sd2-pv");
        box.appendChild(el("div", "hd", "🪄 结果预览 · " + p.name + " · 确认后应用"));
        box.appendChild(el("pre", "tx", p.text));
        const ops = el("div", "ops");
        const close = () => { ed.preview = null; ed.render(); };
        const mk = (label, cls, fn) => {
            const b = el("button", cls, label);
            b.type = "button";
            b.addEventListener("click", (e) => { e.preventDefault(); fn(); });
            ops.appendChild(b);
        };
        mk("应用", "p", () => { ed.enhancer.applyPreview(); });
        mk("复制", "s", () => { navigator.clipboard?.writeText(p.text); });
        mk("丢弃", "d", close);
        box.appendChild(ops);
        return box;
    }

    // --- 批量卡（t2v/i2v/r2v） ----------------------------------------------

    function batchCard(seg, i) {
        const s = ed.store.get();
        const mode = ed.store.mode();
        const isR2v = mode === "r2v";
        const isI2v = mode === "i2v";
        const picOff = (s.global.refs || []).length;
        const maxSlots = Math.max(1, 9 - picOff);

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
        head.appendChild(el("b", "", "提示词组 " + (i + 1)));
        const st = ed.statuses?.statuses?.[i];
        head.appendChild(el("span", "meta",
            seg.durationSec.toFixed(1) + "s · " + seg.frameCount + " 帧 @24fps"
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
        if (isI2v) {
            const col = el("div", "sd2-framesrc");
            col.appendChild(el("span", "lbl", "源图（首帧）"));
            col.appendChild(frameSlot(seg.genImage, "源图",
                () => ed.store.commit({ structural: true })));
            row.appendChild(col);
        }
        const body = el("div", "sd2-card-body");
        body.appendChild(promptArea(
            () => seg.prompt,
            (v) => { seg.prompt = v; ed.store.commit(); },
            i,
            () => mentionItems(i),
        ));
        const pv = previewBlock(i);
        if (pv) body.appendChild(pv);

        // 时长 + 参考图
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

        const refsWrap = el("div", "sd2-refs");
        for (let k = 0; k < maxSlots; k++) {
            refsWrap.appendChild(refSlot(seg.refs, picOff + k,
                () => ed.store.commit({ structural: true })));
        }
        body.appendChild(refsWrap);
        row.appendChild(body);
        card.appendChild(row);
        return card;
    }

    function statusTag(st) {
        if (!st) return null;
        const [cls, text] = st.cached && !st.will_render ? ["ok", "已缓存"]
            : st.will_render && st.cached ? ["warn", "将级联重渲"]
            : !st.cached ? ["bad", "待渲染"] : ["none", ""];
        if (!text) return null;
        return el("span", "sd2-tag " + cls, text);
    }

    function mentionItems(i) {
        const s = ed.store.get();
        const items = [];
        (s.global.refs || []).forEach((r) => {
            items.push({ label: "图片" + (Number(r.index) + 1), insert: "<Picture " + (Number(r.index) + 1) + ">" });
        });
        (s.global.refAudios || []).forEach((r) => {
            items.push({ label: "音频" + (Number(r.index) + 1), insert: "<Audio " + (Number(r.index) + 1) + ">" });
        });
        (s.global.refVideos || []).forEach((r) => {
            items.push({ label: "视频" + (Number(r.index) + 1), insert: "<Video " + (Number(r.index) + 1) + ">" });
        });
        const seg = s.segments[i];
        (seg?.refs || []).forEach((r) => {
            items.push({ label: "图片" + (Number(r.index) + 1), insert: "<Picture " + (Number(r.index) + 1) + ">" });
        });
        return items;
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
        head.appendChild(el("span", "meta", shot.durationSec.toFixed(1) + "s · "
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
        body.appendChild(promptArea(
            () => shot.prompt,
            (v) => { shot.prompt = v; ed.store.commit(); },
            "shot:" + i,
            () => mentionItems(0),
        ));
        const pv = previewBlock("shot:" + i);
        if (pv) body.appendChild(pv);
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
        row.appendChild(body);
        card.appendChild(row);
        return card;
    }

    // --- 全局面板 / r2v 公共面板 ----------------------------------------------

    function globalPanel() {
        const s = ed.store.get();
        const panel = el("div", "sd2-panel");
        const head = el("div", "sd2-card-head");
        head.appendChild(el("b", "", "全局提示词 & 参考图 (图片1–9)"));
        head.appendChild(el("span", "meta", "拼接到每个提示词组；参考图供各组读取"));
        panel.appendChild(head);
        const row = el("div", "sd2-card-row");
        const left = el("div", "sd2-card-body");
        left.appendChild(promptArea(
            () => s.global.prompt,
            (v) => { s.global.prompt = v; ed.store.commit(); },
            "global",
            () => mentionItems(-1),
        ));
        const pv = previewBlock("global");
        if (pv) left.appendChild(pv);
        row.appendChild(left);
        const refsWrap = el("div", "sd2-refs nine");
        for (let k = 0; k < 9; k++) {
            refsWrap.appendChild(refSlot(s.global.refs, k, () => ed.store.commit({ structural: true })));
        }
        row.appendChild(refsWrap);
        panel.appendChild(row);
        return panel;
    }

    function r2vCommonPanel() {
        const s = ed.store.get();
        const g = s.global;
        const panel = el("div", "sd2-panel common");
        const head = el("div", "sd2-card-head");
        head.appendChild(el("b", "", "公共参数（所有素材组共享）"));
        head.appendChild(el("span", "meta", "公共参考图/音频/视频供各组读取；公共提示词拼接到每组前面"));
        panel.appendChild(head);

        panel.appendChild(promptArea(
            () => g.prompt,
            (v) => { g.prompt = v; ed.store.commit(); },
            "global",
            () => mentionItems(-1),
        ));
        const pv = previewBlock("global");
        if (pv) panel.appendChild(pv);

        panel.appendChild(el("div", "sd2-sec", "参考图（组内编号接公共之后）"));
        const imgs = el("div", "sd2-refs nine");
        for (let k = 0; k < 9; k++) {
            imgs.appendChild(refSlot(g.refs, k, () => ed.store.commit({ structural: true })));
        }
        panel.appendChild(imgs);

        const row2 = el("div", "sd2-card-row");
        const audCol = el("div", "sd2-card-body");
        audCol.appendChild(el("div", "sd2-sec", "参考音频（音频1–3）"));
        const auds = el("div", "sd2-refs three");
        for (let k = 0; k < 3; k++) {
            auds.appendChild(audioSlot(g.refAudios, k, () => ed.store.commit({ structural: true })));
        }
        audCol.appendChild(auds);
        row2.appendChild(audCol);
        const vidCol = el("div", "sd2-card-body");
        vidCol.appendChild(el("div", "sd2-sec", "参考视频（视频1–3）"));
        const vids = el("div", "sd2-refs three");
        for (let k = 0; k < 3; k++) {
            vids.appendChild(videoSlot(g.refVideos, k, () => ed.store.commit({ structural: true })));
        }
        vidCol.appendChild(vids);
        row2.appendChild(vidCol);
        panel.appendChild(row2);
        return panel;
    }

    // --- 渲染入口 --------------------------------------------------------------

    function render(main, globalArea) {
        const s = ed.store.get();
        const mode = ed.store.mode();
        main.innerHTML = "";
        globalArea.innerHTML = "";

        if (mode === "v2v" || mode === "rv2v") {
            ed.videoEditor.render(main, globalArea);
            return;
        }

        if (ed.store.isFl2v()) {
            if (!s.shots.length) s.shots.push(ed.store.newShot(5.0));
            s.shots.forEach((sh, i) => main.appendChild(fl2vCard(sh, i)));
            globalArea.appendChild(globalPanel());
            return;
        }

        s.segments.forEach((seg, i) => main.appendChild(batchCard(seg, i)));
        if (mode === "r2v") globalArea.appendChild(r2vCommonPanel());
        else globalArea.appendChild(globalPanel());
    }

    return { render };
}
