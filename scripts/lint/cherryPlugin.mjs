import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SRC_DIR = path.join(REPO_ROOT, 'src')
const FIXTURE_DIR = path.join(import.meta.dirname, '__fixtures__')
const FIXTURE_MARKER = '/scripts/lint/__fixtures__/'

const toPosix = (value) => value.split(path.sep).join('/')

const repoRelative = (filename) => {
  const normalized = toPosix(filename)
  const fixtureIndex = normalized.indexOf(FIXTURE_MARKER)
  if (fixtureIndex !== -1) {
    return normalized.slice(fixtureIndex + FIXTURE_MARKER.length).replace(/^(?:positive|negative)\//, '')
  }
  return toPosix(path.relative(REPO_ROOT, filename))
}

const filenameFor = (context) => context.filename ?? context.getFilename()

const importSource = (node) => {
  const value = node?.source?.value
  return typeof value === 'string' ? value : null
}

const resolveRepoImport = (specifier, fromRelative) => {
  const fromProcess =
    fromRelative.startsWith('src/main/') ||
    fromRelative.startsWith('scripts/utility-process-smoke/harness/utilityEntries/')
      ? 'main'
      : 'renderer'
  let target

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    target = path.posix.resolve(path.posix.dirname(`/${fromRelative}`), specifier).slice(1)
  } else if (specifier === '@application') {
    target = 'src/main/core/application'
  } else if (specifier === '@logger') {
    target = 'src/main/core/logger'
  } else if (specifier === '@renderer') {
    target = 'src/renderer'
  } else if (specifier.startsWith('@renderer/')) {
    target = `src/renderer/${specifier.slice('@renderer/'.length)}`
  } else if (specifier === '@main') {
    target = 'src/main'
  } else if (specifier.startsWith('@main/')) {
    target = `src/main/${specifier.slice('@main/'.length)}`
  } else if (specifier === '@shared') {
    target = 'src/shared'
  } else if (specifier.startsWith('@shared/')) {
    target = `src/shared/${specifier.slice('@shared/'.length)}`
  } else if (specifier === '@data') {
    target = `src/${fromProcess}/data`
  } else if (specifier.startsWith('@data/')) {
    target = `src/${fromProcess}/data/${specifier.slice('@data/'.length)}`
  } else {
    return null
  }

  return path.posix.normalize(target).replace(/\.(?:[cm]?[jt]sx?)$/, '')
}

const importVisitors = (check) => ({
  ImportDeclaration(node) {
    const source = importSource(node)
    if (source) check(node, source)
  },
  ExportNamedDeclaration(node) {
    const source = importSource(node)
    if (source) check(node, source)
  },
  ExportAllDeclaration(node) {
    const source = importSource(node)
    if (source) check(node, source)
  },
  ImportExpression(node) {
    const value = node.source?.value
    if (typeof value === 'string') check(node, value)
  }
})

const isInside = (candidate, directory) => candidate === directory || candidate.startsWith(`${directory}/`)

const isUtilityProcessChild = (filename) =>
  isInside(filename, 'src/main/core/utilityProcess/protocol') ||
  isInside(filename, 'src/main/core/utilityProcess/runtime') ||
  (filename.startsWith('src/main/') && filename.includes('/utilityEntries/')) ||
  isInside(filename, 'scripts/utility-process-smoke/harness/utilityEntries')

const UTILITY_PROCESS_FORBIDDEN_IMPORTS = [
  'src/main/core/application',
  'src/main/core/lifecycle',
  'src/main/core/logger',
  'src/main/core/paths',
  'src/main/data',
  'src/main/ipc',
  'src/main/services/proxy',
  'src/main/core/utilityProcess/host',
  'src/main/core/utilityProcess/UtilityProcessManager'
]

const utilityProcessBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      mainOnly:
        'Utility-process child code runs without the main process singletons. Use the child runtime and protocol layer instead; keep host-only code out of the entry graph.'
    }
  },
  create(context) {
    const importer = repoRelative(filenameFor(context))
    if (!isUtilityProcessChild(importer)) return {}

    const check = (node, specifier) => {
      const target = resolveRepoImport(specifier, importer)
      if (target && UTILITY_PROCESS_FORBIDDEN_IMPORTS.some((directory) => isInside(target, directory))) {
        context.report({ node, messageId: 'mainOnly' })
      }
    }

    return importVisitors(check)
  }
}

const rendererBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      sharedReverse:
        'Shared buckets must not import pages/windows (reverse layer edge). docs/references/architecture/renderer.md §7.',
      utilsComponent:
        'utils/ is stateless and may call downward infra (data/ipc) but must not import components/hooks or any higher app layer. docs/references/architecture/renderer.md §3.',
      utilsService:
        'utils/ must not import renderer services (except @logger). docs/references/architecture/renderer.md §3.',
      serviceBarrel:
        'Renderer service topics are closed barrels — import the topic index, not an internal module. docs/references/architecture/renderer.md §3.1/§5.'
    }
  },
  create(context) {
    const importer = repoRelative(filenameFor(context))
    if (!importer.startsWith('src/renderer/')) return {}

    const check = (node, specifier) => {
      const target = resolveRepoImport(specifier, importer)
      if (!target?.startsWith('src/renderer/')) return

      const sharedBuckets = ['components', 'hooks', 'services', 'utils']
      const importerBucket = sharedBuckets.find((bucket) => isInside(importer, `src/renderer/${bucket}`))
      if (importerBucket && (isInside(target, 'src/renderer/pages') || isInside(target, 'src/renderer/windows'))) {
        context.report({ node, messageId: 'sharedReverse' })
        return
      }

      if (importerBucket === 'utils') {
        if (isInside(target, 'src/renderer/components') || isInside(target, 'src/renderer/hooks')) {
          context.report({ node, messageId: 'utilsComponent' })
          return
        }
        if (
          isInside(target, 'src/renderer/services') &&
          target !== 'src/renderer/services/LoggerService' &&
          !target.startsWith('src/renderer/services/LoggerService/')
        ) {
          context.report({ node, messageId: 'utilsService' })
          return
        }
      }

      const serviceMatch = /^src\/renderer\/services\/([^/]+)(?:\/(.+))?$/.exec(target)
      if (!serviceMatch?.[2]) return
      const topicRoot = `src/renderer/services/${serviceMatch[1]}`
      if (!isInside(importer, topicRoot)) context.report({ node, messageId: 'serviceBarrel' })
    }

    return importVisitors(check)
  }
}

const pageBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      pageWindow: 'A page must not import a window (reverse edge). docs/references/architecture/renderer.md §2/§7.',
      pageSibling:
        'A page must not import another page (cross-page coupling). docs/references/architecture/renderer.md §7.'
    }
  },
  create(context) {
    const importer = repoRelative(filenameFor(context))
    if (!isInside(importer, 'src/renderer/pages')) return {}

    const check = (node, specifier) => {
      const target = resolveRepoImport(specifier, importer)
      if (!target?.startsWith('src/renderer/')) return

      if (isInside(target, 'src/renderer/windows')) {
        context.report({ node, messageId: 'pageWindow' })
        return
      }

      if (!isInside(target, 'src/renderer/pages')) return
      const importerDomain = importer.split('/')[3]
      const targetDomain = target.split('/')[3]
      if (importerDomain && targetDomain && importerDomain !== targetDomain) {
        context.report({ node, messageId: 'pageSibling' })
      }
    }

    return importVisitors(check)
  }
}

const stripCodeComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const isPureReexportIndex = (content) => {
  if (!/\bexport\b[^;]*?\bfrom[ \t]*['"]/.test(content)) return false
  const rest = stripCodeComments(content)
    .replace(/(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from[ \t]*['"][^'"]+['"];?/g, '\n')
    .replace(/(?:^|\n)[ \t]*import[ \t]*['"][^'"]+['"];?/g, '\n')
  return !/\bexport\b/.test(rest)
}

const collectIndexFiles = (directory, output = []) => {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return output
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__mocks__') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectIndexFiles(entryPath, output)
    else if (entry.name === 'index.ts') output.push(entryPath)
  }
  return output
}

const BARREL_DIRS = new Set()
const indexFiles = [
  ...collectIndexFiles(SRC_DIR),
  ...collectIndexFiles(path.join(FIXTURE_DIR, 'positive', 'src')),
  ...collectIndexFiles(path.join(FIXTURE_DIR, 'negative', 'src'))
]
for (const indexFile of indexFiles) {
  try {
    if (isPureReexportIndex(fs.readFileSync(indexFile, 'utf8'))) BARREL_DIRS.add(path.dirname(indexFile))
  } catch {}
}

const BARREL_DIRS_DEEPEST_FIRST = [...BARREL_DIRS].sort((left, right) => right.length - left.length)
const BARREL_DIRS_SHALLOWEST_FIRST = [...BARREL_DIRS_DEEPEST_FIRST].reverse()
const BARREL_RESOLVE_CACHE = new Map()

const resolveBarrelImport = (specifier, fromFile) => {
  const cacheKey = `${fromFile}\0${specifier}`
  if (BARREL_RESOLVE_CACHE.has(cacheKey)) return BARREL_RESOLVE_CACHE.get(cacheKey)

  const relativeFrom = repoRelative(fromFile)
  const relativeTarget = resolveRepoImport(specifier, relativeFrom)
  const isFixture = toPosix(fromFile).includes(FIXTURE_MARKER)
  let base = relativeTarget && !isFixture ? path.join(REPO_ROOT, relativeTarget) : null
  if ((isFixture || !base) && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    base = path.resolve(path.dirname(fromFile), specifier)
  }

  let resolved = null
  if (base) {
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
      base
    ]) {
      try {
        if (fs.statSync(candidate).isFile()) {
          resolved = candidate
          break
        }
      } catch {}
    }
  }

  BARREL_RESOLVE_CACHE.set(cacheKey, resolved)
  return resolved
}

const innermostBarrelDir = (filename) =>
  BARREL_DIRS_DEEPEST_FIRST.find(
    (directory) => filename === directory || filename.startsWith(`${directory}${path.sep}`)
  ) ?? null

const outermostCrossedBarrelDir = (target, importer) =>
  BARREL_DIRS_SHALLOWEST_FIRST.find(
    (directory) =>
      target.startsWith(`${directory}${path.sep}`) &&
      importer !== directory &&
      !importer.startsWith(`${directory}${path.sep}`)
  ) ?? null

const noExportStar = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden:
        'No `export *` — use explicit named re-exports (docs/references/architecture/naming-conventions.md §6.4).'
    }
  },
  create(context) {
    return {
      ExportAllDeclaration(node) {
        if (node.source) context.report({ node, messageId: 'forbidden' })
      }
    }
  }
}

const indexNoImplementation = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      statement: 'A barrel is pure re-export — move top-level logic to a named file.',
      sideEffect: 'A barrel is pure re-export — side-effect imports belong in a named module.',
      defaultExport: 'A barrel must not contain a default implementation.',
      declaration: 'A barrel must not declare local values or types.',
      localExport: 'A barrel must re-export from another module, not export local bindings.'
    }
  },
  create(context) {
    if (!/[\\/]index\.ts$/.test(filenameFor(context))) return {}
    return {
      Program(node) {
        const statement = node.body.find((item) => !/^(?:Import|Export)/.test(item.type))
        if (statement) context.report({ node: statement, messageId: 'statement' })
      },
      ImportDeclaration(node) {
        if (!node.specifiers.length) context.report({ node, messageId: 'sideEffect' })
      },
      ExportDefaultDeclaration(node) {
        context.report({ node, messageId: 'defaultExport' })
      },
      ExportNamedDeclaration(node) {
        if (node.declaration) context.report({ node, messageId: 'declaration' })
        else if (!node.source && node.specifiers.length) context.report({ node, messageId: 'localExport' })
      }
    }
  }
}

