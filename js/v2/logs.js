// logs.js —— 运行日志条：订阅 h3_scenedirector_log 事件，滚动显示后端
// 关键动作（显存规划/模型装卸/逐段进度）+ 实时显存读数。
// 纯追加视图，不参与 store/载荷；onRemoved 时 dispose 退订。
import { el } from "./util.js";

const MAX_LINES = 300;

export function createLogs(ed, { api }) {
    const root = el("div", "sd2-log");

    const head = el("div", "sd2-log-head");
    head.appendChild(el("span", "lbl", "运行日志"));
    const vram = el("span", "sd2-log-vram", "显存 —");
    head.appendChild(vram);
    head.appendChild(el("span", "sp"));
    const clearBtn = el("button", "sd2-btn mini", "清空");
    const foldBtn = el("button", "sd2-btn mini", "收起");
    head.appendChild(clearBtn);
    head.appendChild(foldBtn);
    root.appendChild(head);

    const body = el("div", "sd2-log-body");
    root.appendChild(body);

    let lines = 0;
    const append = (d) => {
        const t = new Date((d.ts || Date.now() / 1000) * 1000);
        const hh = String(t.getHours()).padStart(2, "0");
        const mi = String(t.getMinutes()).padStart(2, "0");
        const ss = String(t.getSeconds()).padStart(2, "0");
        const row = el("div", "sd2-log-line" + (d.src === "comfy" ? " dim" : ""));
        row.textContent = `[${hh}:${mi}:${ss}] ${d.msg}`;
        body.appendChild(row);
        if (++lines > MAX_LINES) { body.removeChild(body.firstChild); lines--; }
        body.scrollTop = body.scrollHeight;      // 新行自动滚底
        if (d.free_gb >= 0) {
            vram.textContent = `显存 已用 ${d.used_gb} · 余 ${d.free_gb} · 共 ${d.total_gb} GB`;
        }
    };
    const onLog = (e) => append(e.detail || {});
    api.addEventListener("h3_scenedirector_log", onLog);

    clearBtn.addEventListener("click", () => { body.innerHTML = ""; lines = 0; });
    foldBtn.addEventListener("click", () => {
        const hidden = body.classList.toggle("hidden");
        foldBtn.textContent = hidden ? "展开" : "收起";
    });

    return {
        element: root,
        dispose() { api.removeEventListener("h3_scenedirector_log", onLog); },
    };
}
