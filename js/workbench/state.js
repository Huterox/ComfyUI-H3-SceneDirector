// SceneDirector 工作台状态：载荷对象 <-> 节点 widget 的 JSON 序列化
// schema v4 见 director/payload.py 头部注释。
export function emptyPayload() {
    return {
        run: "story", run_nonce: 0, global_prompt: "",
        globals: [], assets: [], segments: [],
    };
}

export function parseWidgetValue(text) {
    try {
        const data = JSON.parse(text || "[]");
        if (Array.isArray(data)) {
            const p = emptyPayload();
            p.segments = data;
            return p;
        }
        if (data && typeof data === "object") return Object.assign(emptyPayload(), data);
    } catch (e) { /* 坏 JSON 按空载荷 */ }
    return emptyPayload();
}

export function newSegment(duration) {
    return {
        duration: duration || 5.0, prompt: "", nonce: "",
        assets: [], enabled: true,
        first_frame: null, last_frame: null, source: null,
        audio_mode: "generate",
    };
}

export function newAsset(kind) {
    return { category: "角色", name: "", image: "", subfolder: "", note: "", kind: kind || "image" };
}

// 选择运行统计：勾选数/总数
export function enabledCount(payload) {
    const segs = payload.segments || [];
    return [segs.filter((s) => s.enabled !== false).length, segs.length];
}
