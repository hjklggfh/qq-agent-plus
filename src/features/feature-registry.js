let currentTools = [];
let currentPrompts = [];

export function registerBuiltinFeature({ toolDefs = [], promptSections = [] } = {}) {
  currentTools = Array.isArray(toolDefs) ? toolDefs : [];
  currentPrompts = Array.isArray(promptSections) ? promptSections : [];
}

export function builtinFeatureToolDefs() {
  return currentTools;
}

export function builtinPromptSections() {
  return currentPrompts
    .slice()
    .sort((a, b) => Number(a?.priority || 50) - Number(b?.priority || 50))
    .map((item) => item?.title ? `【${item.title}】\n${item.content}` : String(item?.content || ''))
    .filter(Boolean)
    .join('\n\n');
}
