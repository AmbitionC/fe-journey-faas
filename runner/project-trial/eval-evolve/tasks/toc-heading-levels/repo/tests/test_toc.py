from docs.toc import build, render

DOC = """# 安装
## 准备环境
### 系统要求
# 使用
## 快速开始
```
# 这是代码里的注释
```
## 快速开始
"""


def test_nested_levels():
    roots = build("# 甲\n## 乙\n### 丙\n## 丁")
    assert [r.title for r in roots] == ["甲"]
    assert [c.title for c in roots[0].children] == ["乙", "丁"]
    assert roots[0].children[0].children[0].title == "丙"


def test_jump_back_to_top_level():
    roots = build(DOC)
    assert [r.title for r in roots] == ["安装", "使用"]
    assert [c.title for c in roots[1].children] == ["快速开始", "快速开始"]


def test_duplicate_titles_get_numbered_anchors_and_code_is_skipped():
    roots = build(DOC)
    assert [c.anchor for c in roots[1].children] == ["快速开始", "快速开始-1"]


def test_render():
    assert render(build("# 甲\n## 乙\n# 丙")) == "- [甲](#甲)\n  - [乙](#乙)\n- [丙](#丙)"
