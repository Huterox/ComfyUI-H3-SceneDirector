// util.js —— v2 前端公共工具（自写；公式与后端/Director 语义对齐）。

export function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ":" + s.toFixed(s % 1 ? 1 : 0).padStart(2, "0");
}

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function sanitizeRun(name) {
    let v = String(name ?? "").trim().replace(/[\\/]/g, "_").replace(/^\.+/, "");
    if (v.startsWith("{") || v.startsWith("[")) v = "story";
    return v.slice(0, 64) || "story";
}

// 与后端 payload._task_key_from_label 对齐："t2v — 文生视频(Text to Video)" -> "t2v"
export function taskKeyFromLabel(value) {
    let v = String(value || "").split(",[object Object]")[0].trim();
    if (v.includes(" · ")) v = v.split(" · ", 1)[0].trim();
    for (const sep of [" — ", " —— ", " - ", " – "]) {
        if (v.includes(sep)) return v.split(sep, 1)[0].trim();
    }
    return v || "t2v";
}

export const TASK_LABELS = [
    "t2v — 文生视频(Text to Video)",
    "i2v — 图生视频(Image to Video)",
    "fl2v — 首尾帧生视频(First-Last Frame)",
    "r2v — 参考主体生视频(Reference to Video)",
    "v2v — 视频转视频(Video to Video)",
    "rv2v — 参考素材改视频(Reference Video Edit)",
];
export const labelForTask = (k) => TASK_LABELS.find((l) => l.startsWith(k + " ")) || TASK_LABELS[0];

// --- 时长/帧数（MiniMax 17k+5 网格，24fps；上限 512 帧） -------------------
export const MAX_FRAMES = 512;

export function snapFrames(n) {
    n = Math.max(5, parseInt(n, 10) || 5);
    while (n % 17 !== 5) n += 1;
    return n;
}

export function durationToFrames(seconds, fps = 24) {
    const a = Math.max(0.1, Number(seconds) || 0.1);
    let n = snapFrames(Math.max(5, Math.round(a * fps)));
    if (n > MAX_FRAMES) n = MAX_FRAMES - ((MAX_FRAMES - 5) % 17);   // 512 内最大的 17k+5
    return n;
}

// 帧数反推用户向秒数（1 位小数，保证 durationToFrames(sec) == frames）
export function framesToDuration(frames, fps = 24) {
    let sec = Math.floor((frames / fps) * 10) / 10;
    while (sec > 0.1 && durationToFrames(sec, fps) > frames) sec = Math.round((sec - 0.1) * 10) / 10;
    while (durationToFrames(Math.round((sec + 0.1) * 10) / 10, fps) <= frames) {
        sec = Math.round((sec + 0.1) * 10) / 10;
    }
    return sec;
}

export function setDuration(sec) {
    // 用户输入秒 -> {durationSec（贴合网格后回显）, frameCount}
    const frames = durationToFrames(sec, 24);
    return { durationSec: framesToDuration(frames, 24), frameCount: frames };
}

// --- 文件上传与工件 URL ----------------------------------------------------

export async function uploadImage(api, file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    fd.append("overwrite", "false");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!resp.ok) throw new Error("上传失败: HTTP " + resp.status);
    return await resp.json();   // {name, subfolder, type}
}

export function viewURL(api, file, subfolder, type) {
    return api.apiURL("/view?filename=" + encodeURIComponent(file)
        + "&subfolder=" + encodeURIComponent(subfolder || "")
        + "&type=" + (type || "input"));
}

// 参考条目 {imageFile} 可能带相对子目录：拆出 name/subfolder
export function splitRel(rel) {
    rel = String(rel || "").replace(/\\/g, "/");
    const cut = rel.lastIndexOf("/");
    return cut >= 0
        ? { image: rel.slice(cut + 1), subfolder: rel.slice(0, cut) }
        : { image: rel, subfolder: "" };
}

export function refThumbURL(api, ref) {
    const { image, subfolder } = splitRel(ref?.imageFile || ref?.image || "");
    return image ? viewURL(api, image, subfolder, "input") : "";
}

// 输出目录工件（海报/段视频）
export function artifactUrl(api, run, kind, file, cacheTag) {
    let q = "/view?filename=" + encodeURIComponent(file)
        + "&type=output&subfolder=" + encodeURIComponent(
            "h3_scenedirector/" + run + (kind === "poster" ? "/posters" : ""));
    if (cacheTag) q += "&t=" + encodeURIComponent(String(cacheTag));
    return api.apiURL(q);
}

// 全屏灯箱（图片或视频），点空白处关闭
export function lightbox(url, isVideo) {
    const box = el("div", "sd2-lightbox");
    const m = isVideo ? document.createElement("video") : document.createElement("img");
    m.src = url;
    if (isVideo) { m.controls = true; m.autoplay = true; m.loop = true; }
    m.addEventListener("click", (e) => e.stopPropagation());
    box.appendChild(m);
    box.appendChild(el("span", "x", "×"));
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
}

// 宽高比 -> 分辨率（百万像素预算，32 对齐；与 ResolutionSelector 语义一致）
export const ASPECTS = [
    ["1:1 (方形)", 1, 1], ["3:4 (竖版标准)", 3, 4], ["4:3 (标准)", 4, 3],
    ["9:16 (竖屏)", 9, 16], ["16:9 (宽屏)", 16, 9], ["21:9 (超宽)", 21, 9],
];
export function resolveSize(aspectLabel, megapixels) {
    const found = ASPECTS.find((a) => a[0] === aspectLabel) || ASPECTS[4];
    const [, aw, ah] = found;
    const mp = Math.max(0.05, Number(megapixels) || 1.0) * 1e6;
    let w = Math.sqrt(mp * aw / ah);
    let h = mp / w;
    const snap = (v) => Math.max(32, Math.round(v / 32) * 32);
    return { width: snap(w), height: snap(h) };
}