const noIndexTsx = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden:
        'No `index.tsx` — use `index.ts` for a barrel, a named component file, or `<segment>.index.tsx` for a route.'
    }
  },
  create(context) {
    if (!/[\\/]index\.tsx$/.test(filenameFor(context))) return {}
    return { Program: (node) => context.report({ node, messageId: 'forbidden' }) }
  }
}

const namedOnlyBarrel = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'A barrel exposes named exports; do not forward a bare default.' }
  },
  create(context) {
    if (!/[\\/]index\.tsx?$/.test(filenameFor(context))) return {}
    return {
      ExportNamedDeclaration(node) {
        if (!node.source) return
        for (const specifier of node.specifiers) {
          if (specifier.exported?.name === 'default') context.report({ node: specifier, messageId: 'forbidden' })
        }
      }
    }
  }
}

const barrelClosed = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Deep import into a closed barrel — import its index instead.' }
  },
  create(context) {
    const importer = filenameFor(context)
    const check = (node, specifier) => {
      const target = resolveBarrelImport(specifier, importer)
      if (!target) return
      const crossed = outermostCrossedBarrelDir(target, importer)
      if (!crossed || target === path.join(crossed, 'index.ts')) return
      context.report({ node, messageId: 'forbidden' })
    }
    return importVisitors(check)
  }
}

const barrelNoNesting = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'A barrel must not re-export another barrel; let each unit own its entry point.' }
  },
  create(context) {
    const importer = filenameFor(context)
    if (!/[\\/]index\.ts$/.test(importer)) return {}
    const importerDirectory = path.dirname(importer)
    const check = (node, specifier) => {
      const target = resolveBarrelImport(specifier, importer)
      if (!target) return
      const targetBarrel = innermostBarrelDir(target)
      if (targetBarrel && targetBarrel !== importerDirectory) context.report({ node, messageId: 'forbidden' })
    }
    return importVisitors(check)
  }
}

const noBucketRootBarrel = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Bucket roots (types/utils/services) must not expose a barrel.' }
  },
  create(context) {
    if (
      !/[\\/]src[\\/](?:main|renderer|shared)[\\/](?:types|utils|services)[\\/]index\.tsx?$/.test(filenameFor(context))
    ) {
      return {}
    }
    return { Program: (node) => context.report({ node, messageId: 'forbidden' }) }
  }
}

const isKebabName = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const isCamelName = (value) => /^[a-z][a-zA-Z0-9]*$/.test(value)
const isPascalName = (value) => /^[A-Z][a-zA-Z0-9]*$/.test(value)
const isRouteToken = (value) => value.startsWith('$') || value.startsWith('_')
const isModuleFileStem = (value) => {
  const bare = value.replace(/^_+/, '')
  return isCamelName(bare) || isPascalName(bare)
}

const NAMING_EXEMPT_DIRS = new Set(['__tests__', '__mocks__', '__snapshots__'])
const NAMING_ZONES = [
  {
    prefix: 'packages/ui/',
    root: 2,
    label: 'packages/ui',
    directory: isKebabName,
    directoryExpectation: 'kebab-case',
    file: isKebabName,
    fileExpectation: 'kebab-case'
  },
  {
    prefix: 'src/renderer/routes/',
    root: 3,
    label: 'routes',
    directory: (value) => isKebabName(value) || isRouteToken(value),
    directoryExpectation: 'kebab-case',
    file: (value) => isKebabName(value) || isRouteToken(value),
    fileExpectation: 'kebab-case'
  },
  { prefix: 'src/renderer/assets/', unmanaged: true },
  {
    prefix: 'src/renderer/',
    root: 2,
    label: 'src/renderer',
    directory: (value) => isCamelName(value) || isPascalName(value),
    directoryExpectation: 'camelCase or PascalCase',
    file: isModuleFileStem,
    fileExpectation: 'camelCase or PascalCase'
  },
  ...['main', 'shared', 'preload'].map((processName) => ({
    prefix: `src/${processName}/`,
    root: 2,
    label: `src/${processName}`,
    directory: isCamelName,
    directoryExpectation: 'camelCase',
    file: isModuleFileStem,
    fileExpectation: 'camelCase or PascalCase'
  }))
]

const namingReportedDirectories = new Set()
const pathCase = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      directory: 'Directory segment `{{name}}` must be {{expectation}} under {{zone}}.',
      file: 'File stem `{{name}}` must be {{expectation}} under {{zone}}.'
    }
  },
  create(context) {
    const relative = repoRelative(filenameFor(context))
    const zone = NAMING_ZONES.find((candidate) => relative.startsWith(candidate.prefix))
    if (!zone || zone.unmanaged) return {}

    return {
      Program(node) {
        const parts = relative.split('/')
        const fileName = parts.at(-1)
        const directories = parts.slice(zone.root, -1)
        for (let index = 0; index < directories.length; index++) {
          const segment = directories[index]
          if (segment.startsWith('.') || NAMING_EXEMPT_DIRS.has(segment) || zone.directory(segment)) continue
          const directory = parts.slice(0, zone.root + index + 1).join('/')
          if (namingReportedDirectories.has(directory)) continue
          namingReportedDirectories.add(directory)
          context.report({
            node,
            messageId: 'directory',
            data: { name: segment, expectation: zone.directoryExpectation, zone: zone.label }
          })
        }

        if (/^index\.tsx?$/.test(fileName) || fileName.endsWith('.d.ts')) return
        const stem = fileName.split('.')[0]
        if (!stem || zone.file(stem)) return
        context.report({
          node,
          messageId: 'file',
          data: { name: stem, expectation: zone.fileExpectation, zone: zone.label }
        })
      }
    }
  }
}

const noAsFilepath = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      absolute: '`as AbsoluteFilePath` forges the brand. Build it with AbsoluteFilePathSchema.parse(value) instead.',
      canonical:
        '`as CanonicalFilePath` forges the canonical dedup key. Build it with canonicalizeFilePath(value) instead.'
    }
  },
  create(context) {
    const check = (node) => {
      const annotation = node.typeAnnotation
      if (annotation?.type !== 'TSTypeReference' || annotation.typeName?.type !== 'Identifier') return
      if (annotation.typeName.name === 'AbsoluteFilePath') context.report({ node, messageId: 'absolute' })
      if (annotation.typeName.name === 'CanonicalFilePath') context.report({ node, messageId: 'canonical' })
    }
    return { TSAsExpression: check, TSTypeAssertion: check }
  }
}

