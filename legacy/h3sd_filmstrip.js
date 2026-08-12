// SceneDirector 片段胶片带：时间尺 + 每段缩略图 + 缓存状态 + 点选看片 + 重摇本段
// 我们先前工作台的时间轴设计，挂到 Director 编辑器上（数据：timeline +
// /h3_scenedirector/status 的逐段缓存工件）。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function artifactUrl(run, kind, file) {
    return "/view?filename=" + encodeURIComponent(file)
        + "&type=output&subfolder=" + encodeURIComponent(
            "h3_scenedirector/" + run + (kind === "poster" ? "/posters" : ""));
}

// 缓存目录名 = 节点的 run_name widget（后端 make_list 同源），
// 不是 timeline.run（Director 从不写这个字段）
function resolveRun(ed) {
    const w = ed.node?.widgets?.find((x) => x.name === "run_name");
    const v = String(w?.value ?? "").trim().replace(/[\\/]/g, "_").replace(/^\.+/, "");
    return v.slice(0, 64) || "story";
}

async function fetchStatus(ed) {
    const tl = ed.timeline || {};
    // 行结构对齐后端 parse_director 的输出（seg_hash 要算 duration/prompt/nonce
    // 等字段；raw Director 段没有 duration，直接发会被按未缓存处理）
    const rows = (tl.segments || []).map((s) => {
        const dur = parseFloat(s.durationSec);
        const fc = parseInt(s.frameCount ?? s.length, 10);
        const gen = String(s.genImage?.imageFile || "").replace(/\\/g, "/");
        const cut = gen.lastIndexOf("/");
        return {
            duration: Number.isFinite(dur) ? dur : (Number.isFinite(fc) ? fc / 24 : 5.0),
            prompt: String(s.prompt ?? ""),
            nonce: String(s.id ?? ""),
            task: String(s.taskType || tl.global?.taskType || "t2v").split(" — ")[0].trim(),
            audio_mode: null,
            assets: (s.refs || []).map((r) => {
                const rel = String(r?.imageFile || "").replace(/\\/g, "/");
                if (!rel) return null;
                const c = rel.lastIndexOf("/");
                return {
                    category: "场景", name: "",
                    image: c >= 0 ? rel.slice(c + 1) : rel,
                    subfolder: c >= 0 ? rel.slice(0, c) : "",
                    note: "", kind: "image",
                };
            }).filter(Boolean),
            first_frame: gen ? { image: cut >= 0 ? gen.slice(cut + 1) : gen,
                                 subfolder: cut >= 0 ? gen.slice(0, cut) : "" } : null,
            last_frame: null,
        };
    });
    const body = {
        run: resolveRun(ed),
        global_prompt: tl.global?.prompt || "",
        globals: [],
        assets: (tl.global?.refs || []).map((r) => {
            const rel = String(r?.imageFile || "").replace(/\\/g, "/");
            if (!rel) return null;
            const c = rel.lastIndexOf("/");
            return {
                category: "参考",
                name: (c >= 0 ? rel.slice(c + 1) : rel).replace(/\.[^.]+$/, ""),
                image: c >= 0 ? rel.slice(c + 1) : rel,
                subfolder: c >= 0 ? rel.slice(0, c) : "",
                note: "", kind: "image",
            };
        }).filter(Boolean),
        segments: rows,
    };
    try {
        const r = await api.fetchApi("/h3_scenedirector/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (r.ok) return await r.json();
    } catch (e) { /* 后端不可达静默 */ }
    return null;
}

function buildFilmstrip(ed) {
    const root = el("div", "h3sd-filmstrip");
    const ruler = el("div", "h3sd-fs-ruler");
    const track = el("div", "h3sd-fs-track");
    root.appendChild(ruler);
    root.appendChild(track);

    const state = { statuses: [], timer: 0 };

    function fmtTime(sec) {
        const m = Math.floor(sec / 60), s = sec - m * 60;
        return m + ":" + (s < 10 ? "0" : "") + s.toFixed(0).padStart(2, "0").slice(-2);
    }

    function render() {
        const segs = ed.timeline?.segments || [];
        ruler.innerHTML = "";
        track.innerHTML = "";
        let t = 0;
        const total = segs.reduce((a, s) => a + (parseFloat(s.durationSec ?? s.duration) || 5), 0) || 1;
        segs.forEach((s, i) => {
            const dur = parseFloat(s.durationSec ?? s.duration) || 5;
            const pct = Math.max(6, dur / total * 100);
            // 时间尺刻度（段首）
            const tick = el("span", "h3sd-fs-tick", fmtTime(t));
            tick.style.left = (t / total * 100) + "%";
            ruler.appendChild(tick);

            const st = state.statuses[i] || {};
            const cell = el("div", "h3sd-fs-cell" + (i === (ed.selectedIndex ?? 0) ? " sel" : ""));
            cell.style.width = pct + "%";
            cell.title = "段 " + (i + 1) + " · " + dur.toFixed(1) + "s"
                + (st.cached ? " · 已缓存" : st.will_render ? " · 将重渲" : " · 待渲染");
            if (st.poster_file) {
                const img = document.createElement("img");
                img.src = artifactUrl(resolveRun(ed), "poster", st.poster_file);
                img.loading = "lazy";
                cell.appendChild(img);
            } else {
                cell.appendChild(el("span", "h3sd-fs-empty", "🎬"));
            }
            const dotCls = st.cached ? "ok" : st.will_render ? "warn" : "dim";
            cell.appendChild(el("span", "h3sd-fs-dot " + dotCls));
            cell.appendChild(el("span", "h3sd-fs-idx", String(i + 1)));
            if (st.mp4_file) {
                cell.classList.add("playable");
                cell.addEventListener("dblclick", () => playSegment(st.mp4_file));
            }
            cell.addEventListener("click", () => {
                ed.selectedIndex = i;
                ed.updateSelectionUI?.();
                ed.scheduleRender?.();
                render();
            });
            track.appendChild(cell);
            t += dur;
        });
        const end = el("span", "h3sd-fs-tick", fmtTime(t));
        end.style.left = "calc(100% - 24px)";
        ruler.appendChild(end);
    }

    function playSegment(mp4) {
        const wrap = el("div", "h3sd-lightbox");
        const v = document.createElement("video");
        v.src = artifactUrl(resolveRun(ed), "mp4", mp4);
        v.controls = true;
        v.autoplay = true;
        wrap.appendChild(v);
        wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
        document.body.appendChild(wrap);
    }

    // 重摇本段：只勾选当前段（选择运行），交给用户点运行
    root.rebuildSelected = () => {
        const i = ed.selectedIndex ?? 0;
        ed.timeline.runSelectEnabled = true;
        ed.timeline.runSelection = [i];
        ed.updateRunSelectUI?.();
        ed.commit?.(false, { syncTimeline: true });
        render();
    };

    async function refresh() {
        const r = await fetchStatus(ed);
        if (r) {
            state.statuses = r.statuses || [];
            render();
        }
    }

    // 周期刷新 + 时间线变化时刷新
    render();
    refresh();
    state.timer = setInterval(refresh, 4000);
    const origCommit = ed.commit?.bind(ed);
    if (origCommit) {
        ed.commit = (...args) => {
            const out = origCommit(...args);
            render();
            return out;
        };
    }
    return root;
}

function mount(node) {
    const ed = node._minimaxEditor;
    if (!ed || node._h3sdFilmstrip) return;
    node._h3sdFilmstrip = true;
    try {
        const strip = buildFilmstrip(ed);
        // 插到输出条之后、底部面板之前（我们旧工作台时间轴的位置）
        const output = ed.root?.querySelector(".bd-output");
        if (output && output.parentElement) {
            output.parentElement.insertBefore(strip, output.nextSibling);
        } else if (ed.mainBody) {
            ed.mainBody.appendChild(strip);
        }
        // 「重摇本段」按钮放进输出条右侧
        const btn = document.createElement("button");
        btn.className = "bd-btn h3sd-fs-rebuild";
        btn.textContent = "↻ 重摇本段";
        btn.title = "只勾选当前段（选择运行），再点运行即可只重渲本段";
        btn.addEventListener("click", () => {
            strip.rebuildSelected();
            btn.textContent = "已勾选仅本段 ✓";
            setTimeout(() => { btn.textContent = "↻ 重摇本段"; }, 1600);
        });
        if (output) output.appendChild(btn);
    } catch (e) {
        console.warn("[SceneDirector] 胶片带挂载失败（忽略）", e);
    }
}

app.registerExtension({
    name: "h3.scenedirector.filmstrip",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "H3SceneDirectorList") return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            setTimeout(() => mount(this), 1000);
            return r;
        };
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "H3SceneDirectorList") setTimeout(() => mount(node), 1000);
    },
});
