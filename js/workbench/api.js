// api.js —— 后端通道封装。
//
// 这里不 import ComfyUI 的 app/api（js/workbench/ 下的模块一律由入口
// storydirector.js 注入依赖，避免再数一遍到 scripts/ 的相对路径层级）。
//
// 封装四件事：
//   postStatus     POST /h3_storydirector/status（payload 子集 -> 逐段状态）
//   uploadImage    POST /upload/image（FormData 字段名必须是 image）
//   *URL           /view 工件 URL 构造（海报 / mp4 / 输入目录参考图）
//   onProgress / onExecutionEnd   WS 事件订阅（api.addEventListener），
//                  返回退订函数，节点 onRemoved 时必须调用，避免泄漏

export function createBackend(api) {

    // 编辑后由 progress.js 防抖 800ms 调用；body 形状见 state.statusBody()
    async function postStatus(body) {
        const resp = await api.fetchApi("/h3_storydirector/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error("status 查询失败: HTTP " + resp.status);
        return await resp.json();
    }

    // 返回 {name, subfolder, type}；调用方把 name/subfolder 存进资产卡
    async function uploadImage(file) {
        const fd = new FormData();
        fd.append("image", file, file.name);
        fd.append("type", "input");
        fd.append("overwrite", "false");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!resp.ok) throw new Error("图片上传失败: HTTP " + resp.status);
        return await resp.json();
    }

    // /view 查询串手工拼（encodeURIComponent 把空格编成 %20；
    // URLSearchParams 会编成 +，aiohttp 的 query 解析不把 + 当空格）
    function viewQuery(file, subfolder, type) {
        return "/view?filename=" + encodeURIComponent(file)
            + "&subfolder=" + encodeURIComponent(subfolder || "")
            + "&type=" + type;
    }

    // 输出目录工件 URL。cacheTag 防浏览器缓存旧图：
    // 传后端返回的 updated（秒级时间戳）或 Date.now()
    function outputURL(file, subfolder, cacheTag) {
        let q = viewQuery(file, subfolder, "output");
        if (cacheTag) q += "&t=" + encodeURIComponent(String(cacheTag));
        return api.apiURL(q);
    }

    // 输入目录（上传的参考图）URL
    function inputURL(card) {
        return api.apiURL(viewQuery(card.image, card.subfolder || "", "input"));
    }

    // 海报：output/h3_storydirector/<run>/posters/<poster_file>
    const posterURL = (run, file, cacheTag) =>
        outputURL(file, "h3_storydirector/" + run + "/posters", cacheTag);

    // 段视频：output/h3_storydirector/<run>/<mp4_file>
    const mp4URL = (run, file, cacheTag) =>
        outputURL(file, "h3_storydirector/" + run, cacheTag);

    // WS：渲染进度 {run, segment, total, cached}
    function onProgress(fn) {
        const handler = (ev) => fn(ev.detail || {});
        api.addEventListener("h3_storydirector_progress", handler);
        return () => api.removeEventListener("h3_storydirector_progress", handler);
    }

    // WS：逐步实时预览 {run, segment, total, step, steps, image(base64 jpeg)}
    function onStep(fn) {
        const handler = (ev) => fn(ev.detail || {});
        api.addEventListener("h3_storydirector_step", handler);
        return () => api.removeEventListener("h3_storydirector_step", handler);
    }

    // WS：一次执行结束后刷新全部状态
    function onExecutionEnd(fn) {
        const handler = (ev) => fn(ev.detail || {});
        api.addEventListener("execution_end", handler);
        return () => api.removeEventListener("execution_end", handler);
    }

    return {
        postStatus, uploadImage,
        outputURL, inputURL, posterURL, mp4URL,
        onProgress, onStep, onExecutionEnd,
    };
}
