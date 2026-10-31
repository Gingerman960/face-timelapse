// In-memory implementation of every command and job channel of the IPC
// contract (ARCHITECTURE §7). Install it with `installMockBackend()`.
import type {
  ActiveJob,
  AlignEvent,
  CommandMap,
  CommandName,
  ExportImagesEvent,
  ExportVideoEvent,
  JobId,
  JobKind,
  ScanEvent,
} from '../contract'
import { alignScript } from './alignJob'
import { DEFAULT_MESSAGES, MESSAGES, invalid, ipcError, isIpcError } from './errors'
import { exportImagesScript, exportVideoScript } from './exportJobs'
import { frameHandlers } from './frameCommands'
import { detectionOf } from './reference'
import { framesOf } from './frames'
import { type EventSink, JobRunner, type JobScript, jobTiming } from './jobs'
import { libraryHandlers } from './libraryCommands'
import { classifyPath, isDirectory, normalizePath, parentDir } from './mockFs'
import {
  type MidwayFailPoint,
  type MockOptions,
  type MockScenario,
  isCommandName,
  resolveMockOptions,
} from './options'
import { type JobEnv, scanScript } from './scanJob'
import { scenarioState } from './scenarios'
import { snapshotOf } from './session'
import { APP_INFO, type Handler, type Outcome, setupHandlers } from './setupCommands'
import { type MockState, currentFolder } from './state'
import { type Args, absolutePath, argsOf, channel, imageExportSettings, renderSettings, str } from './validate'
import { planVideo, videoSettings } from './videoPlan'

type Result<K extends CommandName> = CommandMap[K]['result']

/** Commands that work while a job runs (D4; `set_video_settings` is a light change, v1.5). */
const READ_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'get_app_info',
  'get_session',
  'get_photos',
  'get_photo',
  'get_days',
  'get_frames',
  'cancel_job',
  'reveal_path',
  'open_path',
  'set_video_settings',
])

const MIDWAY_POINT: Readonly<Record<JobKind, MidwayFailPoint>> = {
  scan: 'scanMidway',
  align: 'alignMidway',
  exportImages: 'exportImagesMidway',
  exportVideo: 'exportVideoMidway',
}

type SyncCommand = Exclude<
  CommandName,
  'get_session' | 'cancel_job' | 'start_scan' | 'start_align' | 'start_export_images' | 'start_export_video'
>

const HANDLERS: { [K in SyncCommand]: Handler<K> } = {
  ...setupHandlers,
  ...libraryHandlers,
  ...frameHandlers,
}

/** Mimics the JSON boundary: callers never share objects with the backend state. */
function serialized<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** Commands whose path argument must be granted (v1.3 §7.1), and how strictly. */
const PATH_ARGS: Partial<Record<CommandName, { key: string; exact: boolean }>> = {
  set_reference_photo: { key: 'path', exact: false },
  set_source_folder: { key: 'path', exact: false },
  add_photo_to_day: { key: 'path', exact: false },
  start_export_images: { key: 'dir', exact: true },
  start_export_video: { key: 'path', exact: true },
}

/** Commands that run the face models (`require_models` in the backend). */
const NEEDS_MODELS: ReadonlySet<CommandName> = new Set(['start_scan', 'start_align', 'add_photo_to_day', 'set_frame_adjustment'])

export class FakeBackend {
  private state: MockState
  private options: MockOptions
  private readonly runner = new JobRunner()
  /** Paths the user chose (dialogs, drops): the shell records these before the page can call. */
  private readonly granted = new Set<string>()

  constructor(options: Partial<MockOptions> = {}) {
    this.options = resolveMockOptions(options)
    this.state = scenarioState(this.options.scenario)
  }

  /** The current (immutable) state, for tests and debugging. */
  get current(): MockState {
    return this.state
  }

  get activeJob(): ActiveJob | null {
    return this.runner.activeJob
  }

  get settings(): Readonly<MockOptions> {
    return this.options
  }

