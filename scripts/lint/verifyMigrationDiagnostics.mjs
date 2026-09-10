import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import crossSpawn from 'cross-spawn'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const fixtureRoot = path.join(import.meta.dirname, '__fixtures__')
const readJson = (filename) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, filename), 'utf8'))
const snapshot = readJson('migration-diagnostics.json')
const reactContract = readJson('react-migration-contract.json')
const require = createRequire(import.meta.url)
const oxlintConfig = require(path.join(repoRoot, 'oxlint.config.ts'))

function runOxlint(args) {
  const result = crossSpawn.sync(path.join(repoRoot, 'node_modules/.bin/oxlint'), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (!result.stdout) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  return JSON.parse(result.stdout).diagnostics
}

const diagnostics = runOxlint(['-c', 'oxlint.config.ts', '--format', 'json', '--threads=1'])
let failed = false

for (const diagnostic of diagnostics.filter((item) => item.severity === 'error')) {
  process.stderr.write(`${diagnostic.filename}: ${diagnostic.code}: ${diagnostic.message}\n`)
  failed = true
}

function normalizeDiagnostic(diagnostic) {
  const span = diagnostic.labels[0]?.span
  return [
    path.relative(repoRoot, path.resolve(repoRoot, diagnostic.filename)).split(path.sep).join('/'),
    span?.line ?? null,
    span?.column ?? null,
    diagnostic.code,
    diagnostic.message
  ]
}

function compareDiagnostics(left, right) {
  return (
    left[0].localeCompare(right[0]) ||
    (left[1] ?? -1) - (right[1] ?? -1) ||
    (left[2] ?? -1) - (right[2] ?? -1) ||
    left[3].localeCompare(right[3]) ||
    left[4].localeCompare(right[4])
  )
}

for (const group of snapshot.groups) {
  const actual = diagnostics
    .filter((diagnostic) => group.after.rules.includes(diagnostic.code) && diagnostic.severity === group.after.severity)
    .map(normalizeDiagnostic)
    .sort(compareDiagnostics)
  const expected = [...group.after.diagnostics].sort(compareDiagnostics)

  if (actual.length !== group.after.count) {
    process.stderr.write(
      `${group.name}: expected ${group.after.count} ${group.after.severity} diagnostics, got ${actual.length}\n`
    )
    failed = true
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.stderr.write(`${group.name}: diagnostic snapshot changed\n`)
    process.stderr.write(`  expected: ${JSON.stringify(expected)}\n`)
    process.stderr.write(`  actual:   ${JSON.stringify(actual)}\n`)
    failed = true
  }
}

const severityRank = (value) => {
  const severity = Array.isArray(value) ? value[0] : value
  if (severity === 0 || severity === 'allow' || severity === 'off') return 0
  if (severity === 1 || severity === 'warn' || severity === 'warning') return 1
  if (severity === 2 || severity === 'deny' || severity === 'error') return 2
  return -1
}

const diagnosticCode = (rule) => {
  const separator = rule.indexOf('/')
  return `${rule.slice(0, separator)}(${rule.slice(separator + 1)})`
}

const productionScope = reactContract.scopes.repository
if (
  !productionScope ||
  productionScope.files.length === 0 ||
  !Array.isArray(productionScope.excludeFiles) ||
  JSON.stringify(productionScope.ignorePatterns) !== JSON.stringify(oxlintConfig.ignorePatterns)
) {
  process.stderr.write('React migration scope does not match the production Oxlint scope.\n')
  failed = true
}

const beforeRules = new Set(reactContract.rules.map((mapping) => mapping.before.rule))
if (reactContract.rules.length !== 51 || beforeRules.size !== 51) {
  process.stderr.write(`React migration contract must contain 51 unique source rules; got ${beforeRules.size}.\n`)
  failed = true
}

const fixtureDiagnostics = runOxlint([
  '-c',
  reactContract.fixtures.config,
  '--format',
  'json',
  '--threads=1',
  reactContract.fixtures.positiveRoot,
  reactContract.fixtures.negativeRoot
])
const positiveDiagnostics = fixtureDiagnostics.filter((diagnostic) =>
  path
    .relative(fixtureRoot, path.resolve(repoRoot, diagnostic.filename))
    .split(path.sep)
    .join('/')
    .startsWith('positive/')
)
if (positiveDiagnostics.length > 0) {
  process.stderr.write(`React migration positive fixtures produced ${positiveDiagnostics.length} diagnostics.\n`)
  failed = true
}

for (const mapping of reactContract.rules) {
  const configuredSeverity = severityRank(oxlintConfig.rules[mapping.after.rule])
  const expectedSeverity = severityRank(mapping.after.severity)
  const beforeSeverity = severityRank(mapping.before.severity)
  if (configuredSeverity !== expectedSeverity || expectedSeverity < beforeSeverity) {
    process.stderr.write(
      `${mapping.before.rule}: expected ${mapping.after.rule} at ${mapping.after.severity} without a severity downgrade.\n`
    )
    failed = true
  }

  if (!reactContract.scopes[mapping.scope]) {
    process.stderr.write(`${mapping.before.rule}: unknown scope ${mapping.scope}.\n`)
    failed = true
  }

  const fixturePath = path.join(fixtureRoot, mapping.fixture.file)
  const matchingLines = fs
    .readFileSync(fixturePath, 'utf8')
    .split('\n')
    .flatMap((line, index) => (line.includes(mapping.fixture.token) ? [index + 1] : []))
  if (matchingLines.length !== 1) {
    process.stderr.write(`${mapping.before.rule}: fixture token must identify exactly one line.\n`)
    failed = true
    continue
  }

  const expectedCode = diagnosticCode(mapping.after.rule)
  const hasFixtureDiagnostic = fixtureDiagnostics.some((diagnostic) => {
    const relative = path.relative(fixtureRoot, path.resolve(repoRoot, diagnostic.filename)).split(path.sep).join('/')
    return (
      relative === mapping.fixture.file &&
      diagnostic.code === expectedCode &&
      severityRank(diagnostic.severity) === expectedSeverity &&
      diagnostic.labels.some((label) => label.span.line === matchingLines[0])
    )
  })
  if (!hasFixtureDiagnostic) {
    process.stderr.write(`${mapping.before.rule}: no matching ${mapping.after.rule} fixture diagnostic.\n`)
    failed = true
  }
}

if (failed) process.exit(1)
process.stdout.write(
  `Verified ${snapshot.groups.length} diagnostic groups and ${reactContract.rules.length} React rule migrations.\n`
)
