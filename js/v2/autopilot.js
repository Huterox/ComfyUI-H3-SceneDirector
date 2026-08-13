// autopilot.js —— AI 自动创作抽屉（body 挂载 overlay，契约作用域外故意，
// 与 config.js/lightbox 同款）。
//
// 数据流：
//   开始 → POST /agent/autoplan（带当前工作台快照）→ 轮询 /autoplan/status
//   对话 → POST /agent/autoplan/reply（挂起回答/追改）
//   放弃 → POST /agent/autoplan/cancel
//   应用 → status.draft 落进 store（全量覆盖当前模式舱）→ 自动存项目并切换
// 会话按项目绑定：关掉抽屉再开，步骤流与对话都在（服务端 SQLite）。
import { el, refThumbURL, lightbox } from "./util.js";

export function createAutopilot(ed, { api }) {
    let overlay = null;
    let pollTimer = 0;
    let snap = { status: "idle", steps: [] };
    let chatLog = [];        // [{role, text}]
    let chatLoaded = false;
    let sending = false;

    const project = () => ed.store.resolveRun();

    // --- 后端通道 -------------------------------------------------------------

    async function fetchStatus() {
        try {
            const r = await api.fetchApi("/h3_scenedirector/agent/autoplan/status?project="
                + encodeURIComponent(project()));
            if (r.ok) snap = await r.json();
        } catch (e) { /* 网络抖动：下轮再试 */ }
    }

    async function fetchChat() {
        try {
            const r = await api.fetchApi("/h3_scenedirector/agent/history?project="
                + encodeURIComponent(project()));
            if (!r.ok) return;
            const data = await r.json();
            // 自动创作线程：⟦autoplan⟧ 标签的用户消息 + 其后的 assistant
            const thread = [];
            let mine = false;
            for (const m of (data.messages || [])) {
                if (m.role === "user") {
                    mine = (m.target === "autoplan");
                    if (mine) {
                        // 任务消息只显示"用户想法"一行；追问原样显示
                        const t = m.text || "";
                        const idea = /用户想法：([^\n]+)/.exec(t);
                        thread.push({ role: "user",
                                      text: idea ? idea[1].trim() : t });
                    }
                } else if (mine && m.role === "assistant") {
                    thread.push({ role: "assistant", text: m.text });
                }
            }
            chatLog = thread;
            chatLoaded = true;
        } catch (e) { /* 忽略 */ }
    }

    // --- 渲染 -----------------------------------------------------------------

    function statusBadge(st) {
        const map = { running: ["run", "ReAct Agent 运行中…"],
                      waiting_user: ["ask", "agent 反问中 · 等你回答"],
                      done: ["ok", "已完成 · 待应用"],
                      error: ["bad", "出错了"],
                      cancelled: ["mut", "已放弃"],
                      idle: ["mut", "待开始"] };
        const [cls, text] = map[st] || map.idle;
        return el("span", "sd2-ap-badge " + cls, text);
    }

    function renderSteps(box) {
        box.innerHTML = "";
        if (!snap.steps?.length) {
            box.appendChild(el("div", "sd2-ap-hint",
                "还没有步骤：写下想法，点「开始」让导演 agent 开拍。"));
            return;
        }
        for (const s of snap.steps) {
            const row = el("div", "sd2-ap-step");
            row.appendChild(el("span", "ic", s.icon || "•"));
            row.appendChild(el("span", "tx", s.text || ""));
            box.appendChild(row);
        }
        box.scrollTop = box.scrollHeight;
    }

    function renderProducts(box) {
        box.innerHTML = "";
        const draft = snap.draft;
        if (!draft) {
            box.appendChild(el("div", "sd2-ap-hint", "产物区：素材与分段会出现在这里。"));
            return;
        }
        // 资产卡
        const lib = draft.library || [];
        if (lib.length) {
            box.appendChild(el("div", "sd2-ap-sec", "资产（" + lib.length + "）"));
            const grid = el("div", "sd2-ap-assets");
            for (const c of lib) {
                const card = el("div", "sd2-ap-asset");
                const thumb = el("div", "th");
                if (c.imageFile) {
                    const img = document.createElement("img");
                    img.src = refThumbURL(api, { imageFile: c.imageFile });
                    img.addEventListener("click", () =>
                        lightbox(refThumbURL(api, { imageFile: c.imageFile }), false));
                    thumb.appendChild(img);
                } else {
                    thumb.appendChild(el("span", "nf", "设定卡"));
                }
                card.appendChild(thumb);
                card.appendChild(el("b", "", (c.category || "参考") + "·" + c.name));
                card.appendChild(el("span", "mt",
                    (c.pinned !== false ? "📌常驻" : "○按需")
                    + (c.note ? " · " + c.note.slice(0, 24) : "")));
                grid.appendChild(card);
            }
            box.appendChild(grid);
        }
        // 分段表
        const segs = draft.segments || [];
        if (segs.length) {
            box.appendChild(el("div", "sd2-ap-sec",
                "分镜（" + segs.length + " 段 · 总长 "
                + segs.reduce((a, s) => a + (s.durationSec || 0), 0).toFixed(1) + "s）"));
            const tbl = el("div", "sd2-ap-table");
            for (let i = 0; i < segs.length; i++) {
                const s = segs[i];
                const row = el("div", "row");
                row.appendChild(el("span", "no", String(i + 1)));
                row.appendChild(el("span", "du", (s.durationSec || 0).toFixed(1) + "s"));
                row.appendChild(el("span", "pr", (s.prompt || "").slice(0, 120)));
                row.appendChild(el("span", "rf", (s.libRefs || []).join("、")));
                tbl.appendChild(row);
            }
            box.appendChild(tbl);
        }
        if (!lib.length && !segs.length) {
            box.appendChild(el("div", "sd2-ap-hint", "产物区：素材与分段会出现在这里。"));
        }
    }

    function renderChat(box) {
        box.innerHTML = "";
        if (!chatLog.length) {
            box.appendChild(el("div", "sd2-ap-hint",
                "对话区：agent 拿不准会在这里反问你；你也可以随时插话改需求。"));
        }
        for (const m of chatLog) {
            const b = el("div", "sd2-chat-msg " + (m.role === "user" ? "user" : "agent"));
            b.appendChild(el("div", "tx", m.text || ""));
            box.appendChild(b);
        }
        if (snap.status === "running") {
            box.appendChild(el("div", "sd2-chat-msg agent wait", "⏳ agent 正在干活…"));
        }
        if (snap.status === "error" && snap.error) {
            const b = el("div", "sd2-chat-msg err");
            b.appendChild(el("div", "tx", "⚠ " + snap.error));
            box.appendChild(b);
        }
        box.scrollTop = box.scrollHeight;
    }

    function render() {
        if (!overlay) return;
        const badgeBox = overlay.querySelector(".sd2-ap-badgebox");
        badgeBox.innerHTML = "";
        badgeBox.appendChild(statusBadge(snap.status));
        renderSteps(overlay.querySelector(".sd2-ap-steps"));
        renderProducts(overlay.querySelector(".sd2-ap-prod"));
        renderChat(overlay.querySelector(".sd2-ap-chatlog"));
        const startBtn = overlay.querySelector(".sd2-ap-start");
        startBtn.disabled = snap.status === "running" || sending;
        startBtn.textContent = snap.status === "running" ? "运行中…"
            : (snap.status === "idle" || snap.status === "cancelled" ? "▶ 开始" : "↻ 重新开拍");
        const applyBtn = overlay.querySelector(".sd2-ap-apply");
        const segs = snap.draft?.segments || [];
        const canApply = snap.status !== "running" && segs.length > 0;
        applyBtn.disabled = !canApply;
        applyBtn.textContent = "✓ 应用到工作台"
            + (segs.length ? "（回填资产库 + " + segs.length + " 分段）" : "");
        const stopBtn = overlay.querySelector(".sd2-ap-stop");
        stopBtn.disabled = snap.status === "idle";
    }

    // --- 动作 -----------------------------------------------------------------

    async function start() {
        const idea = overlay.querySelector(".sd2-ap-idea").value.trim();
        if (!idea || snap.status === "running") return;
        sending = true;
        render();
        try {
            const r = await api.fetchApi("/h3_scenedirector/agent/autoplan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    project: project(),
                    idea,
                    mode: ed.store.mode(),
                    workbench: { ...ed.store.projectState(), mode: ed.store.mode() },
                }),
            });
            const data = await r.json();
            if (!r.ok || data.error) {
                chatLog.push({ role: "assistant",
                               text: "⚠ " + (data.error || ("HTTP " + r.status)) });
            } else {
                chatLog.push({ role: "user", text: idea });
            }
        } catch (e) {
            chatLog.push({ role: "assistant", text: "⚠ 请求失败: " + (e?.message || e) });
        } finally {
            sending = false;
            await fetchStatus();
            render();
        }
    }

    async function reply() {
        const inp = overlay.querySelector(".sd2-ap-in");
        const text = inp.value.trim();
        if (!text || sending || snap.status === "running") return;
        sending = true;
        inp.value = "";
        chatLog.push({ role: "user", text });
        render();
        try {
            const r = await api.fetchApi("/h3_scenedirector/agent/autoplan/reply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: project(), message: text }),
            });
            const data = await r.json();
            if (!r.ok || data.error) {
                chatLog.push({ role: "assistant",
                               text: "⚠ " + (data.error || ("HTTP " + r.status)) });
            }
        } catch (e) {
            chatLog.push({ role: "assistant", text: "⚠ 请求失败: " + (e?.message || e) });
        } finally {
            sending = false;
            await fetchStatus();
            render();
        }
    }

    async function cancel() {
        try {
            await api.fetchApi("/h3_scenedirector/agent/autoplan/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: project() }),
            });
        } catch (e) { /* 忽略 */ }
        await fetchStatus();
        render();
    }

    async function apply() {
        const draft = snap.draft;
        if (!draft || !(draft.segments || []).length) return;
        // 1) 落到当前工作台（全量覆盖当前模式舱）
        if (draft.mode && ed.store.mode() !== draft.mode) ed.store.setMode(draft.mode);
        const s = ed.store.get();
        s.global.prompt = draft.global?.prompt || "";
        s.library = (draft.library || []).map((c) => ({ ...c }));
        s.segments = draft.segments.map((x) => ({ ...x }));
        s.shots = [];
        ed.selectedIndex = 0;
        ed.store.commit({ structural: true });
        // 2) 自动存成项目并切换（未保存的用想法起名）
        let name = ed.store.resolveRun();
        if (!name || name === "story" || name.startsWith("__")) {
            const idea = (snap.idea || "AI创作").replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 18);
            name = idea || "AI创作";
        }
        try {
            await api.fetchApi("/h3_scenedirector/project/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, state: ed.store.projectState() }),
            });
            const w = ed.store.runWidget();
            if (w && w.value !== name) { w.value = name; ed.store.commit(); }
        } catch (e) { console.error("[sd2] 自动存项目失败", e); }
        ed.els.refreshProjects();
        close();
    }

    // --- 开合 -----------------------------------------------------------------

    function build() {
        // 抽屉挂 body，但皮肤变量与组件样式都定义在 .mmx-host .sd2 作用域下：
        // 遮罩带 mmx-host、面板带 sd2，把抽屉接回同一套皮肤（契约 16）
        overlay = el("div", "sd2-ap-mask mmx-host");
        const panel = el("div", "sd2 sd2-ap");
        overlay.appendChild(panel);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });

        // 头
        const hd = el("div", "sd2-ap-hd");
        hd.appendChild(el("b", "", "✨ AI 自动创作"));
        const badgeBox = el("span", "sd2-ap-badgebox");
        hd.appendChild(badgeBox);
        hd.appendChild(el("span", "sp"));
        hd.appendChild(el("span", "meta",
            "项目 agent · 与对话改写同一 session · 会话存 SQLite"));
        const x = el("button", "x", "× 关闭");
        x.type = "button";
        x.addEventListener("click", close);
        hd.appendChild(x);
        panel.appendChild(hd);

        // 想法行
        const ideaRow = el("div", "sd2-ap-idearow");
        const idea = el("textarea", "sd2-ap-idea");
        idea.placeholder = "一句话想法，比如：两个女剑客在竹林决斗，三招定胜负，要有对白，30 秒";
        if (snap.idea) idea.value = snap.idea;
        ideaRow.appendChild(idea);
        const startBtn = el("button", "sd2-btn primary sd2-ap-start", "▶ 开始");
        startBtn.type = "button";
        startBtn.addEventListener("click", start);
        ideaRow.appendChild(startBtn);
        panel.appendChild(ideaRow);

        // 主区：左步骤流 / 右产物
        const main = el("div", "sd2-ap-main");
        const left = el("div", "sd2-ap-col");
        left.appendChild(el("div", "sd2-ap-sec", "步骤流"));
        left.appendChild(el("div", "sd2-ap-steps"));
        const right = el("div", "sd2-ap-col wide");
        right.appendChild(el("div", "sd2-ap-prod"));
        main.appendChild(left);
        main.appendChild(right);
        panel.appendChild(main);

        // 对话区
        const chatBox = el("div", "sd2-ap-chat");
        chatBox.appendChild(el("div", "sd2-ap-sec",
            "对话（修订 / 确认 / 反问都在这里；步骤流只放干活记录）"));
        chatBox.appendChild(el("div", "sd2-ap-chatlog"));
        const inRow = el("div", "sd2-chat-in");
        const inp = el("input", "txt sd2-ap-in");
        inp.placeholder = "回复 agent…（它问完才会继续；也可以随时插话改需求）";
        const send = el("button", "go", "发送");
        send.type = "button";
        send.addEventListener("click", reply);
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); reply(); }
            e.stopPropagation();
        });
        inRow.appendChild(inp);
        inRow.appendChild(send);
        chatBox.appendChild(inRow);
        panel.appendChild(chatBox);

        // 底栏
        const ft = el("div", "sd2-ap-ft");
        const stop = el("button", "sd2-btn sd2-ap-stop", "× 放弃本次");
        stop.type = "button";
        stop.addEventListener("click", cancel);
        ft.appendChild(stop);
        ft.appendChild(el("span", "meta",
            "agent 逐步调用工具，产物随出随审；渲染仍由你手动触发"));
        ft.appendChild(el("span", "sp"));
        const applyBtn = el("button", "sd2-btn primary sd2-ap-apply", "✓ 应用到工作台");
        applyBtn.type = "button";
        applyBtn.addEventListener("click", apply);
        ft.appendChild(applyBtn);
        panel.appendChild(ft);

        document.body.appendChild(overlay);
    }

    async function tick() {
        const wasRunning = snap.status === "running";
        await fetchStatus();
        if (wasRunning && snap.status !== "running") await fetchChat();  // 跑完补一轮对话
        render();
    }

    function open() {
        if (overlay) return;
        snap = { status: "idle", steps: [] };
        chatLog = [];
        chatLoaded = false;
        build();
        (async () => {
            await fetchStatus();
            await fetchChat();
            if (snap.idea) overlay.querySelector(".sd2-ap-idea").value = snap.idea;
            render();
        })();
        pollTimer = setInterval(tick, 1600);
    }

    function close() {
        clearInterval(pollTimer);
        pollTimer = 0;
        overlay?.remove();
        overlay = null;
    }

    function dispose() { close(); }

    return { open, close, dispose,
             get isOpen() { return !!overlay; } };
}
