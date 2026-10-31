import { describe, expect, it } from 'vitest'
import { abbreviatePath, homeFromDataDir } from './paths'

describe('homeFromDataDir', () => {
  it('finds the home folder from the app data folder on each platform', () => {
    expect(homeFromDataDir('/Users/ana/Library/Application Support/io.github.gingerman960.facetimelapse')).toBe('/Users/ana')
    expect(homeFromDataDir('C:\\Users\\ana\\AppData\\Roaming\\io.github.gingerman960.facetimelapse')).toBe('C:\\Users\\ana')
    expect(homeFromDataDir('/home/ana/.local/share/io.github.gingerman960.facetimelapse')).toBe('/home/ana')
    expect(homeFromDataDir('/opt/ft')).toBeNull()
    expect(homeFromDataDir(undefined)).toBeNull()
  })
})

describe('abbreviatePath', () => {
  const home = '/Users/ana'
  it('replaces the home folder with ~', () => {
    expect(abbreviatePath('/Users/ana/Pictures/Daily selfies', home)).toBe('~/Pictures/Daily selfies')
    expect(abbreviatePath('/Users/anabel/Pictures', home)).toBe('/Users/anabel/Pictures')
  })
  it('keeps the start and the last folders of a long path, truncating the middle', () => {
    const long = '/Users/ana/Projects/Archive/Phone backups/2012–2022/Camera roll/everyday photos/photos'
    const short = abbreviatePath(long, home, 40)
    expect(short).toBe('~/Projects/…/everyday photos/photos')
    expect(short.length).toBeLessThanOrEqual(40)
  })
  it('falls back to the last folder name when even that is too long', () => {
    expect(abbreviatePath('/Volumes/Backup disk with a long name/some/where/A folder with a long name', null, 24)).toBe('…/A folder with a long name')
  })
  it('works with Windows separators', () => {
    expect(abbreviatePath('C:\\Users\\ana\\Pictures\\Selfies', 'C:\\Users\\ana')).toBe('~\\Pictures\\Selfies')
  })
})
