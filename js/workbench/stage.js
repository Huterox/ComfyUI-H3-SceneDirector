// SceneDirector 工作台：预览舞台（逐步实时预览 / 海报 / 视频灯箱）+ 进度条
import { t } from "./i18n.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function buildStage(ctx) {
    const box = el("div", "h3sd-stage");
    const screen = el("div", "h3sd-screen");
    screen.appendChild(el("span", "h3sd-thumb-empty", "🎬"));
    const bar = el("div", "h3sd-progress");
    const fill = el("div", "h3sd-progress-fill");
    const label = el("span", "h3sd-progress-label", "0%");
    bar.appendChild(fill);
    bar.appendChild(label);
    box.appendChild(screen);
    box.appendChild(bar);

    let liveSeg = -1;

    const stage = {
        root: box,
        // 逐步实时预览：渲染中的段把投影帧投进舞台
        showLive(d) {
            const i = (d.segment || 0) - 1;
            if (i !== ctx.selected && liveSeg !== i) ctx.selected = i;
            liveSeg = i;
            let img = screen.querySelector("img.h3sd-live");
            let tag = screen.querySelector(".h3sd-livetag");
            if (!img) {
                screen.innerHTML = "";
                img = document.createElement("img");
                img.className = "h3sd-live";
                tag = el("div", "h3sd-livetag");
                screen.appendChild(img);
                screen.appendChild(tag);
            }
            img.src = "data:image/jpeg;base64," + d.image;
            tag.textContent = t("live") + " · 段 " + d.segment + "/" + d.total
                + " · step " + d.step + "/" + d.steps;
        },
        clearLive() { liveSeg = -1; },
        // 静态海报
        showPoster(url) {
            if (liveSeg >= 0) return;   // 实时预览期间不被状态刷新盖掉
            screen.innerHTML = "";
            if (url) {
                const img = document.createElement("img");
                img.src = url;
                screen.appendChild(img);
            } else {
                screen.appendChild(el("span", "h3sd-thumb-empty", "🎬"));
            }
        },
        setProgress(pct, text) {
            fill.style.width = Math.min(100, Math.max(0, pct)) + "%";
            label.textContent = text || Math.round(pct) + "%";
        },
        // 全屏灯箱（图片放大 / 视频播放）
        lightbox(node) {
            const wrap = el("div", "h3sd-lightbox");
            wrap.appendChild(node);
            wrap.addEventListener("click", (e) => {
                if (e.target === wrap) wrap.remove();
            });
            document.body.appendChild(wrap);
        },
    };
    return stage;
}
