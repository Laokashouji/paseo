import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type AllocationSeverity = "stable" | "fresh-shallow" | "fresh-nested";

export type SelectorViolationRule =
  | "unstable-plain-selector"
  | "unstable-shallow-nested-selector"
  | "missing-equality-fn"
  | "unstable-object-is-selector";

export interface SelectorViolation {
  file: string;
  line: number;
  hookName: string;
  rule: SelectorViolationRule;
  detail: string;
  snippet: string;
}

export interface VirtualSourceFile {
  filePath: string;
  content: string;
}

interface ParsedFile {
  filePath: string;
  relPath: string;
  sourceFile: ts.SourceFile;
}

interface FunctionSummary {
  severity: AllocationSeverity;
  /** Property-level allocation severities when a function returns an object literal. */
  propertySeverities: Map<string, AllocationSeverity>;
}

interface LocalBindings {
  severities: Map<string, AllocationSeverity>;
  propertiesByVar: Map<string, Map<string, AllocationSeverity>>;
}

interface ClassificationContext {
  sf: ts.SourceFile;
  fnSummaries: ReadonlyMap<string, FunctionSummary>;
  locals: LocalBindings;
}

const STABLE_SUMMARY: FunctionSummary = {
  severity: "stable",
  propertySeverities: new Map(),
};

const ALLOCATING_ARRAY_METHODS = new Set([
  "map",
  "flatMap",
  "filter",
  "slice",
  "concat",
  "flat",
  "toSorted",
  "toReversed",
  "sort",
  "reverse",
  "split",
  "entries",
  "keys",
  "values",
]);

const NESTED_ELEMENT_TRANSFORM_METHODS = new Set(["map", "flatMap"]);

const ALLOCATING_OBJECT_METHODS = new Set(["keys", "values", "entries", "fromEntries", "assign"]);

const PRIMITIVE_OR_FIND_METHODS = new Set([
  "join",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "has",
  "get",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "toString",
  "valueOf",
  "getTime",
]);

const PRIMITIVE_PROPERTIES = new Set(["length", "size"]);

function maxSeverity(a: AllocationSeverity, b: AllocationSeverity): AllocationSeverity {
  if (a === "fresh-nested" || b === "fresh-nested") return "fresh-nested";
  if (a === "fresh-shallow" || b === "fresh-shallow") return "fresh-shallow";
  return "stable";
}

function makeSummary(
  severity: AllocationSeverity,
  propertySeverities = new Map<string, AllocationSeverity>(),
): FunctionSummary {
  return { severity, propertySeverities };
}

function mergePropertySeverities(
  left: ReadonlyMap<string, AllocationSeverity>,
  right: ReadonlyMap<string, AllocationSeverity>,
): Map<string, AllocationSeverity> {
  const merged = new Map(left);
  for (const [key, value] of right) {
    merged.set(key, maxSeverity(merged.get(key) ?? "stable", value));
  }
  return merged;
}

