/**
 * Pi-Staffs 配置模块：schema 逐字照抄 pi-fabric-role-router 0.4.1（票 02 取证，D15），
 * 差异：删 runner/transport/extensions（D12 单一引擎），加模型档位 preset/presets（D23）；
 * 不再有每角色备胎链（D24 —— 与其自动换模型，不如让人切档位）。
 *
 * 为什么保留开放形状（[key: string]: unknown）：用户与 Fabric 都会往角色里加字段，
 * 我们读写时必须原样带过——否则一次 save 就静默吃掉别人的配置。
 */
import {
   closeSync,
   existsSync,
   fsyncSync,
   mkdirSync,
   openSync,
   readFileSync,
   renameSync,
   writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1;

/** 与 role-router 逐字一致（含 off/xhigh 两个冷门档）。 */
export type ThinkingLevel =
   | "off"
   | "minimal"
   | "low"
   | "medium"
   | "high"
   | "xhigh"
   | "max";

export type RoleMode = "primary" | "primary-or-advisory" | "subagent";

export const THINKING_LEVELS: ReadonlySet<string> = new Set([
   "off",
   "minimal",
   "low",
   "medium",
   "high",
   "xhigh",
   "max",
]);
export const ROLE_MODES: ReadonlySet<string> = new Set([
   "primary",
   "primary-or-advisory",
   "subagent",
]);
/** 角色名限制与 role-router 同族：小写字母数字与连字符。 */
export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type RoleRoute = {
   /** provider/model 直引，或 fabric.json 别名（D20 的解析规则）。 */
   model: string;
   thinking: ThinkingLevel;
   tools: string[];
   mode: RoleMode;
   /** 缺省与 true 都表示可派发（照抄 role-router 语义）。 */
   enabled?: boolean;
   purpose?: string;
   instructions?: string;
   [key: string]: unknown;
};

/** 档位里对单个角色的覆盖（D23）：只允许改模型与思考档。 */
export type PresetRole = {
   model: string;
   thinking?: ThinkingLevel;
   [key: string]: unknown;
};
/** 档位表：presets[档位名][角色名] = 覆盖；没写的角色继续用基线。 */
export type Presets = Record<string, Record<string, PresetRole>>;

export type DispatchConfig = {
   primaryRole?: string;
   defaultImplementationRole?: string;
   /** 每个模型最多尝试几次（含首次）；准入类失败值得多试一次。 */
   attemptsPerModel?: number;
   backoffBaseMs?: number;
   backoffCapMs?: number;
   [key: string]: unknown;
};

export type StaffsConfig = {
   configVersion: number;
   /** 当前档位名；空串表示不用档位（各角色用自带 model）。 */
   preset: string;
   presets: Presets;
   dispatch: DispatchConfig;
   roles: Record<string, RoleRoute>;
   [key: string]: unknown;
};

export const DEFAULT_DISPATCH: DispatchConfig = {
   primaryRole: "orchestrator",
   defaultImplementationRole: "fixer",
   attemptsPerModel: 2,
   backoffBaseMs: 1500,
   backoffCapMs: 30000,
};

/**
 * 七神祇（票 04 矩阵落盘值，来自 notes/04-role-matrix.md）。
 * 这里的 model 是**基线**：档位（presets）里的同名条目会覆盖它（D23）。
 */
export const DEFAULT_ROLES: Record<string, RoleRoute> = {
   orchestrator: {
      model: "ollama-cloud/glm-5.3",
      thinking: "high",
      mode: "primary",
      tools: ["*"],
      enabled: true,
      purpose: "队长：拆任务 / 派发 / 整合 / 验收",
   },
   explorer: {
      model: "ollama-cloud/glm-5.3-flash",
      thinking: "low",
      mode: "subagent",
      tools: ["read", "grep", "find", "ls"],
      enabled: true,
      purpose: "只读侦察：路径 + 行号 + 结论；也能读图（截图/设计稿/图表）",
   },
   oracle: {
      model: "ollama-cloud/kimi-k3",
      thinking: "max",
      mode: "subagent",
      tools: [
         "read",
         "grep",
         "find",
         "ls",
         "symbol_search",
         "module_report",
         "read_symbol",
         "read_enclosing",
         "lsp_diagnostics",
         "lens_diagnostics",
         "project_report",
      ],
      enabled: true,
      purpose: "战略顾问与审查者：架构选型、diff 审查、调试方向、安全与 YAGNI",
   },
   council: {
      model: "ollama-cloud/glm-5.3",
      thinking: "high",
      mode: "subagent",
      tools: ["*"],
      enabled: true,
      purpose: "多模型合议：并行 N 个模型出稿后合成单一答案并列出分歧点",
      /** 合议成员；票 07 用它喂 Fabric 的 council API。 */
      councilMembers: [
         "ollama-cloud/kimi-k3",
         "ollama-cloud/glm-5.3-flash",
         "xai/grok-4.6",
         "ollama-cloud/minimax-m2.7",
      ],
   },
   librarian: {
      model: "ollama-cloud/deepseek-v4-flash:0731",
      thinking: "medium",
      mode: "subagent",
      tools: [
         "read",
         "grep",
         "find",
         "ls",
         "grep_app_searchCode",
         "grep_app_github_file",
         "ddg_search_search",
         "ddg_search_fetch_content",
         "resolve-library-id",
         "query-docs",
      ],
      enabled: true,
      purpose: "外部知识：库 API、版本特定行为、需要最新 Web 事实的问题",
   },
   designer: {
      model: "ollama-cloud/glm-5.3-flash",
      thinking: "high",
      mode: "subagent",
      tools: [
         "read",
         "grep",
         "find",
         "ls",
         "edit",
         "write",
         "bash",
         "lsp_diagnostics",
         "lens_diagnostics",
         "module_report",
         "read_symbol",
         "read_enclosing",
         "ast_search",
      ],
      enabled: true,
      purpose:
         "用户可见界面：布局、响应式、UX 关键组件、视觉一致性、动效微交互",
   },
   fixer: {
      model: "ollama-cloud/deepseek-v4-flash:0731",
      thinking: "high",
      mode: "subagent",
      tools: [
         "read",
         "grep",
         "find",
         "ls",
         "edit",
         "write",
         "bash",
         "lsp_diagnostics",
         "lens_diagnostics",
         "module_report",
         "read_symbol",
         "read_enclosing",
         "ast_search",
      ],
      enabled: true,
      purpose: "按已定规范做有边界改动、可并行分区实现、测试改动",
   },
};

/**
 * 内置档位（D23）：`baseline` 就是各角色的基线模型。加档位只需在 presets 里加一个名字
 * （如 "cheap" / "cc"），条目只写要覆盖的角色。
 */
export const DEFAULT_PRESET = "baseline";
export const DEFAULT_PRESETS: Presets = {
   baseline: Object.fromEntries(
      Object.entries(DEFAULT_ROLES).map(([name, role]) => [
         name,
         { model: role.model },
      ]),
   ),
};

/** 全新配置的落盘内容（三处默认构造共用，避免各写一份而漏字段）。 */
export const defaultStaffsConfig = (): StaffsConfig => ({
   configVersion: CONFIG_VERSION,
   preset: DEFAULT_PRESET,
   presets: { baseline: { ...DEFAULT_PRESETS.baseline } },
   dispatch: { ...DEFAULT_DISPATCH },
   roles: { ...DEFAULT_ROLES },
});

export const staffsConfigPath = (
   env: NodeJS.ProcessEnv = process.env,
): string =>
   env.PI_STAFFS_CONFIG?.trim() ||
   join(homedir(), ".pi", "agent", "pi-staffs.json");

export const fabricConfigPath = (
   env: NodeJS.ProcessEnv = process.env,
): string =>
   env.PI_STAFFS_FABRIC_CONFIG?.trim() ||
   join(homedir(), ".pi", "agent", "fabric.json");

/** 读 JSON；任何失败（不存在/坏 JSON）都返回 undefined —— 调用方决定如何降级。 */
export const readJson = (path: string): unknown => {
   try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
   } catch {
      return undefined;
   }
};

