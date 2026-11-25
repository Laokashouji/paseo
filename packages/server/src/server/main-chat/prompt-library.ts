import {
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
  MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES,
  MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS,
  MAIN_CHAT_PROMPT_DESC_MAX_CHARS,
  MAIN_CHAT_PROMPT_TITLE_MAX_CHARS,
  isBuiltinMainChatPromptSlug,
  isReservedMainChatPromptSlug,
  normalizeMainChatPromptSlug,
  type MainChatPromptTemplate,
  type MainChatPromptTemplateInput,
} from "@getpaseo/protocol/main-chat";

function makePromptTemplateId(): string {
  return `ptpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listMergedPromptTemplates(customTemplates: readonly MainChatPromptTemplate[]): {
  templates: MainChatPromptTemplate[];
  builtinCount: number;
  customCount: number;
} {
  const sortedCustom = [...customTemplates]
    .filter((entry) => !entry.builtin)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    templates: [...BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES, ...sortedCustom],
    builtinCount: BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES.length,
    customCount: sortedCustom.length,
  };
}

function validateAndNormalizePromptInput(template: MainChatPromptTemplateInput): {
  slug: string;
  title: string;
  description: string;
  content: string;
  argumentHint: string | null;
} {
  const slug = normalizeMainChatPromptSlug(template.slug);
  if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error("快捷命令 slug 须以字母或数字开头，仅允许小写字母、数字、连字符和下划线");
  }
  if (isReservedMainChatPromptSlug(slug)) {
    throw new Error(`/${slug} 为 Paseo 内置客户端命令，不能作为自定义提示词命令名`);
  }
  if (isBuiltinMainChatPromptSlug(slug)) {
    throw new Error(`/${slug} 与内置提示词模板冲突，请使用其他自定义 slug`);
  }

  const title = template.title.trim();
  if (!title || title.length > MAIN_CHAT_PROMPT_TITLE_MAX_CHARS) {
    throw new Error(`提示词标题须为 1–${MAIN_CHAT_PROMPT_TITLE_MAX_CHARS} 字`);
  }

  const description = (template.description ?? "").trim();
  if (description.length > MAIN_CHAT_PROMPT_DESC_MAX_CHARS) {
    throw new Error(`提示词描述不能超过 ${MAIN_CHAT_PROMPT_DESC_MAX_CHARS} 字`);
  }

  const content = template.content.trim();
  if (!content || content.length > MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS) {
    throw new Error(`提示词正文须为 1–${MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS} 字`);
  }

  return {
    slug,
    title,
    description,
    content,
    argumentHint: template.argumentHint?.trim() || null,
  };
}

export function upsertCustomPromptTemplate(input: {
  template: MainChatPromptTemplateInput;
  existingCustom: readonly MainChatPromptTemplate[];
  nowIso: string;
}): {
  saved: MainChatPromptTemplate;
  nextCustom: MainChatPromptTemplate[];
} {
  const { slug, title, description, content, argumentHint } = validateAndNormalizePromptInput(
    input.template,
  );

  const existingById = input.template.id
    ? input.existingCustom.find((entry) => entry.id === input.template.id)
    : undefined;
  const existingBySlug = input.existingCustom.find((entry) => entry.slug === slug);

  if (existingBySlug && existingById && existingBySlug.id !== existingById.id) {
    throw new Error(`快捷命令 /${slug} 已存在，请换用其他 slug`);
  }

  const target = existingById ?? existingBySlug ?? null;
  if (!target && input.existingCustom.length >= MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES) {
    throw new Error(`自定义提示词已达上限（最多 ${MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES} 条）`);
  }

  const saved: MainChatPromptTemplate = {
    id: target?.id ?? makePromptTemplateId(),
    slug,
    title,
    description,
    content,
    argumentHint,
    builtin: false,
    category: input.template.category ?? "custom",
    createdAt: target?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso,
  };

  const nextCustom = target
    ? input.existingCustom.map((entry) => (entry.id === target.id ? saved : entry))
    : [saved, ...input.existingCustom];

  return { saved, nextCustom };
}

export function removeCustomPromptTemplate(input: {
  id?: string;
  slug?: string;
  existingCustom: readonly MainChatPromptTemplate[];
}): {
  deleted: boolean;
  nextCustom: MainChatPromptTemplate[];
} {
  const targetId = input.id?.trim() || null;
  const targetSlug = input.slug ? normalizeMainChatPromptSlug(input.slug) : null;
  if (!targetId && !targetSlug) {
    throw new Error("请提供要删除的提示词 id 或 slug");
  }

  if (
    (targetId && BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES.some((entry) => entry.id === targetId)) ||
    (targetSlug && isBuiltinMainChatPromptSlug(targetSlug))
  ) {
    throw new Error("内置快捷提示词受保护，不可删除");
  }

  const nextCustom = input.existingCustom.filter((entry) => {
    if (targetId && entry.id === targetId) return false;
    if (targetSlug && entry.slug === targetSlug) return false;
    return true;
  });

  return {
    deleted: nextCustom.length < input.existingCustom.length,
    nextCustom,
  };
}
