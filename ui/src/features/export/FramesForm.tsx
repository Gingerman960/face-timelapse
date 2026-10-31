import type { ImageExportSettings, ImageFormat } from '../../ipc/contract'
import { NumberField, SwitchRow } from '../../components/ui/Controls'
import { Segmented, type SegmentOption } from '../../components/ui/Segmented'
import { clashHelp, parseJpegQuality } from './exportModel'

const FORMATS: ReadonlyArray<SegmentOption<ImageFormat>> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
]

interface FramesFormProps {
  settings: ImageExportSettings
  onChange: (s: ImageExportSettings) => void
  lookOn: boolean
  onLook: (on: boolean) => void
}

/** Frames-as-images export settings. */
export function FramesForm({ settings, onChange, lookOn, onLook }: FramesFormProps) {
  const setQuality = (raw: string) => {
    const jpegQuality = parseJpegQuality(raw)
    if (jpegQuality === null) return false
    onChange({ ...settings, jpegQuality })
  }
  return (
    <div className="form">
      <div className="field">
        <span className="field-label">File type</span>
        <Segmented<ImageFormat> label="File type" value={settings.format} onChange={(format) => onChange({ ...settings, format })} options={FORMATS} />
      </div>
      {settings.format === 'jpeg' ? (
        <div className="field">
          <span className="field-label">Quality</span>
          <NumberField label="JPEG quality, 50 to 100" value={String(settings.jpegQuality)} unit="of 100" onCommit={setQuality} />
        </div>
      ) : null}
      <div className="field stack">
        <span className="field-label">Names</span>
        <SwitchRow
          label="Replace files with the same name"
          help={clashHelp(settings.format)}
          checked={settings.overwrite}
          onChange={(overwrite) => onChange({ ...settings, overwrite })}
        />
      </div>
      <div className="field stack">
        <span className="field-label">Light</span>
        <SwitchRow label="Even out light and colour" help="Same setting as the player’s Even light" checked={lookOn} onChange={onLook} />
      </div>
    </div>
  )
}