function unwrapExpr(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function walkSourceFiles(rootDir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function createParsedFile(filePath: string, relPath: string, content: string): ParsedFile {
  return {
    filePath,
    relPath,
    sourceFile: ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

function parseFiles(rootDir: string, virtualFiles?: readonly VirtualSourceFile[]): ParsedFile[] {
  if (virtualFiles) {
    return virtualFiles.map((file) => createParsedFile(file.filePath, file.filePath, file.content));
  }
  return walkSourceFiles(rootDir).map((filePath) =>
    createParsedFile(filePath, path.relative(rootDir, filePath), fs.readFileSync(filePath, "utf8")),
  );
}

function discoverZustandStoreHooks(files: readonly ParsedFile[]): Set<string> {
  const hooks = new Set<string>(["useStore"]);
  for (const { sourceFile } of files) {
    if (!sourceFile.text.includes("zustand")) continue;
    collectStoreHooksInFile(sourceFile, hooks);
  }
  return hooks;
}

function collectStoreHooksInFile(sourceFile: ts.SourceFile, hooks: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initText = node.initializer.getText(sourceFile);
      if (
        node.name.text.startsWith("use") &&
        /^(create\s*[<(]|createWorkspaceLayoutStore\s*\()/.test(initText)
      ) {
        hooks.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function getPropertyNameText(name: ts.PropertyName, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sf);
}

function classifyObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  let severity: AllocationSeverity = "fresh-shallow";
  const propertySeverities = new Map<string, AllocationSeverity>();

  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyNameText(prop.name, ctx.sf);
      const child = classifyExpression(prop.initializer, ctx);
      if (key) propertySeverities.set(key, child.severity);
      if (child.severity !== "stable") severity = "fresh-nested";
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      const childSev = ctx.locals.severities.get(key) ?? "stable";
      propertySeverities.set(key, childSev);
      if (childSev !== "stable") severity = "fresh-nested";
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      const child = classifyExpression(prop.expression, ctx);
      for (const [k, v] of child.propertySeverities) {
        propertySeverities.set(k, v);
        if (v !== "stable") severity = "fresh-nested";
      }
      if (child.severity === "fresh-nested") severity = "fresh-nested";
    }
  }

  return makeSummary(severity, propertySeverities);
}

function classifyArrayLiteral(
  expr: ts.ArrayLiteralExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  let severity: AllocationSeverity = "fresh-shallow";
  for (const element of expr.elements) {
    if (ts.isSpreadElement(element)) {
      if (classifyExpression(element.expression, ctx).severity === "fresh-nested") {
        severity = "fresh-nested";
      }
    } else if (classifyExpression(element, ctx).severity !== "stable") {
      severity = "fresh-nested";
    }
  }
  return makeSummary(severity);
}

function classifyObjectStaticCall(
  methodName: string,
  expr: ts.CallExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  if (methodName === "entries") return makeSummary("fresh-nested");
  if (methodName !== "fromEntries" || !expr.arguments[0]) return makeSummary("fresh-shallow");

  const arg = unwrapExpr(expr.arguments[0]);
  if (
    !ts.isCallExpression(arg) ||
    !ts.isPropertyAccessExpression(arg.expression) ||
    arg.expression.name.text !== "map" ||
    !arg.arguments[0]
  ) {
    return makeSummary("fresh-shallow");
  }
  const cb = unwrapExpr(arg.arguments[0]);
  if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) {
    return makeSummary("fresh-shallow");
  }
  const entryValSev = classifyTupleSecondElement(cb, ctx);
  return makeSummary(entryValSev !== "stable" ? "fresh-nested" : "fresh-shallow");
}

function classifyArrayFromCall(
  expr: ts.CallExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  const mapArg = expr.arguments[1];
  if (!mapArg) return makeSummary("fresh-shallow");
  const cb = unwrapExpr(mapArg);
  if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) {
    return makeSummary("fresh-shallow");
  }
  const cbRes = classifyFunctionLike(cb, ctx.sf, ctx.fnSummaries, ctx.locals);
  return makeSummary(cbRes.severity !== "stable" ? "fresh-nested" : "fresh-shallow");
}

function classifyArrayMethodCall(
  methodName: string,
  callee: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  if (NESTED_ELEMENT_TRANSFORM_METHODS.has(methodName) && expr.arguments[0]) {
    const cb = unwrapExpr(expr.arguments[0]);
    if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
      const cbRes = classifyFunctionLike(cb, ctx.sf, ctx.fnSummaries, ctx.locals);
      if (methodName === "flatMap") {
        // flatMap unwraps one array layer returned by the callback.
        return makeSummary(cbRes.severity === "fresh-nested" ? "fresh-nested" : "fresh-shallow");
      }
      return makeSummary(cbRes.severity !== "stable" ? "fresh-nested" : "fresh-shallow");
    }
  }
  const receiver = classifyExpression(callee.expression, ctx);
  return makeSummary(receiver.severity === "fresh-nested" ? "fresh-nested" : "fresh-shallow");
}

function classifyCallExpression(
  expr: ts.CallExpression,
  ctx: ClassificationContext,
): FunctionSummary {
  const callee = expr.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text;
    const objName = ts.isIdentifier(callee.expression) ? callee.expression.text : null;

    if (PRIMITIVE_OR_FIND_METHODS.has(methodName)) return STABLE_SUMMARY;
    if (objName === "Object" && ALLOCATING_OBJECT_METHODS.has(methodName)) {
      return classifyObjectStaticCall(methodName, expr, ctx);
    }
    if (objName === "Array" && methodName === "from") {
      return classifyArrayFromCall(expr, ctx);
    }
    if (ALLOCATING_ARRAY_METHODS.has(methodName)) {
      return classifyArrayMethodCall(methodName, callee, expr, ctx);
    }
    return STABLE_SUMMARY;
  }

  if (ts.isIdentifier(callee)) {
    return ctx.fnSummaries.get(callee.text) ?? STABLE_SUMMARY;
  }
  return STABLE_SUMMARY;
}

