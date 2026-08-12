// agentchat.js —— 项目 agent 对话面板（魔法棒「对话改写」）。
//
// 会话按项目绑定（服务端 SQLite，user/SceneDirector/agent_sessions.db），
// 整个工作台共用一条 session；面板按 ⟦target⟧ 标签分拣本段的对话线程。
// 面板状态挂在 ed.chatState 上：结构重绘（段增删/排序）后对话不丢。
//
// 提案契约：回复里最后一个 ```prompt 代码块 = 提案（服务端已解析好
// proposal 字段），「应用此版」写回目标提示词。
import { el } from "./util.js";

export function createAgentChat(ed, { api }) {
    if (!ed.chatState) ed.chatState = {};

    function st(target) {
        const key = String(target);
        if (!ed.chatState[key]) {
            ed.chatState[key] = { open: false, loaded: false,
                                  sending: false, log: [], error: null };
        }
        return ed.chatState[key];
    }

    const isOpen = (target) => st(target).open;
    const project = () => ed.store.resolveRun();

    function toggle(target) {
        const s = st(target);
        s.open = !s.open;
        if (s.open && !s.loaded) {
            s.loading = true;
            loadHistory(target).finally(() => { s.loading = false; ed.render(); });
        }
        ed.render();
    }

    async function loadHistory(target) {
        const s = st(target);
        try {
            const r = await api.fetchApi("/h3_scenedirector/agent/history?project="
                + encodeURIComponent(project()));
            const data = await r.json();
            // 只留本目标的线程：user 带本 target 标签起，到下一条 user 为止
            const thread = [];
            let mine = false;
            for (const m of (data.messages || [])) {
                if (m.role === "user") mine = (m.target === String(target));
                if (mine) thread.push(m);
            }
            s.log = thread;
            s.loaded = true;
            s.error = null;
        } catch (e) {
            s.error = "历史读取失败";
        }
    }

    // --- 气泡 -----------------------------------------------------------------

    function bubble(target, msg, logEl) {
        if (msg.role === "user") {
            const b = el("div", "sd2-chat-msg user");
            b.appendChild(el("div", "tx", msg.text));
            return b;
        }
        if (msg.role === "error") {
            const b = el("div", "sd2-chat-msg err");
            b.appendChild(el("div", "tx", "⚠ " + msg.text));
            return b;
        }
        const b = el("div", "sd2-chat-msg agent");
        b.appendChild(el("div", "tx", msg.text));
        if (msg.proposal) {
            const prop = el("div", "sd2-chat-prop");
            prop.appendChild(el("pre", "pv", msg.proposal));
            const ops = el("div", "ops");
            const apply = el("button", "p", "应用此版");
            apply.type = "button";
            apply.addEventListener("click", (e) => {
                e.preventDefault();
                msg.applyCb?.(msg.proposal);
                apply.textContent = "已应用 ✓";
                apply.disabled = true;
            });
            const copy = el("button", "s", "复制");
            copy.type = "button";
            copy.addEventListener("click", (e) => {
                e.preventDefault();
                navigator.clipboard?.writeText(msg.proposal);
                copy.textContent = "已复制 ✓";
                setTimeout(() => { copy.textContent = "复制"; }, 1200);
            });
            ops.appendChild(apply);
            ops.appendChild(copy);
            prop.appendChild(ops);
            b.appendChild(prop);
        }
        return b;
    }

    function renderLog(target, logEl) {
        const s = st(target);
        logEl.innerHTML = "";
        if (s.loading) {
            logEl.appendChild(el("div", "sd2-chat-hint", "读取对话记录…"));
            return;
        }
        if (!s.log.length) {
            logEl.appendChild(el("div", "sd2-chat-hint",
                "还没有对话：直接说想怎么改，比如「节奏再快一点，加个特写」。"));
        }
        for (const m of s.log) logEl.appendChild(bubble(target, m, logEl));
        if (s.sending) {
            logEl.appendChild(el("div", "sd2-chat-msg agent wait",
                                 "⏳ 项目 agent 思考中…"));
        }
        logEl.scrollTop = logEl.scrollHeight;
    }

    // --- 面板 -----------------------------------------------------------------

    // opts: { name, makeTarget(), assets(), apply(text) }
    function panel(target, opts) {
        const s = st(target);
        const box = el("div", "sd2-chat");

        const hd = el("div", "sd2-chat-hd");
        hd.appendChild(el("b", "", (opts.name || "目标") + " · 对话改写"));
        hd.appendChild(el("span", "note",
            "项目 agent · 与自动创作同一 session，全项目记忆"));
        hd.appendChild(el("span", "sp"));
        const fold = el("button", "x", "× 收起");
        fold.type = "button";
        fold.addEventListener("click", (e) => { e.preventDefault(); toggle(target); });
        hd.appendChild(fold);
        box.appendChild(hd);

        const logEl = el("div", "sd2-chat-log");
        box.appendChild(logEl);

        const inRow = el("div", "sd2-chat-in");
        const inp = el("input", "txt");
        inp.placeholder = "继续对话：不满意直接说，满意点「应用此版」";
        const send = el("button", "go", "发送");
        send.type = "button";
        inRow.appendChild(inp);
        inRow.appendChild(send);
        box.appendChild(inRow);

        async function doSend() {
            const text = inp.value.trim();
            if (!text || s.sending) return;
            inp.value = "";
            s.log.push({ role: "user", text });
            s.sending = true;
            renderLog(target, logEl);
            try {
                const r = await api.fetchApi("/h3_scenedirector/agent/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        project: project(),
                        message: text,
                        target: opts.makeTarget(),
                        assets: opts.assets ? opts.assets() : [],
                    }),
                });
                const data = await r.json();
                if (!r.ok || data.error) {
                    s.log.push({ role: "error",
                                 text: data.error || ("HTTP " + r.status) });
                } else {
                    s.log.push({ role: "assistant", text: data.reply,
                                 proposal: data.proposal, applyCb: opts.apply });
                    if (data.compacted) {
                        s.log.push({ role: "error",
                                     text: "（上下文超长，已自动压缩早期对话）" });
                    }
                }
            } catch (e) {
                s.log.push({ role: "error", text: "请求失败: " + (e?.message || e) });
            } finally {
                s.sending = false;
                renderLog(target, logEl);
                inp.focus();
            }
        }
        send.addEventListener("click", (e) => { e.preventDefault(); doSend(); });
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
            e.stopPropagation();   // 别触发画布的快捷键
        });

        renderLog(target, logEl);
        return box;
    }

    return { panel, toggle, isOpen, st };
}
