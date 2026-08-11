// SceneDirector 工作台（自研 UI）：载荷状态
// schema 见 director/payload.py；本模块只做纯数据。
export function emptyPayload() {
    return {
        run: "story", run_nonce: 0, global_prompt: "",
        globals: [], assets: [], segments: [],
        task: "t2v", continuity: true, context_length: 22,
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
    return { category: "参考", name: "", image: "", subfolder: "", note: "", kind: kind || "image" };
}

export const TASKS = [
    ["t2v", "t2v 文生视频"],
    ["i2v", "i2v 图生视频"],
    ["fl2v", "fl2v 首尾帧"],
    ["r2v", "r2v 参考主体"],
    ["v2v", "v2v 视频转视频"],
    ["rv2v", "rv2v 参考改视频"],
];

export function totalDuration(payload) {
    return (payload.segments || []).reduce((a, s) => a + (parseFloat(s.duration) || 0), 0);
}

export function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    return m + ":" + String(s).padStart(2, "0");
}
