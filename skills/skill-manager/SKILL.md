---
name: skill-manager
description: 查看/整理 skill 使用情况、归档不常用 skill、恢复或按需加载已归档 skill。当任务需要的 capability 没有已安装 skill 可用时，先查归档清单 ~/.cs-nexus/skill-archive.json，按绝对路径 Read 加载已归档 skill 的 SKILL.md 并严格按其内容执行。用户要求统计 skill 使用、清理不常用 skill、恢复或动态加载已归档 skill 时使用；本 skill 绝不直接移动、删除或修改 skill 文件，一切文件操作走 cs-nexus CLI。
---

# Skill Manager

管理本机全局 skill 的生命周期：使用统计 → 归档 → 按需动态加载 → 恢复。

## 行为协议

1. **查清单**：读 `~/.cs-nexus/skill-archive.json`；文件不存在即当前无归档。
2. **动态加载**：按清单条目的 description 匹配任务所需能力 → `Read` 该条目 `skillFile` 字段的绝对路径 → 严格按其内容执行（skill 本质是 markdown 注入，读取即等效正式加载；附属脚本/引用文件随整目录归档，相对路径仍有效）。
3. **管理指引**：建议用户运行 `cs-nexus skill-usage` 查看使用报告（含归档计数）；确认名单后运行 `cs-nexus archive <names>` 归档；恢复运行 `cs-nexus archive --restore <name>`。若近期多次按需加载同一 skill（报告 usageCount 持续增长），主动建议 restore。
4. **边界**：绝不直接移动/删除/修改任何 skill 文件或清单文件；一切文件操作走 cs-nexus CLI。

## 已知限制

- 归档后 `/name` 斜杠命令入口消失；用户显式点名已归档 skill 时，直接读清单按第 2 条加载。
- 归档区内容是归档时的快照；如需更新，先 restore 再 `skills update`。
