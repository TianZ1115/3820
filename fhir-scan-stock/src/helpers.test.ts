import { describe, it, expect } from 'vitest'
import { idFromLocation, bundleEntries } from './App'

describe('helpers', () => {
  describe('idFromLocation', () => {
    it('extracts id from simple location', () => {
      expect(idFromLocation('Device/123')).toBe('123')
    })
    it('extracts id before history segment', () => {
      expect(idFromLocation('Device/123/_history/1')).toBe('123')
    })
    it('returns null for falsy input', () => {
      // @ts-expect-error testing undefined
      expect(idFromLocation(undefined)).toBeNull()
    })
  })

  describe('bundleEntries', () => {
    it('maps entry resources into a flat array', () => {
      const res = bundleEntries({ entry: [ { resource: { a: 1 } }, { resource: { b: 2 } } ] })
      expect(res).toEqual([{ a: 1 }, { b: 2 }])
    })
    it('returns empty array for non-bundle-like input', () => {
      // @ts-expect-error testing non-bundle
      const res = bundleEntries({ foo: 'bar' })
      expect(res).toEqual([])
    })
  })
})

