# Skill 使用统计与归档管理设计

> 日期：2026-10-11
> 状态：已与用户逐节确认；同日修订（v2）：修正 Codex 调用信号定义、明确增量游标语义、扩大保活配置作用域、归档区纳入使用统计、兼容 skills CLI symlink 安装模式（依据本机实测与 vercel-labs/skills 源码核实）
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
| 安装模式 | 兼容 skills CLI 的 copy 与 symlink（Windows junction）两种磁盘布局，归档/恢复按条目实际类型处理 |

## 2. 调研事实（2026-10-11 本机验证 + skills CLI 源码核实）

| | Claude Code | Codex |
|---|---|---|
| 全局 skill 目录 | `~/.claude/skills/` | `~/.agents/skills/`（canonical，skills CLI 安装）与 `~/.codex/skills/`（官方路径），两者都可能存在 |
| 会话记录 | `~/.claude/projects/<项目>/*.jsonl` | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` |
| skill 调用信号 | ① assistant tool_use：`{"name":"Skill","input":{"skill":"<name>"}}`；② 用户斜杠命令：user message 内 `<command-name>/<name></command-name>`；③ 动态加载：assistant `Read` tool_use 的 `input.file_path` 落在归档区根下（仅归档区需要，已安装 skill 走信号①） | `payload.type === "function_call"` 的行，其 `arguments` 中出现对 `<skills根>/<name>/SKILL.md` 的读取（如 `Get-Content -Path ...SKILL.md`；根含三个安装根与归档区根） |

### 2.1 Codex 信号的硬性约束（防全量误报）

实测确认：**每个 Codex 会话的 `role:"developer"` 消息都注入完整 skill 清单**，每项形如 `(file: C:/Users/demo/.agents/skills/<name>/SKILL.md)`。若按"行内出现路径"匹配，等于每个会话把所有已装 skill 各记一次使用，统计完全失效。因此解析器必须：

1. 只处理 `payload.type === "function_call"` 的行；
2. 明确排除 `role: "developer"` / `"system"` 消息与 `function_call_output`（命令输出回显路径同样不是调用）；
3. `function_call` 内的提及型误报（如 `rg` 搜索模式含 `SKILL.md` 字样）视为可接受的保守误差——误报方向是"把提及算成使用"，只会让 skill 显得更常用、延迟归档，不会误归档。

Claude 侧同理：`<command-name>` 需与 skill 清单按名交集，非 skill 命令（`/clear`、`/init` 等）自然落选。

### 2.2 skills CLI 磁盘布局与锁机制（源码核实：installer.ts / remove.ts / list.ts）

| 机制 | 事实 |
|---|---|
| symlink 模式（CLI 默认） | 实体存放在 canonical 目录 `~/.agents/skills/<name>`；非 universal agent 的目录下创建链接（Windows 为 junction，无需管理员权限；posix 为相对 symlink）。universal agent（Codex、Claude Code 的全局安装）直接读 canonical，不建链 |
| copy 模式（`--copy`） | 直接把实体复制到各 agent 目录，无 canonical 链接关系 |
| 本机现状 | 三个根目录均为真实目录（无 junction/symlink）；同名 skill 在 `~/.agents/skills` 与 `~/.codex/skills` 可同时存在独立副本（如 smart-commit） |
| `.skill-lock.json`（`~/.agents/`，version 3） | 记录每个 skill 的 source/sourceUrl/skillPath/skillFolderHash 等元数据；`skills list` **以目录扫描为准**，lock 仅补充 source 信息（未入 lock 的 skill 显示 `source: null`） |
| `skills remove <name> --global --yes` | 摘除所有 agent 目录下的链接（lstat 识别，只删链接不删实体）；canonical 仅在无其他 agent 使用时删除；**lock 条目清理支持"磁盘已空但 lock 残留"的 stale 场景**——因此"先迁实体、后补 remove"的归档顺序成立 |

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
~/.cs-nexus/skill-archive/<name>/    归档区（skill 文件实体；也是使用统计的第四个匹配根）
~/.cs-nexus/skill-archive.json       归档清单（运行时状态数据，与手写策略分离）
~/.cs-nexus/usage-state.json         增量扫描游标（按文件记录 mtime/size/计数）
```

职责边界沿用项目现有原则：**skill 管交互与决策，CLI 管执行与数据**。

## 4. CLI 层设计

### 4.1 新增模块