  /** Changes speed / failure injection / dialogs at runtime (e.g. from Playwright). */
  configure(patch: Partial<Omit<MockOptions, 'scenario'>>): void {
    this.options = resolveMockOptions({ ...this.options, ...patch, fail: patch.fail ?? this.options.fail })
  }

  /** Replaces the whole session with a scenario; a running job is dropped silently. */
  loadScenario(scenario: MockScenario): void {
    this.runner.dispose()
    this.options = { ...this.options, scenario }
    this.state = scenarioState(scenario)
  }

  /**
   * Rewrites the session state in place of a scenario, for states no scenario
   * reaches (tests and captures: e.g. a finished scan whose results were lost, N5).
   */
  replaceState(update: (state: MockState) => MockState): void {
    this.state = update(this.state)
  }

  /** Records OS-drop grants (the real shell does this before the webview sees the drop). */
  grant(paths: readonly string[]): void {
    for (const p of paths) this.granted.add(p)
  }

  /** The session's own paths: current and recent reference and folders, folders with decisions, earlier outputs. */
  private sessionPaths(): string[] {
    const s = this.state
    return [
      ...(s.reference ? [s.reference.path] : []),
      ...(s.folderPath ? [s.folderPath] : []),
      ...s.recents.references,
      ...s.recents.folders,
      ...Object.keys(s.folders),
      ...s.outputs,
    ]
  }

  /** v1.3 grant check, byte for byte: a path inside a chosen folder counts unless `exact`. */
  private isGranted(path: string, exact: boolean): boolean {
    const roots = exact ? [...this.granted, ...this.state.outputs] : [...this.granted, ...this.sessionPaths()]
    return roots.some((root) => path === root || (!exact && path.startsWith(root.endsWith('/') ? root : `${root}/`)))
  }

  private checkGrant(cmd: CommandName, args: Args): void {
    const rule = PATH_ARGS[cmd]
    if (!rule || !this.options.strictGrants) return
    const value = args[rule.key]
    if (typeof value === 'string' && !this.isGranted(value, rule.exact)) throw ipcError('permissionDenied', MESSAGES.notGranted)
  }

  private recordGrant(cmd: CommandName, result: unknown): void {
    if (result === null || result === undefined) return
    if (cmd === 'pick_export_folder' || cmd === 'pick_video_path') this.grant([result as string])
    else if (cmd === 'pick_source_folder') this.grant([(result as { path: string }).path])
    else if (cmd === 'pick_reference_photo') this.grant([(result as { image: { path: string } }).image.path])
  }

  /** Typed entry point (tests). */
  call<K extends CommandName>(cmd: K, args: CommandMap[K]['args']): Promise<Result<K>> {
    return this.handle(cmd, args) as Promise<Result<K>>
  }

  /** `mockIPC` callback: window/plugin commands resolve to null; rejections are `IpcError` objects. */
  readonly handle = async (cmd: string, payload?: unknown): Promise<unknown> => {
    if (cmd.startsWith('plugin:')) return null
    if (!isCommandName(cmd)) throw ipcError('internal', `Unknown command "${cmd}".`)
    if (this.runner.activeJob && !READ_COMMANDS.has(cmd)) throw ipcError('busy')
    const injected = this.options.fail[cmd]
    if (injected) throw ipcError(injected)
    // A command that needs the models waits for the load and gives up after 2 s (§7.1); the mock's load never ends on its own.
    if ((this.options.modelsMissing || this.options.modelsLoading) && NEEDS_MODELS.has(cmd)) throw ipcError('modelUnavailable')
    try {
      const args = argsOf(payload)
      this.checkGrant(cmd, args)
      const result = this.execute(cmd, args)
      this.recordGrant(cmd, result)
      return serialized(result)
    } catch (error) {
      if (isIpcError(error)) throw error
      console.error(`[mock] ${cmd} failed`, error)
      throw ipcError('internal')
    }
  }

