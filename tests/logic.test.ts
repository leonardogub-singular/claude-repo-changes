import { describe, expect, test } from 'claude-code/testing'

import {
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
  toHunks,
} from '../hooks/logic'

const file = (status: string, path: string) => ({ status, path })

describe('parseStatus', () => {
  test('reads branch, modified, untracked and renamed entries', async () => {
    const raw = '## main...origin/main [ahead 1]\0 M src/a.ts\0?? new file.md\0R  b.ts\0old-b.ts\0D  gone.ts\0'
    const { branch, files } = parseStatus(raw)
    expect(branch).toBe('main...origin/main [ahead 1]')
    expect(files).toEqual([
      file('M', 'src/a.ts'),
      file('??', 'new file.md'),
      file('R', 'b.ts'),
      file('D', 'gone.ts'),
    ])
  })
})

describe('parseBranch', () => {
  test('splits name from upstream and reads ahead/behind', async () => {
    expect(parseBranch('main...origin/main [behind 33]')).toEqual({ name: 'main', ahead: 0, behind: 33 })
    expect(parseBranch('feat/x...origin/feat/x [ahead 2, behind 1]')).toEqual({ name: 'feat/x', ahead: 2, behind: 1 })
    expect(parseBranch('staging')).toEqual({ name: 'staging', ahead: 0, behind: 0 })
    expect(parseBranch('No commits yet on main')).toEqual({ name: 'main', ahead: 0, behind: 0 })
  })
})

describe('badgeOf and countKinds', () => {
  test('maps git status to a glyph and a kind', async () => {
    expect(badgeOf('??').glyph).toBe('+')
    expect(badgeOf('D').glyph).toBe('−')
    expect(badgeOf('M').glyph).toBe('M')
    expect(badgeOf('UU').glyph).toBe('!')
    expect(countKinds([file('M', 'a'), file('??', 'b'), file('A', 'c'), file('D', 'd')])).toEqual({
      modified: 1,
      new: 2,
      deleted: 1,
      conflict: 0,
    })
  })
})

describe('buildRows', () => {
  const sample = sortFiles([
    file('M', 'CLAUDE.md'),
    file('M', 'package.json'),
    file('M', 'src/scripts/scrape-http.ts'),
    file('M', 'src/scripts/upload-reports.ts'),
    file('??', 'src/scripts/check.ts'),
    file('??', 'src/shared/hash.ts'),
    file('??', 'files/list/a.csv'),
    file('??', 'files/list/b.csv'),
    file('??', 'files/list/c.sh'),
  ])

  test('shows root files first, then dir headers, and folds an all-new folder', async () => {
    const rows = buildRows(sample, new Set())
    expect(rows.map(r => (r.type === 'file' ? r.name : `${r.type}:${r.dir}`))).toEqual([
      'CLAUDE.md',
      'package.json',
      'group:files/list/',
      'dir:src/scripts/',
      'check.ts',
      'scrape-http.ts',
      'upload-reports.ts',
      'dir:src/shared/',
      'hash.ts',
    ])
  })

  test('an open group shows its files', async () => {
    const rows = buildRows(sample, new Set(['files/list/']))
    expect(rows.filter(r => r.type === 'group')).toEqual([])
    expect(rows.some(r => r.type === 'dir' && r.dir === 'files/list/')).toBe(true)
  })

  test('a big folder folds at its deepest shared level, a lone sibling stays loose', async () => {
    const many = Array.from({ length: 14 }, (_, i) => file('??', `bruno/WS/collections/c${i}.bru`))
    const rows = buildRows(sortFiles([...many, file('M', 'bruno/WS/workspace.yml')]), new Set())
    const group = rows.find(r => r.type === 'group')
    expect(group?.type === 'group' && group.dir).toBe('bruno/WS/collections/')
    expect(group?.type === 'group' && group.files.length).toBe(14)
    expect(rows.some(r => r.type === 'file' && r.name === 'workspace.yml')).toBe(true)
  })
})

describe('toHunks and diffStats', () => {
  test('drops git headers and counts changed lines', async () => {
    const raw = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n+c\n'
    const hunks = toHunks(raw)
    expect(hunks).toEqual({ source: '@@ -1,2 +1,2 @@\n-a\n+b\n+c', isDiff: true })
    expect(diffStats(hunks.source)).toEqual({ adds: 2, dels: 1 })
  })

  test('a binary diff is shown as text', async () => {
    expect(toHunks('diff --git a/i.png b/i.png\nBinary files differ\n').isDiff).toBe(false)
  })
})

describe('matchesFilter', () => {
  test('filters by text and hides untracked when asked', async () => {
    expect(matchesFilter(file('M', 'src/Upload.ts'), 'upload', false)).toBe(true)
    expect(matchesFilter(file('??', 'src/new.ts'), '', true)).toBe(false)
    expect(matchesFilter(file('M', 'src/a.ts'), 'zzz', false)).toBe(false)
  })
})

describe('groupByOwner', () => {
  test('puts worktrees under their repo, repos and worktrees by name', async () => {
    const groups = groupByOwner([
      { label: 'web-app › zeta' },
      { label: 'api' },
      { label: 'web-app › alpha' },
      { label: 'api › dash' },
    ])
    expect(groups.map(g => g.owner)).toEqual(['api', 'web-app'])
    expect(groups[0]?.main?.label).toBe('api')
    expect(groups[0]?.worktrees.map(w => w.label)).toEqual(['api › dash'])
    expect(groups[1]?.main).toBeUndefined()
    expect(groups[1]?.worktrees.map(w => w.label)).toEqual(['web-app › alpha', 'web-app › zeta'])
  })
})

describe('flatRows', () => {
  test('lists every file with no folder rows, root files first', async () => {
    const rows = flatRows([file('??', 'files/list/a.csv'), file('M', 'src/x.ts'), file('M', 'README.md')])
    expect(rows.map(r => r.type)).toEqual(['file', 'file', 'file'])
    expect(rows.map(r => (r.type === 'file' ? r.file.path : ''))).toEqual(['README.md', 'files/list/a.csv', 'src/x.ts'])
  })
})
