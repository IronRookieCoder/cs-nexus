import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const INSTALL_TYPES = new Set(["agent-skill", "upstream-guide", "command"]);
const SCOPES = new Set(["global", "project"]);

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  let source;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`找不到配置文件：${absolutePath}`);
    }
    throw error;
  }

  let value;
  try {
    value = YAML.parse(source);
  } catch (error) {
    throw new Error(`YAML 解析失败：${error.message}`);
  }

  return validateConfig(value, absolutePath);
}

export function validateConfig(value, configPath = path.resolve("cs-nexus.yaml")) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("配置必须是 YAML 对象");
  }
  if (value.version !== 1) {
    throw new Error(`不支持的配置版本：${String(value.version)}，当前仅支持 version: 1`);
  }
  if (!value.routing || typeof value.routing !== "object" || Array.isArray(value.routing)) {
    throw new Error("routing 必须是非空对象");
  }

  const routing = {};
  for (const [capability, route] of Object.entries(value.routing)) {
    const skill = typeof route === "string" ? route : route?.skill;
    assertSkillRef(skill, `routing.${capability}.skill`);
    routing[capability] = { skill };
  }

  const dependencies = {};
  for (const [skill, declaration] of Object.entries(value.dependencies ?? {})) {
    assertSkillRef(skill, `dependencies.${skill}`);
    const requires = Array.isArray(declaration) ? declaration : declaration?.requires;
    if (!Array.isArray(requires)) {
      throw new Error(`dependencies.${skill} 必须是数组或包含 requires 数组`);
    }
    for (const required of requires) {
      assertSkillRef(required, `dependencies.${skill}.requires`);
    }
    dependencies[skill] = [...new Set(requires)];
  }

  const providers = {};
  for (const [skill, provider] of Object.entries(value.providers ?? {})) {
    assertSkillRef(skill, `providers.${skill}`);
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`providers.${skill} 必须是对象`);
    }
    const install = provider.install ?? {};
    const type = install.type ?? "agent-skill";
    if (!INSTALL_TYPES.has(type)) {
      throw new Error(`providers.${skill}.install.type 不受支持：${type}`);
    }
    if (type === "agent-skill" && (typeof provider.source !== "string" || provider.source.trim() === "")) {
      throw new Error(`providers.${skill}.source 必须是字符串`);
    }
    if (type === "agent-skill" && install.copy !== undefined && typeof install.copy !== "boolean") {
      throw new Error(`providers.${skill}.install.copy 必须是布尔值`);
    }
    if (type === "upstream-guide" && (typeof install.url !== "string" || install.url.trim() === "")) {
      throw new Error(`providers.${skill}.install.url 必须是字符串`);
    }
    if (type === "upstream-guide" && install.actions !== undefined && !isStringArray(install.actions)) {
      throw new Error(`providers.${skill}.install.actions 必须是非空字符串数组`);
    }
    if (type === "command" && !isStringArray(install.command)) {
      throw new Error(`providers.${skill}.install.command 必须是非空字符串数组`);
    }
    if (type === "command" && install.verify !== undefined && !isCommandList(install.verify)) {
      throw new Error(`providers.${skill}.install.verify 必须是命令数组的数组`);
    }
    providers[skill] = {
      source: provider.source,
      name: provider.name,
      install: { ...install, type }
    };
  }

  const installation = value.installation ?? {};
  if (installation.agent !== undefined && (typeof installation.agent !== "string" || installation.agent.trim() === "")) {
    throw new Error("installation.agent 必须是非空字符串");
  }
  const scope = installation.scope ?? "global";
  if (!SCOPES.has(scope)) {
    throw new Error(`installation.scope 仅支持 global 或 project`);
  }
  const include = installation.include ?? [];
  if (!Array.isArray(include)) {
    throw new Error("installation.include 必须是数组");
  }
  include.forEach((skill) => assertSkillRef(skill, "installation.include"));

  const policy = value.policy ?? {};
  const mode = policy.default ?? "auto";
  if (!["auto", "fast", "deep"].includes(mode)) {
    throw new Error("policy.default 仅支持 auto、fast 或 deep");
  }
  const escalation = {
    enabled: true,
    direction: "simple-to-complex",
    ...(policy.escalation ?? {})
  };
  if (typeof escalation.enabled !== "boolean") {
    throw new Error("policy.escalation.enabled 必须是布尔值");
  }
  if (escalation.direction !== "simple-to-complex") {
    throw new Error("policy.escalation.direction 仅支持 simple-to-complex");
  }

  return {
    version: 1,
    routing,
    dependencies,
    providers,
    policy: { ...policy, default: mode, escalation },
    installation: {
      agent: installation.agent ?? "auto",
      scope,
      include: [...new Set(include)]
    },
    configPath,
    baseDir: path.dirname(configPath)
  };
}

function assertSkillRef(value, location) {
  if (typeof value !== "string" || value.trim() === "" || /\s/.test(value)) {
    throw new Error(`${location} 必须是非空且不含空格的 Skill 引用`);
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function isCommandList(value) {
  return Array.isArray(value) && value.every(isStringArray);
}
