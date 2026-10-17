const features = new Map();

export function registerBuiltinFeature({ id = 'jm', toolDefs = [], promptSections = [] } = {}) {
  features.set(id, { toolDefs: Array.isArray(toolDefs) ? toolDefs : [], promptSections: Array.isArray(promptSections) ? promptSections : [] });
}

export function builtinFeatureToolDefs() {
  return [...features.values()].flatMap((f) => f.toolDefs);
}

export function builtinPromptSections() {
  return [...features.values()].flatMap((f) => f.promptSections)
    .sort((a, b) => Number(a?.priority || 50) - Number(b?.priority || 50))
    .map((item) => item?.title ? `【${item.title}】\n${item.content}` : String(item?.content || ''))
    .filter(Boolean)
    .join('\n\n');
}
