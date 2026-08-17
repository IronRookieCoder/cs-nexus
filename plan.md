# 插件化 AI Coding 工作流设计方案

> 目标：遵循 **“一切皆插件”** 的思想，构建一套智能、高效、灵活，同时对开发者足够简单的 AI Coding 工作流。
>
> 核心原则：**只自研现有生态没有解决好的关键决策层；Brainstorm、Plan、Debug、TDD、Review、Browser 等具体能力优先复用成熟 Skill。**

------

## 1. 设计目标

这套工作流需要同时解决两个看似冲突的问题：

- **简单任务足够快**：不能修改一行代码也走 Brainstorm → Spec → Plan → Subagent → Review 的重流程。
- **复杂任务足够稳**：不能大型架构改造仍然直接 Explore → Edit → Done。
- **需求不明确时主动澄清**：但不能把能从代码中找到的事实反问给开发者。
- **能力可替换**：今天使用 Superpowers，未来出现更好的 Skill 时，可以直接替换。
- **插件按需安装**：不绑定某个开源仓库，更不要求整个仓库全部安装。
- **默认自动化**：开发者不需要学习工作流框架才能使用。
- **允许人工干预**：高级用户需要时可以强制轻量或深度流程。
- **质量有统一底线**：无论任务大小，完成之前必须验证。

最终希望达到：

```text
内部：智能路由 + 多种 Skills + 动态升级 + 依赖解析

用户：直接说要做什么
```

------

# 2. 核心设计原则

## 2.1 一切皆 Skill

Brainstorming、Planning、Debugging、TDD、Browser、Code Review、Subagent 编排等都视为可替换能力：

```text
Capability
    ↓
Skill Provider
```

例如：

```text
debugging
    ↓
superpowers:systematic-debugging
```

未来可以替换成：

```text
debugging
    ↓
other-repo:better-debugging
```

Router 不应该依赖具体仓库实现。

------

## 2.2 Policy 与 Capability 分离

整个系统最重要的职责边界：

```text
Router = 决定做什么、何时做

Skill = 决定具体怎么做
```

Router 不应该自己实现：

- Brainstorm
- Spec
- Plan
- TDD
- Debug
- Code Review
- Browser automation
- Subagent execution
- Worktree management

否则最终会重新造出一个新的 Superpowers。

------

## 2.3 Skill 是安装和组合的最小单位

不要：

```text
安装 Superpowers
安装 mattpocock/skills
```

而应该：

```text
安装：
- systematic-debugging
- verification-before-completion
- brainstorming
- writing-plans
- grilling
...
```

`vercel-labs/skills` 当前支持从 GitHub、GitLab、本地目录等来源安装，并通过 `--skill` 精确选择仓库里的特定 Skill，也支持针对 Codex、Claude Code 等不同 Agent 安装，因此 Skill 包管理本身没有必要重新开发。

例如：

```bash
npx skills add obra/superpowers \
  --skill systematic-debugging \
  --skill verification-before-completion
```

------

# 3. 用户体验优先

整个架构虽然内部插件化，但**不能把插件复杂度暴露给开发者**。

开发者的正常体验应该只有：

```text
第一次：
ai-coding setup

以后：
直接描述任务
```

例如：

```text
“修复登录按钮点击没反应的问题”
```

系统自己决定：

```text
Router
→ Debugging Skill
→ Fix
→ Verify
```

开发者不应该需要回答：

```text
这是 L1 还是 L2？

要不要 Brainstorm？

是否启用 SDD？

使用哪个 Skill？

是否创建 Worktree？
```

原则：

> **用户描述目标，系统选择流程。**

------

# 4. 整体架构

```text
                       Developer
                           │
                    Natural Language
                           │
                           ▼
                  ┌─────────────────┐
                  │   Task Router   │
                  │  唯一决策核心   │
                  └────────┬────────┘
                           │
                     Task Routing
                           │
         ┌─────────────────┼──────────────────┐
         │                 │                  │
       Simple             Bug              Complex
         │                 │                  │
         ▼                 ▼                  ▼
   Native Coding      Debug Skill       Design / Plan
      Loop                                    │
         │                                     ▼
         │                              Execution Strategy
         │                              ┌──────┴──────┐
         │                              │             │
         │                         Sequential     Subagents
         │                              │             │
         └──────────────┬───────────────┴─────────────┘
                        │
                  On-demand Skills
                        │
          ┌─────────────┼─────────────┐
          │             │             │
        Browser       Review         TDD ...
          │             │             │
          └─────────────┼─────────────┘
                        │
                        ▼
                    Verification
                        │
                        ▼
                       Done
```

