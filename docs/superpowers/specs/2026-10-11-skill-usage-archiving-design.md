# Skill 使用统计与归档管理设计

> 日期：2026-10-11
> 状态：已与用户逐节确认
> 关联：plan.md（cs-nexus 总体设计）

## 1. 背景与目标

cs-nexus 复用 `vercel-labs/skills` CLI 安装全局 skill。随着全局 skill 数量增长，每个已安装 skill 的 name + description 都会注入 agent 的系统提示，占用 context 并稀释自动触发精度。

本功能新增一个 skill 生命周期管理层：

1. **使用统计**：扫描本地双 agent（Claude Code、Codex）的会话记录，统计每个全局 skill 的调用次数与最近使用时间。
2. **归档**：把不常用的 skill 从 agent 的活跃 skill 集合中移除（不再占用 context），文件迁入统一归档区并在清单中登记。
3. **动态加载**：常驻的 `skill-manager` skill 在任务需要已归档能力时，按归档清单中的绝对路径 `Read` SKILL.md，将其内容载入当前会话——与正式安装等效，零恢复成本、不联网。

### 已确认的产品决策

| 决策点 | 结论 |
|---|---|
| 归档语义 | 真移除 + 留档案；恢复不重装，直接按绝对路径 Read 加载 |
| "不常用"判定 | 时间 + 次数双维度（`N` 天未用 或 豁免期后总调用 `< M`），报告确认制，参数可配置 |
| 统计范围 | 扫描全部项目的会话记录（全局 skill 在任何项目里的调用都算使用） |
| 管理对象 | 仅全局安装的 skill；项目级 skill 是项目依赖，不纳入 |
| Agent 支持 | Claude Code + Codex 一步到位，解析层按 agent 分模块 |
| 组件形态 | CLI 为执行层（方案 A），skill 为薄交互层 |

## 2. 调研事实（2026-10-11 本机验证）

| | Claude Code | Codex |
|---|---|---|
| 全局 skill 目录 | `~/.claude/skills/` | `~/.agents/skills/`（skills CLI 安装）与 `~/.codex/skills/`（官方路径），两者都可能存在 |
| 会话记录 | `~/.claude/projects/<项目>/*.jsonl` | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` |
| skill 调用信号 | ① assistant tool_use：`{"name":"Skill","input":{"skill":"<name>"}}`；② 用户斜杠命令：user message 内 `<command-name>/<name></command-name>` | 模型以 read SKILL.md 方式使用 skill，session 行内出现 `<skills根>/<name>/SKILL.md` 路径引用 |

Codex 侧另有 `~/.codex/history.jsonl`（用户输入历史），存在误报风险（prompt 提及 ≠ 调用），**不作为统计信号**，留作未来可选增强。

## 3. 总体架构

```
用户 / 模型（自然语言）
   │ "整理不常用的 skill" / "我需要已归档的 X"
   ▼
skill-manager skill（常驻交互层，随 setup 安装到各 agent）
   │ ① 读归档清单  ② 按绝对路径 Read 动态加载  ③ 指引运行 CLI
   ▼
cs-nexus CLI（执行层，纯 Node，可单测）
   ├─ skill-usage   扫描双 agent 会话 → 使用报告 + 归档候选
   ├─ archive       保活检查 → 归档 / --list / --restore
   ▼