const noDirectQuit = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      restricted: 'Quit APIs and signals are owned by the Application lifecycle; do not use {{name}} directly.'
    }
  },
  create(context) {
    const appMethods = new Set(['quit', 'exit', 'relaunch'])
    const appEvents = new Set(['before-quit', 'will-quit', 'window-all-closed'])
    const processSignals = new Set(['SIGINT', 'SIGTERM'])
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return
        const property = callee.property.type === 'Identifier' ? callee.property.name : null
        if (!property) return

        if (callee.object.name === 'app' && appMethods.has(property)) {
          context.report({ node, messageId: 'restricted', data: { name: `app.${property}()` } })
          return
        }

        const firstArgument = node.arguments[0]
        if (firstArgument?.type !== 'Literal' || typeof firstArgument.value !== 'string') return
        if (callee.object.name === 'app' && ['on', 'once'].includes(property) && appEvents.has(firstArgument.value)) {
          context.report({ node, messageId: 'restricted', data: { name: `app.${property}('${firstArgument.value}')` } })
        }
        if (
          callee.object.name === 'process' &&
          ['on', 'once'].includes(property) &&
          processSignals.has(firstArgument.value)
        ) {
          context.report({
            node,
            messageId: 'restricted',
            data: { name: `process.${property}('${firstArgument.value}')` }
          })
        }
      }
    }
  }
}

const noTemplateInTranslation = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: '⚠️ Avoid template literals in t() — they make rendering output unpredictable' }
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        const isTranslation =
          (callee.type === 'Identifier' && callee.name === 't') ||
          (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && callee.property.name === 't')
        if (isTranslation && node.arguments[0]?.type === 'TemplateLiteral') {
          context.report({ node: node.arguments[0], messageId: 'forbidden' })
        }
      }
    }
  }
}

const validateSchemaKey = (key) => {
  const templatePattern = /\$\{([^}]*)\}/g
  for (const match of key.matchAll(templatePattern)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(match[1])) return 'invalidTemplate'
  }
  const normalized = key.replace(/\$\{[^}]+\}/g, 'x')
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(normalized) ? null : 'invalidKey'
}

const validSchemaKey = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      invalidKey: 'Schema key `{{key}}` must follow namespace.sub.key_name.',
      invalidTemplate: 'Template variables in `{{key}}` must be valid identifiers.'
    }
  },
  create(context) {
    const check = (node) => {
      if (node.key?.type !== 'Literal' || typeof node.key.value !== 'string') return
      if (node.type === 'Property') {
        const objectExpression = node.parent
        const call = objectExpression?.parent
        if (
          call?.type === 'CallExpression' &&
          call.callee?.type === 'MemberExpression' &&
          call.callee.object?.type === 'Identifier' &&
          call.callee.object.name === 'z'
        ) {
          return
        }
      }
      const messageId = validateSchemaKey(node.key.value)
      if (messageId) context.report({ node: node.key, messageId, data: { key: node.key.value } })
    }
    return { TSPropertySignature: check, Property: check }
  }
}

const preferZodNamespace = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    schema: [],
    messages: { namespace: 'Import Zod as a namespace (`import * as z from "zod"`).' }
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (typeof source !== 'string' || (source !== 'zod' && !source.startsWith('zod/'))) return
        for (const specifier of node.specifiers) {
          const isDefault = specifier.type === 'ImportDefaultSpecifier'
          const isZodNamed =
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            ['z', 'core'].includes(specifier.imported.name)
          if (!isDefault && !isZodNamed) continue

          const report = {
            node: specifier,
            messageId: 'namespace'
          }
          if (node.specifiers.length === 1) {
            report.fix = (fixer) => {
              const namespaceSource =
                isZodNamed && specifier.imported.name === 'core' && source === 'zod/v4' ? 'zod/v4/core' : source
              const typePrefix = node.importKind === 'type' ? 'type ' : ''
              return fixer.replaceText(
                node,
                `import ${typePrefix}* as ${specifier.local.name} from '${namespaceSource}'`
              )
            }
          }
          context.report(report)
        }
      }
    }
  }
}

const propertyName = (node) => {
  if (!node) return null
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return null
}

const isFunctionNode = (node) =>
  node?.type === 'FunctionDeclaration' ||
  node?.type === 'FunctionExpression' ||
  node?.type === 'ArrowFunctionExpression'

const functionName = (node) => {
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return node.id?.name ?? null
  const parent = node.parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
  if (parent?.type === 'PropertyDefinition' || parent?.type === 'MethodDefinition') return propertyName(parent.key)
  return null
}

const isComponentName = (name) => typeof name === 'string' && /^[A-Z]/.test(name)

const createImportTracker = (source) => {
  const named = new Map()
  const namespaces = new Set()

  return {
    record(node) {
      if (node.source.value !== source) return
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const imported = propertyName(specifier.imported)
          if (!imported) continue
          const bindings = named.get(imported) ?? new Set()
          bindings.add(specifier.local.name)
          named.set(imported, bindings)
        } else {
          namespaces.add(specifier.local.name)
        }
      }
    },
    importedNames(name) {
      return named.get(name) ?? new Set()
    },
    matchesCall(callee, name) {
      if (callee.type === 'Identifier') return named.get(name)?.has(callee.name) ?? false
      return (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        namespaces.has(callee.object.name) &&
        propertyName(callee.property) === name
      )
    },
    isNamespace(name) {
      return namespaces.has(name)
    }
  }
}

const isReactComponentClass = (node, react) => {
  const parent = node.superClass
  if (!parent) return false
  if (parent.type === 'Identifier') {
    return react.importedNames('Component').has(parent.name) || react.importedNames('PureComponent').has(parent.name)
  }
  return (
    parent.type === 'MemberExpression' &&
    parent.object.type === 'Identifier' &&
    react.isNamespace(parent.object.name) &&
    ['Component', 'PureComponent'].includes(propertyName(parent.property))
  )
}

