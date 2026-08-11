// assets.js —— 场景资产卡组件。
//
// 资产卡 {category, name, image, subfolder, note}：
//   * 带图的卡 = H3 参考图，按顺序编号 P1..Pn 注入每一段（身份锚），
//     提示词里用 <Picture N> 引用；纯文字卡并入全局文本块；
//   * 分类（角色/场景/物品/风格 datalist，可自由输入）、名称、备注可编辑；
//   * 图片上传：点击缩略图区域选文件，或把图片文件拖到卡上；
//   * 改动任意一张卡都会让整条链重渲（资产进了每一段的条件），
//     头部提示语里写明。
//
// 文件选择器是本组件私有的隐藏 <input type=file>，上传完成写回目标卡后
// structural commit 触发整体重绘。

import { ASSET_CATEGORIES } from "./state.js";

let uid = 0;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function createAssets({ store, backend }) {
    const root = el("section", "h3wb-sec");
    const head = el("label", "h3wb-sec-label",
        "场景资产卡（有图 = 参考图注入每段，按顺序编号 P1..Pn；纯文字 = 写进全局设定。改动会整条重渲）");
    const grid = el("div", "h3wb-cards");
    root.appendChild(head);
    root.appendChild(grid);

    const dlId = "h3wb-assetcats-" + (++uid);

    // 隐藏文件选择器：uploadCard 为 null 表示"上传成一张新卡"，
    // 否则把上传结果写回该卡（换图 / 补图）
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    root.appendChild(fileInput);
    let uploadCard = null;

    async function doUpload(file, card) {
        try {
            const info = await backend.uploadImage(file);
            const target = card || { category: "角色", name: "", image: "", subfolder: "", note: "" };
            target.image = info.name;
            target.subfolder = info.subfolder || "";
            if (!card) store.get().assets.push(target);
            store.commit({ structural: true });
        } catch (e) {
            console.error("[h3-workbench] 图片上传失败", e);
        }
    }

    fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (file) doUpload(file, uploadCard);
    });

    const pickImage = (card) => { uploadCard = card || null; fileInput.click(); };

    // 放大显示：全屏灯箱，点任意处关闭
    function showLightbox(url) {
        const box = el("div", "h3wb-lightbox");
        const img = document.createElement("img");
        img.src = url;
        box.appendChild(img);
        box.appendChild(el("span", "", "×"));
        box.addEventListener("click", () => box.remove());
        document.body.appendChild(box);
    }

    // 缩略图操作菜单：替换图片 / 放大显示（点菜单外任意处关闭）
    function showThumbMenu(thumb, card) {
        if (thumb.querySelector(".h3wb-thumbmenu")) return;   // 已开着就别重复建
        const menu = el("div", "h3wb-thumbmenu");
        const bReplace = el("button", "", "替换图片");
        bReplace.title = "从本机选一张新图（改动会整条重渲）";
        bReplace.addEventListener("click", (e) => {
            e.stopPropagation();
            close();
            pickImage(card);
        });
        const bZoom = el("button", "", "放大显示");
        bZoom.addEventListener("click", (e) => {
            e.stopPropagation();
            close();
            showLightbox(backend.inputURL(card));
        });
        menu.appendChild(bReplace);
        menu.appendChild(bZoom);
        const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
        function close() {
            menu.remove();
            document.removeEventListener("pointerdown", onDoc, true);
        }
        menu.addEventListener("click", (e) => e.stopPropagation());
        document.addEventListener("pointerdown", onDoc, true);
        thumb.appendChild(menu);
    }

    // 拖拽上传：dragover 必须 preventDefault 才会触发 drop
    function bindDrop(zone, card) {
        zone.addEventListener("dragover", (e) => {
            e.preventDefault();
            zone.classList.add("h3wb-drop");
        });
        zone.addEventListener("dragleave", () => zone.classList.remove("h3wb-drop"));
        zone.addEventListener("drop", (e) => {
            e.preventDefault();
            zone.classList.remove("h3wb-drop");
            const file = e.dataTransfer?.files?.[0];
            if (file && file.type.startsWith("image/")) doUpload(file, card);
        });
    }

    function cardEl(card, ord) {
        const elCard = el("div", "h3wb-card");

        // 缩略图 / 上传区（有图点击弹操作菜单：替换图片/放大显示；无图点击直传，可拖拽）
        const thumb = el("div", "h3wb-card-thumb");
        if (card.image) {
            const img = document.createElement("img");
            img.src = backend.inputURL(card);
            img.alt = card.name || card.image;
            thumb.appendChild(img);
            thumb.title = "点击：替换图片 / 放大显示（换图会整条重渲）";
            if (ord > 0) {
                const badge = el("span", "h3wb-pord", "P" + ord);
                badge.title = "<Picture " + ord + ">";
                thumb.appendChild(badge);
            }
        } else {
            thumb.classList.add("h3wb-card-nothumb");
            thumb.textContent = "点击上传\n或拖拽图片到此";
            thumb.title = "上传参考图（角色定妆照 / 场景 / 道具）";
        }
        thumb.addEventListener("click", () => {
            if (card.image) showThumbMenu(thumb, card);
            else pickImage(card);
        });
        bindDrop(thumb, card);
        elCard.appendChild(thumb);

        const del = el("button", "h3wb-x h3wb-card-x", "×");
        del.title = "删除此卡（改动会整条重渲）";
        del.addEventListener("click", () => {
            const cards = store.get().assets;
            cards.splice(cards.indexOf(card), 1);
            store.commit({ structural: true });
        });
        elCard.appendChild(del);

        const cat = el("input", "h3wb-card-cat");
        cat.setAttribute("list", dlId);
        cat.value = card.category;
        cat.placeholder = "分类";
        cat.addEventListener("input", () => { card.category = cat.value; store.commit(); });
        elCard.appendChild(cat);

        const name = el("input", "h3wb-card-name");
        name.value = card.name;
        name.placeholder = "名称（如：无畏机甲）";
        name.addEventListener("input", () => { card.name = name.value; store.commit(); });
        elCard.appendChild(name);

        const note = el("input", "h3wb-card-note");
        note.value = card.note;
        note.placeholder = "备注（可选，拼进提示词）";
        note.addEventListener("input", () => { card.note = note.value; store.commit(); });
        elCard.appendChild(note);

        return elCard;
    }

    function render() {
        grid.innerHTML = "";

        const dl = document.createElement("datalist");
        dl.id = dlId;
        for (const c of ASSET_CATEGORIES) {
            const op = document.createElement("option");
            op.value = c;
            dl.appendChild(op);
        }
        grid.appendChild(dl);

        let ord = 0;   // 只数带图的卡：P1..Pn
        for (const card of store.get().assets) {
            if (card.image) ord += 1;
            grid.appendChild(cardEl(card, ord));
        }

        const add = el("button", "h3wb-addcard", "+ 资产卡");
        add.title = "加一张空卡（点卡的图片区上传参考图；也可以直接把图片文件拖到这里）";
        add.addEventListener("click", () => {
            store.get().assets.push({ category: "角色", name: "", image: "", subfolder: "", note: "" });
            store.commit({ structural: true });
        });
        bindDrop(add, null);   // 拖到按钮上 = 上传成新卡
        grid.appendChild(add);
    }

    return { element: root, render };
}
