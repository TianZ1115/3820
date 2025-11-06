import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fhirRead, fhirSearch, fhirUpdate, fhirDelete, fhirTransaction, __setSmartClientForTest, __clearSmartClientForTest } from './App'

const mockJson = (data: any) => ({ ok: true, json: async () => data }) as any

describe('FHIR helper functions', () => {
  beforeEach(() => {
    __clearSmartClientForTest()
    // @ts-ignore
    global.fetch = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __clearSmartClientForTest()
  })

  describe('non-SMART path (anonymous)', () => {
    it('fhirRead calls fetch with normalized path', async () => {
      ;(global.fetch as any).mockResolvedValue(mockJson({ resourceType: 'Device', id: '123' }))
      const res = await fhirRead('/Device/123')
      expect(res.id).toBe('123')
      expect((global.fetch as any).mock.calls[0][0]).toMatch(/Device\/123$/)
    })

    it('fhirSearch appends _ts param for cache-busting', async () => {
      ;(global.fetch as any).mockResolvedValue(mockJson({ resourceType: 'Bundle', entry: [] }))
      await fhirSearch('DeviceUseStatement?_count=5')
      const url = (global.fetch as any).mock.calls[0][0] as string
      expect(url).toMatch(/DeviceUseStatement\?_count=5&_ts=\d+$/)
    })

    it('fhirUpdate uses PUT with JSON body', async () => {
      ;(global.fetch as any).mockResolvedValue(mockJson({ resourceType: 'Device', id: '123' }))
      await fhirUpdate('Device/123', { id: '123', resourceType: 'Device' })
      const [, opts] = (global.fetch as any).mock.calls[0]
      expect(opts.method).toBe('PUT')
      expect(opts.headers['Content-Type']).toBe('application/fhir+json')
    })

    it('fhirDelete uses DELETE with cascade', async () => {
      ;(global.fetch as any).mockResolvedValue({ ok: true, status: 204, text: async () => '' })
      await fhirDelete('Device/123')
      const url = (global.fetch as any).mock.calls[0][0] as string
      expect(url).toMatch(/Device\/123\?_cascade=delete$/)
    })

    it('fhirTransaction posts bundle to base', async () => {
      ;(global.fetch as any).mockResolvedValue(mockJson({ resourceType: 'Bundle', type: 'transaction-response' }))
      await fhirTransaction({ resourceType: 'Bundle', type: 'transaction', entry: [] })
      const [, opts] = (global.fetch as any).mock.calls[0]
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/fhir+json')
    })
  })

  describe('SMART path', () => {
    it('delegates to SMART client for read/update/delete/search/transaction', async () => {
      const request = vi.fn()
        // read
        .mockResolvedValueOnce({ resourceType: 'Device', id: '123' })
        // search
        .mockResolvedValueOnce({ resourceType: 'Bundle', entry: [] })
        // update
        .mockResolvedValueOnce({ resourceType: 'Device', id: '123' })
        // delete
        .mockResolvedValueOnce({ ok: true })
        // transaction
        .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'batch-response' })
      __setSmartClientForTest({ request })

      await fhirRead('Device/123')
      await fhirSearch('DeviceUseStatement?_count=1')
      await fhirUpdate('Device/123', { id: '123', resourceType: 'Device' })
      await fhirDelete('Device/123')
      await fhirTransaction({ resourceType: 'Bundle', type: 'transaction', entry: [] })

      expect(request).toHaveBeenCalled()
      // verify transaction hit base '/'
      const lastCall = request.mock.calls[4]
      expect(lastCall[0]).toBe('/')
      expect(lastCall[1].method).toBe('POST')
    })
  })
})