系统核心只负责：

```text
1. 理解任务
2. 判断是否需要澄清
3. 判断任务复杂度
4. 选择 Skill
5. 动态升级流程
6. 保证最终验证
```

------

# 5. Router：唯一需要重点自研的能力

Router 不应该是 Workflow Engine。

它本质上是一个：

> **Task → Policy → Skill 的智能路由器**

主要解决四个问题。

------

## 5.1 这是什么任务？

首先识别任务类型：

```text
Question
Research
Code Change
Bug
Refactor
Architecture
Review
...
```

例如：

```text
“解释这个函数”
→ Answer

“调查为什么接口偶发 500”
→ Debug

“订单列表增加来源字段”
→ Code Change

“设计一套新的权限系统”
→ Architecture
```

------

# 6. 第一个关键判断：Fact 还是 Decision

需求不明确不能简单等于：

```text
不知道
→ 问用户
```

必须区分：

### Fact

可以通过代码、文档、日志、运行环境找到答案。

例如：

```text
登录 API 在哪里？

当前页面用了什么状态管理？

字段从哪个接口返回？

项目有哪些测试命令？
```

处理：

```text
Explore
→ 自己找
```

不要询问开发者。

------

### Decision

代码无法替开发者决定的问题。

例如：

```text
登录成功后：

A. 返回原页面
B. 进入首页
C. 进入租户选择
```

这才应该：

```text
Clarification Skill
```

因此：

```text
Unknown
   │
   ├─ Fact
   │    ↓
   │  Explore
   │
   └─ Decision
        ↓
     Clarify
```

------

# 7. 需求澄清：使用 Skill，而不是 Router 自己问

需求存在关键未决决策时：

```text
Router
   ↓
Requirement Clarification
   ↓
Skill
```

以 mattpocock/skills 为例，更准确的底层 Provider 应该是：

```text
grilling
```

而 `/grill-me` 更接近用户调用入口；当前 `grill-me` Skill 本身设置了 `disable-model-invocation`，内部调用 `grilling`。

因此可以配置：

```yaml
requirement_clarification:
  provider: mattpocock/skills:grilling
```

而用户仍然可以显式使用：

```text
/grill-me
```

进入完整讨论模式。

------

# 8. 第二个关键判断：Simple / Complex

任务等级不要设计成：

```text
L0 / L1 / L2 / L3 / L4 / L5
```

否则任务分级本身又变成新的流程负担。

只保留：

```text
Simple
Complex
```

并通过**动态升级**处理边界情况。

------

# 9. Simple：默认最轻路径

满足以下大多数条件即可走 Simple：

- 需求明确
- 修改范围局部
- 已有成熟实现模式可以复用
- 不涉及重要架构决策
- 不改变公共协议
- 不涉及数据库迁移
- 不涉及安全、权限、计费等高风险逻辑
- 不涉及复杂并发和一致性
- 不跨多个系统
- 验证方式明确

典型任务：

```text
修改文案

增加普通字段

简单 UI 调整

已有页面增加按钮

局部逻辑修复

明确的小功能

简单重构
```

执行：

```text
Explore
   ↓
Light Plan
   ↓
Execute
   ↓
Verify
```

------

## 9.1 Simple 不需要独立 quick-dev Skill

这部分应该直接利用 Coding Agent 原生能力。

例如：

```text
Explore
→ 找到相关文件和调用链

Plan
→ 内部形成 3~5 个步骤

Execute
→ 最小范围修改

Verify
→ 测试 / lint / typecheck / browser 等
```

不要生成：

```text
SPEC.md

DESIGN.md

docs/plans/xxx.md

多个 Subagent
```

除非执行过程中发现任务比预想复杂。

------

# 10. Complex：风险和不确定性驱动

复杂度不要按：

```text
预计开发几小时

代码多少行
```

判断。

真正应该关注：

```text
影响范围
+
不确定性
+
风险
+
验证难度
```

以下情况可以直接进入 Complex：

