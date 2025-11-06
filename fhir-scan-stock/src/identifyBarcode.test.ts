import { describe, it, expect } from 'vitest'
import { identifyBarcode } from './App'

describe('identifyBarcode', () => {
  it('matches built-in database entries', () => {
    const info = identifyBarcode('1000000000001')
    expect(info.Category).toBeDefined()
    expect(info.Products).toBeDefined()
  })

  it('parses JSON QR payloads', () => {
    const payload = JSON.stringify({ Products: 'Custom Device', Supplier: 'Acme', StockLevel: 7, Category: 'CustomCat' })
    const info = identifyBarcode(payload)
    expect(info).toEqual({ Category: 'CustomCat', Products: 'Custom Device', Supplier: 'Acme', StockLevel: 7 })
  })

  it('falls back to pattern hints for 13-digit 100* barcode', () => {
    const code = '1001234567890'
    const info = identifyBarcode(code)
    expect(info).toEqual({ Category: 'Medical Device', Products: code, Supplier: 'Unknown', StockLevel: 0 })
  })

  it('falls back to pattern hints for 13-digit 010* barcode', () => {
    const code = '0109876543210'
    const info = identifyBarcode(code)
    expect(info).toEqual({ Category: 'Implantable Device', Products: code, Supplier: 'Unknown', StockLevel: 0 })
  })

  it('returns a sensible default for unknown strings', () => {
    const code = 'UNKNOWN-CODE'
    const info = identifyBarcode(code)
    expect(info).toEqual({ Category: 'Uncategorized', Products: code, Supplier: 'Unknown', StockLevel: 0 })
  })
})