function isLogicalOrNullishBinary(expr: ts.Expression): expr is ts.BinaryExpression {
  if (!ts.isBinaryExpression(expr)) return false;
  const op = expr.operatorToken.kind;
  return (
    op === ts.SyntaxKind.QuestionQuestionToken ||
    op === ts.SyntaxKind.BarBarToken ||
    op === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

function classifyExpression(rawExpr: ts.Expression, ctx: ClassificationContext): FunctionSummary {
  const expr = unwrapExpr(rawExpr);

  if (ts.isIdentifier(expr)) {
    return makeSummary(
      ctx.locals.severities.get(expr.text) ?? "stable",
      ctx.locals.propertiesByVar.get(expr.text) ?? new Map(),
    );
  }
  if (ts.isObjectLiteralExpression(expr)) return classifyObjectLiteral(expr, ctx);
  if (ts.isArrayLiteralExpression(expr)) return classifyArrayLiteral(expr, ctx);
  if (ts.isNewExpression(expr)) return makeSummary("fresh-shallow");

  if (ts.isConditionalExpression(expr)) {
    const t = classifyExpression(expr.whenTrue, ctx);
    const f = classifyExpression(expr.whenFalse, ctx);
    return makeSummary(
      maxSeverity(t.severity, f.severity),
      mergePropertySeverities(t.propertySeverities, f.propertySeverities),
    );
  }

  if (isLogicalOrNullishBinary(expr)) {
    const l = classifyExpression(expr.left, ctx);
    const r = classifyExpression(expr.right, ctx);
    return makeSummary(
      maxSeverity(l.severity, r.severity),
      mergePropertySeverities(l.propertySeverities, r.propertySeverities),
    );
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    if (PRIMITIVE_PROPERTIES.has(propName)) return STABLE_SUMMARY;
    const base = classifyExpression(expr.expression, ctx);
    return makeSummary(base.propertySeverities.get(propName) ?? "stable");
  }

  if (ts.isCallExpression(expr)) return classifyCallExpression(expr, ctx);

  return STABLE_SUMMARY;
}

function classifyTupleSecondElement(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  ctx: ClassificationContext,
): AllocationSeverity {
  const inspectTuple = (expr: ts.Expression): AllocationSeverity => {
    const unwrapped = unwrapExpr(expr);
    if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length < 2) return "stable";
    const valEl = unwrapped.elements[1];
    if (!valEl || ts.isSpreadElement(valEl)) return "stable";
    return classifyExpression(valEl, ctx).severity;
  };

  if (!ts.isBlock(fn.body)) return inspectTuple(fn.body);

  let severity: AllocationSeverity = "stable";
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) {
      severity = maxSeverity(severity, inspectTuple(node.expression));
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return severity;
}

function recordVariableDeclaration(node: ts.VariableDeclaration, ctx: ClassificationContext): void {
  if (!node.initializer) return;
  const res = classifyExpression(node.initializer, ctx);

  if (ts.isIdentifier(node.name)) {
    ctx.locals.severities.set(node.name.text, res.severity);
    if (res.propertySeverities.size > 0) {
      ctx.locals.propertiesByVar.set(node.name.text, res.propertySeverities);
    }
    return;
  }

  if (!ts.isObjectBindingPattern(node.name)) return;
  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const propKey = element.propertyName
      ? getPropertyNameText(element.propertyName, ctx.sf)
      : element.name.text;
    if (propKey && res.propertySeverities.has(propKey)) {
      ctx.locals.severities.set(element.name.text, res.propertySeverities.get(propKey) ?? "stable");
    }
  }
}

function recordAssignmentMutation(node: ts.BinaryExpression, ctx: ClassificationContext): void {
  const rhs = classifyExpression(node.right, ctx);
  if (ts.isIdentifier(node.left)) {
    const prev = ctx.locals.severities.get(node.left.text) ?? "stable";
    ctx.locals.severities.set(node.left.text, maxSeverity(prev, rhs.severity));
    if (rhs.propertySeverities.size > 0) {
      ctx.locals.propertiesByVar.set(node.left.text, rhs.propertySeverities);
    }
    return;
  }
  if (ts.isElementAccessExpression(node.left) && ts.isIdentifier(node.left.expression)) {
    const varName = node.left.expression.text;
    const prev = ctx.locals.severities.get(varName) ?? "stable";
    if (prev !== "stable" && rhs.severity !== "stable") {
      ctx.locals.severities.set(varName, "fresh-nested");
    }
  }
}