- 跨模块
- 跨服务
- 新增子系统
- 核心业务流程变化
- 架构调整
- Public API / Protocol 变化
- DB Schema / Migration
- 权限 / 安全 / 用户数据
- 计费
- 并发 / 一致性
- 基础设施
- 复杂状态机
- 大量未知代码
- 多种方案存在重大 Trade-off
- 很难验证正确性

------

# 11. Complex 工作流

推荐：

```text
Design
   ↓
Plan
   ↓
Execution Strategy
   ↓
Execute
   ↓
Review / Verify
```

例如使用 Superpowers：

```text
superpowers:brainstorming
        ↓
superpowers:writing-plans
        ↓
Execution Strategy
        ↓
┌──────────────────────────────┐
│                              │
▼                              ▼
executing-plans       subagent-driven-development
│                              │
└──────────────┬───────────────┘
               ↓
            Verify
```

Superpowers 当前本身提供 brainstorming、writing-plans、executing-plans、subagent-driven-development、systematic-debugging、TDD、code review、worktree 等相互组合的 Skills。

所以这里的原则是：

> **复用它的 Skill，不重新实现它的方法论。**

------

# 12. Complex ≠ Multi-Agent

这是必须避免的误区。

是否使用 Subagent 应该看：

```text
Task Independence
```

而不是：

```text
Task Complexity
```

因此：

```text
Complex
   ↓
Tasks independent?
   │
   ├─ Yes
   │    ↓
   │  Subagent-driven development
   │
   └─ No
        ↓
      Sequential execution
```

例如：

```text
Task A：实现后端接口
Task B：实现独立的数据迁移工具
Task C：实现前端页面
```

边界明确时可以并行。

但：

```text
Task B 强依赖 Task A 过程中形成的数据模型
Task C 又依赖 A/B 的具体实现
```

强行 Subagent 化只会增加：

- 上下文重建
- Agent handoff
- 重复探索
- 冲突
- Review 成本

因此：

> **复杂度决定流程重量，独立性决定并行方式。**

------

# 13. Bug 走独立路径

Bug 不应该先进行通用 brainstorming。

推荐：

```text
Bug
 ↓
Debugging Skill
 ↓
Reproduce
 ↓
Evidence
 ↓
Root Cause
 ↓
Fix
 ↓
Regression Verification
```

例如：

```yaml
debugging:
  provider: obra/superpowers:systematic-debugging
```

Superpowers 当前提供独立的 `systematic-debugging` 和 `verification-before-completion`。

未来也完全可以替换成其他 Debug Skill。

------

# 14. 动态升级：整个系统最重要的机制

Router 不需要第一次就百分百判断正确。

推荐：

> **最轻流程启动，根据新证据升级。**

例如：

```text
用户：
订单列表增加一个状态字段
```

开始：

```text
Simple
```

Explore 后发现：

```text
DB Schema
   ↓
Migration
   ↓
Backend API
   ↓
Frontend
   ↓
Backward Compatibility
```

立即：

```text
Simple
   ↓
Upgrade
   ↓
Complex
```

然后进入：

```text
Design
→ Plan
→ Execute
```

------

## 14.1 只升级，不强制降级

推荐：

```text
Simple → Complex
```

不要：

```text
Complex → Simple → Complex
```

避免流程反复震荡。

------

## 14.2 升级不回填历史流程

比如已经：

```text
Explore
→ 修改了一部分
```

随后发现复杂度提升。

不应该：

```text
回到起点

重新补齐所有此前应该存在的流程文档
```

而应该：

```text
保存已有证据
→ 暂停扩大修改
→ 从当前状态进入 Design / Plan
```

原则：

> **流程是风险控制手段，不是文档仪式。**

------

# 15. Skill 选择原则

Router 面对能力时遵循：

```text
Capability
   ↓
Preferred Provider
   ↓
Skill
```

例如：

```yaml
routing:

  requirement_clarification:
    skill: mattpocock/skills:grilling

  complex_design:
    skill: obra/superpowers:brainstorming

  planning:
    skill: obra/superpowers:writing-plans

  debugging:
    skill: obra/superpowers:systematic-debugging

  sequential_execution:
    skill: obra/superpowers:executing-plans

  parallel_execution:
    skill: obra/superpowers:subagent-driven-development

  verification:
    skill: obra/superpowers:verification-before-completion
```

