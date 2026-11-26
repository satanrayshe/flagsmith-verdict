import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { Facts, emptyFacts } from './facts.js';
import { listPackageFiles, listSourceFiles } from './files.js';

type Node = any;

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

function walk(node: Node, visit: (n: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit, ancestors);
    else if (child && typeof child.type === 'string') walk(child, visit, ancestors);
  }
  ancestors.pop();
}

const str = (n: Node): string | null =>
  n?.type === 'StringLiteral' ? n.value
  : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked
  : null;

/** Name of the called method or function: a.b.c() gives "c", f() gives "f". */
function calleeName(call: Node): string | null {
  const c = call.callee;
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if ((c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed && c.property?.type === 'Identifier') return c.property.name;
  return null;
}

const unwrap = (n: Node): Node => {
  let cur = n;
  while (cur && ['AwaitExpression', 'TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSSatisfiesExpression'].includes(cur.type)) {
    cur = cur.argument ?? cur.expression;
  }
  return cur;
};

const isCall = (n: Node): boolean => n?.type === 'CallExpression' || n?.type === 'OptionalCallExpression';
const isMember = (n: Node): boolean => n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';

function objectProp(obj: Node, name: string): Node | undefined {
  if (obj?.type !== 'ObjectExpression') return undefined;
  return obj.properties.find((p: Node) => (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && !p.computed &&
    ((p.key.type === 'Identifier' && p.key.name === name) || (p.key.type === 'StringLiteral' && p.key.value === name)));
}
const hasSpread = (obj: Node): boolean => obj?.type === 'ObjectExpression' && obj.properties.some((p: Node) => p.type === 'SpreadElement');

/** True when the expression produces a new value on every run (random or time based). */
function isUnstable(expr: Node, unstableVars: Set<string>): boolean {
  let found = false;
  walk(expr, (n) => {
    if (n.type === 'Identifier' && unstableVars.has(n.name)) found = true;
    if (!isCall(n)) return;
    const c = n.callee;
    const name = calleeName(n);
    const objName = isMember(c) && c.object?.type === 'Identifier' ? c.object.name : null;
    if ((objName === 'Math' && name === 'random') || (objName === 'Date' && name === 'now') ||
        name === 'randomUUID' || name === 'uuidv4' || name === 'nanoid' || (objName === 'uuid' && name === 'v4')) found = true;
  });
  return found;
}

const PERSISTENCE = /localStorage|sessionStorage|document\.cookie|AsyncStorage|cookies\(|getCookie|setCookie/;

export function extractFromSource(code: string, file: string, facts: Facts): void {
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAttributes'],
    });
  } catch (err) {
    facts.parseErrors.push({ file, message: (err as Error).message });
    return;
  }
  const lines = code.split(/\r?\n/);
  const loc = (n: Node) => ({ file, line: n.loc?.start.line ?? 0, snippet: (lines[(n.loc?.start.line ?? 1) - 1] ?? '').trim().slice(0, 140) });

  const nodeFile = /['"](@flagsmith\/nodejs|flagsmith-nodejs)['"]/.test(code);
  const usesPersistence = PERSISTENCE.test(code);
  let hasFlushOrClose = false;
  let hasProcessExit = false;

  // Pass 1: variables.
  const flagVars = new Map<string, string>();      // const f = getExperimentFlag('x')  ->  f: x
  const variantVars = new Map<string, { flag: string; property: 'variant' | 'value' }>();
  const unstableVars = new Set<string>();

  const experimentCallFlag = (expr: Node): string | null => {
    const e = unwrap(expr);
    if (!isCall(e)) return null;
    const name = calleeName(e);
    if (name !== 'getExperimentFlag' && name !== 'useExperiment') return null;
    return str(e.arguments[0]);
  };
  const flagOfObject = (obj: Node): string | null => {
    const o = unwrap(obj);
    if (o?.type === 'Identifier') return flagVars.get(o.name) ?? null;
    return experimentCallFlag(o);
  };

  // Two sweeps so that `const v = f.variant` resolves when `f` is declared later in the walk order.
  for (let sweep = 0; sweep < 2; sweep++) {
    walk(ast, (n) => {
      if (n.type !== 'VariableDeclarator' && n.type !== 'AssignmentExpression') return;
      const target = n.type === 'VariableDeclarator' ? n.id : n.left;
      const init = n.type === 'VariableDeclarator' ? n.init : n.right;
      if (!init || !target) return;
      const value = unwrap(init);
      if (target.type === 'Identifier') {
        const flag = experimentCallFlag(value);
        if (flag) flagVars.set(target.name, flag);
        if (isMember(value) && !value.computed && (value.property.name === 'variant' || value.property.name === 'value')) {
          const f = flagOfObject(value.object);
          if (f) variantVars.set(target.name, { flag: f, property: value.property.name });
        }
        if (!usesPersistence && isUnstable(value, unstableVars)) unstableVars.add(target.name);
      } else if (target.type === 'ObjectPattern') {
        const f = flagOfObject(value);
        if (!f) return;
        for (const p of target.properties) {
          if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier' || p.value.type !== 'Identifier') continue;
          if (p.key.name === 'variant' || p.key.name === 'value') variantVars.set(p.value.name, { flag: f, property: p.key.name });
        }
      }
    });
  }

  const compareTarget = (expr: Node): { flag: string; property: 'variant' | 'value' } | null => {
    const e = unwrap(expr);
    if (e?.type === 'Identifier') return variantVars.get(e.name) ?? null;
    if (isMember(e) && !e.computed && (e.property.name === 'variant' || e.property.name === 'value')) {
      const f = flagOfObject(e.object);
      if (f) return { flag: f, property: e.property.name };
    }
    return null;
  };

  const readInit = (options: Node, kind: 'browser' | 'react' | 'node', at: Node) => {
    const ee = objectProp(options, 'enableEvents');
    let enableEvents: boolean | 'unknown';
    if (options?.type !== 'ObjectExpression') enableEvents = 'unknown';
    else if (!ee) enableEvents = hasSpread(options) ? 'unknown' : false;
    else if (ee.value?.type === 'BooleanLiteral') enableEvents = ee.value.value;
    else enableEvents = 'unknown';
    const local = objectProp(options, 'enableLocalEvaluation');
    const identity = objectProp(options, 'identity');
    facts.inits.push({
      ...loc(at), kind, enableEvents,
      localEvaluation: local?.value?.type === 'BooleanLiteral' && local.value.value === true,
      hasIdentityOption: Boolean(identity),
      unstableIdentity: Boolean(identity) && !usesPersistence && isUnstable(identity.value, unstableVars),
    });
  };

  // Pass 2: facts.
  walk(ast, (n, ancestors) => {
    if (n.type === 'NewExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'Flagsmith') {
      readInit(n.arguments[0], 'node', n);
      return;
    }
    if (n.type === 'JSXOpeningElement' && n.name?.type === 'JSXIdentifier' && n.name.name === 'FlagsmithProvider') {
      const attr = n.attributes.find((a: Node) => a.type === 'JSXAttribute' && a.name?.name === 'options');
      const value = attr?.value?.type === 'JSXExpressionContainer' ? attr.value.expression : undefined;
      readInit(value, 'react', n);
      return;
    }
    if (n.type === 'BinaryExpression' && ['===', '==', '!==', '!='].includes(n.operator)) {
      const pairs: [Node, Node][] = [[n.left, n.right], [n.right, n.left]];
      for (const [a, b] of pairs) {
        const literal = str(b);
        const target = literal !== null ? compareTarget(a) : null;
        if (target) facts.compares.push({ ...loc(n), flag: target.flag, literal: literal!, property: target.property });
      }
      return;
    }
    if (n.type === 'SwitchStatement') {
      const target = compareTarget(n.discriminant);
      if (target) {
        for (const c of n.cases) {
          const literal = str(c.test);
          if (literal !== null) facts.compares.push({ ...loc(c), flag: target.flag, literal, property: target.property });
        }
      }
      return;
    }
    if (!isCall(n)) return;
    const name = calleeName(n);
    const member = isMember(n.callee);
    const args = n.arguments;
    switch (name) {
      case 'init': {
        if (member && args[0]?.type === 'ObjectExpression' && (objectProp(args[0], 'environmentID') || objectProp(args[0], 'enableEvents'))) {
          readInit(args[0], 'browser', n);
        }
        break;
      }
      case 'getExperimentFlag':
      case 'useExperiment': {
        const flag = str(args[0]);
        if (flag !== null && (member || name === 'useExperiment')) facts.experimentFlags.push({ ...loc(n), flag, api: name, nodeFile });
        break;
      }
      case 'trackEvent': {
        if (!member) break;
        const opts = args[1];
        const hasIdentifier = opts?.type === 'ObjectExpression' ? Boolean(objectProp(opts, 'identifier')) || hasSpread(opts) : Boolean(opts);
        facts.trackEvents.push({ ...loc(n), name: str(args[0]), hasIdentifier, nodeFile });
        break;
      }
      case 'trackExposureEvent': {
        if (!member) break;
        const fn = [...ancestors].reverse().find((a) => /Function|ArrowFunctionExpression|ObjectMethod|ClassMethod/.test(a.type)) ?? ast;
        const text = code.slice(fn.start ?? 0, fn.end ?? code.length);
        facts.exposures.push({ ...loc(n), flag: str(args[0]), guarded: /inExperiment/.test(text) });
        break;
      }
      case 'identify': {
        if (!member || args.length === 0) break;
        facts.identifies.push({ ...loc(n), unstable: !usesPersistence && isUnstable(args[0], unstableVars) });
        break;
      }
      case 'close':
      case 'flushEvents':
        if (member) hasFlushOrClose = true;
        break;
      case 'exit':
        if (member && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'process') hasProcessExit = true;
        break;
    }
  });

  facts.files.push({ file, nodeFile, hasFlushOrClose, hasProcessExit, usesPersistence });
}

const SDK_PACKAGES = ['@flagsmith/flagsmith', '@flagsmith/nodejs', 'flagsmith-nodejs', 'flagsmith', 'react-native-flagsmith'];

export function extractFromPackageJson(text: string, file: string, facts: Facts): void {
  let pkg: any;
  try { pkg = JSON.parse(text); } catch { return; }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of SDK_PACKAGES) {
      const range = pkg?.[section]?.[name];
      if (typeof range === 'string') facts.deps.push({ file, name, range });
    }
  }
}

/** Scans a directory (or a single file) and returns every fact the rules need. */
export async function scan(root: string): Promise<Facts> {
  const abs = path.resolve(root);
  const facts = emptyFacts(abs);
  if (!fs.existsSync(abs)) throw new Error(`Path not found: ${root}`);
  if (fs.statSync(abs).isFile()) {
    extractFromSource(fs.readFileSync(abs, 'utf8'), path.basename(abs), facts);
    facts.filesScanned = 1;
    return facts;
  }
  const sources = await listSourceFiles(abs);
  for (const rel of sources) {
    const full = path.join(abs, rel);
    if (fs.statSync(full).size > 1_500_000) continue; // generated or bundled file
    extractFromSource(fs.readFileSync(full, 'utf8'), rel, facts);
  }
  facts.filesScanned = sources.length;
  for (const rel of await listPackageFiles(abs)) extractFromPackageJson(fs.readFileSync(path.join(abs, rel), 'utf8'), rel, facts);
  return facts;
}
