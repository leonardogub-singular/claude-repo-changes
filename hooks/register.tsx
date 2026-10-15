import type { EngineInterface, Register } from 'claude-code'

import type { Repo, RepoFile, Selected } from '../types'
import {
  COLORS,
  badgeOf,
  buildRows,
  countKinds,
  diffStats,
  flatRows,
  groupByOwner,
  matchesFilter,
  parseBranch,
  parseStatus,
  sortFiles,
  splitPath,
  toHunks,
  WORKTREE_SEP,
} from './logic'

const PANE = 'repo-changes'
const TITLE = 'Repo changes'
const POLL_MS = 30_000
const ROWS_PAGE = 100
const INDENT = 2
const AUTO_OPEN_MAX_REPOS = 2
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'MultiEdit'])

const REPOS = { plugin: 'repo-changes', key: 'repos' } as const
const CLEAN_COUNT = { plugin: 'repo-changes', key: 'cleanCount' } as const
const SELECTED = { plugin: 'repo-changes', key: 'selected' } as const
const UPDATED_AT = { plugin: 'repo-changes', key: 'updatedAt' } as const
const OPEN_REPOS = { plugin: 'repo-changes', key: 'openRepos' } as const
const OPEN_GROUPS = { plugin: 'repo-changes', key: 'openGroups' } as const
const FILTER = { plugin: 'repo-changes', key: 'filter' } as const
const TRACKED_ONLY = { plugin: 'repo-changes', key: 'isTrackedOnly' } as const
const LAST_VIEWED = { plugin: 'repo-changes', key: 'lastViewed' } as const
const IS_FLAT = { plugin: 'repo-changes', key: 'isFlat' } as const
const STORE_IS_FLAT = 'isFlat'
const ROW_LIMITS = { plugin: 'repo-changes', key: 'rowLimits' } as const

type Target = { path: string; label: string }

async function git($: EngineInterface, cwd: string, args: string[]) {
  try {
    return await $.process.run(['git', ...args], { cwd, timeoutMs: 15_000 })
  } catch {
    return undefined
  }
}

async function findTargets($: EngineInterface, root: string): Promise<Target[]> {
  const targets: Target[] = []
  if (await $.fs.exists(`${root}/.git`)) targets.push({ path: root, label: '.' })
  for (const entry of await $.fs.list(root)) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const dir = `${root}/${entry.name}`
    if (!(await $.fs.exists(`${dir}/.git`))) continue
    targets.push({ path: dir, label: entry.name })
    const worktrees = `${dir}/.claude/worktrees`
    if (!(await $.fs.exists(worktrees))) continue
    for (const wt of await $.fs.list(worktrees)) {
      if (wt.kind !== 'dir') continue
      if (!(await $.fs.exists(`${worktrees}/${wt.name}/.git`))) continue
      targets.push({ path: `${worktrees}/${wt.name}`, label: `${entry.name} › ${wt.name}` })
    }
  }
  return targets
}

async function loadDiff($: EngineInterface, repoPath: string, file: RepoFile) {
  const args =
    file.status === '??'
      ? ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path]
      : ['diff', '--no-color', 'HEAD', '--', file.path]
  const ran = await git($, repoPath, args)
  if (!ran) return { source: 'git diff failed.', isDiff: false, adds: 0, dels: 0 }
  if (!ran.stdout.trim()) {
    return { source: ran.stderr.trim() || 'No text changes.', isDiff: false, adds: 0, dels: 0 }
  }
  const hunks = toHunks(ran.stdout)
  return { ...hunks, ...(hunks.isDiff ? diffStats(hunks.source) : { adds: 0, dels: 0 }) }
}