这只是默认 Provider。

未来：

```yaml
debugging:
  skill: company/better-debugging
```

Router 不需要改变。

------

# 16. 一个 Capability 只有一个默认 Owner

不要出现：

```text
Bug
 ↓
systematic-debugging
 ↓
diagnosing-bugs
 ↓
另外一个 Debug Skill
```

这会造成：

- 指令冲突
- 重复流程
- Token 浪费
- Agent 行为不可预测

正确模型：

```text
Capability
    ↓
One Active Provider
```

其他 Skill 可以作为：

```text
Alternative Provider
```

但不默认叠加。

------

# 17. Superpowers 的正确集成方式

这是整个方案中非常关键的一点。

Superpowers 本身不仅是 Skill 集合，也是完整开发方法论；其官方基础流程会把 brainstorming、worktree、planning、execution、TDD、review 等组合起来，并强调相关 Skill 属于 mandatory workflow。

特别是当前 `using-superpowers` 要求只要 Skill 有可能适用，就优先调用，而且明确把 brainstorming 放在开发任务之前。

如果直接全量安装并让它成为顶层 Policy：

```text
Router
 ↓
Simple
```

可能又被：

```text
using-superpowers
 ↓
brainstorming
 ↓
...
```

重新升级成重流程。

因此：

## 推荐

```text
Router = Global Policy Owner

Superpowers = Skill Provider
```

默认**不要依赖 `using-superpowers` 作为整个系统入口**。

而是选择性使用：

```text
brainstorming
writing-plans
systematic-debugging
executing-plans
subagent-driven-development
verification-before-completion
...
```

这样才能真正实现：

```text
小任务轻
复杂任务重
```

------

# 18. Skill 安装：不要自己造包管理器

Agent Skill 类型的安装、更新、Agent 适配等能力直接交给：

```text
vercel-labs/skills
```

它当前支持：

```text
find
add
use
update

GitHub / GitLab / Git / Local

指定 Skill

指定 Agent

Project / Global
```

并支持 Codex、Claude Code、Cursor、OpenCode 等大量 Agent。

所以不要开发：

```text
Skill Downloader

GitHub Resolver

Agent Path Resolver

Update Engine

Symlink Manager
```

这些都不是本项目的核心价值。

------

# 19. Skill Bootstrap

可以提供一个非常薄的：

```bash
ai-coding setup
```

它不是新的包管理器。

本质：

```text
读取 ai-coding.yaml
       ↓
解析需要的 Skills
       ↓
解析 Skill Dependencies
       ↓
调用 npx skills
       ↓
检查是否安装成功
```

例如：

```bash
npx skills add obra/superpowers \
  --skill brainstorming \
  --skill writing-plans \
  --skill systematic-debugging \
  --skill verification-before-completion \
  -a codex
```

------

# 20. 不要求整个仓库安装

例如 Superpowers 可以只选择：

```text
brainstorming
writing-plans
systematic-debugging
verification-before-completion
```

而不是全部安装。

同样：

```text
mattpocock/skills
```

也只安装真正需要的 Skill。

这正是 Skill 化架构的重要收益。

------

# 21. 必须增加 Dependency Rules

选择单个 Skill 后，有可能存在 Skill 间依赖。

例如当前：

```text
grill-me
 ↓
grilling
```

`grill-me` 本身只是调用 `grilling` 的入口。

因此应该声明：

```yaml
dependencies:

  mattpocock/skills:grill-me:
    requires:
      - mattpocock/skills:grilling
```

同理，某些 Superpowers Skill 也可能依赖其他 Skill 或流程能力。

所以 Bootstrap 必须：

```text
Selected Skills
      ↓
Resolve Dependencies
      ↓
Install Closure
```

但不要做复杂的依赖求解器。

简单 DAG 即可。

------

# 22. 非标准 Skill / 外部工具同样插件化

不是所有能力都一定能通过：

```text
npx skills
```

完成。

某些 Skill 可能还依赖：

- CLI
- Browser Extension
- Docker
- Runtime
- MCP
- Binary
- Local Service

这种情况允许声明：

```yaml
install:
  type: upstream-guide
```

例如 BrowserSkill 只是这种类型的一个例子，并不是系统必选组件。

