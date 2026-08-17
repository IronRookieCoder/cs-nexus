import path from "node:path";
import { resolveSkillClosure } from "./dependencies.js";

export function createInstallPlan(config, { agent, scope = config.installation.scope } = {}) {
  if (!agent || agent === "auto") {
    throw new Error("创建安装计划前必须确定目标 Agent");
  }

  const selected = [
    ...Object.values(config.routing).map((route) => route.skill),
    ...config.installation.include
  ];
  const ordered = resolveSkillClosure(selected, config.dependencies);
  const steps = [];
  const manual = [];
  const commands = [];

  for (const reference of ordered) {
    const descriptor = describeProvider(reference, config);
    if (descriptor.type === "upstream-guide") {
      manual.push(descriptor);
      steps.push(descriptor);
      continue;
    }
    if (descriptor.type === "command") {
      commands.push(descriptor);
      steps.push(descriptor);
      continue;
    }

    const localSource = isLocalSource(descriptor.source);
    const source = resolveSource(descriptor.source, config.baseDir);
    const copy = descriptor.copy ?? localSource;
    const previous = steps.at(-1);
    if (previous?.type === "agent-skill" && previous.source === source && previous.scope === scope && previous.copy === copy) {
      if (!previous.skills.includes(descriptor.name)) previous.skills.push(descriptor.name);
    } else {
      steps.push({ type: "agent-skill", source, scope, copy, skills: [descriptor.name] });
    }
  }

  return {
    agent,
    scope,
    selected: ordered,
    steps,
    agentSkills: steps.filter((step) => step.type === "agent-skill"),
    manual,
    commands
  };
}

export function buildNpxArgs(group, agent) {
  const args = ["--yes", "skills", "add", group.source];
  for (const skill of group.skills) args.push("--skill", skill);
  if (group.scope === "global") args.push("--global");
  if (group.copy) args.push("--copy");
  args.push("--agent", agent, "--yes");
  return args;
}

export function buildListArgs(scope, agent) {
  const args = ["--yes", "skills", "list"];
  if (scope === "global") args.push("--global");
  args.push("--agent", agent);
  return args;
}

function describeProvider(reference, config) {
  const configured = config.providers[reference];
  if (configured) {
    return {
      reference,
      type: configured.install.type,
      source: configured.source,
      name: configured.name ?? skillNameFromReference(reference),
      url: configured.install.url,
      actions: configured.install.actions ?? [],
      command: configured.install.command,
      copy: configured.install.copy,
      verify: configured.install.verify ?? []
    };
  }

  const separator = reference.lastIndexOf(":");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`Skill ${reference} 缺少 provider 声明，也不是 source:name 简写`);
  }
  return {
    reference,
    type: "agent-skill",
    source: reference.slice(0, separator),
    name: reference.slice(separator + 1)
  };
}

function skillNameFromReference(reference) {
  const separator = reference.lastIndexOf(":");
  return separator === -1 ? reference : reference.slice(separator + 1);
}

function resolveSource(source, baseDir) {
  if (isLocalSource(source)) {
    return path.resolve(baseDir, source);
  }
  return source;
}

function isLocalSource(source) {
  return source.startsWith("./") || source.startsWith("../") || path.isAbsolute(source);
}