const isThisMember = (node, name) =>
  node?.type === 'MemberExpression' && node.object.type === 'ThisExpression' && propertyName(node.property) === name

const expressionKey = (node) => {
  if (node?.type === 'Identifier') return node.name
  if (node?.type !== 'MemberExpression' || node.computed) return null
  const object = expressionKey(node.object)
  const property = propertyName(node.property)
  return object && property ? `${object}.${property}` : null
}

const assignmentTargetKey = (node) => {
  let child = node
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'VariableDeclarator' && parent.init === child) return expressionKey(parent.id)
    if (parent.type === 'AssignmentExpression' && parent.right === child) return expressionKey(parent.left)
    if (parent.type === 'PropertyDefinition' && parent.value === child) return expressionKey(parent.key)
    if (parent.type === 'BlockStatement' || parent.type === 'Program' || isFunctionNode(parent)) return null
  }
  return null
}

const makeForbiddenImportedCallRule = ({ source, name, message, reportImport = false }) => ({
  meta: { type: 'problem', schema: [], messages: { forbidden: message } },
  create(context) {
    const imports = createImportTracker(source)
    return {
      ImportDeclaration(node) {
        imports.record(node)
        if (!reportImport || node.source.value !== source) return
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && propertyName(specifier.imported) === name) {
            context.report({ node: specifier, messageId: 'forbidden' })
          }
        }
      },
      CallExpression(node) {
        if (imports.matchesCall(node.callee, name)) context.report({ node, messageId: 'forbidden' })
      }
    }
  }
})

const reactNoAccessStateInSetstate = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: "Do not access 'this.state' within 'setState'. Use the update function instead." }
  },
  create(context) {
    const react = createImportTracker('react')
    const classes = []
    let setStateDepth = 0
    const enterClass = (node) => classes.push(isReactComponentClass(node, react))
    return {
      ImportDeclaration: react.record,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit'() {
        classes.pop()
      },
      ClassExpression: enterClass,
      'ClassExpression:exit'() {
        classes.pop()
      },
      CallExpression(node) {
        if (isThisMember(node.callee, 'setState')) setStateDepth += 1
      },
      'CallExpression:exit'(node) {
        if (isThisMember(node.callee, 'setState')) setStateDepth -= 1
      },
      MemberExpression(node) {
        if (classes.at(-1) && setStateDepth > 0 && isThisMember(node, 'state')) {
          context.report({ node, messageId: 'forbidden' })
        }
      },
      VariableDeclarator(node) {
        if (!classes.at(-1) || setStateDepth === 0 || node.init?.type !== 'ThisExpression') return
        if (
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some((property) => property.type === 'Property' && propertyName(property.key) === 'state')
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const reactNoContextProvider = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: "In React 19, render '<Context>' as the provider instead of '<Context.Provider>'." }
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const name = node.name
        if (
          name.type === 'JSXMemberExpression' &&
          propertyName(name.property) === 'Provider' &&
          isComponentName(propertyName(name.object.property ?? name.object))
        ) {
          context.report({ node: name, messageId: 'forbidden' })
        }
      }
    }
  }
}

const reactNoCreateRef = {
  meta: { type: 'problem', schema: [], messages: { forbidden: "[Deprecated] Use 'useRef' instead." } },
  create(context) {
    const react = createImportTracker('react')
    const classes = []
    const enterClass = (node) => classes.push(isReactComponentClass(node, react))
    return {
      ImportDeclaration: react.record,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit'() {
        classes.pop()
      },
      ClassExpression: enterClass,
      'ClassExpression:exit'() {
        classes.pop()
      },
      CallExpression(node) {
        if (!classes.includes(true) && react.matchesCall(node.callee, 'createRef')) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const reactNoDefaultProps = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: '[Deprecated] Use ES6 default parameters instead.' }
  },
  create(context) {
    const functions = new Map()
    const recordFunction = (node) => {
      const name = functionName(node)
      if (name) functions.set(name, node)
    }
    return {
      FunctionDeclaration: recordFunction,
      FunctionExpression: recordFunction,
      ArrowFunctionExpression: recordFunction,
      AssignmentExpression(node) {
        const left = node.left
        if (left.type !== 'MemberExpression' || propertyName(left.property) !== 'defaultProps') return
        const name = left.object.type === 'Identifier' ? left.object.name : null
        if (isComponentName(name) && functions.has(name))
          context.report({ node: left.property, messageId: 'forbidden' })
      }
    }
  }
}

const reactNoForwardRef = makeForbiddenImportedCallRule({
  source: 'react',
  name: 'forwardRef',
  message: "In React 19, 'forwardRef' is unnecessary. Pass 'ref' as a prop instead."
})

const reactNoUseContext = makeForbiddenImportedCallRule({
  source: 'react',
  name: 'useContext',
  message: "In React 19, 'use' is preferred over 'useContext'.",
  reportImport: true
})

const reactDomNoHydrate = makeForbiddenImportedCallRule({
  source: 'react-dom',
  name: 'hydrate',
  message: "[Deprecated] Use 'hydrateRoot()' instead."
})

const reactDomNoRender = makeForbiddenImportedCallRule({
  source: 'react-dom',
  name: 'render',
  message: "[Deprecated] Use 'createRoot(node).render()' instead."
})

const reactDomNoUseFormState = makeForbiddenImportedCallRule({
  source: 'react-dom',
  name: 'useFormState',
  message: "[Deprecated] Use 'useActionState' from 'react' instead."
})

