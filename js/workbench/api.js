// SceneDirector 工作台：后端 API 封装 + 实时事件订阅
// 路由见 director/routes.py；事件见 director/executor.py 顶部常量。
import { api } from "../../scripts/api.js";

async function post(path, body) {
    const r = await api.fetchApi(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch (e) { /* 空 */ }
        throw new Error(msg);
    }
    return r.json();
}

export const backend = {
    // 逐段缓存状态（哈希匹配 + 工件名）
    status(payload) { return post("/h3_scenedirector/status", payload); },
    // 源视频元信息
    probe(video, subfolder) { return post("/h3_scenedirector/probe", { video, subfolder }); },
    // 智能分镜切点
    smartSplit(video, subfolder, sensitivity, min_shot) {
        return post("/h3_scenedirector/smart_split",
            { video, subfolder, sensitivity, min_shot });
    },
    // LLM 提示词增强
    enhance(prompt, task, duration, opts) {
        return post("/h3_scenedirector/enhance",
            Object.assign({ prompt, task, duration }, opts || {}));
    },
    // 源视频分块上传（全部块到齐后 done=true，name 为最终落盘名）
    async uploadVideo(file, onProgress) {
        const CHUNK = 4 * 1024 * 1024;
        let offset = 0, name = file.name;
        while (offset < file.size) {
            const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
            const res = await post("/h3_scenedirector/upload_video", {
                name, offset, total: file.size,
                chunk: btoa(String.fromCharCode(...new Uint8Array(buf))),
            });
            offset += buf.byteLength;
            name = res.name;
            if (onProgress) onProgress(offset / file.size);
            if (res.done) return res.name;
        }
        return name;
    },
    // 图片上传走 ComfyUI 官方端点，返回文件名（资产卡/首尾帧用）
    async uploadImage(file) {
        const fd = new FormData();
        fd.append("image", file, file.name);
        const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!r.ok) throw new Error("图片上传失败 HTTP " + r.status);
        const j = await r.json();
        return j.name;
    },
    // 缓存工件（海报/mp4）的 URL
    artifactUrl(run, kind, file) {
        return api.apiURL("/view?filename=" + encodeURIComponent(file)
            + "&type=output&subfolder=" + encodeURIComponent("h3_scenedirector/" + run + (kind === "poster" ? "/posters" : "")));
    },
};

// 实时事件：进度（含引擎自发 done）与逐步预览
export function onProgress(handler) {
    const fn = (e) => handler(e.detail);
    api.addEventListener("h3_scenedirector_progress", fn);
    return () => api.removeEventListener("h3_scenedirector_progress", fn);
}

export function onStep(handler) {
    const fn = (e) => handler(e.detail);
    api.addEventListener("h3_scenedirector_step", fn);
    return () => api.removeEventListener("h3_scenedirector_step", fn);
}