其官方安装指南当前要求安装 CLI + Skill、运行 `bsk doctor`，浏览器扩展仍需要用户交互完成。

所以系统应该支持：

```text
Agent Skill
→ npx skills

External Capability
→ official install guide

Company Internal Skill
→ internal installer

Local Skill
→ local path
```

统一的是**能力模型**，而不是安装方式。

------

# 23. 外部安装必须有安全边界

对于：

```text
curl ... | sh

irm ... | iex

npm install -g ...

docker ...

修改系统配置
```

不要默认静默执行。

推荐：

```text
首次安装
   ↓
识别来源
   ↓
展示要执行的操作
   ↓
用户授权
   ↓
安装
   ↓
Verify
```

可信来源可以记住授权。

目标是：

> 日常无感，但首次修改机器环境时透明。

------

# 24. 一个统一配置文件即可

避免：

```text
routing.yaml
capabilities.yaml
profiles.yaml
plugins.yaml
dependencies.yaml
```

概念过多。

MVP 推荐统一：

```text
ai-coding.yaml
```

例如：

```yaml
version: 1

routing:
  clarification:
    skill: mattpocock/skills:grilling

  design:
    skill: obra/superpowers:brainstorming

  planning:
    skill: obra/superpowers:writing-plans

  debugging:
    skill: obra/superpowers:systematic-debugging

  sequential-execution:
    skill: obra/superpowers:executing-plans

  parallel-execution:
    skill: obra/superpowers:subagent-driven-development

  verification:
    skill: obra/superpowers:verification-before-completion

dependencies:
  mattpocock/skills:grill-me:
    - mattpocock/skills:grilling

policy:
  default: auto

  complex_when:
    - architecture-change
    - cross-service
    - public-api-change
    - db-migration
    - security
    - permissions
    - billing
    - concurrency
    - high-verification-cost

  escalation:
    enabled: true
    direction: simple-to-complex

installation:
  agent: auto
```

这是配置，不应该演变成新的 DSL。

------

# 25. 日常运行时流程

完整流程最终可以压缩成：

```text
                         Task
                           │
                           ▼
                        Router
                           │
                 Need clarification?
                    ┌──────┴──────┐
                   Yes            No
                    │              │
                    ▼              ▼
               Clarify Skill    Task Type
                                   │
                       ┌───────────┼───────────┐
                       │           │           │
                     Simple       Bug        Complex
                       │           │           │
                       ▼           ▼           ▼
                    Native       Debug       Design
                    Coding       Skill         │
                     Loop                      ▼
                                            Plan
                                              │
                                       Task Independence
                                         ┌────┴────┐
                                         │         │
                                     Coupled   Independent
                                         │         │
                                      Inline   Subagents
                                         │         │
                                         └────┬────┘
                                              │
                                              ▼
                                           Verify
                                              │
                                              ▼
                                             Done
```

------

# 26. Verify 是所有路径的统一底线

Simple 不意味着：

```text
代码改完
→ Done
```

而应该：

```text
代码改完
→ Evidence
→ Done
```

Evidence 根据任务自动选择：

```text
Unit Test

Integration Test

Typecheck

Lint

Build

Browser verification

API call

Screenshot

Logs

Smoke Test
```

关键原则：

> **没有新的验证证据，就不要宣称任务完成。**

可以默认使用：

```text
superpowers:verification-before-completion
```

作为通用 Provider。

------

# 27. Browser / UI / Review / TDD 都不是一级工作流

这些属于：

> **On-demand Capability**

例如：

```text
Frontend task
 ↓
Simple Coding
 ↓
Need visual verification
 ↓
Browser Skill
 ↓
Verify
```

又例如：

```text
Complex backend change
 ↓
Plan
 ↓
High regression risk
 ↓
TDD Skill
 ↓
Execute
```

不要设计：

```text
Simple Flow
Frontend Flow
Browser Flow
TDD Flow
Review Flow
Backend Flow
...
```

否则 Route 数量会持续膨胀。

------

# 28. Developer Override：只保留三个模式

默认：

```text
auto
```

Router 自己决定。

高级用户只保留：

```text
fast
deep
```

例如：

```text
/fast 修改这个文案
```

表示：

```text
尽可能保持轻流程
```

而：

```text
/deep 重构权限系统
```

表示：

```text
强制进行完整设计和计划
```