~/.cs-nexus/skill-archive/<name>/    归档区（skill 文件实体，从原目录整体迁入）
~/.cs-nexus/skill-archive.json       归档清单（运行时状态数据，与手写策略分离）
~/.cs-nexus/usage-state.json         增量扫描游标（已扫文件的 mtime/大小）
```

职责边界沿用项目现有原则：**skill 管交互与决策，CLI 管执行与数据**。

## 4. CLI 层设计

### 4.1 新增模块

| 模块 | 职责 |
|---|---|
| `src/usage/claude-code.js` | 解析 `~/.claude/projects/**/*.jsonl`，识别上述两种信号 |
| `src/usage/codex.js` | 解析 `~/.codex/sessions/**/rollout-*.jsonl`，识别对 `<skills根>/<name>/SKILL.md` 的读取引用（三种根目录、`/` 与 `\` 分隔符均匹配） |
| `src/usage/scan.js` | 调度两解析器、按 skill 名合并计数、维护增量游标 |
| `src/skill-inventory.js` | 枚举全局已装 skill（三个根目录），读取各 SKILL.md frontmatter 的 name/description |
| `src/archive.js` | 归档（保活检查→迁入归档区→更新清单）、恢复、清单读写与重建 |
| `src/commands/skill-usage.js`、`src/commands/archive.js` | 命令层：参数解析、报告渲染、确认交互 |

`bin/cs-nexus.js` 改为按首参数分发：`setup` 走现有 `runCli`（不改），`skill-usage` / `archive` 走新命令模块。

### 4.2 命令

```text
cs-nexus skill-usage [--json] [--config <path>]
    # 报告列：skill | 来源目录 | 调用次数 | 最近使用 | 状态
    # 状态 = active / candidate（命中阈值）/ pinned（保活）

cs-nexus archive <name...> [--yes] [--config <path>]
    # 执行归档；保活检查强制，--yes 只跳过确认，不能跳过保活

cs-nexus archive --list [--json]

cs-nexus archive --restore <name> [--config <path>]
```

阈值判定只发生在 `skill-usage` 输出（candidate 标记）；`archive` 执行时不重复判定，用户点名即归档。

### 4.3 数据模型

归档清单 `~/.cs-nexus/skill-archive.json`：

```json
{
  "version": 1,
  "archived": [
    {
      "name": "zhihu-analyzer",
      "description": "（SKILL.md frontmatter 摘要，供 skill-manager 路由匹配）",
      "skillFile": "C:\\Users\\demo\\.cs-nexus\\skill-archive\\zhihu-analyzer\\SKILL.md",
      "archivedAt": "2026-10-11T12:00:00.000Z",
      "lastUsedAt": "2026-05-01T08:10:26.000Z",
      "usageCount": 3,
      "origin": { "dirs": ["C:\\Users\\demo\\.codex\\skills"] }
    }
  ]
}
```

**多副本处理**：同名 skill 可能同时存在于多个根目录（如 smart-commit 在 `~/.agents/skills` 与 `~/.codex/skills` 都有）——归档时全部移除，归档区按 name 存一份，`origin.dirs` 记录全部原位置；恢复时写回所有原目录。多副本内容不一致时以首份为准并在输出中提示。

### 4.4 保活规则

以下 skill 永远拒绝归档（`archive` 强制执行，不可跳过）：

1. `routing` 中被引用的 skill；
2. `dependencies` 依赖闭包内的 skill；
3. `installation.include` 声明的本地 skill（含 skill-manager 自身）。

违反时拒绝并输出被哪条配置引用。

## 5. skill-manager skill（`skills/skill-manager/`）

- 组成：`SKILL.md` + `agents/openai.yaml`（仿 task-router 的 Codex 配置）。
- `cs-nexus.yaml` 变更：`providers` 新增 `local:skill-manager`；`installation.include` 加入。
- **description**（触发路由的关键，覆盖三类场景）：查看/整理 skill 使用情况、归档不常用 skill、恢复或按需加载已归档 skill；当任务需要的 capability 没有已安装 skill 可用时，先查归档清单。

SKILL.md 行为协议：

1. **查清单**：读 `~/.cs-nexus/skill-archive.json`；文件不存在即无归档。
2. **动态加载**：按 description 匹配所需能力 → `Read` 该条目的 `skillFile` 绝对路径 → 严格按其内容执行（skill 本质是 markdown 注入，读取即等效正式加载）。
3. **管理指引**：建议用户运行 `cs-nexus skill-usage` 查看报告；确认名单后 `cs-nexus archive <names>`；恢复用 `cs-nexus archive --restore <name>`。
4. **边界**：skill-manager 绝不直接移动/删除文件，一切文件操作走 CLI。

配套小改动：task-router SKILL.md 的 "Add capabilities on demand" 一节增加一句——能力缺失时先查 skill-manager 的归档清单，再考虑社区安装。

## 6. 配置（cs-nexus.yaml 新增，缺省全有默认值）

```yaml
archiving:
  enabled: true
  unused_after_days: 30      # 连续 N 天未用 → 候选
  min_invocations: 5         # 豁免期后总调用 < M → 候选
  new_skill_grace_days: 7    # 新装 skill 豁免期（按 skill 目录 birthtime，不可用时回退 mtime）
  auto: false                # 保留位；false = 报告确认制