function recordArrayPushMutation(node: ts.CallExpression, ctx: ClassificationContext): void {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "push" ||
    !ts.isIdentifier(node.expression.expression)
  ) {
    return;
  }
  const varName = node.expression.expression.text;
  if ((ctx.locals.severities.get(varName) ?? "stable") === "stable") return;
  for (const arg of node.arguments) {
    if (classifyExpression(arg, ctx).severity !== "stable") {
      ctx.locals.severities.set(varName, "fresh-nested");
    }
  }
}

function collectLocalBindings(
  fn: ts.FunctionLikeDeclarationBase,
  body: ts.Block,
  ctx: ClassificationContext,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isVariableDeclaration(node)) {
      recordVariableDeclaration(node, ctx);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      recordAssignmentMutation(node, ctx);
    } else if (ts.isCallExpression(node)) {
      recordArrayPushMutation(node, ctx);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function classifyFunctionLike(
  fn: ts.FunctionLikeDeclarationBase,
  sf: ts.SourceFile,
  fnSummaries: ReadonlyMap<string, FunctionSummary>,
  outerLocals?: LocalBindings,
): FunctionSummary {
  if (!fn.body) return STABLE_SUMMARY;

  const ctx: ClassificationContext = {
    sf,
    fnSummaries,
    locals: {
      severities: new Map(outerLocals?.severities),
      propertiesByVar: new Map(outerLocals?.propertiesByVar),
    },
  };

  if (!ts.isBlock(fn.body)) return classifyExpression(fn.body, ctx);

  collectLocalBindings(fn, fn.body, ctx);

  let severity: AllocationSeverity = "stable";
  let propertySeverities = new Map<string, AllocationSeverity>();

  const collectReturns = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const res = classifyExpression(node.expression, ctx);
      severity = maxSeverity(severity, res.severity);
      propertySeverities = mergePropertySeverities(propertySeverities, res.propertySeverities);
    }
    ts.forEachChild(node, collectReturns);
  };
  collectReturns(fn.body);

  return makeSummary(severity, propertySeverities);
}

interface IndexedFunctionDecl {
  name: string;
  fn: ts.FunctionLikeDeclarationBase;
  sf: ts.SourceFile;
}

function collectTopLevelFunctions(sourceFile: ts.SourceFile, out: IndexedFunctionDecl[]): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      if (!/^[A-Z]/.test(stmt.name.text)) {
        out.push({ name: stmt.name.text, fn: stmt, sf: sourceFile });
      }
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || /^[A-Z]/.test(decl.name.text)) {
        continue;
      }
      const init = unwrapExpr(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        out.push({ name: decl.name.text, fn: init, sf: sourceFile });
      }
    }
  }
}

function summariesEqual(a: FunctionSummary, b: FunctionSummary): boolean {
  if (a.severity !== b.severity || a.propertySeverities.size !== b.propertySeverities.size) {
    return false;
  }
  for (const [key, value] of a.propertySeverities) {
    if (b.propertySeverities.get(key) !== value) return false;
  }
  return true;
}

function buildFunctionIndex(files: readonly ParsedFile[]): Map<string, FunctionSummary> {
  const declarations: IndexedFunctionDecl[] = [];
  for (const { sourceFile } of files) {
    collectTopLevelFunctions(sourceFile, declarations);
  }

  const summaries = new Map<string, FunctionSummary>();
  // Fixed-point propagation handles multi-hop helpers (e.g. findMainChatAgentOnHost ->
  // resolveTargetMainChatHost -> selectMainChatSidebarSummary).
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const { name, fn, sf } of declarations) {
      const next = classifyFunctionLike(fn, sf, summaries);
      const prev = summaries.get(name);
      const merged = prev
        ? makeSummary(
            maxSeverity(prev.severity, next.severity),
            mergePropertySeverities(prev.propertySeverities, next.propertySeverities),
          )
        : next;
      if (!prev || !summariesEqual(prev, merged)) {
        summaries.set(name, merged);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return summaries;
}

function unwrapUseCallback(expr: ts.Expression): ts.Expression {
  const unwrapped = unwrapExpr(expr);
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "useCallback" &&
    unwrapped.arguments.length > 0
  ) {
    return unwrapExpr(unwrapped.arguments[0]);
  }
  return unwrapped;
}

function classifySelectorArg(
  rawArg: ts.Expression,
  sf: ts.SourceFile,
  fnSummaries: ReadonlyMap<string, FunctionSummary>,
): AllocationSeverity {
  const arg = unwrapUseCallback(rawArg);
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return classifyFunctionLike(arg, sf, fnSummaries).severity;
  }
  if (ts.isIdentifier(arg)) {
    return fnSummaries.get(arg.text)?.severity ?? "stable";
  }
  return "stable";
}

