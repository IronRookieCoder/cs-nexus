# CS Nexus

CS Nexus 是一个薄的 AI Coding 路由层：开发者完成一次初始化后，继续用自然语言描述任务；`task-router` 根据任务类型、风险和不确定性选择最小充分流程，并把设计、调试、执行、验证等具体方法交给可替换的 Skill。

它不是工作流引擎，也不实现新的 Skill 包管理器。Skill 的发现、安装和更新复用 [`vercel-labs/skills`](https://github.com/vercel-labs/skills)。

## 环境要求

- Node.js 20 或更高版本
- npm / npx
- `skills` CLI 支持的 Coding Agent，例如 Codex 或 Claude Code

## 快速开始

克隆仓库后，在 PowerShell 中运行：

```powershell
.\scripts\setup.ps1
```

macOS / Linux：

```bash
./scripts/setup.sh
```

也可以安装 npm 包后使用统一命令：

```bash
ai-coding setup
```

Setup 会先展示安装范围、来源和完整命令，得到确认后才会安装。默认全局安装；无法自动识别 Agent 时显式传入：

```bash
ai-coding setup --agent codex
ai-coding setup --agent claude-code
```

Setup 验证所有 Agent Skill 都已出现在 `skills list --json` 后，才会保存 Router 使用的策略配置并输出 `Ready.`。全局安装保存到 `~/.ai-coding/ai-coding.yaml`，项目安装保存到当前项目的 `.ai-coding/ai-coding.yaml`；项目根目录中的 `ai-coding.yaml` 优先级最高。

常用参数：

```text
--dry-run          只展示计划，不修改环境
--yes, -y          跳过交互确认，适合可信的 CI 环境
--project          安装到当前项目而不是用户目录
--config <path>    使用另一份统一配置
--agent <name>     指定 skills CLI 的 Agent 名称
```

## 配置

所有策略和安装信息集中在 [`ai-coding.yaml`](./ai-coding.yaml)：

- `routing`：一个 Capability 对应一个默认 Skill Provider。
- `dependencies`：声明 Skill 间的简单 DAG 依赖，Setup 安装完整闭包。
- `providers`：覆盖来源或声明非标准安装方式。
- `policy`：配置 `auto` / `fast` / `deep` 以及单向动态升级条件。
- `installation`：指定 Agent、安装范围和必须安装的本地 Router Skill。

标准 `source:name` 引用会自动转换成按 Skill 安装命令。Provider 还支持两种需要显式安全处理的安装类型：

```yaml
providers:
  browser:browser-skill:
    install:
      type: upstream-guide
      url: https://example.com/official-install-guide
      actions:
        - 安装 CLI
        - 安装浏览器扩展

  company:internal-skill:
    install:
      type: command
      command: [company-skill-installer, install, internal-skill]
      verify: [[company-skill-installer, verify, internal-skill]]
```

`upstream-guide` 永远只展示官方指南，不替用户执行。`command` 会在总确认之后再次单独请求授权；只有显式 `--yes` 才允许非交互执行。

## Router 行为

Router 默认保持安静，开发者无需理解内部标签。它会：

- 先探索可发现的事实，只把无法从代码判断的产品或架构决策交给用户。
- 对明确局部修改使用原生轻流程。
- 对故障先复现和定位根因，再修复并回归验证。
- 对跨模块、高风险或难验证的改动使用设计与计划 Skill。
- 只有任务真正独立时才采用并行执行。
- 在新证据揭示风险时从 Simple 单向升级为 Complex。
- 在所有路径结束前要求与完成声明相匹配的新鲜验证证据。

## 开发与验证

```bash
npm install
npm test
npm run check
node bin/ai-coding.js setup --agent codex --dry-run
```

项目使用 Node.js 内置测试运行器，只需执行相关模块测试，无需额外测试框架。