const reactDomNoFlushSync = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: "Using 'flushSync' is uncommon and can hurt the performance of your app." }
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          (callee.type === 'Identifier' && callee.name === 'flushSync') ||
          (callee.type === 'MemberExpression' && propertyName(callee.property) === 'flushSync')
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const reactNoChildrenMethods = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: '`React.Children.{{method}}` should not be used.' }
  },
  create(context) {
    const react = createImportTracker('react')
    const forbidden = new Set(['count', 'forEach', 'map', 'only'])
    return {
      ImportDeclaration: react.record,
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression') return
        const method = propertyName(callee.property)
        if (!forbidden.has(method)) return
        const object = callee.object
        const isNamedChildren = object.type === 'Identifier' && react.importedNames('Children').has(object.name)
        const isNamespacedChildren =
          object.type === 'MemberExpression' &&
          object.object.type === 'Identifier' &&
          react.isNamespace(object.object.name) &&
          propertyName(object.property) === 'Children'
        if (isNamedChildren || isNamespacedChildren) {
          context.report({ node, messageId: 'forbidden', data: { method } })
        }
      }
    }
  }
}

const reactNoImplicitKey = {
  meta: { type: 'problem', schema: [], messages: { forbidden: "Do not use implicit 'key' props." } },
  create(context) {
    const keyedObjects = new Set()
    const objectHasKey = (node) =>
      node?.type === 'ObjectExpression' &&
      node.properties.some((property) => property.type === 'Property' && propertyName(property.key) === 'key')
    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && objectHasKey(node.init)) keyedObjects.add(node.id.name)
      },
      JSXSpreadAttribute(node) {
        if (
          objectHasKey(node.argument) ||
          (node.argument.type === 'Identifier' && keyedObjects.has(node.argument.name))
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const reactNoMisusedCaptureOwnerStack = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      import: "Use a React namespace import for 'captureOwnerStack'.",
      guard: "Call 'captureOwnerStack' only inside an explicit non-production guard."
    }
  },
  create(context) {
    const react = createImportTracker('react')
    const isDevelopmentGuard = (node) => {
      if (node.type !== 'IfStatement' || node.test.type !== 'BinaryExpression' || node.test.operator !== '!==')
        return false
      const { left, right } = node.test
      return (
        right.type === 'Literal' &&
        right.value === 'production' &&
        left.type === 'MemberExpression' &&
        propertyName(left.property) === 'NODE_ENV' &&
        left.object.type === 'MemberExpression' &&
        left.object.object.type === 'Identifier' &&
        left.object.object.name === 'process' &&
        propertyName(left.object.property) === 'env'
      )
    }
    const isGuarded = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) if (isDevelopmentGuard(parent)) return true
      return false
    }
    return {
      ImportDeclaration(node) {
        react.record(node)
        if (node.source.value !== 'react') return
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && propertyName(specifier.imported) === 'captureOwnerStack') {
            context.report({ node: specifier, messageId: 'import' })
          }
        }
      },
      CallExpression(node) {
        if (react.matchesCall(node.callee, 'captureOwnerStack') && !isGuarded(node)) {
          context.report({ node, messageId: 'guard' })
        }
      }
    }
  }
}

const reactContextName = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { invalid: "A context name must be a component name with the suffix 'Context'." }
  },
  create(context) {
    const react = createImportTracker('react')
    return {
      ImportDeclaration: react.record,
      CallExpression(node) {
        if (!react.matchesCall(node.callee, 'createContext')) return
        const parent = node.parent
        let target = null
        if (parent?.type === 'VariableDeclarator') target = parent.id
        else if (parent?.type === 'AssignmentExpression') target = parent.left
        else if (parent?.type === 'Property') target = parent.key
        const name = target?.type === 'MemberExpression' ? propertyName(target.property) : propertyName(target)
        if (name && /^[A-Z][A-Za-z0-9]*Context$/.test(name)) return
        if (target) context.report({ node: target, messageId: 'invalid' })
      }
    }
  }
}

const reactNoNestedLazyComponentDeclarations = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Declare lazy components at the top level of the module.' }
  },
  create(context) {
    const react = createImportTracker('react')
    const isInsideComponent = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isFunctionNode(parent)) {
          const name = functionName(parent)
          return isComponentName(name) || /^use[A-Z0-9]/.test(name ?? '')
        }
        if (
          (parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') &&
          isReactComponentClass(parent, react)
        ) {
          return true
        }
      }
      return false
    }
    return {
      ImportDeclaration: react.record,
      CallExpression(node) {
        if (react.matchesCall(node.callee, 'lazy') && isInsideComponent(node)) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const REACT_LIFECYCLE_MEMBERS = new Set([
  'componentDidCatch',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillMount',
  'componentWillReceiveProps',
  'componentWillUnmount',
  'componentWillUpdate',
  'constructor',
  'getSnapshotBeforeUpdate',
  'render',
  'shouldComponentUpdate',
  'state',
  'UNSAFE_componentWillMount',
  'UNSAFE_componentWillReceiveProps',
  'UNSAFE_componentWillUpdate'
])

const reactNoUnusedClassComponentMembers = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { unused: "Unused method or property '{{member}}' of class '{{className}}'." }
  },
  create(context) {
    const react = createImportTracker('react')
    const classes = []
    const members = []
    const enterClass = (node) => {
      classes.push(
        isReactComponentClass(node, react)
          ? { name: node.id?.name ?? 'Component', definitions: new Map(), usages: new Set() }
          : null
      )
    }
    const exitClass = () => {
      const current = classes.pop()
      if (!current) return
      for (const [member, node] of current.definitions) {
        if (!REACT_LIFECYCLE_MEMBERS.has(member) && !current.usages.has(member)) {
          context.report({ node, messageId: 'unused', data: { member, className: current.name } })
        }
      }
    }
    const enterMember = (node) => {
      members.push(node)
      const current = classes.at(-1)
      const name = propertyName(node.key)
      if (current && !node.static && name) current.definitions.set(name, node.key)
    }
    const exitMember = () => members.pop()
    return {
      ImportDeclaration: react.record,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit': exitClass,
      ClassExpression: enterClass,
      'ClassExpression:exit': exitClass,
      MethodDefinition: enterMember,
      'MethodDefinition:exit': exitMember,
      PropertyDefinition: enterMember,
      'PropertyDefinition:exit': exitMember,
      MemberExpression(node) {
        const current = classes.at(-1)
        const member = members.at(-1)
        if (!current || member?.static || node.object.type !== 'ThisExpression') return
        const name = propertyName(node.property)
        if (!name) return
        if (node.parent?.type === 'AssignmentExpression' && node.parent.left === node) {
          current.definitions.set(name, node.property)
        } else {
          current.usages.add(name)
        }
      },
      VariableDeclarator(node) {
        const current = classes.at(-1)
        const member = members.at(-1)
        if (!current || member?.static || node.init?.type !== 'ThisExpression' || node.id.type !== 'ObjectPattern')
          return
        for (const property of node.id.properties) {
          if (property.type === 'Property') {
            const name = propertyName(property.key)
            if (name) current.usages.add(name)
          }
        }
      }
    }
  }
}

