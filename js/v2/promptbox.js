// promptbox.js —— 共享提示词组件：promptArea（轻量 commit + @引用 + 🪄对话改写）。
//
// 从 cards.js 拆出（library/cards/video 三处都要用，避免循环依赖）。
// @ 引用条目由调用方的 mentionScope() 提供：{label, insert, key, pinned}；
// 选中时先替换文本插锚点，再回调 onPick(item)（调用方负责挂载 libRefs
// 并局部刷新 chips——不走 structural commit，保住输入焦点）。
// 🪄 按钮只做一件事：调 opts.onWand()（由 agentchat.js 开/关对话面板），
// 自己不碰 LLM——改写是项目 agent 的多轮对话，不是一次性扩写。
import { el } from "./util.js";

export function createPromptBox(ed, { api }) {

    // 提示词框：轻量 commit + @引用 + 🪄
    // opts: { wandTarget, mentionScope(), onPick(item), onWand() }
    function promptArea(getPrompt, setPrompt, opts = {}) {
        const { wandTarget, mentionScope, onPick, onWand } = opts;
        const wrap = el("div", "sd2-pwrap");
        const head = el("div", "sd2-phead");
        head.appendChild(el("span", "lbl", "提示词"));
        if (wandTarget !== null && wandTarget !== undefined && onWand) {
            const wand = el("button", "sd2-wand", "🪄 对话改写");
            wand.type = "button";
            wand.title = "项目 agent 对话改写这段提示词（多轮打磨，满意后点「应用此版」；"
                + "LLM 配置见「服务配置」）";
            wand.addEventListener("click", (e) => {
                e.preventDefault();
                onWand();
            });
            head.appendChild(wand);
        }
        wrap.appendChild(head);

        const ta = el("textarea", "sd2-prompt");
        ta.value = getPrompt();
        ta.placeholder = "描述这一段的画面/运镜/声音；输入 @ 引用资产库的卡";
        ta.addEventListener("input", () => { setPrompt(ta.value); maybeMention(ta); });
        wrap.appendChild(ta);

        // @ 引用弹层：跟随过滤（@后输入字符时按关键字过滤，回删到 @ 恢复全量）
        let pop = null;
        const closePop = () => { pop?.remove(); pop = null; };
        function maybeMention(textarea) {
            if (!mentionScope) return;
            const pos = textarea.selectionStart;
            const before = textarea.value.slice(0, pos);
            const m = /(?:^|[\s，。；、（(\n])[@＠]([\w一-鿿-]{0,12})$/.exec(before);
            if (!m) { closePop(); return; }
            const q = m[1];
            const items = mentionScope().filter((it) => !q || it.label.includes(q));
            if (!items.length) { closePop(); return; }
            closePop();
            pop = el("div", "sd2-mention");
            for (const it of items) {
                const b = el("button", "", it.label);
                b.type = "button";
                b.addEventListener("pointerdown", (e) => {
                    e.preventDefault();   // 不打断输入焦点
                    e.stopPropagation();
                    // 用引用标签替换 @查询 段
                    const start = pos - q.length - 1;
                    textarea.value = textarea.value.slice(0, start) + it.insert + " "
                        + textarea.value.slice(pos);
                    textarea.dispatchEvent(new Event("input"));
                    closePop();
                    textarea.focus();
                    onPick?.(it);   // @ 引用即挂载（v5）：进本段参考块
                });
                pop.appendChild(b);
            }
            wrap.appendChild(pop);
            // 点弹层外关闭（注意弹层按钮用 pointerdown 抢先处理，不会被这里误清）
            setTimeout(() => {
                document.addEventListener("pointerdown", function h(ev) {
                    if (pop && !pop.contains(ev.target)) {
                        closePop();
                        document.removeEventListener("pointerdown", h, true);
                    }
                }, true);
            }, 0);
        }
        return wrap;
    }

    return { promptArea };
}