/** 只取 fabric.json 的 models.aliases；D6 要求模型来源走别名，所以别名表是必需输入。 */
export const readAliases = (
   path: string = fabricConfigPath(),
): Record<string, string> => {
   const raw = readJson(path);
   const aliases = (raw as { models?: { aliases?: unknown } } | undefined)
      ?.models?.aliases;
   if (!aliases || typeof aliases !== "object") return {};
   const out: Record<string, string> = {};
   for (const [name, value] of Object.entries(
      aliases as Record<string, unknown>,
   )) {
      if (typeof value === "string" && value.trim()) out[name] = value.trim();
   }
   return out;
};

export type ResolvedModel = { ref: string; provider: string; id: string };

/**
 * D20：含 `/` 视作 provider/model 直引，否则视作 fabric.json 别名；别名只解一层
 * （再深就是配置错误，宁可报错也不要隐式猜）。
 */
export const resolveModelRef = (
   ref: unknown,
   aliases: Record<string, string>,
): ResolvedModel | undefined => {
   if (typeof ref !== "string") return undefined;
   let text = ref.trim();
   if (!text) return undefined;
   if (!text.includes("/")) {
      const alias = aliases[text] ?? aliases[text.toLowerCase()];
      if (typeof alias !== "string" || !alias.trim()) return undefined;
      text = alias.trim();
   }
   const slash = text.indexOf("/");
   if (slash <= 0) return undefined;
   const provider = text.slice(0, slash).trim();
   const id = text.slice(slash + 1).trim();
   if (!provider || !id) return undefined;
   return { ref: `${provider}/${id}`, provider, id };
};

