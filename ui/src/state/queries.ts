import { QueryClient, useQuery } from '@tanstack/react-query'
import { call } from '../ipc/client'
import type {
  AppInfo,
  DayGroup,
  FramesView,
  MatchStatus,
  PhotoDetail,
  PhotoId,
  PhotoSummary,
  SessionSnapshot,
} from '../ipc/contract'

/**
 * Backend data never changes behind our back: it changes through commands we
 * issue or jobs we run, and both invalidate explicitly. So nothing goes stale
 * on its own and nothing refetches on focus.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false },
    mutations: { retry: false },
  },
})

/** Query keys exactly as ARCHITECTURE §8 lists them. */
export const queryKeys = {
  appInfo: ['appInfo'] as const,
  session: ['session'] as const,
  photos: (statuses: MatchStatus[] | null) => ['photos', statuses] as const,
  photosAll: ['photos'] as const,
  photo: (id: PhotoId) => ['photo', id] as const,
  photoAll: ['photo'] as const,
  days: ['days'] as const,
  frames: ['frames'] as const,
}

/** App info (image base URL, platform, parallelism). Never refetched. */
export function useAppInfo() {
  return useQuery<AppInfo>({ queryKey: queryKeys.appInfo, queryFn: () => call('get_app_info') })
}

/** The session snapshot: the source of truth for reachability and the ledger. */
export function useSession() {
  return useQuery<SessionSnapshot>({ queryKey: queryKeys.session, queryFn: () => call('get_session') })
}

/** Photo summaries, optionally filtered by status (relPath order). */
export function usePhotos(statuses: MatchStatus[] | null, enabled = true) {
  return useQuery<PhotoSummary[]>({
    queryKey: queryKeys.photos(statuses),
    queryFn: () => call('get_photos', { query: { statuses } }),
    enabled,
  })
}

/**
 * Read-only view of a cached photo list: never fetches by itself (the screen
 * that owns the list does), but has its queryFn so any refetch it takes part
 * in works. Uses the module client, so it also works outside a provider.
 */
export function useCachedPhotos(statuses: MatchStatus[] | null) {
  return useQuery<PhotoSummary[]>(
    { queryKey: queryKeys.photos(statuses), queryFn: () => call('get_photos', { query: { statuses } }), enabled: false },
    queryClient,
  )
}

/** Read-only view of the cached app info (see useCachedPhotos). */
export function useCachedAppInfo() {
  return useQuery<AppInfo>({ queryKey: queryKeys.appInfo, queryFn: () => call('get_app_info'), enabled: false }, queryClient)
}

/** One photo's detail (faces, matched face, raw similarity). */
/** One photo's detail query (key and fetch), shared by `usePhoto` and Review's prefetch. */
export function photoQuery(id: PhotoId): { queryKey: ReturnType<typeof queryKeys.photo>; queryFn: () => Promise<PhotoDetail> } {
  return { queryKey: queryKeys.photo(id), queryFn: () => call('get_photo', { photoId: id }) }
}

export function usePhoto(id: PhotoId | null) {
  return useQuery<PhotoDetail>({ ...photoQuery(id ?? ''), enabled: id !== null })
}

/** Day groups, ascending. */
export function useDays(enabled = true) {
  return useQuery<DayGroup[]>({ queryKey: queryKeys.days, queryFn: () => call('get_days'), enabled })
}

/** Frames of the current fingerprint, chronological. */
export function useFrames(enabled = true) {
  return useQuery<FramesView>({ queryKey: queryKeys.frames, queryFn: () => call('get_frames'), enabled })
}

/** Re-reads the session and everything derived from it (after a job ends). */
export async function refreshAll(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.session })
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.photosAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.photoAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.days }),
    queryClient.invalidateQueries({ queryKey: queryKeys.frames }),
  ])
}

/**
 * The backend changed the session on its own (v1.2 `session-changed`: dev
 * autoload, a re-analyzed reference). What changed is unknown, possibly the
 * folder, so derived caches are dropped (never shown stale) and re-read.
 */
export function sessionChangedByBackend(): void {
  libraryReplaced()
}

/**
 * The day pool changed (a decision, a pick, a move, an add, an exclusion):
 * the session counts, the photo list, the days and the frames all follow.
 */
export function dayPoolChanged(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.session })
  void queryClient.invalidateQueries({ queryKey: queryKeys.photosAll })
  void queryClient.invalidateQueries({ queryKey: queryKeys.days })
  void queryClient.invalidateQueries({ queryKey: queryKeys.frames })
}

/**
 * The library itself changed (another folder, or its scan results were
 * forgotten): nothing derived from the old one may show, even briefly, so
 * those caches are dropped rather than refetched in place.
 */
export function libraryReplaced(): void {
  for (const queryKey of [queryKeys.photosAll, queryKeys.photoAll, queryKeys.days, queryKeys.frames]) {
    void queryClient.cancelQueries({ queryKey })
    queryClient.removeQueries({ queryKey })
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.session })
  // The video settings and the playhead stay: the settings are the session's, not
  // the library's, and the playhead clamp keeps a shorter timelapse in range (UI review 3, L2).
}