最终：

```text
auto   默认智能决策
fast   用户偏向速度
deep   用户偏向完整性
```

不要暴露十几个 Workflow Flags。

------

# 29. Router 默认应该静默

不要每个任务都输出：

```text
Route: SIMPLE

Complexity: 23

Selected provider:
superpowers:...

Reason:
...
```

用户真正想看的是：

```text
我先检查订单列表的字段来源和已有实现。
```

只有这些情况下需要解释：

### 动态升级

```text
检查后发现这个修改还涉及数据库迁移和 API 协议，我会先确认设计再继续。
```

### 需要用户决策

```text
这里有一个无法从代码判断的产品行为需要确认……
```

### 缺少能力

```text
这个任务需要真实浏览器验证，目前没有可用的 Browser Skill。
```

原则：

> **Reveal complexity only when complexity matters.**

------

# 30. Skill Discovery 也可以插件化

未来遇到当前没有 Provider 的能力：

```text
Need Capability
      ↓
No Provider
      ↓
Skill Discovery
```

可以进一步调用：

```text
npx skills find ...
```

`vercel-labs/skills` 本身提供 Skill 搜索能力。

例如：

```text
Need:
accessibility audit

No configured provider
        ↓
find skill
        ↓
quality / source check
        ↓
recommend
        ↓
user approve install
```

这使整个架构具备真正的可扩展性：

> **未知能力不是重新开发，而是先寻找现成 Skill。**

------

# 31. Skill 选择优先级

推荐：

```text
1. 项目内部 Skill
2. 团队官方 Skill
3. 已配置可信开源 Skill
4. 主流社区 Skill
5. 自研
```

只有：

```text
没有合适 Skill
+
这是长期重复出现的能力
+
具有明显业务价值
```

才自研新的 Skill。

贯彻：

> **Reuse → Configure → Compose → Build**

而不是：

> **Build first**

------

# 32. MVP 项目结构

整个项目可以非常小：

```text
ai-coding/
│
├── skills/
│   └── task-router/
│       └── SKILL.md
│
├── ai-coding.yaml
│
├── scripts/
│   └── setup.*
│
└── README.md
```

核心只有：

```text
Task Router
+
Skill Configuration
+
Dependency Rules
+
Thin Bootstrap
```

不要第一阶段开发：

```text
Workflow Engine
Plugin Runtime
Package Manager
Agent Platform
Task Database
Web UI
DAG Engine
Observability Platform
```

------

# 33. Setup 用户体验

第一次：

```bash
ai-coding setup
```

可以自动：

```text
✓ Detect Codex

✓ Resolve required skills

✓ Install requirement clarification

✓ Install debugging

✓ Install verification

✓ Install complex-development skills

✓ Validate installation

Ready.
```

如果某能力涉及修改机器环境：

```text
Optional external capability detected

This installer will:
- install xxx CLI
- add an Agent Skill
- require xxx permission

Install? [Y/n]
```

一次完成即可。

------

# 34. 日常使用示例

## 示例 1：简单需求

开发者：

```text
订单列表增加“订单来源”字段。
```

Router：

```text
Simple
```

实际：

```text
Explore
→ 找类似字段
→ 修改
→ test/typecheck
→ Done
```

用户基本感觉不到 Router 存在。

------

## 示例 2：小需求发现隐藏复杂度

开发者：

```text
用户增加所属租户字段。
```

开始：

```text
Simple
```

Explore 后发现：

```text
tenant
→ authentication
→ permission
→ token
→ DB
```

自动：

```text
Upgrade → Complex
```

Agent 告知：

```text
这个字段实际影响登录身份和权限模型，我会先确认数据模型和兼容方案再修改。
```

然后：

```text
Brainstorm
→ Plan
→ Execute
→ Verify
```

------

# 35. 示例 3：需求不明确

开发者：

```text
优化一下登录流程。
```

Agent先 Explore：

```text
当前：
手机号一键登录
验证码登录
登录后进入首页
...
```

只有出现真正 Decision 时：

```text
这次优化主要解决哪个问题：

A. 减少登录步骤
B. 提升一键登录成功率
C. 调整首次登录流程
```

进入 Clarification Skill。

------

# 36. 示例 4：Bug

开发者：

```text
偶尔登录后会跳回登录页面，修一下。
```