/** 当前档位名：preset 为空或指向不存在的档位时返回 ""（= 不用档位，各角色用自己的 model）。 */
export const activePresetName = (config: StaffsConfig): string => {
   const name = typeof config.preset === "string" ? config.preset.trim() : "";
   return name && config.presets?.[name] ? name : "";
};

/**
 * 生效角色 = 角色基线 ⊕ 档位覆盖（D23）：档位只覆盖 model 与 thinking，
 * tools / mode / 提示词仍由角色决定——避免同一角色在不同档位下行为飘移。
 */
export const resolveRole = (
   config: StaffsConfig,
   roleName: string,
): RoleRoute | undefined => {
   const role = config.roles[roleName];
   if (!role) return undefined;
   const overlay = config.presets?.[activePresetName(config)]?.[roleName];
   if (!overlay || typeof overlay !== "object") return role;
   const model =
      typeof overlay.model === "string" && overlay.model.trim()
         ? overlay.model.trim()
         : role.model;
   const thinking =
      typeof overlay.thinking === "string" &&
      THINKING_LEVELS.has(overlay.thinking)
         ? overlay.thinking
         : role.thinking;
   return { ...role, model, thinking };
};

/**
 * 校验并归一：逐字段报问题（role-router 的风格），但不因为一个问题就丢掉整份配置——
 * 能用的部分继续用，问题列表交给 UI 提示。
 */
