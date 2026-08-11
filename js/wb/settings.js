// settings.js —— 场景设定表组件。
//
// 标签 + 内容两行式列表：
//   * 固定首行是"通用"（映射 payload.global_prompt，不可删、标签不可改）；
//   * 其余行 {category, content}：标签自由编辑（datalist 给预设）、
//     内容多行编辑、可删行、可加行；
//   * 每行内容会自动拼到每段提示词前面，所以改动会整条链重渲（头部提示语
//     里写明这一点）。
//
// 组件只改 store.get() 的数据然后 commit，序列化过滤（空内容行丢弃）
// 由 state.serializePayload 统一做。

import { SETTING_CATEGORIES } from "./state.js";

let uid = 0;   // datalist id 需要文档内唯一

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function createSettings({ store }) {
    const root = el("section", "h3wb-sec");
    const head = el("label", "h3wb-sec-label",
        "场景设定表（每行一类，自动拼到每段提示词前面；改动会让整条链重渲）");
    const list = el("div", "h3wb-settings");
    root.appendChild(head);
    root.appendChild(list);

    const dlId = "h3wb-setcats-" + (++uid);

    // 固定"通用"行：自由文本，映射 global_prompt
    function generalRowEl() {
        const row = el("div", "h3wb-setrow");
        const top = el("div", "h3wb-setrow-top");
        const tag = el("input", "h3wb-settag");
        tag.value = "通用";
        tag.disabled = true;
        tag.title = "固定首行：映射 payload.global_prompt，不可删除";
        top.appendChild(tag);
        row.appendChild(top);

        const ta = el("textarea", "h3wb-setcontent");
        ta.rows = 2;
        ta.value = store.get().global_prompt;
        ta.placeholder = "自由文本（主角设定等；提示词里用 <Picture 1> 引用资产卡）";
        ta.addEventListener("input", () => {
            store.get().global_prompt = ta.value;
            store.commit();
        });
        row.appendChild(ta);
        return row;
    }

    // 普通设定行：标签（datalist 预设 + 自由输入）+ 内容 + 删除
    function rowEl(g) {
        const row = el("div", "h3wb-setrow");
        const top = el("div", "h3wb-setrow-top");

        const tag = el("input", "h3wb-settag");
        tag.setAttribute("list", dlId);
        tag.value = g.category;
        tag.placeholder = "标签";
        tag.addEventListener("input", () => {
            g.category = tag.value;
            store.commit();
        });
        top.appendChild(tag);

        const del = el("button", "h3wb-x", "×");
        del.title = "删除本行（改动会整条重渲）";
        del.addEventListener("click", () => {
            const rows = store.get().globals;
            rows.splice(rows.indexOf(g), 1);
            store.commit({ structural: true });
        });
        top.appendChild(del);
        row.appendChild(top);

        const ta = el("textarea", "h3wb-setcontent");
        ta.rows = 2;
        ta.value = g.content;
        ta.placeholder = "内容（如：3D CG 电影感，冷峻暗黑基调，硝烟与火光的体积光）";
        ta.addEventListener("input", () => {
            g.content = ta.value;
            store.commit();
        });
        row.appendChild(ta);
        return row;
    }

    function render() {
        list.innerHTML = "";

        const dl = document.createElement("datalist");
        dl.id = dlId;
        for (const c of SETTING_CATEGORIES) {
            const op = document.createElement("option");
            op.value = c;
            dl.appendChild(op);
        }
        list.appendChild(dl);

        list.appendChild(generalRowEl());          // 固定首行：通用
        for (const g of store.get().globals) list.appendChild(rowEl(g));

        const add = el("button", "h3wb-addrow", "+ 加设定行");
        add.addEventListener("click", () => {
            store.get().globals.push({ category: "视觉风格", content: "" });
            store.commit({ structural: true });
        });
        list.appendChild(add);
    }

    return { element: root, render };
}