  private execute(cmd: CommandName, args: Args): unknown {
    switch (cmd) {
      case 'get_app_info':
        return {
          ...APP_INFO,
          modelsReady: !this.options.modelsMissing && !this.options.modelsLoading,
          modelsError: this.options.modelsMissing ? DEFAULT_MESSAGES.modelUnavailable : null,
        }
      case 'get_session':
        return snapshotOf(this.state, this.runner.activeJob)
      case 'cancel_job':
        this.runner.cancel(str(args, 'jobId'))
        return null
      case 'start_scan':
        return this.startScan(args)
      case 'start_align':
        return this.startAlign(args)
      case 'start_export_images':
        return this.startExportImages(args)
      case 'start_export_video':
        return this.startExportVideo(args)
      default:
        return this.apply((HANDLERS[cmd] as Handler<typeof cmd>)({ state: this.state, options: this.options }, args))
    }
  }

  private apply<R>(outcome: Outcome<R>): R {
    if (outcome.state) this.state = outcome.state
    return outcome.result
  }

  private startJob<E>(kind: JobKind, sink: EventSink<E>, script: (env: JobEnv) => JobScript<E>): JobId {
    const timing = jobTiming(kind, this.options.speed)
    const failKind = this.options.fail[MIDWAY_POINT[kind]]
    return this.runner.start(
      kind,
      { onmessage: (event: E) => sink.onmessage(serialized(event)) },
      (jobId) =>
        script({
          jobId,
          steps: timing.steps,
          get: () => this.state,
          set: (next) => {
            this.state = next
          },
        }),
      {
        timing,
        failAt: failKind ? { step: Math.floor(timing.steps / 2), error: ipcError(failKind) } : null,
      },
    )
  }

  private startScan(args: Args): JobId {
    const sink = channel<ScanEvent>(args)
    if (!currentFolder(this.state)) throw ipcError('notReady', MESSAGES.noFolder)
    if (!this.state.reference) throw ipcError('notReady', MESSAGES.noReference)
    if (!detectionOf(this.state.reference)) throw ipcError('noFaceInReference')
    return this.startJob('scan', sink, scanScript)
  }

  private startAlign(args: Args): JobId {
    const render = renderSettings(args)
    const sink = channel<AlignEvent>(args)
    if (!this.state.reference) throw ipcError('notReady', MESSAGES.noReference)
    if (!detectionOf(this.state.reference)) throw ipcError('noFaceInReference')
    const next: MockState = { ...this.state, render }
    if (framesOf(next).expected === 0) throw ipcError('notReady', MESSAGES.noActiveDays)
    this.state = next
    return this.startJob('align', sink, (env) => alignScript(env, this.options.alignFailures))
  }

  private startExportImages(args: Args): JobId {
    const dir = normalizePath(absolutePath(args, 'dir'))
    const settings = imageExportSettings(args)
    const sink = channel<ExportImagesEvent>(args)
    if (framesOf(this.state).count === 0) throw ipcError('notReady', MESSAGES.noFrames)
    const kind = classifyPath(dir)
    if (kind.kind !== 'directory') throw invalid('Choose an existing folder to export into.')
    if (kind.locked) throw ipcError('permissionDenied', MESSAGES.notWritable)
    this.state = { ...this.state, imageExport: settings }
    return this.startJob('exportImages', sink, (env) => exportImagesScript(env, dir, settings))
  }

  private startExportVideo(args: Args): JobId {
    const path = normalizePath(absolutePath(args))
    const settings = videoSettings(args)
    const sink = channel<ExportVideoEvent>(args)
    const frames = framesOf(this.state)
    if (frames.count < 2 || !frames.outputSize) throw ipcError('notReady', MESSAGES.tooFewFrames)
    if (!path.toLowerCase().endsWith('.mp4')) throw invalid('Save the video as an .mp4 file.')
    if (!isDirectory(parentDir(path))) throw invalid('Choose an existing folder for the video.')
    const plan = planVideo(settings, frames.count, frames.outputSize)
    this.state = { ...this.state, video: settings }
    return this.startJob('exportVideo', sink, (env) => exportVideoScript(env, path, plan))
  }
}