| 模块 | 职责 |
|---|---|
| `src/usage/claude-code.js` | 解析 `~/.claude/projects/**/*.jsonl`，识别上述三种信号（信号③按归档区根路径提取 name） |
| `src/usage/codex.js` | 解析 `~/.codex/sessions/**/rollout-*.jsonl`，只识别 `payload.type === "function_call"` 行内对 `<skills根>/<name>/SKILL.md` 的读取引用（四种根目录、`/` 与 `\` 分隔符均匹配；排除 developer/system 消息与 function_call_output） |
| `src/usage/scan.js` | 调度两解析器、按 skill 名合并计数、维护增量游标（按文件粒度，见 4.6） |
| `src/skill-inventory.js` | 枚举全局已装 skill（三个安装根），`lstat` 识别每个条目是实体目录还是链接（junction/symlink），按 realpath 去重合并为"一个 skill 多个位置"；读取实体 SKILL.md frontmatter 的 name/description |
| `src/archive.js` | 归档（保活检查→按位置类型分别处理→迁入归档区→更新清单+lock）、恢复、清单读写与重建 |
| `src/commands/skill-usage.js`、`src/commands/archive.js` | 命令层：参数解析、报告渲染、确认交互 |

`bin/cs-nexus.js` 改为按首参数分发：`setup` 走现有 `runCli`（不改），`skill-usage` / `archive` 走新命令模块。

### 4.2 命令

```text
cs-nexus skill-usage [--json] [--config <path>]
    # 报告列：skill | 位置（实体/链接） | 调用次数 | 最近使用 | 状态
    # 状态 = active / candidate（命中阈值）/ pinned（保活）
    # 报告全量列出（含 pinned 行）；"候选名单"仅含 candidate

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
  "version": 2,
  "archived": [
    {
      "name": "zhihu-analyzer",
      "description": "（SKILL.md frontmatter 摘要，供 skill-manager 路由匹配）",
      "skillFile": "C:\\Users\\demo\\.cs-nexus\\skill-archive\\zhihu-analyzer\\SKILL.md",
      "archivedAt": "2026-10-11T12:00:00.000Z",
      "lastUsedAt": "2026-05-01T08:10:26.000Z",
      "usageCount": 3,
      "origin": {
        "entries": [
          { "path": "C:\\Users\\demo\\.codex\\skills\\zhihu-analyzer", "kind": "dir" },
          { "path": "C:\\Users\\demo\\.claude\\skills\\zhihu-analyzer", "kind": "link",
            "target": "C:\\Users\\demo\\.agents\\skills\\zhihu-analyzer" }
        ]
      },
      "lockEntry": {
        "source": "example/zhihu-skills", "sourceType": "github",
        "sourceUrl": "https://github.com/example/zhihu-skills.git",
        "skillPath": "skills/zhihu-analyzer/SKILL.md",
        "skillFolderHash": "…", "installedAt": "…", "updatedAt": "…"
      }
    }
  ]
}
```

- **origin.entries**：记录归档时该 name 的全部磁盘位置及其类型。`kind: "dir"` 为实体目录（恢复时迁回原路径）；`kind: "link"` 为链接（恢复时按 target 重建）。
- **lockEntry**：归档时从 `~/.agents/.skill-lock.json` 快照的条目（无则省略）。恢复时回写，保住 `skills update` 的 source 元数据；回写失败（如 lock version 不再是 3）则跳过并提示可用 `skills add` 重装，不阻塞恢复。
- **多副本处理**：归档区按 name 存一份实体（canonical/首份为准），其余独立实体副本迁入前对比提示（内容不一致时以首份为准并在输出中列出差异）。symlink 模式下实体只有一个，不会触发该分支。

### 4.4 保活规则

以下 skill 永远拒绝归档（`archive` 强制执行，不可跳过）：

1. `routing` 中被引用的 skill；
2. `dependencies` 依赖闭包内的 skill；
3. `installation.include` 声明的本地 skill（含 skill-manager 自身）。

违反时拒绝并输出被哪条配置引用。

**配置作用域（归档是全局操作）**：保活集合不只读当前解析出的单份配置，而是合并：

- 当前目录按四级顺序解析出的配置（见 §6）；
- 使用扫描中发现的全部项目（Claude `projects/` 目录名反解路径、Codex rollout 会话元数据中的 cwd）各自的 `cs-nexus.yaml` / `.cs-nexus/cs-nexus.yaml`；
- 全局 `~/.cs-nexus/cs-nexus.yaml`。

引用按 `ref → name` 映射（`:` 后段，`providers` 声明的 name 优先），与现有 `skillNameFromReference` 逻辑一致。合并过程中某项目配置解析失败（YAML 损坏等）时跳过该项目并在输出中提示，不中断。

### 4.5 symlink 模式的归档与恢复

**归档**（对 name 的全部 origin 位置，按序执行）：

1. 保活检查（§4.4）；
2. 摘除全部 `kind: "link"` 位置——只删链接本身，不动 target（Node `fs.rm(linkPath, { recursive: true, force: true })` 对链接即此语义）；
3. 实体目录 `rename` 迁入 `~/.cs-nexus/skill-archive/<name>/`（跨盘 fallback 为 copy+delete）；
4. 补调 `npx skills remove <name> --global --yes` 清理 lock 残留与可能漏扫的 agent 目录幽灵链接（remove.ts 对"磁盘已空但 lock 残留"有专门处理，幂等安全；skills CLI 不可用时降级为输出提示，不阻塞归档）；
5. 更新清单（origin.entries + lockEntry 快照）。

**恢复**：

1. 冲突检查：任一 origin 路径上已存在同名条目 → 报错并列出冲突路径，不覆盖；
2. 实体 `rename` 回第一个 `kind: "dir"` 的路径（归档时至少有一个实体，必存在）；
3. 逐个重建 `kind: "link"`：目标为恢复后的实体路径；Windows 用 junction（`fs.symlink(target, path, "junction")`，无需管理员权限），posix 用相对 symlink，与 skills CLI 行为一致；
4. 回写 lockEntry 快照（读改写 `~/.agents/.skill-lock.json`，保留其他条目）；
5. 移出清单。

**悬挂链接**（target 已不存在的 link）：仍按 link 摘除/重建处理，摘除无风险；报告中对悬挂链接标注提示。

### 4.6 增量游标语义（防重复计数）

会话 jsonl 为追加式，活跃会话文件的 mtime/size 每次运行都会变化并触发重扫。`usage-state.json` 按**文件**存储：

```json
{ "files": { "<jsonl绝对路径>": {
    "mtimeMs": 0, "size": 0,
    "counts": { "<skillName>": 3 },
    "lastUsed": { "<skillName>": "2026-10-11T08:00:00.000Z" }
} } }
```

- 文件 mtime/size 未变 → 跳过；
- 变化 → 重扫整文件，**以本次结果替换该文件的 counts/lastUsed**（绝不累加）；
- 全局聚合（报告与阈值判定）= 各文件计数之和。

此语义天然规避同一调用被重复统计，也无需字节偏移续扫的复杂度。

## 5. skill-manager skill（`skills/skill-manager/`）

- 组成：`SKILL.md` + `agents/openai.yaml`（仿 task-router 的 Codex 配置）。
- `cs-nexus.yaml` 变更：`providers` 新增 `local:skill-manager`；`installation.include` 加入。
- **description**（触发路由的关键，覆盖三类场景）：查看/整理 skill 使用情况、归档不常用 skill、恢复或按需加载已归档 skill；当任务需要的 capability 没有已安装 skill 可用时，先查归档清单。

SKILL.md 行为协议：

1. **查清单**：读 `~/.cs-nexus/skill-archive.json`；文件不存在即无归档。
2. **动态加载**：按 description 匹配所需能力 → `Read` 该条目的 `skillFile` 绝对路径 → 严格按其内容执行（skill 本质是 markdown 注入，读取即等效正式加载；附属脚本/引用文件随整目录归档，相对路径仍有效）。
3. **管理指引**：建议用户运行 `cs-nexus skill-usage` 查看报告；确认名单后 `cs-nexus archive <names>`；恢复用 `cs-nexus archive --restore <name>`。若近期多次按需加载同一 skill（可用 `skill-usage` 报告中该 skill 的归档区计数确认），主动建议 restore。
4. **边界**：skill-manager 绝不直接移动/删除文件，一切文件操作走 CLI。

已知限制（写入 SKILL.md 提示）：归档后 `/name` 斜杠命令入口消失，需经 skill-manager 按描述路由加载；显式点名已归档 skill 时直接读清单。

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
- 配置解析顺序沿用 task-router 文档中的四级顺序（项目 → 项目 .cs-nexus → `CS_NEXUS_CONFIG` → 全局）。**注意：现有 `loadConfig` 只接受显式路径，四级发现是该顺序在 CLI 侧的新实现**（供 `skill-usage` / `archive` 共用的 `resolveConfigPath`），并非既有代码复用。
- 无该 section 时使用代码内置默认值，命令可直接运行。

## 7. 数据流（完整生命周期）

```
日常使用 → 会话 jsonl 累积
   ↓ 用户："整理一下不常用的 skill"