```

- `validateConfig` 增加对应校验（数值为正整数、`auto` 为布尔）。
- 配置解析顺序沿用 task-router 现有四级顺序（项目 → 项目 .cs-nexus → 环境变量 → 全局）。
- 无该 section 时使用代码内置默认值，命令可直接运行。

## 7. 数据流（完整生命周期）

```
日常使用 → 会话 jsonl 累积
   ↓ 用户："整理一下不常用的 skill"
skill-manager 触发 → 指引 cs-nexus skill-usage
   ↓ 增量扫描（游标记录 mtime+size，二次运行秒级）
报告 + 候选名单（pinned 的不出现）
   ↓ 用户确认
cs-nexus archive X Y → 保活检查 → 文件迁入 ~/.cs-nexus/skill-archive/ → 更新清单
   ↓ 数周后，任务需要 X 的能力
skill-manager：查清单 → 匹配 description → Read 绝对路径 → 按内容执行
   ↓ 若 X 重新高频使用
cs-nexus archive --restore X → 写回全部 origin 目录 → 移出清单
```

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 某 agent 的会话目录不存在 | 跳过该 agent，报告注明"未检测到 Codex / Claude Code" |
| jsonl 单行损坏 | 跳过该行并计数（transcript 行独立，不影响整体） |
| 归档目标已在归档区 | 幂等提示，不重复迁移 |
| restore 时原目录有同名新 skill | 报错并列出冲突路径，不覆盖 |
| 清单 JSON 损坏 | 从归档区目录重建（读各 SKILL.md frontmatter），统计字段置空 |
| 保活冲突 | 拒绝归档，说明引用来源 |
| skill-usage 无任何会话数据 | 正常输出全量报告（调用次数为 0，正常参与阈值判定） |

## 9. 测试（node:test，沿用现有风格，只测新模块）

- `test/usage/claude-code.test.js`：fixture jsonl → 两种信号形态统计、增量游标。
- `test/usage/codex.test.js`：fixture rollout → 路径引用匹配、三种根目录、`\` 与 `/` 分隔符。
- `test/skill-inventory.test.js`：临时目录模拟三个根 → 枚举 + frontmatter 解析。
- `test/archive.test.js`：tmp 目录 → 多副本合并归档、保活拒绝、幂等、恢复、清单重建。
- 命令层薄，`--json` 输出结构做集成冒烟。

## 10. 实现期验证点（不阻塞设计）

1. `~/.agents/skills/` 受 skills CLI lock 管理：归档先迁文件；若 lock 残留导致 `skills list` 仍显示该 skill，补调 `skills remove <name> --global --yes` 清理。
2. Codex session 内 read 调用的路径具体字段与格式（`payload` 结构）在实现解析器时用真实样本校准正则。
3. Claude Code transcript 中 `<command-name>` 的完整形态（含嵌套转义）在 fixture 中覆盖。

## 11. 范围外（明确不做）

- 项目级 skill 的统计与归档。
- `auto: true` 的自动归档执行（配置位保留，本期只实现报告确认制）。
- `~/.codex/history.jsonl` 用户点名信号（误报风险，未来可选增强）。
- 归档区跨机器同步。
