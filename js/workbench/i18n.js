// SceneDirector 工作台 i18n（zh 默认，en 可选）
const dict = {
    zh: {
        globals: "场景设定", assets: "场景资产", segments: "分镜时间线",
        addRow: "+ 加一行", addAsset: "+ 加资产卡", addSeg: "+ 加一段",
        run: "运行", enabled: "启用", duration: "时长(秒)",
        cached: "已缓存", willRender: "将重渲", dirty: "待渲染",
        source: "源视频", uploadSource: "上传源视频", smartSplit: "智能分镜",
        enhance: "AI 增强", firstFrame: "首帧", lastFrame: "尾帧",
        audioMode: "声音", audioGenerate: "生成", audioOriginal: "原声", audioMute: "静音",
        replace: "替换图片", zoom: "放大显示", noCache: "未勾选且无缓存",
        live: "实时预览", progress: "整体进度",
        probeFail: "源视频探测失败", splitDone: "分镜完成", task: "任务",
    },
    en: {
        globals: "Scene Settings", assets: "Assets", segments: "Timeline",
        addRow: "+ Row", addAsset: "+ Asset", addSeg: "+ Segment",
        run: "Run", enabled: "On", duration: "Dur(s)",
        cached: "Cached", willRender: "Will render", dirty: "Dirty",
        source: "Source", uploadSource: "Upload video", smartSplit: "Smart split",
        enhance: "Enhance", firstFrame: "First", lastFrame: "Last",
        audioMode: "Audio", audioGenerate: "Gen", audioOriginal: "Src", audioMute: "Mute",
        replace: "Replace", zoom: "Zoom", noCache: "Unchecked & no cache",
        live: "Live", progress: "Progress",
        probeFail: "Probe failed", splitDone: "Split done", task: "Task",
    },
};

let lang = localStorage.getItem("h3sd_lang") || "zh";

export function t(key) { return (dict[lang] && dict[lang][key]) || dict.zh[key] || key; }
export function getLang() { return lang; }
export function toggleLang() {
    lang = lang === "zh" ? "en" : "zh";
    localStorage.setItem("h3sd_lang", lang);
    return lang;
}