const reactNoUnusedState = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { unused: "Unused class component state in '{{className}}'." }
  },
  create(context) {
    const react = createImportTracker('react')
    const classes = []
    const methods = []
    const enterClass = (node) => {
      classes.push(
        isReactComponentClass(node, react)
          ? { name: node.id?.name ?? 'Component', definition: null, used: false }
          : null
      )
    }
    const exitClass = () => {
      const current = classes.pop()
      if (current?.definition && !current.used) {
        context.report({ node: current.definition, messageId: 'unused', data: { className: current.name } })
      }
    }
    const enterMember = (node) => {
      const name = propertyName(node.key)
      methods.push(name)
      if (name === 'state' && classes.at(-1) && !node.static) classes.at(-1).definition = node.key
    }
    return {
      ImportDeclaration: react.record,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit': exitClass,
      ClassExpression: enterClass,
      'ClassExpression:exit': exitClass,
      MethodDefinition: enterMember,
      'MethodDefinition:exit'() {
        methods.pop()
      },
      PropertyDefinition: enterMember,
      'PropertyDefinition:exit'() {
        methods.pop()
      },
      AssignmentExpression(node) {
        const current = classes.at(-1)
        if (current && methods.at(-1) === 'constructor' && isThisMember(node.left, 'state')) {
          current.definition = node.left
        }
      },
      MemberExpression(node) {
        const current = classes.at(-1)
        if (!current || methods.at(-1) === 'constructor' || !isThisMember(node, 'state')) return
        if (node.parent?.type === 'AssignmentExpression' && node.parent.left === node) return
        current.used = true
      },
      VariableDeclarator(node) {
        const current = classes.at(-1)
        if (
          current &&
          methods.at(-1) !== 'constructor' &&
          node.init?.type === 'ThisExpression' &&
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some((property) => property.type === 'Property' && propertyName(property.key) === 'state')
        ) {
          current.used = true
        }
      }
    }
  }
}

const callPropertyName = (node) => {
  const callee = node.callee
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') return propertyName(callee.property)
  return null
}

const effectCallback = (node) => {
  const call = node.parent
  return (
    call?.type === 'CallExpression' &&
    call.arguments.includes(node) &&
    ['useEffect', 'useInsertionEffect', 'useLayoutEffect'].includes(callPropertyName(call))
  )
}

const reactNoLeakedInterval = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      id: "A 'setInterval' must be assigned to a variable for proper cleanup.",
      cleanup: "A 'setInterval' created in an effect must be cleared with 'clearInterval'.",
      unmount: "A 'setInterval' created in 'componentDidMount' must be cleared in 'componentWillUnmount'."
    }
  },
  create(context) {
    const react = createImportTracker('react')
    const functions = []
    const classes = []
    const methods = []
    const enterFunction = (node) =>
      functions.push(effectCallback(node) ? { intervals: new Map(), clears: new Set() } : null)
    const exitFunction = () => {
      const current = functions.pop()
      if (!current) return
      for (const [key, node] of current.intervals) {
        if (!current.clears.has(key)) context.report({ node, messageId: 'cleanup' })
      }
    }
    const enterClass = (node) => {
      classes.push(isReactComponentClass(node, react) ? { intervals: new Map(), clears: new Set() } : null)
    }
    const exitClass = () => {
      const current = classes.pop()
      if (!current) return
      for (const [key, node] of current.intervals) {
        if (!current.clears.has(key)) context.report({ node, messageId: 'unmount' })
      }
    }
    const enterMethod = (node) => methods.push(propertyName(node.key))
    const recordSet = (node, target) => {
      const key = assignmentTargetKey(node)
      if (!key) context.report({ node, messageId: 'id' })
      else target.intervals.set(key, node)
    }
    return {
      ImportDeclaration: react.record,
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit': exitClass,
      ClassExpression: enterClass,
      'ClassExpression:exit': exitClass,
      MethodDefinition: enterMethod,
      'MethodDefinition:exit'() {
        methods.pop()
      },
      PropertyDefinition: enterMethod,
      'PropertyDefinition:exit'() {
        methods.pop()
      },
      CallExpression(node) {
        const name = callPropertyName(node)
        const effect = functions.findLast(Boolean)
        const component = classes.at(-1)
        if (name === 'setInterval') {
          if (effect) recordSet(node, effect)
          else if (component && methods.at(-1) === 'componentDidMount') recordSet(node, component)
        } else if (name === 'clearInterval') {
          const key = expressionKey(node.arguments[0])
          if (!key) return
          if (effect) effect.clears.add(key)
          if (component && methods.at(-1) === 'componentWillUnmount') component.clears.add(key)
        }
      }
    }
  }
}