export const validateConfig = (
   raw: unknown,
   aliases: Record<string, string>,
): { config: StaffsConfig; issues: string[] } => {
   const issues: string[] = [];
   const source = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
   >;
   const dispatchRaw = (
      source.dispatch && typeof source.dispatch === "object"
         ? source.dispatch
         : {}
   ) as DispatchConfig;
   const rolesRaw = (
      source.roles && typeof source.roles === "object" ? source.roles : {}
   ) as Record<string, unknown>;

   const roles: Record<string, RoleRoute> = {};
   for (const [name, value] of Object.entries(rolesRaw)) {
      if (!ROLE_NAME_PATTERN.test(name)) {
         issues.push(
            `角色名 ${name} 非法（须匹配 ${ROLE_NAME_PATTERN.source}）`,
         );
         continue;
      }
      if (!value || typeof value !== "object") {
         issues.push(`角色 ${name} 不是对象，已跳过`);
         continue;
      }
      roles[name] = value as RoleRoute;
   }

   const configVersion =
      typeof source.configVersion === "number"
         ? source.configVersion
         : CONFIG_VERSION;

   if (Object.keys(roles).length === 0) {
      issues.push(
         `roles 为空，本次使用内置七神祇（${Object.keys(DEFAULT_ROLES).join(", ")}）`,
      );
      return {
         config: {
            ...source,
            ...defaultStaffsConfig(),
            configVersion,
            dispatch: { ...DEFAULT_DISPATCH, ...dispatchRaw },
         },
         issues,
      };
   }

   for (const [name, role] of Object.entries(roles)) {
      if (!resolveModelRef(role.model, aliases)) {
         issues.push(`角色 ${name} 的 model 无法解析：${String(role.model)}`);
      }
      if (
         typeof role.thinking !== "string" ||
         !THINKING_LEVELS.has(role.thinking)
      ) {
         issues.push(`角色 ${name} 的 thinking 非法：${String(role.thinking)}`);
      }
      if (
         !Array.isArray(role.tools) ||
         role.tools.some((tool) => typeof tool !== "string")
      ) {
         issues.push(`角色 ${name} 的 tools 必须是字符串数组`);
      }
      if (typeof role.mode !== "string" || !ROLE_MODES.has(role.mode)) {
         issues.push(`角色 ${name} 的 mode 非法：${String(role.mode)}`);
      }
      if (role.enabled !== undefined && typeof role.enabled !== "boolean") {
         issues.push(`角色 ${name} 的 enabled 必须是布尔`);
      }
   }

   // 档位校验（D23）：条目必须指向已存在的角色；报问题但**保留**原样，避免一次 save 吃掉用户数据。
   const presetsRaw = (
      source.presets && typeof source.presets === "object" ? source.presets : {}
   ) as Record<string, unknown>;
   const presets: Presets = {};
   for (const [presetName, entries] of Object.entries(presetsRaw)) {
      if (!entries || typeof entries !== "object") {
         issues.push(`档位 ${presetName} 不是对象，已跳过`);
         continue;
      }
      const kept: Record<string, PresetRole> = {};
      for (const [roleName, entry] of Object.entries(
         entries as Record<string, unknown>,
      )) {
         if (!entry || typeof entry !== "object") {
            issues.push(`档位 ${presetName} 的角色 ${roleName} 不是对象，已跳过`);
            continue;
         }
         if (!roles[roleName]) {
            issues.push(`档位 ${presetName} 引用了不存在的角色：${roleName}`);
         }
         const overlay = entry as PresetRole;
         if (!resolveModelRef(overlay.model, aliases)) {
            issues.push(
               `档位 ${presetName} 的角色 ${roleName} 模型无法解析：${String(overlay.model)}`,
            );
         }
         if (
            overlay.thinking !== undefined &&
            !THINKING_LEVELS.has(String(overlay.thinking))
         ) {
            issues.push(
               `档位 ${presetName} 的角色 ${roleName} thinking 非法：${String(overlay.thinking)}`,
            );
         }
         kept[roleName] = overlay;
      }
      presets[presetName] = kept;
   }
   const presetName =
      typeof source.preset === "string" ? source.preset.trim() : "";
   if (presetName && !presets[presetName]) {
      issues.push(`preset 指向不存在的档位：${presetName}（本次改用角色基线模型）`);
   }

   const config: StaffsConfig = {
      ...source,
      configVersion,
      preset: presetName,
      presets,
      dispatch: { ...DEFAULT_DISPATCH, ...dispatchRaw },
      roles,
   };
   if (
      config.dispatch.primaryRole &&
      !config.roles[config.dispatch.primaryRole]
   ) {
      issues.push(
         `dispatch.primaryRole 指向不存在的角色：${config.dispatch.primaryRole}`,
      );
   }
   if (
      config.dispatch.defaultImplementationRole &&
      !config.roles[config.dispatch.defaultImplementationRole]
   ) {
      issues.push(
         `dispatch.defaultImplementationRole 指向不存在的角色：${config.dispatch.defaultImplementationRole}`,
      );
   }
   return { config, issues };
};

export type LoadOutcome = {
   config: StaffsConfig;
   issues: string[];
   created: boolean;
   path: string;
};

/**
 * 加载配置：文件不存在就落一份七神祇默认（原子写）；坏 JSON 时用默认值但**不覆盖**用户文件
 * ——覆盖是数据丢失，宁可每次会话都提示一次。
 */
export const loadStaffsConfig = (
   options: { path?: string; aliasesPath?: string } = {},
): LoadOutcome => {
   const path = options.path ?? staffsConfigPath();
   const aliases = readAliases(options.aliasesPath ?? fabricConfigPath());
   if (!existsSync(path)) {
      const config = defaultStaffsConfig();
      writeStaffsConfig(config, path);
      return { config, issues: [], created: true, path };
   }
   const raw = readJson(path);
   if (raw === undefined) {
      return {
         config: defaultStaffsConfig(),
         issues: [
            `配置文件不是合法 JSON，本次用内置默认；原文件未改动：${path}`,
         ],
         created: false,
         path,
      };
   }
   const { config, issues } = validateConfig(raw, aliases);
   return { config, issues, created: false, path };
};

/** 原子写（临时文件 + fsync + rename，权限 0600），照抄 role-router 的 ensureRoutingConfig。 */
export const writeStaffsConfig = (
   config: StaffsConfig,
   path: string = staffsConfigPath(),
): void => {
   mkdirSync(dirname(path), { recursive: true });
   const temporary = `${path}.${process.pid}.tmp`;
   const descriptor = openSync(temporary, "w", 0o600);
   try {
      writeSync(descriptor, `${JSON.stringify(config, null, 2)}\n`);
      fsyncSync(descriptor);
   } finally {
      closeSync(descriptor);
   }
   renameSync(temporary, path);
};