let isRefreshing = false
let isPending = false

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isPending = true
    return
  }
  isRefreshing = true
  try {
    const root = await $.session.root()
    const targets = await findTargets($, root)
    const results = await Promise.all(
      targets.map(async (t): Promise<Repo | undefined> => {
        const ran = await git($, t.path, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
        if (!ran || ran.exitCode !== 0) return undefined
        const { branch, files } = parseStatus(ran.stdout)
        return { path: t.path, label: t.label, branch, files: sortFiles(files) }
      }),
    )
    const found = results.filter((r): r is Repo => r !== undefined)
    const changed = found
      .filter(r => r.files.length > 0)
      .sort((a, b) => b.files.length - a.files.length)
    await $.state.set(REPOS, changed)
    await $.state.set(CLEAN_COUNT, found.length - changed.length)
    await $.state.set(UPDATED_AT, Date.now())

    const { value: sel } = await $.state.get(SELECTED)
    if (sel) {
      const repo = changed.find(r => r.path === sel.repoPath)
      const file = repo?.files.find(f => f.path === sel.file.path)
      if (!file) {
        await $.state.set(SELECTED, null)
      } else {
        const diff = await loadDiff($, sel.repoPath, file)
        await $.state.set(SELECTED, { ...sel, file, diff: diff.source, isDiff: diff.isDiff, adds: diff.adds, dels: diff.dels })
      }
    }
  } finally {
    isRefreshing = false
    if (isPending) {
      isPending = false
      void refresh($)
    }
  }
}

async function select($: EngineInterface, repo: Repo, file: RepoFile) {
  const diff = await loadDiff($, repo.path, file)
  const next: Selected = {
    repoPath: repo.path,
    repoLabel: repo.label,
    file,
    diff: diff.source,
    isDiff: diff.isDiff,
    adds: diff.adds,
    dels: diff.dels,
  }
  await $.state.set(SELECTED, next)
  await $.state.set(LAST_VIEWED, `${repo.path}::${file.path}`)
}

async function toggleRepo($: EngineInterface, path: string, shown: string[]) {
  const next = shown.includes(path) ? shown.filter(p => p !== path) : [...shown, path]
  await $.state.set(OPEN_REPOS, next)
}

async function toggleGroup($: EngineInterface, key: string) {
  const { value: open = [] } = await $.state.get(OPEN_GROUPS)
  await $.state.set(OPEN_GROUPS, open.includes(key) ? open.filter(k => k !== key) : [...open, key])
}

async function toggleFlat($: EngineInterface) {
  const { value: isFlat = false } = await $.state.get(IS_FLAT)
  await $.state.set(IS_FLAT, !isFlat)
  await $.store.set(STORE_IS_FLAT, !isFlat)
}

