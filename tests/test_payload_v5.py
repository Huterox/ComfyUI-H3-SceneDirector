"""载荷 v5（资产库常驻/引用语义）离线单测。

payload 模块只含纯函数，stub 掉 folder_paths 后即可脱离 ComfyUI 运行：

    python tests/test_payload_v5.py
"""

import hashlib
import json
import os
import sys
import tempfile
import types

# --- stub folder_paths（payload 唯一的外部依赖） ---------------------------
TMP = tempfile.mkdtemp(prefix="h3sd_payload_test_")
_fp = types.ModuleType("folder_paths")
_fp.get_input_directory = lambda: TMP
sys.modules["folder_paths"] = _fp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from director import payload as P  # noqa: E402


def _mkfile(name, content):
    with open(os.path.join(TMP, name), "wb") as f:
        f.write(content)
    return name


def _seg(**kw):
    # task 缺省 ""——与 parse_payload 的原始输入一致（未推断前的状态）
    seg = {"duration": 5.0, "prompt": "p", "nonce": "", "refs": [],
           "assets": [], "enabled": True, "task": "",
           "audio_mode": "generate", "first_frame": None,
           "last_frame": None, "source": None}
    seg.update(kw)
    return seg


# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------

def test_norm_assets_pinned_default():
    """pinned 缺省 True（对齐旧版"全局资产全量注入"）；显式 False 保留。"""
    cards = P.norm_assets([
        {"category": "角色", "name": "A", "image": "a.png"},
        {"category": "道具", "name": "B", "image": "b.png", "pinned": False},
    ])
    assert cards[0]["pinned"] is True
    assert cards[1]["pinned"] is False
    # 无效卡（三无）丢弃
    assert P.norm_assets([{"category": "角色"}]) == []


def test_asset_key_and_resolve_order():
    """引用键 = "类别·名字"；resolve 按 refs 顺序返回，缺失键静默跳过。"""
    assets = P.norm_assets([
        {"category": "角色", "name": "甲"}, {"category": "场景", "name": "乙"},
        {"category": "道具", "name": "丙"},
    ])
    assert P.asset_key(assets[0]) == "角色·甲"
    got = P.resolve_refs(assets, ["道具·丙", "角色·甲", "不存在·丁"])
    assert [a["name"] for a in got] == ["丙", "甲"]
    # refs 去重保序
    assert P._norm_refs(["角色·甲", "角色·甲", "", " 场景·乙 "]) == ["角色·甲", "场景·乙"]


def test_seg_effective_assets_order_and_dedup():
    """生效顺序 = 常驻 + refs 解析（跳过已被常驻覆盖的键）+ 段级内嵌。"""
    assets = P.norm_assets([
        {"category": "角色", "name": "主角", "image": "x.png"},          # 常驻
        {"category": "道具", "name": "剑", "image": "y.png", "pinned": False},
    ])
    seg = _seg(refs=["道具·剑", "角色·主角"],  # 主角已被常驻覆盖，不重复
               assets=[{"category": "场景", "name": "竹林", "image": "z.png",
                        "subfolder": "", "note": "", "kind": "image",
                        "pinned": True}])
    eff = P.seg_effective_assets(assets, seg)
    assert [(a["category"], a["name"]) for a in eff] == [
        ("角色", "主角"), ("道具", "剑"), ("场景", "竹林")]


# ---------------------------------------------------------------------------
# 任务推断
# ---------------------------------------------------------------------------

def test_infer_task_refs_aware():
    """refs 挂图 -> r2v；refs 挂纯文本卡 -> 仍 t2v；显式 task 优先；
    只有常驻图卡（无 refs/内嵌）-> t2v（对齐旧版全局资产行为）。"""
    lib = P.norm_assets([
        {"category": "角色", "name": "甲", "image": "a.png"},  # 常驻
        {"category": "道具", "name": "乙", "image": "b.png", "pinned": False},
        {"category": "风格", "name": "丙", "note": "水墨", "pinned": False},
    ])
    assert P.infer_task(_seg(refs=["道具·乙"]), lib) == "r2v"
    assert P.infer_task(_seg(refs=["风格·丙"]), lib) == "t2v"
    assert P.infer_task(_seg(), lib) == "t2v"
    assert P.infer_task(_seg(task="i2v"), lib) == "i2v"
    assert P.infer_task(_seg(refs=["道具·乙"],
                             source={"video": "v.mp4", "subfolder": "",
                                     "start": 0.0, "end": 1.0}), lib) == "rv2v"


# ---------------------------------------------------------------------------
# 哈希（sd6 标签 + 级联语义）
# ---------------------------------------------------------------------------

