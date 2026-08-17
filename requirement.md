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
cs-nexus setup

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