Router：

```text
Bug
```

执行：

```text
systematic-debugging
↓
复现
↓
收集 token / route / request evidence
↓
定位 root cause
↓
增加 regression test
↓
修复
↓
verification
```

不是先 brainstorm 产品方案。

------

# 37. 示例 5：大型需求

开发者：

```text
增加多租户权限体系。
```

Router：

```text
Complex
```

流程：

```text
Explore
↓
Brainstorm
↓
Architecture Decision
↓
Plan
↓
Task decomposition
↓
判断 task independence
↓
Sequential / Subagent execution
↓
Review
↓
Verification
```

------

# 38. 核心质量规则

无论什么 Skill，都应该遵守几条框架级规则：

### 规则 1：Explore before ask

代码能回答的问题不要问用户。

### 规则 2：Smallest sufficient process

只使用足以控制当前风险的最轻流程。

### 规则 3：Escalate on evidence

发现复杂度后升级，而不是一开始预防性使用最重流程。

### 规则 4：No duplicated ownership

一个 Capability 默认只有一个 Provider。

### 规则 5：No duplicated implementation

成熟 Skill 已经解决的问题不重新开发。

### 规则 6：Verify before completion

所有路径最终必须有新鲜验证证据。

### 规则 7：User intent > workflow ritual

流程服务于开发任务，而不是开发任务服务于流程。

------

# 39. 最终系统边界

## 我们负责

```text
Task Understanding

Routing

Complexity Classification

Dynamic Escalation

Skill Selection

Skill Dependencies

Basic Bootstrap

Completion Policy
```

## 开源 Skill 负责

```text
Requirement Clarification

Brainstorming

Planning

Debugging

TDD

Code Review

Subagent Development

Browser Automation

Architecture Review

Testing

Deployment

...
```

## vercel-labs/skills 负责

```text
Skill Discovery

Repository Resolution

Skill Installation

Agent Adaptation

Skill Update
```

这样职责边界最清晰。

------

# 40. 最终架构

```text
                         Developer
                             │
                             ▼
                      Natural Request
                             │
                             ▼
                    ┌─────────────────┐
                    │   Task Router   │
                    │                 │
                    │ understand      │
                    │ classify        │
                    │ route           │
                    │ escalate        │
                    └────────┬────────┘
                             │
                       Need Capability
                             │
                             ▼
                    ┌─────────────────┐
                    │ ai-coding.yaml  │
                    │                 │
                    │ provider        │
                    │ dependency      │
                    │ policy          │
                    └────────┬────────┘
                             │
                        Select Skill
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
     Superpowers       Matt Skills       Other Skills
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                             ▼
                      Execute / Verify
                             │
                             ▼
                            Done


                    Installation Layer

                       ai-coding setup
                             │
                             ▼
                     dependency resolve
                             │
                   ┌─────────┴──────────┐
                   │                    │
                   ▼                    ▼
             Agent Skills         External Tools
                   │                    │
                   ▼                    ▼
             npx skills          upstream installer
```

------

# 41. 最终方案总结

最终不要构建：

```text
一个新的 AI Coding Workflow Framework
```

而是构建：

```text
AI Coding Router
+
Composable Skills
```

核心可以进一步压缩成：

```text
Task
 ↓
Understand
 ↓
Clarify if needed
 ↓
Simple / Bug / Complex
 ↓
Select Skill
 ↓
Execute
 ↓
Escalate if needed
 ↓
Verify
 ↓
Done
```

整个体系真正自研的部分只有：

```text
1. Task Router
2. Dynamic Escalation Policy
3. Skill Mapping
4. Skill Dependency Rules
5. Thin Setup Bootstrap
```

其他全部尽可能复用开源生态。

最终判断这套方案是否成功，可以用一个非常简单的标准：

> **一个开发者完成一次初始化后，即使完全不知道 Router、Superpowers、grilling、SDD、Capability Provider 等概念，也能直接描述开发需求，并自动获得与任务复杂度匹配的工作流。**

内部可以复杂和智能，但外部必须做到：

> **简单任务不打扰，复杂任务不草率；需要决策时才问，需要能力时才调用，发现风险时才升级，完成任务前一定验证。**

这就是“一切皆插件”思想下，兼顾 **智能、高效、灵活和简单易用** 的 AI Coding 工作流。