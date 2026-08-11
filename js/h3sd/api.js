// SceneDirector 工作台：后端 API 与实时事件
import { api } from "../../../scripts/api.js";

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
    status(payload) { return post("/h3_scenedirector/status", payload); },
    probe(video, subfolder) { return post("/minimax/director/probe_video", { videoFile: video, subfolder }); },
    smartSplit(video, sensitivity, frameRate, totalFrames) {
        return post("/minimax/director/detect_shots", {
            videoFile: video, sensitivity, frameRate, totalFrames,
        });
    },
    enhance(prompt, task, opts) {
        return post("/minimax/director/enhance", Object.assign({ prompt, task_type: task, node: opts?.node }, opts || {}));
    },
    getTemplate(task) { return post("/minimax/director/get_template", { task_type: task }); },
    enhanceModels() { return post("/minimax/director/enhance_models", {}); },
    async uploadImage(file) {
        const fd = new FormData();
        fd.append("image", file, file.name);
        const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!r.ok) throw new Error("图片上传失败 HTTP " + r.status);
        return (await r.json()).name;
    },
    // 分块上传（Director 形状）
    async uploadVideo(file, onProgress) {
        const CHUNK = 4 * 1024 * 1024;
        const uploadId = "h3sd-" + Date.now() + "-" + Math.round(Math.random() * 1e6);
        const total = Math.max(1, Math.ceil(file.size / CHUNK));
        let name = file.name;
        for (let i = 0; i < total; i++) {
            const fd = new FormData();
            fd.append("upload_id", uploadId);
            fd.append("filename", file.name);
            fd.append("chunk_index", String(i));
            fd.append("total_chunks", String(total));
            fd.append("chunk", new Blob([await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer()]));
            const r = await api.fetchApi("/minimax/director/upload_chunk", { method: "POST", body: fd });
            if (!r.ok) throw new Error("分块上传失败 HTTP " + r.status);
            const j = await r.json();
            if (j.name) name = j.name;
            if (onProgress) onProgress((i + 1) / total);
        }
        return name;
    },
    artifactUrl(run, kind, file) {
        return "/view?filename=" + encodeURIComponent(file)
            + "&type=output&subfolder=" + encodeURIComponent(
                "h3_scenedirector/" + run + (kind === "poster" ? "/posters" : ""));
    },
    inputImageUrl(name, subfolder) {
        return "/view?filename=" + encodeURIComponent(name) + "&type=input"
            + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : "");
    },
};

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