function checkEqualityFnCall(
  node: ts.CallExpression,
  relPath: string,
  line: number,
  snippet: string,
  sourceFile: ts.SourceFile,
  fnSummaries: ReadonlyMap<string, FunctionSummary>,
): SelectorViolation | null {
  const selectorArg = node.arguments[1];
  const equalityArg = node.arguments[2];
  if (!equalityArg) {
    return {
      file: relPath,
      line,
      hookName: "useStoreWithEqualityFn",
      rule: "missing-equality-fn",
      detail: "useStoreWithEqualityFn requires an explicit equality function.",
      snippet,
    };
  }
  if (!selectorArg) return null;

  const eqText = equalityArg.getText(sourceFile).trim();
  const unwrappedSelector = unwrapUseCallback(selectorArg);
  if (
    eqText === "Object.is" &&
    (ts.isArrowFunction(unwrappedSelector) || ts.isFunctionExpression(unwrappedSelector))
  ) {
    if (classifySelectorArg(selectorArg, sourceFile, fnSummaries) !== "stable") {
      return {
        file: relPath,
        line,
        hookName: "useStoreWithEqualityFn",
        rule: "unstable-object-is-selector",
        detail:
          "Inline selector allocates fresh object/array with Object.is equality; use fast-deep-equal or a memoized selector.",
        snippet,
      };
    }
  }

  if (
    eqText === "shallow" &&
    classifySelectorArg(selectorArg, sourceFile, fnSummaries) === "fresh-nested"
  ) {
    return {
      file: relPath,
      line,
      hookName: "useStoreWithEqualityFn",
      rule: "unstable-shallow-nested-selector",
      detail:
        "Selector allocates nested objects/arrays inside a shallow-compared snapshot (causes React #185); use fast-deep-equal (`equal`).",
      snippet,
    };
  }

  return null;
}

function checkStoreHookCall(
  callee: string,
  node: ts.CallExpression,
  relPath: string,
  line: number,
  snippet: string,
  sourceFile: ts.SourceFile,
  fnSummaries: ReadonlyMap<string, FunctionSummary>,
): SelectorViolation | null {
  const argIndex = callee === "useStore" ? 1 : 0;
  const selectorArg = node.arguments[argIndex];
  if (!selectorArg) return null;

  const unwrapped = unwrapExpr(selectorArg);
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "useShallow" &&
    unwrapped.arguments[0]
  ) {
    if (classifySelectorArg(unwrapped.arguments[0], sourceFile, fnSummaries) === "fresh-nested") {
      return {
        file: relPath,
        line,
        hookName: `${callee}(useShallow)`,
        rule: "unstable-shallow-nested-selector",
        detail:
          "useShallow only compares one level with Object.is; returning nested fresh objects/arrays still triggers React #185. Use useStoreWithEqualityFn(..., ..., equal) or select flat primitives.",
        snippet,
      };
    }
    return null;
  }

  if (classifySelectorArg(selectorArg, sourceFile, fnSummaries) !== "stable") {
    return {
      file: relPath,
      line,
      hookName: callee,
      rule: "unstable-plain-selector",
      detail:
        "Plain Zustand selector allocates a fresh object/array on every getSnapshot call (causes React #185 infinite re-render). Select primitives, wrap flat results in useShallow, or use useStoreWithEqualityFn(..., ..., equal).",
      snippet,
    };
  }
  return null;
}

export function auditZustandSelectors(options: {
  rootDir: string;
  virtualFiles?: readonly VirtualSourceFile[];
  extraStoreHooks?: readonly string[];
}): SelectorViolation[] {
  const files = parseFiles(options.rootDir, options.virtualFiles);
  const storeHooks = discoverZustandStoreHooks(files);
  for (const extra of options.extraStoreHooks ?? []) {
    storeHooks.add(extra);
  }
  const fnSummaries = buildFunctionIndex(files);
  const violations: SelectorViolation[] = [];

  for (const { relPath, sourceFile } of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (callee === "useStoreWithEqualityFn" || storeHooks.has(callee)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const snippet = node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180);
          const violation =
            callee === "useStoreWithEqualityFn"
              ? checkEqualityFnCall(node, relPath, line, snippet, sourceFile, fnSummaries)
              : checkStoreHookCall(callee, node, relPath, line, snippet, sourceFile, fnSummaries);
          if (violation) violations.push(violation);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return violations;
}