def test_seg_hash_sd6_tag():
    """哈希输入以 "sd6" 开头——手工复算，钉死标签（旧缓存自动作废）。"""
    seg = _seg(duration=5.0, prompt="hello", nonce="n1", task="t2v")
    parts = ["sd6", 0, 5.0, "hello", "n1", "t2v", "generate"]
    expect = hashlib.sha1(
        json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()
    assert P.seg_hash(0, seg) == expect
    # enabled（选择运行）不入哈希
    assert P.seg_hash(0, _seg(prompt="hello", nonce="n1", task="t2v",
                              enabled=False)) == expect


def test_seg_hash_refs_cascade():
    """改被引用的按需卡 -> 引用它的段哈希变（级联重渲）；
    改没人引用的按需卡 -> 段哈希不变。不带 library 时只按引用键字符串算。"""
    _mkfile("sword.png", b"v1")
    _mkfile("cape.png", b"v1")
    assets = P.norm_assets([
        {"category": "道具", "name": "剑", "image": "sword.png", "pinned": False},
        {"category": "服装", "name": "披风", "image": "cape.png", "pinned": False},
    ])
    seg = _seg(refs=["道具·剑"])
    h1 = P.seg_hash(0, seg, assets)
    _mkfile("sword.png", b"v2")          # 改被引用的卡
    h2 = P.seg_hash(0, seg, assets)
    assert h1 != h2
    _mkfile("cape.png", b"v2")           # 改没被引用的卡
    h3 = P.seg_hash(0, seg, assets)
    assert h2 == h3
    # 无 library：只按引用键字符串，不碰文件
    assert P.seg_hash(0, seg) == P.seg_hash(0, seg)


def test_global_hash_pinned_only():
    """全局哈希只算常驻卡：改按需卡不变；改常驻卡/切 pinned 状态变。"""
    _mkfile("hero.png", b"v1")
    _mkfile("prop.png", b"v1")
    kw = dict(run_nonce=0, width=960, height=544, context_length=39,
              audio_context_length=39, encode_mode="video", anchor_mode="head",
              audio_mode="timeline", crop="center")
    assets = P.norm_assets([
        {"category": "角色", "name": "甲", "image": "hero.png"},
        {"category": "道具", "name": "乙", "image": "prop.png", "pinned": False},
    ])
    h1 = P.global_hash(assets=assets, **kw)
    _mkfile("prop.png", b"v2")                       # 改按需卡
    assert P.global_hash(assets=assets, **kw) == h1
    _mkfile("hero.png", b"v2")                       # 改常驻卡
    assert P.global_hash(assets=assets, **kw) != h1
    assets2 = P.norm_assets([                          # 按需 -> 常驻
        {"category": "角色", "name": "甲", "image": "hero.png"},
        {"category": "道具", "name": "乙", "image": "prop.png", "pinned": True},
    ])
    assert P.global_hash(assets=assets2, **kw) != h1


# ---------------------------------------------------------------------------
# 兼容迁移
# ---------------------------------------------------------------------------

def test_parse_legacy_payload():
    """旧载荷（裸段列表 / 无 pinned/refs 键）解析不炸，缺省值补齐。"""
    run, nonce, gp, grows, assets, segs = P.parse_payload(
        json.dumps([{"duration": 5, "prompt": "甲"},
                    {"duration": 3, "prompt": "乙", "assets": [
                        {"category": "场景", "name": "丙", "image": "c.png"}]}]))
    assert len(segs) == 2
    assert segs[0]["refs"] == [] and segs[0]["enabled"] is True
    assert segs[1]["assets"][0]["pinned"] is True       # 段级内嵌卡缺省常驻语义
    assert segs[1]["task"] == "r2v"                      # 旧行为：内嵌图 -> r2v
    # 旧工作台对象格式
    run, nonce, gp, grows, assets, segs = P.parse_payload(json.dumps({
        "run": "竹林对决", "global_prompt": "武侠",
        "assets": [{"category": "角色", "name": "青霜", "image": "q.png"}],
        "segments": [{"duration": 5, "prompt": "出剑"}],
    }))
    assert run == "竹林对决" and assets[0]["pinned"] is True
    assert segs[0]["refs"] == []


def test_compose_global_roster():
    """清单行只列调用方给的（常驻）子集；编号按 kind 分别连续。"""
    pinned = P.norm_assets([
        {"category": "角色", "name": "甲", "image": "a.png"},
        {"category": "音乐", "name": "鼓", "image": "d.mp3", "kind": "audio"},
    ])
    block = P.compose_global("武侠", [{"category": "场景", "content": "竹林"}], pinned)
    assert "武侠" in block and "场景：竹林" in block
    assert "<Picture 1>=角色·甲" in block
    assert "<Audio 1>=音乐·鼓" in block
    assert "道具" not in block


def test_schema_version():
    assert P.SCHEMA == 5


# ---------------------------------------------------------------------------
# parse_director：资产库（timeline v4.1 library/libRefs）
# ---------------------------------------------------------------------------

def test_parse_director_library():
    """library 非空 -> 以它为准（pinned 保留）；段 libRefs -> 载荷 refs；
    旧键（global.refs / 段内联 refs）被忽略。"""
    tl = {
        "global": {"prompt": "武侠", "taskType": "r2v — 参考主体生视频(Reference to Video)",
                   "refs": [{"index": 0, "imageFile": "legacy.png"}]},
        "library": [
            {"category": "角色", "name": "青霜", "imageFile": "q.png",
             "note": "青衫", "kind": "image", "pinned": True},
            {"category": "道具", "name": "竹剑", "imageFile": "sw.png",
             "kind": "image", "pinned": False},
            {"category": "音乐", "name": "鼓点", "imageFile": "sub/d.mp3",
             "kind": "audio", "pinned": True},
        ],
        "segments": [
            {"id": "s1", "durationSec": 5, "prompt": "出剑",
             "libRefs": ["道具·竹剑"],
             "refs": [{"index": 9, "imageFile": "legacy_seg.png"}]},
            {"id": "s2", "durationSec": 5, "prompt": "收剑", "libRefs": []},
        ],
    }
    gp, assets, segs, _ = P.parse_director(json.dumps(tl), "", "", "竹林")
    assert gp == "武侠"
    assert [(a["category"], a["name"], a["kind"], a["pinned"]) for a in assets] == [
        ("角色", "青霜", "image", True),
        ("道具", "竹剑", "image", False),
        ("音乐", "鼓点", "audio", True)]
    assert assets[2]["subfolder"] == "sub" and assets[2]["image"] == "d.mp3"
    assert segs[0]["refs"] == ["道具·竹剑"]
    assert segs[0]["assets"] == []                # 旧内联键被忽略
    assert segs[0]["task"] == "r2v"
    assert segs[1]["refs"] == []
    # 载荷全链路：refs 解析出生效资产（常驻 + 引用）
    run, nonce, gp2, grows, lib, psegs = P.parse_payload(json.dumps({
        "run": "x", "assets": assets,
        "segments": [{"duration": 5, "prompt": "出剑", "refs": segs[0]["refs"]}],
    }))
    eff = P.seg_effective_assets(lib, psegs[0])
    assert [a["name"] for a in eff] == ["青霜", "鼓点", "竹剑"]


def test_parse_director_legacy_fallback():
    """无 library -> 旧行为：global.refs 常驻、段内联卡进 assets。"""
    tl = {
        "global": {"prompt": "", "refs": [{"index": 0, "imageFile": "g.png"}]},
        "segments": [{"id": "s1", "durationSec": 5, "prompt": "x",
                      "refs": [{"index": 1, "imageFile": "s.png"}]}],
    }
    gp, assets, segs, _ = P.parse_director(json.dumps(tl), "", "", "r")
    assert [a["name"] for a in assets] == ["g"]
    assert assets[0]["pinned"] is True
    assert [a["name"] for a in segs[0]["assets"]] == ["s"]
    assert segs[0]["refs"] == []
    # 空 library（全删光了）也走旧路
    tl["library"] = []
    gp, assets, segs, _ = P.parse_director(json.dumps(tl), "", "", "r")
    assert [a["name"] for a in assets] == ["g"]


def test_parse_director_shots_librefs():
    """fl2v shots 的 libRefs 同样进载荷 refs。"""
    tl = {
        "global": {"prompt": "", "taskType": "fl2v — 首尾帧生视频(First-Last Frame)"},
        "library": [{"category": "角色", "name": "甲", "imageFile": "a.png",
                     "kind": "image", "pinned": True}],
        "shots": [{"id": "sh1", "durationSec": 5, "prompt": "p",
                   "startImage": {"imageFile": "f.png"},
                   "libRefs": ["角色·甲"]}],
    }
    gp, assets, segs, _ = P.parse_director(json.dumps(tl), "", "", "r")
    assert segs[0]["task"] == "fl2v"
    assert segs[0]["refs"] == ["角色·甲"]
    assert segs[0]["first_frame"] == {"image": "f.png", "subfolder": ""}


ALL = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    failed = 0
    for fn in ALL:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except AssertionError as e:
            failed += 1
            import traceback
            print("FAIL %s: %s" % (fn.__name__, e))
            traceback.print_exc()
    print("---- %d/%d 通过 ----" % (len(ALL) - failed, len(ALL)))
    sys.exit(1 if failed else 0)
