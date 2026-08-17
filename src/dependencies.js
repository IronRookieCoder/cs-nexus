export function resolveSkillClosure(selected, dependencies = {}) {
  const result = [];
  const visited = new Set();
  const visiting = [];

  function visit(skill) {
    if (visited.has(skill)) return;
    const cycleStart = visiting.indexOf(skill);
    if (cycleStart !== -1) {
      const cycle = [...visiting.slice(cycleStart), skill].join(" -> ");
      throw new Error(`Skill 依赖存在环：${cycle}`);
    }

    visiting.push(skill);
    for (const dependency of dependencies[skill] ?? []) {
      visit(dependency);
    }
    visiting.pop();
    visited.add(skill);
    result.push(skill);
  }

  for (const skill of selected) visit(skill);
  return result;
}