const reactNoLeakedResizeObserver = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      floating: "A 'ResizeObserver' created in an effect must be assigned for cleanup.",
      cleanup: "A 'ResizeObserver' created in an effect must be disconnected or unobserved in cleanup.",
      unmount: "A 'ResizeObserver' created in 'componentDidMount' must be disconnected in 'componentWillUnmount'."
    }
  },
  create(context) {
    const react = createImportTracker('react')
    const functions = []
    const classes = []
    const methods = []
    const createFrame = () => ({
      observers: new Map(),
      observed: new Map(),
      unobserved: new Map(),
      disconnected: new Set()
    })
    const enterFunction = (node) => functions.push(effectCallback(node) ? createFrame() : null)
    const reportFrame = (current, messageId) => {
      if (!current) return
      for (const [key, node] of current.observers) {
        if (current.disconnected.has(key)) continue
        const observed = current.observed.get(key) ?? new Set()
        const unobserved = current.unobserved.get(key) ?? new Set()
        if ([...observed].some((target) => !unobserved.has(target))) {
          context.report({ node, messageId })
        }
      }
    }
    const exitFunction = () => reportFrame(functions.pop(), 'cleanup')
    const enterClass = (node) => classes.push(isReactComponentClass(node, react) ? createFrame() : null)
    const exitClass = () => reportFrame(classes.pop(), 'unmount')
    const addTarget = (map, observer, target) => {
      if (!observer || !target) return
      const targets = map.get(observer) ?? new Set()
      targets.add(target)
      map.set(observer, targets)
    }
    return {
      ImportDeclaration: react.record,
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit': exitClass,
      ClassExpression: enterClass,
      'ClassExpression:exit': exitClass,
      MethodDefinition(node) {
        methods.push(propertyName(node.key))
      },
      'MethodDefinition:exit'() {
        methods.pop()
      },
      PropertyDefinition(node) {
        methods.push(propertyName(node.key))
      },
      'PropertyDefinition:exit'() {
        methods.pop()
      },
      NewExpression(node) {
        const current = functions.findLast(Boolean) ?? (methods.at(-1) === 'componentDidMount' ? classes.at(-1) : null)
        if (!current || node.callee.type !== 'Identifier' || node.callee.name !== 'ResizeObserver') return
        const key = assignmentTargetKey(node)
        if (!key) context.report({ node, messageId: 'floating' })
        else current.observers.set(key, node)
      },
      CallExpression(node) {
        const effect = functions.findLast(Boolean)
        const component = classes.at(-1)
        const current =
          effect ??
          (component && ['componentDidMount', 'componentWillUnmount'].includes(methods.at(-1)) ? component : null)
        const callee = node.callee
        if (!current || callee.type !== 'MemberExpression') return
        const observer = expressionKey(callee.object)
        const method = propertyName(callee.property)
        if (method === 'disconnect' && observer) current.disconnected.add(observer)
        else if (method === 'observe') addTarget(current.observed, observer, expressionKey(node.arguments[0]))
        else if (method === 'unobserve') addTarget(current.unobserved, observer, expressionKey(node.arguments[0]))
      }
    }
  }
}

const noPropTypes = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'TypeScript React components must use TypeScript types, not runtime propTypes.' }
  },
  create(context) {
    const isPropTypesMember = (node) =>
      node?.type === 'MemberExpression' &&
      ((node.property.type === 'Identifier' && node.property.name === 'propTypes') ||
        (node.property.type === 'Literal' && node.property.value === 'propTypes'))
    return {
      AssignmentExpression(node) {
        if (isPropTypesMember(node.left)) context.report({ node, messageId: 'forbidden' })
      },
      PropertyDefinition(node) {
        if (
          (node.key.type === 'Identifier' && node.key.name === 'propTypes') ||
          (node.key.type === 'Literal' && node.key.value === 'propTypes')
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const dynamicReactChildrenMap = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: '`React.Children.map` should not be used.' }
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'MemberExpression' &&
          callee.object.object.type === 'Identifier' &&
          callee.object.object.name === 'React' &&
          callee.object.property.type === 'Identifier' &&
          callee.object.property.name === 'Children' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'map'
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

const dynamicReactCloneElement = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: '`React.cloneElement` should not be used.' }
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'React' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'cloneElement'
        ) {
          context.report({ node, messageId: 'forbidden' })
        }
      }
    }
  }
}

export const rules = {
  'renderer-boundaries': rendererBoundaries,
  'page-boundaries': pageBoundaries,
  'utility-process-boundaries': utilityProcessBoundaries,
  'no-export-star': noExportStar,
  'index-no-impl': indexNoImplementation,
  'no-index-tsx': noIndexTsx,
  'barrel-named-only': namedOnlyBarrel,
  'barrel-closed': barrelClosed,
  'barrel-no-nesting': barrelNoNesting,
  'no-bucket-root-barrel': noBucketRootBarrel,
  'path-case': pathCase,
  'no-as-filepath': noAsFilepath,
  'no-direct-quit': noDirectQuit,
  'no-template-in-t': noTemplateInTranslation,
  'valid-schema-key': validSchemaKey,
  'prefer-zod-namespace': preferZodNamespace,
  'no-prop-types': noPropTypes,
  'react-context-name': reactContextName,
  'react-dom-no-flush-sync': reactDomNoFlushSync,
  'react-dom-no-hydrate': reactDomNoHydrate,
  'react-dom-no-render': reactDomNoRender,
  'react-dom-no-use-form-state': reactDomNoUseFormState,
  'react-no-access-state-in-setstate': reactNoAccessStateInSetstate,
  'react-no-children-methods': reactNoChildrenMethods,
  'react-no-context-provider': reactNoContextProvider,
  'react-no-create-ref': reactNoCreateRef,
  'react-no-default-props': reactNoDefaultProps,
  'react-no-forward-ref': reactNoForwardRef,
  'react-no-implicit-key': reactNoImplicitKey,
  'react-no-leaked-interval': reactNoLeakedInterval,
  'react-no-leaked-resize-observer': reactNoLeakedResizeObserver,
  'react-no-misused-capture-owner-stack': reactNoMisusedCaptureOwnerStack,
  'react-no-nested-lazy-component-declarations': reactNoNestedLazyComponentDeclarations,
  'react-no-unused-class-component-members': reactNoUnusedClassComponentMembers,
  'react-no-unused-state': reactNoUnusedState,
  'react-no-use-context': reactNoUseContext,
  'dynamic-react-children-map': dynamicReactChildrenMap,
  'dynamic-react-clone-element': dynamicReactCloneElement
}

export default {
  meta: { name: 'cherry', version: '1.0.0' },
  rules
}