skill-manager 触发 → 指引 cs-nexus skill-usage
   ↓ 增量扫描（游标按文件记录 mtime/size/计数，重扫即替换，二次运行秒级）
报告（全量，含 pinned 标记）+ 候选名单（仅 candidate）
   ↓ 用户确认
cs-nexus archive X Y → 保活检查（合并全部项目配置）
   → 摘链接 → 实体迁入 ~/.cs-nexus/skill-archive/ → 补 skills remove 清 lock → 更新清单
   ↓ 数周后，任务需要 X 的能力
skill-manager：查清单 → 匹配 description → Read 绝对路径 → 按内容执行
   ↓ 该 Read 发生在归档区根下，计入使用统计（第四个匹配根）
若 X 重新高频使用（报告中归档区计数可见）
cs-nexus archive --restore X → 实体迁回原路径 → 重建链接 → 回写 lock → 移出清单
```

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 某 agent 的会话目录不存在 | 跳过该 agent，报告注明"未检测到 Codex / Claude Code" |
| jsonl 单行损坏 | 跳过该行并计数（transcript 行独立，不影响整体） |
| 归档目标名在任何根目录都不存在 | 报错并列出可用 skill 名 |
| 归档目标已在归档区 | 幂等提示，不重复迁移 |
| 悬挂链接（target 已不存在） | 按链接正常摘除；报告中标注提示 |
| `skills remove` 补调失败 / CLI 不可用 | 降级为输出手动清理提示，不阻塞归档结果 |
| restore 时原路径有同名新条目 | 报错并列出冲突路径，不覆盖 |
| lockEntry 回写失败（lock 版本不兼容等） | 跳过回写并提示（source 元数据缺失、`skills update` 失效，可 `skills add` 重装），不阻塞恢复 |
| 清单 JSON 损坏 | 从归档区目录重建（读各 SKILL.md frontmatter），统计字段置空；origin.entries 不可恢复时恢复操作要求显式指定目标目录 |
| 保活冲突 | 拒绝归档，说明引用来源 |
| skill-usage 无任何会话数据 | 正常输出全量报告（调用次数为 0，正常参与阈值判定） |

## 9. 测试（node:test，沿用现有风格，只测新模块）

- `test/usage/claude-code.test.js`：fixture jsonl → 三种信号形态统计（含归档区根下的 Read 动态加载）、`<command-name>` 与非 skill 命令的交集过滤、增量游标。
- `test/usage/codex.test.js`：fixture rollout → function_call 匹配；**developer 消息注入清单不计数的回归用例**；四种根目录、`\` 与 `/` 分隔符；`function_call_output` 排除。
- `test/usage/scan.test.js`：按文件替换语义（文件变化重扫不累加）、跨文件聚合。
- `test/skill-inventory.test.js`：临时目录模拟三个根 → 枚举 + frontmatter 解析 + **实体/链接识别与 realpath 去重**（Windows 下用 junction、posix 下用 symlink 构造 fixture）。
- `test/archive.test.js`：tmp 目录 → 纯 copy 布局归档、**symlink 布局归档（先摘链后迁实体）**、多副本合并、保活拒绝（含跨项目配置合并）、幂等、恢复（实体迁回 + 链接重建 + lock 快照回写）、清单重建。
- 命令层薄，`--json` 输出结构做集成冒烟。

## 10. 实现期验证点（不阻塞设计）

1. `skills remove` 在磁盘条目已被迁移（仅 lock 残留）时的实际行为——源码已确认支持 stale lock 清理，实现时实测一次确认无交互卡点。
2. Codex `function_call` 读取命令形态的启发式校准：真实样本（`Get-Content -Path`、`cat` 等）与提及型误报（`rg` 模式含 `SKILL.md`）的边界，以真实会话抽样对比。
3. Claude Code transcript 中 `<command-name>` 的完整形态（含嵌套转义）在 fixture 中覆盖。
4. Windows 无管理员权限环境下 junction 创建/删除行为（Node `fs.symlink(…, "junction")` 理论上无需特权，实测确认）。
5. Codex rollout 会话元数据中项目路径（cwd）字段的具体位置与格式，用于保活配置合并的项目发现。

## 11. 范围外（明确不做）

- 项目级 skill 的统计与归档。
- `auto: true` 的自动归档执行（配置位保留，本期只实现报告确认制）。
- `~/.codex/history.jsonl` 用户点名信号（误报风险，未来可选增强）。
- 归档区跨机器同步。
- 归档区内容与 source 上游的 diff/更新（归档即快照；需要更新时 restore 后走 `skills update`）。
