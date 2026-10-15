export type RepoFile = { status: string; path: string }

export type Repo = { path: string; label: string; branch: string; files: RepoFile[] }

export type Selected = {
  repoPath: string
  repoLabel: string
  file: RepoFile
  diff: string
  isDiff: boolean
  adds: number
  dels: number
}

declare module 'claude-code' {
  interface PluginState {
    'repo-changes': {
      repos: Repo[]
      cleanCount: number
      selected: Selected | null
      updatedAt: number
      openRepos: string[] | null
      openGroups: string[]
      filter: string
      isTrackedOnly: boolean
      lastViewed: string | null
      isFlat: boolean
      rowLimits: Record<string, number>
    }
  }
}