async function showMore($: EngineInterface, repoPath: string) {
  const { value: limits = {} } = await $.state.get(ROW_LIMITS)
  await $.state.set(ROW_LIMITS, { ...limits, [repoPath]: (limits[repoPath] ?? ROWS_PAGE) + ROWS_PAGE })
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'repo-changes',
      description: 'Show git changes of every repo inside this folder',
    })
    await $.state.set(IS_FLAT, (await $.store.get(STORE_IS_FLAT)) === true)
    const root = await $.session.root()
    if (!(await $.fs.exists(`${root}/.git`))) {
      void refresh($).then(() => $.ui.open({ id: PANE, title: TITLE }))
      $.clock.every(POLL_MS, () => void refresh($))
    }
    return next(e)
  })

  on('command.run', { command: 'repo-changes' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    const { value: list = [] } = await $.state.get(REPOS)
    const files = list.reduce((n, r) => n + r.files.length, 0)
    return { text: `Repo changes: ${files} files in ${list.length} repos.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (EDIT_TOOLS.has(String(e.tool))) void refresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const { value: all = [] } = await $.state.get(REPOS)
    const { value: clean = 0 } = await $.state.get(CLEAN_COUNT)
    const { value: at = 0 } = await $.state.get(UPDATED_AT)
    const { value: sel = null } = await $.state.get(SELECTED)
    const { value: openReposRaw = null } = await $.state.get(OPEN_REPOS)
    const { value: openGroupList = [] } = await $.state.get(OPEN_GROUPS)
    const { value: filter = '' } = await $.state.get(FILTER)
    const { value: isTrackedOnly = false } = await $.state.get(TRACKED_ONLY)
    const { value: lastViewed = null } = await $.state.get(LAST_VIEWED)
    const { value: isFlat = false } = await $.state.get(IS_FLAT)
    const { value: rowLimits = {} } = await $.state.get(ROW_LIMITS)

    const time = at ? new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '…'
    const isFiltering = filter.trim() !== ''
    const repos = all
      .map(r => ({ ...r, files: r.files.filter(f => matchesFilter(f, filter.trim(), isTrackedOnly)) }))
      .filter(r => r.files.length > 0)
    const allFiles = repos.flatMap(r => r.files)
    const totals = countKinds(allFiles)
    const openRepos = openReposRaw ?? (repos.length <= AUTO_OPEN_MAX_REPOS ? repos.map(r => r.path) : [])
    const isAllOpen = repos.length > 0 && repos.every(r => openRepos.includes(r.path))

    const renderRepo = (repo: Repo, depth: number) => {
      const isOpen = isFiltering || openRepos.includes(repo.path)
      const branch = parseBranch(repo.branch)
      const counts = countKinds(repo.files)
      const [owner = repo.label, worktree] = repo.label.split(WORKTREE_SEP)
      const headPad = INDENT * depth
      const pad = headPad + INDENT * 2
      const openGroups = new Set(
        isFiltering
          ? repo.files.map(f => splitPath(f.path).dir)
          : openGroupList.filter(k => k.startsWith(`${repo.path}::`)).map(k => k.slice(repo.path.length + 2)),
      )
      const rows = !isOpen ? [] : isFlat ? flatRows(repo.files) : buildRows(repo.files, openGroups)
      const shown = rows.slice(0, rowLimits[repo.path] ?? ROWS_PAGE)
      const hidden = rows.length - shown.length

      return (
        <Box key={repo.path} flexDirection="column">
          <Box
            key={`head:${repo.path}`}
            flexDirection="row"
            gap={1}
            paddingLeft={headPad}
            paddingRight={1}
            hover={{ backgroundColor: COLORS.hover }}
          >
            <Text color={COLORS.faint}>{isOpen ? '▾' : '▸'}</Text>
            <Box flexShrink={0}>
              {worktree ? (
                <Button key={`repo:${repo.path}`} plain label={worktree} onPress={() => void toggleRepo($, repo.path, openRepos)} />
              ) : (
                <Button key={`repo:${repo.path}`} plain onPress={() => void toggleRepo($, repo.path, openRepos)}>
                  <Text bold color={COLORS.text}>
                    {owner}
                  </Text>
                </Button>
              )}
            </Box>
            {branch.name && !(worktree && branch.name.endsWith(worktree)) && (
              <Text color={COLORS.muted} backgroundColor={COLORS.chip} wrap="truncate-end">
                {` ${branch.name} `}
              </Text>
            )}
            {branch.ahead > 0 && (
              <Box flexShrink={0}>
                <Text color={COLORS.ahead} backgroundColor={COLORS.aheadBg} wrap="truncate-end">
                  {` ↑${branch.ahead} `}
                </Text>
              </Box>
            )}
            {branch.behind > 0 && (
              <Box flexShrink={0}>
                <Text color={COLORS.behind} backgroundColor={COLORS.behindBg} wrap="truncate-end">
                  {` ↓${branch.behind} `}
                </Text>
              </Box>
            )}
            <Box flexGrow={1} />
            <Box flexShrink={0} flexDirection="row" gap={1}>
              {counts.modified > 0 && <Text color={COLORS.modified}>{counts.modified}</Text>}
              {counts.deleted > 0 && <Text color={COLORS.deleted}>−{counts.deleted}</Text>}
              {counts.conflict > 0 && <Text color={COLORS.conflict}>!{counts.conflict}</Text>}
              {counts.new > 0 && <Text color={COLORS.new}>+{counts.new}</Text>}
            </Box>
          </Box>

          {shown.map(row => {
            if (row.type === 'dir') {
              return (
                <Box paddingLeft={pad}>
                  <Text color={COLORS.path} wrap="truncate-start">
                    {row.dir}
                  </Text>
                </Box>
              )
            }
            if (row.type === 'group') {
              const c = countKinds(row.files)
              return (
                <Box
                  key={`grow:${repo.path}::${row.dir}`}
                  paddingLeft={pad}
                  paddingRight={1}
                  flexDirection="row"
                  gap={1}
                  hover={{ backgroundColor: COLORS.hover }}
                >
                  <Text color={COLORS.faint}>▸</Text>
                  <Button key={`group:${repo.path}::${row.dir}`} plain label={row.dir} onPress={() => void toggleGroup($, `${repo.path}::${row.dir}`)} />
                  <Box flexGrow={1} />
                  {c.modified > 0 && <Text color={COLORS.modified}>{c.modified}</Text>}
                  {c.deleted > 0 && <Text color={COLORS.deleted}>−{c.deleted}</Text>}
                  {c.new > 0 && <Text color={COLORS.new}>+{c.new}</Text>}
                </Box>
              )
            }
            const badge = badgeOf(row.file.status)
            const rowKey = `${repo.path}::${row.file.path}`
            return (
              <Box
                key={`frow:${rowKey}`}
                paddingLeft={pad}
                paddingRight={1}
                flexDirection="row"
                gap={1}
                backgroundColor={rowKey === lastViewed ? COLORS.selected : undefined}
                hover={{ backgroundColor: rowKey === lastViewed ? COLORS.selected : COLORS.hover }}
              >
                <Box width={2} flexShrink={0}>
                  <Text color={badge.color} bold>
                    {badge.glyph}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Button key={`file:${repo.path}::${row.file.path}`} plain label={row.name} onPress={() => void select($, repo, row.file)} />
                </Box>
                {isFlat && (
                  <Text color={COLORS.path} wrap="truncate-start">
                    {splitPath(row.file.path).dir}
                  </Text>
                )}
              </Box>
            )
          })}
          {hidden > 0 && (
            <Box paddingLeft={pad} flexDirection="row" gap={1}>
              <Button
                key={`more:${repo.path}`}
                plain
                label={`Show ${Math.min(hidden, ROWS_PAGE)} more`}
                onPress={() => void showMore($, repo.path)}
              />
              <Text color={COLORS.faint}>of {hidden} hidden</Text>
            </Box>
          )}
        </Box>
      )
    }

    if (sel) {
      const repo = all.find(r => r.path === sel.repoPath)
      const order = repo ? repo.files : [sel.file]
      const index = Math.max(0, order.findIndex(f => f.path === sel.file.path))
      const prev = order[index - 1]
      const next = order[index + 1]
      const badge = badgeOf(sel.file.status)
      const { dir, name } = splitPath(sel.file.path)
      const nextParts = next ? splitPath(next.path) : undefined
      const nextBadge = next ? badgeOf(next.status) : undefined

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="back" label="‹ All files" hotkey="b" onPress={() => void $.state.set(SELECTED, null)} />
            <Box flexGrow={1} />
            <Text color={COLORS.faint}>
              {index + 1} of {order.length}
            </Text>
            {prev && repo && <Button key="prev" label="↑" hotkey="k" onPress={() => void select($, repo, prev)} />}
            {next && repo && <Button key="next" label="↓" hotkey="j" onPress={() => void select($, repo, next)} />}
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={badge.color} bold>
                {badge.glyph}
              </Text>
              <Text bold color={COLORS.text} wrap="truncate-middle">
                {name}
              </Text>
              <Box flexGrow={1} />
              {sel.isDiff && <Text color={COLORS.ahead}>+{sel.adds}</Text>}
              {sel.isDiff && <Text color={COLORS.deleted}>−{sel.dels}</Text>}
            </Box>
            <Box paddingLeft={2}>
              <Text color={COLORS.path} wrap="truncate-start">
                {sel.repoLabel} / {dir || './'}
              </Text>
            </Box>
          </Box>
          {sel.isDiff ? (
            <Code source={sel.diff} format="diff" path={sel.file.path} />
          ) : (
            <Text color={COLORS.muted}>{sel.diff}</Text>
          )}
          {next && repo && nextParts && nextBadge && (
            <Box flexDirection="row" gap={1}>
              <Text color={COLORS.faint}>Next</Text>
              <Text color={nextBadge.color} bold>
                {nextBadge.glyph}
              </Text>
              <Button key="next-file" plain label={nextParts.name} onPress={() => void select($, repo, next)} />
              <Text color={COLORS.path} wrap="truncate-start">
                {nextParts.dir}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold color={COLORS.text}>
              {plural(allFiles.length, 'file', 'files')}
            </Text>
            <Text color={COLORS.muted}>in {plural(repos.length, 'repo', 'repos')}</Text>
            <Box flexGrow={1} />
            <Text color={COLORS.faint}>{time}</Text>
            <Button key="refresh" label="↻" onPress={() => void refresh($)} />
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            {Input && (
            <Box flexGrow={1}>
              <Input
                key="filter"
                placeholder="Filter files"
                value={filter}
                submitLabel="↵"
                onInput={(value: string) => void $.state.set(FILTER, value)}
                onSubmit={(value: string) => void $.state.set(FILTER, value)}
              />
            </Box>
            )}
            <Button
              key="show-all"
              label="All"
              variant={isTrackedOnly ? 'secondary' : 'primary'}
              onPress={() => void $.state.set(TRACKED_ONLY, false)}
            />
            <Button
              key="show-tracked"
              label="Tracked"
              variant={isTrackedOnly ? 'primary' : 'secondary'}
              onPress={() => void $.state.set(TRACKED_ONLY, true)}
            />
          </Box>
          <Box flexDirection="row" gap={2} alignItems="center">
            <Text color={COLORS.muted} wrap="truncate-end">
              {totals.modified > 0 ? <Text color={COLORS.modified}>● </Text> : ''}
              {totals.modified > 0 ? `${totals.modified} modified   ` : ''}
              {totals.new > 0 ? <Text color={COLORS.new}>● </Text> : ''}
              {totals.new > 0 ? `${totals.new} new   ` : ''}
              {totals.deleted > 0 ? <Text color={COLORS.deleted}>● </Text> : ''}
              {totals.deleted > 0 ? `${totals.deleted} deleted   ` : ''}
              {totals.conflict > 0 ? <Text color={COLORS.conflict}>● </Text> : ''}
              {totals.conflict > 0 ? `${totals.conflict} conflict` : ''}
            </Text>
            <Box flexGrow={1} />
            <Button key="toggle-flat" plain label={isFlat ? 'Folders' : 'Flat'} onPress={() => void toggleFlat($)} />
            {repos.length > 0 && (
              <Button
                key="toggle-all"
                plain
                label={isAllOpen ? 'Collapse' : 'Expand'}
                onPress={() => void $.state.set(OPEN_REPOS, isAllOpen ? [] : repos.map(r => r.path))}
              />
            )}
          </Box>
        </Box>

        {repos.length === 0 && (
          <Text color={COLORS.muted}>{isFiltering || isTrackedOnly ? 'No file matches.' : 'No changes in any repo.'}</Text>
        )}

        <Box flexDirection="column">
          {groupByOwner(repos).map(group => (
            <Box key={`owner:${group.owner}`} flexDirection="column" marginBottom={1}>
              {group.main ? (
                renderRepo(group.main, 0)
              ) : (
                <Box flexDirection="row" gap={1}>
                  <Text color={COLORS.faint}>·</Text>
                  <Text bold color={COLORS.text}>
                    {group.owner}
                  </Text>
                  <Text color={COLORS.faint}>clean</Text>
                </Box>
              )}
              {group.worktrees.map(worktree => renderRepo(worktree, 1))}
            </Box>
          ))}
        </Box>

        {!isFiltering && clean > 0 && <Text color={COLORS.faint}>{plural(clean, 'repo', 'repos')} clean</Text>}
      </Box>
    )
  })
}
