import type { RepoFile } from '../types'

export const MAX_DIFF_CHARS = 90_000
const GROUP_MIN_FILES = 12
const GROUP_MIN_NEW = 3
const GROUP_DESCEND_SHARE = 0.8

export const COLORS = {
  modified: '#d9a04e',
  new: '#7fa9e6',
  deleted: '#e5776b',
  conflict: '#c792ea',
  ahead: '#7fbf8e',
  aheadBg: '#1f3326',
  behind: '#e0a370',
  behindBg: '#3a2c20',
  accent: '#d97757',
  text: '#ebe8e3',
  muted: '#9a968f',
  faint: '#77736c',
  path: '#86827b',
  chip: '#2a2927',
  hover: '#2c2b29',
  selected: '#33302c',
}

export type Kind = 'modified' | 'new' | 'deleted' | 'conflict'

export function kindOf(status: string): Kind {
  if (status === '??' || status.includes('A')) return 'new'
  if (status.includes('U') || status === 'AA' || status === 'DD') return 'conflict'
  if (status.includes('D')) return 'deleted'
  return 'modified'
}

export function badgeOf(status: string): { glyph: string; color: string } {
  const kind = kindOf(status)
  if (kind === 'new') return { glyph: '+', color: COLORS.new }
  if (kind === 'deleted') return { glyph: '−', color: COLORS.deleted }
  if (kind === 'conflict') return { glyph: '!', color: COLORS.conflict }
  if (status.includes('R')) return { glyph: 'R', color: COLORS.modified }
  return { glyph: 'M', color: COLORS.modified }
}

export function parseStatus(stdout: string): { branch: string; files: RepoFile[] } {
  const parts = stdout.split('\0')
  let branch = ''
  const files: RepoFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (part.startsWith('## ')) {
      branch = part.slice(3)
      continue
    }
    const status = part.slice(0, 2)
    files.push({ status: status.trim() || status, path: part.slice(3) })
    if (status[0] === 'R' || status[0] === 'C') i++
  }
  return { branch, files }
}

export type Branch = { name: string; ahead: number; behind: number }

export function parseBranch(raw: string): Branch {
  const ahead = Number(/ahead (\d+)/.exec(raw)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(raw)?.[1] ?? 0)
  let name = raw.replace(/ \[.*\]$/, '')
  if (name.startsWith('No commits yet on ')) name = name.slice('No commits yet on '.length)
  name = name.split('...')[0] ?? name
  return { name, ahead, behind }
}

export type Counts = { modified: number; new: number; deleted: number; conflict: number }

export function countKinds(files: RepoFile[]): Counts {
  const counts: Counts = { modified: 0, new: 0, deleted: 0, conflict: 0 }
  for (const file of files) counts[kindOf(file.status)]++
  return counts
}

export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/', path.endsWith('/') ? path.length - 2 : path.length)
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

export type Row =
  | { type: 'dir'; dir: string }
  | { type: 'file'; file: RepoFile; name: string }
  | { type: 'group'; dir: string; files: RepoFile[] }

function ancestors(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/') + '/'
    if (dir !== '/') out.push(dir)
  }
  return out
}

function groupDirOf(path: string, total: Map<string, number>, fresh: Map<string, number>) {
  const dirs = ancestors(path)
  const isFoldable = (d: string) => {
    const n = total.get(d) ?? 0
    return n >= GROUP_MIN_FILES || (n >= GROUP_MIN_NEW && fresh.get(d) === n)
  }
  let at = dirs.findIndex(isFoldable)
  if (at < 0) return undefined
  while (at + 1 < dirs.length) {
    const here = total.get(dirs[at] as string) ?? 0
    const below = total.get(dirs[at + 1] as string) ?? 0
    if (below < here * GROUP_DESCEND_SHARE) break
    at++
  }
  return dirs[at]
}

export function sortFiles(files: RepoFile[]): RepoFile[] {
  return [...files].sort((a, b) => {
    const pa = splitPath(a.path)
    const pb = splitPath(b.path)
    if (!pa.dir !== !pb.dir) return pa.dir ? 1 : -1
    return pa.dir === pb.dir ? pa.name.localeCompare(pb.name) : pa.dir.localeCompare(pb.dir)
  })
}

export function buildRows(files: RepoFile[], openGroups: ReadonlySet<string>): Row[] {
  const total = new Map<string, number>()
  const fresh = new Map<string, number>()
  for (const file of files) {
    for (const dir of ancestors(file.path)) {
      total.set(dir, (total.get(dir) ?? 0) + 1)
      if (file.status === '??') fresh.set(dir, (fresh.get(dir) ?? 0) + 1)
    }
  }

  const groups = new Map<string, RepoFile[]>()
  const loose: RepoFile[] = []
  for (const file of files) {
    const dir = groupDirOf(file.path, total, fresh)
    if (dir === undefined) {
      loose.push(file)
      continue
    }
    groups.set(dir, [...(groups.get(dir) ?? []), file])
  }
  for (const [dir, members] of groups) {
    if (members.length < GROUP_MIN_NEW || openGroups.has(dir)) {
      loose.push(...members)
      groups.delete(dir)
    }
  }

  type Item = { sortDir: string; sortName: string; row: Row }
  const items: Item[] = loose.map(file => {
    const { dir, name } = splitPath(file.path)
    return { sortDir: dir, sortName: name, row: { type: 'file', file, name } }
  })
  for (const [dir, members] of groups) {
    items.push({ sortDir: dir, sortName: '', row: { type: 'group', dir, files: members } })
  }
  items.sort((a, b) => {
    if (!a.sortDir !== !b.sortDir) return a.sortDir ? 1 : -1
    return a.sortDir === b.sortDir
      ? a.sortName.localeCompare(b.sortName)
      : a.sortDir.localeCompare(b.sortDir)
  })

  const rows: Row[] = []
  let lastDir: string | undefined = ''
  for (const item of items) {
    if (item.row.type === 'group') {
      rows.push(item.row)
      lastDir = undefined
      continue
    }
    if (item.sortDir !== lastDir && item.sortDir) rows.push({ type: 'dir', dir: item.sortDir })
    lastDir = item.sortDir
    rows.push(item.row)
  }
  return rows
}

export function toHunks(raw: string): { source: string; isDiff: boolean } {
  const start = raw.startsWith('@@') ? 0 : raw.indexOf('\n@@') + 1
  if (start === 0 && !raw.startsWith('@@')) return { source: raw.trim(), isDiff: false }
  let source = raw.slice(start)
  if (source.length > MAX_DIFF_CHARS) {
    const cut = source.lastIndexOf('\n@@', MAX_DIFF_CHARS)
    if (cut <= 0) return { source: source.slice(0, MAX_DIFF_CHARS), isDiff: false }
    source = source.slice(0, cut + 1)
  }
  return { source: source.replace(/\n$/, ''), isDiff: true }
}

export function diffStats(hunks: string): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const line of hunks.split('\n')) {
    if (line.startsWith('+')) adds++
    else if (line.startsWith('-')) dels++
  }
  return { adds, dels }
}

export function matchesFilter(file: RepoFile, text: string, isTrackedOnly: boolean): boolean {
  if (isTrackedOnly && file.status === '??') return false
  return !text || file.path.toLowerCase().includes(text.toLowerCase())
}

export const WORKTREE_SEP = ' › '

export type OwnerGroup<R extends { label: string }> = { owner: string; main?: R; worktrees: R[] }

export function groupByOwner<R extends { label: string }>(repos: R[]): OwnerGroup<R>[] {
  const groups = new Map<string, OwnerGroup<R>>()
  for (const repo of repos) {
    const [owner = repo.label, worktree] = repo.label.split(WORKTREE_SEP)
    const group = groups.get(owner) ?? { owner, worktrees: [] }
    if (worktree === undefined) group.main = repo
    else group.worktrees.push(repo)
    groups.set(owner, group)
  }
  const byLabel = (a: R, b: R) => a.label.localeCompare(b.label)
  return [...groups.values()]
    .map(g => ({ ...g, worktrees: [...g.worktrees].sort(byLabel) }))
    .sort((a, b) => a.owner.localeCompare(b.owner))
}

export function flatRows(files: RepoFile[]): Row[] {
  return sortFiles(files).map(file => ({ type: 'file', file, name: splitPath(file.path).name }))
}
